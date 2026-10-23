#!/bin/bash
# Application-only cutover. Invoked from the checksum-verified release archive.
# Arguments: release SHA256, bundle directory, host.json, expected live release.
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
import json,sys
from pathlib import Path
current=json.loads(Path('/etc/bolts-gamelift.json').read_text())
assert current == json.loads(Path(sys.argv[1]).read_text()), 'Hosting configuration changed'
assert current.get('extraLobbiesEnabled') is False, 'Regional hosting must remain disabled'
BOLTS_CONFIG
verify_empty_lobbies() {
  curl --fail --silent --show-error --max-time 10 http://127.0.0.1:8080/api/lobbies | python3 -c '
import json,sys
rooms=json.load(sys.stdin).get("lobbies")
if not isinstance(rooms,list) or not rooms or any(type(r.get("players")) is not int or r["players"] != 0 for r in rooms):
    raise SystemExit("Cutover deferred: a human seat is occupied.")
'
}
verify_empty_lobbies
systemctl start bolts-backup.service
verify_empty_lobbies
verify_current_release
checkpoint=$(mktemp -d /var/lib/bolts/three-deathmatches.XXXXXX)
cp -p /etc/bolts.env "$checkpoint/bolts.env"
cp -p /etc/bolts.env "$checkpoint/next.env"
python3 - "$checkpoint/next.env" <<'BOLTS_ENV'
import re,sys
from pathlib import Path
path=Path(sys.argv[1])
data=path.read_bytes()
pattern=rb'(?m)^BOLTS_MAX_ROOMS=[^\r\n]*$'
assert re.findall(pattern,data)==[b'BOLTS_MAX_ROOMS=11'], 'Expected exactly one room cap of 11'
path.write_bytes(re.sub(pattern,b'BOLTS_MAX_ROOMS=6',data))
BOLTS_ENV
install -d -m 0755 "/opt/bolts/releases/$release"
install -m 0755 "$bundle/bolts-host" "$bundle/bolts-server" "/opt/bolts/releases/$release/"
verify_empty_lobbies
verify_current_release
cmp /etc/bolts.env "$checkpoint/bolts.env"
# From the first running-configuration write onward, every failed command and
# termination signal restores the complete previous environment and release.
rollback() {
  local status=$?
  trap - EXIT HUP INT TERM
  set +e
  systemctl stop bolts.service
  local restored=true
  cp -p "$checkpoint/bolts.env" /etc/bolts.env || restored=false
  ln -sfn "$previous" /opt/bolts/current.next || restored=false
  mv -Tf /opt/bolts/current.next /opt/bolts/current || restored=false
  systemctl restart bolts.service || restored=false
  if [ "$restored" = true ]; then
    echo 'Cutover failed; previous environment and binaries restored.' >&2
  else
    echo "Cutover failed; rollback needs inspection at $checkpoint." >&2
  fi
  if [ "$status" -eq 0 ]; then status=1; fi
  exit "$status"
}
trap rollback EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
cp -p "$checkpoint/next.env" /etc/bolts.env
ln -sfn "/opt/bolts/releases/$release" /opt/bolts/current.next
mv -Tf /opt/bolts/current.next /opt/bolts/current
systemctl restart bolts.service
healthy=false
for attempt in $(seq 1 30); do
  if curl --fail --silent --max-time 3 http://127.0.0.1:8080/api/lobbies | python3 -c '
import json,sys
data=json.load(sys.stdin)
expected=[("Deathmatch 1",6),("Deathmatch 2",6),("Deathmatch 3",6),("1v1 Alpha",2),("1v1 Beta",2),("1v1 Delta",2)]
assert data.get("version")==2 and data.get("locations")==[]
rooms=data["lobbies"]
assert [(r.get("name"),r.get("capacity")) for r in rooms]==expected
assert all(r.get("location")=="or" and r.get("managed") is False for r in rooms)
' 2>/dev/null; then healthy=true; break; fi
  sleep 1
done
test "$healthy" = true
systemctl start bolts-backup.service
trap - EXIT HUP INT TERM
echo 'Six local rooms healthy; previous environment retained in the private host checkpoint.'
