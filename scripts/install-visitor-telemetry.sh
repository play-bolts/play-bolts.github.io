#!/bin/bash
# Application-only telemetry cutover; retain all host configuration and gateway.
# Arguments: release SHA256, verified bundle, host.json, expected live release.
set -euo pipefail
umask 077
test "$#" -eq 4
release=$1
bundle=$2
config=$3
expected_release=$4
[[ "$release" =~ ^[a-f0-9]{64}$ ]]
[[ "$expected_release" =~ ^[a-f0-9]{64}$ ]]
exec 9>/var/lock/bolts-release.lock
flock -n 9 || { echo 'Another Bolts release is in progress.' >&2; exit 1; }
previous=$(readlink /opt/bolts/current)
verify_current_release() {
  test "$(readlink /opt/bolts/current)" = "$previous"
  test "$previous" = "/opt/bolts/releases/$expected_release"
}
verify_current_release
test -f /var/lib/bolts-bootstrap.ready
test -x "$bundle/bolts-host"
test -x "$bundle/bolts-server"
cmp "$bundle/bolts-host" "$previous/bolts-host"
"$bundle/bolts-host" --mode=directory --config="$config" --check-config
python3 - "$config" <<'BOLTS_CONFIG'
import json,re,sys
from pathlib import Path
current=json.loads(Path('/etc/bolts-gamelift.json').read_text())
assert current == json.loads(Path(sys.argv[1]).read_text()), 'Hosting configuration changed'
assert current.get('extraLobbiesEnabled') is False, 'Regional hosting must remain disabled'
env=Path('/etc/bolts.env')
assert env.stat().st_mode & 0o777 == 0o600
assert re.findall(rb'(?m)^BOLTS_MAX_ROOMS=([^\r\n]*)$',env.read_bytes()) == [b'6']
assert re.search(rb'(?m)^BOLTS_ADMIN_API_KEY=[^\r\n]+$',env.read_bytes())
BOLTS_CONFIG
verify_empty_lobbies() {
  curl --fail --silent --show-error --max-time 10 http://127.0.0.1:8080/api/lobbies | python3 -c '
import json,sys
data=json.load(sys.stdin)
expected=[("Deathmatch 1",6),("Deathmatch 2",6),("Deathmatch 3",6),("1v1 Alpha",2),("1v1 Beta",2),("1v1 Delta",2)]
rooms=data.get("lobbies")
if data.get("locations") != [] or not isinstance(rooms,list) or [(r.get("name"),r.get("capacity")) for r in rooms] != expected:
    raise SystemExit("Local lobby inventory changed.")
if any(type(r.get("players")) is not int or r["players"] != 0 for r in rooms):
    raise SystemExit("Cutover deferred: a human seat is occupied.")
'
}
verify_empty_lobbies
checkpoint=$(mktemp -d /var/lib/bolts/visitor-telemetry.XXXXXX)
# Keep an online SQLite checkpoint locally as well as the existing encrypted S3
# backup. No database rows or private environment values leave this host.
python3 - "$checkpoint" <<'BOLTS_CHECKPOINT'
import hashlib,json,sqlite3,sys
from contextlib import closing
from pathlib import Path
folder=Path(sys.argv[1])
paths=['/etc/bolts.env','/etc/bolts-gamelift.json','/etc/systemd/system/bolts.service.d/gamelift.conf','/etc/systemd/system/bolts.service','/etc/systemd/system/bolts-backup.service','/etc/systemd/system/bolts-backup.timer','/usr/local/libexec/bolts-backup']
protected={name:{'sha256':hashlib.sha256(Path(name).read_bytes()).hexdigest(),'mode':Path(name).stat().st_mode & 0o777} for name in paths}
(folder/'protected.json').write_text(json.dumps(protected))
with closing(sqlite3.connect('file:/var/lib/bolts/bolts.sqlite?mode=ro',uri=True,timeout=30)) as source:
    with closing(sqlite3.connect(folder/'bolts.sqlite')) as target:
        source.backup(target,pages=128,sleep=0.05)
        assert target.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
BOLTS_CHECKPOINT
verify_protected_files() {
  python3 - "$checkpoint/protected.json" <<'BOLTS_PROTECTED'
import hashlib,json,sys
from pathlib import Path
for name,expected in json.loads(Path(sys.argv[1]).read_text()).items():
    path=Path(name)
    assert {'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'mode':path.stat().st_mode & 0o777} == expected, 'Protected configuration changed'
BOLTS_PROTECTED
}
systemctl start bolts-backup.service
test "$(systemctl show bolts-backup.service --property=Result --value)" = success
verify_empty_lobbies
verify_current_release
verify_protected_files
install -d -m 0755 "/opt/bolts/releases/$release"
install -m 0755 "$bundle/bolts-host" "$bundle/bolts-server" "/opt/bolts/releases/$release/"
verify_empty_lobbies
verify_current_release
verify_protected_files
verify_health() {
  curl --fail --silent --max-time 3 http://127.0.0.1:8080/api/health | python3 -c 'import json,sys; assert json.load(sys.stdin)=={"ok":True,"version":3}' || return 1
  curl --fail --silent --max-time 3 http://127.0.0.1:8080/api/lobbies | python3 -c '
import json,sys
data=json.load(sys.stdin)
expected=[("Deathmatch 1",6),("Deathmatch 2",6),("Deathmatch 3",6),("1v1 Alpha",2),("1v1 Beta",2),("1v1 Delta",2)]
assert data.get("version")==2 and data.get("locations")==[]
assert [(r.get("name"),r.get("capacity")) for r in data["lobbies"]] == expected
assert all(r.get("location")=="or" and r.get("managed") is False for r in data["lobbies"])
'
}
rollback() {
  local status=$?
  trap - EXIT HUP INT TERM
  set +e
  systemctl stop bolts.service
  local restored=true
  ln -sfn "$previous" /opt/bolts/current.next || restored=false
  mv -Tf /opt/bolts/current.next /opt/bolts/current || restored=false
  systemctl restart bolts.service || restored=false
  verify_health || restored=false
  if [ "$restored" = true ]; then
    echo 'Cutover failed; previous binaries restored and healthy. Additive schema and checkpoint retained.' >&2
  else
    echo "Cutover failed; inspect rollback and checkpoint at $checkpoint." >&2
  fi
  echo "Database was not restored; inspect the reported failure and retained checkpoint at $checkpoint." >&2
  if [ "$status" -eq 0 ]; then status=1; fi
  exit "$status"
}
trap rollback EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
ln -sfn "/opt/bolts/releases/$release" /opt/bolts/current.next
mv -Tf /opt/bolts/current.next /opt/bolts/current
systemctl restart bolts.service
healthy=false
for attempt in $(seq 1 30); do
  if verify_health >/dev/null 2>&1; then healthy=true; break; fi
  sleep 1
done
test "$healthy" = true
verify_protected_files
python3 - "$checkpoint/bolts.sqlite" <<'BOLTS_DATABASE'
import sqlite3,sys
from contextlib import closing
with closing(sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)) as before, closing(sqlite3.connect('file:/var/lib/bolts/bolts.sqlite?mode=ro',uri=True,timeout=30)) as after:
    after.execute('PRAGMA query_only=ON')
    assert after.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
    assert not after.execute('PRAGMA foreign_key_check').fetchall()
    assert after.execute('SELECT count(*) FROM schema_migrations WHERE version=5').fetchone()[0]==1
    for table in ['visitors','visitor_activity','visitor_networks','single_player_events']:
        assert after.execute("SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?",[table]).fetchone()[0]==1
    for player,credential in before.execute('SELECT id,credential_hash FROM players WHERE is_bot=0'):
        assert after.execute('SELECT credential_hash FROM players WHERE id=?',[player]).fetchone()==(credential,), 'Existing identity changed'
    for table in ['players','connections','lobbies','matches','memberships','match_players','events','combat_events','leaderboard_names','leaderboard_events','visitors','visitor_activity']:
        assert after.execute('SELECT count(*) FROM '+table).fetchone()[0]>=before.execute('SELECT count(*) FROM '+table).fetchone()[0], 'Existing records removed'
BOLTS_DATABASE
systemctl start bolts-backup.service
test "$(systemctl show bolts-backup.service --property=Result --value)" = success
systemctl is-active --quiet bolts-backup.timer
verify_protected_files
trap - EXIT HUP INT TERM
echo "Telemetry release healthy; configuration unchanged; pre-migration checkpoint retained at $checkpoint."
