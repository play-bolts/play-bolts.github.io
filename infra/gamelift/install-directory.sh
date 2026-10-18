#!/bin/bash
# Run as root via the existing private SSM release path after checksum validation.
# Arguments: release SHA256, unpacked Linux bundle, finalized directory host.json,
# optional expected-current release SHA256.
set -euo pipefail
umask 077
test "$#" -eq 3 -o "$#" -eq 4
release=$1
bundle=$2
config=$3
expected_release=${4:-}
[[ "$release" =~ ^[a-f0-9]{64}$ ]]
[[ -z "$expected_release" || "$expected_release" =~ ^[a-f0-9]{64}$ ]]
exec 9>/var/lock/bolts-release.lock
flock -n 9 || { echo 'Another Bolts release is in progress.' >&2; exit 1; }
previous=$(readlink /opt/bolts/current)
verify_current_release() {
  if [ "$(readlink /opt/bolts/current)" != "$previous" ] || { [ -n "$expected_release" ] && [ "$previous" != "/opt/bolts/releases/$expected_release" ]; }; then
    echo 'Current release changed; leaving the running service untouched.' >&2
    exit 1
  fi
}
verify_current_release
test -f /var/lib/bolts-bootstrap.ready
test -x "$bundle/bolts-host"
test -x "$bundle/bolts-server"
"$bundle/bolts-host" --mode=directory --config="$config" --check-config
# Drain first: the initial cutover replaces the old process's gameplay sockets;
# a later fleet switch must not hide active sessions on the previous fleet.
verify_empty_lobbies() {
 curl --fail --silent --show-error --max-time 10 http://127.0.0.1:8080/api/lobbies | python3 -c '
import json,sys
rooms=json.load(sys.stdin).get("lobbies")
if not isinstance(rooms,list) or any(not isinstance(r.get("players"),int) or r["players"] != 0 for r in rooms):
    raise SystemExit("Cutover deferred: a human seat is occupied.")
'
}
verify_empty_lobbies
systemctl start bolts-backup.service
# Backup can take time: do not disconnect players who joined while it ran.
verify_empty_lobbies
verify_current_release
checkpoint=$(mktemp -d /var/lib/bolts/gamelift-cutover.XXXXXX)
dropin=/etc/systemd/system/bolts.service.d/gamelift.conf
if [ -f "$dropin" ]; then cp "$dropin" "$checkpoint/gamelift.conf"; fi
if [ -f /etc/bolts-gamelift.json ]; then cp /etc/bolts-gamelift.json "$checkpoint/host.json"; fi
install -d -m 0755 "/opt/bolts/releases/$release" /etc/systemd/system/bolts.service.d
install -m 0755 "$bundle/bolts-host" "$bundle/bolts-server" "/opt/bolts/releases/$release/"
install -m 0644 "$config" /etc/bolts-gamelift.json
cat > "$dropin" <<'UNIT'
[Service]
ExecStart=
ExecStart=/opt/bolts/current/bolts-host --mode=directory --config=/etc/bolts-gamelift.json
IPAddressDeny=
KillMode=mixed
TimeoutStopSec=45
Restart=always
UNIT
ln -sfn "/opt/bolts/releases/$release" /opt/bolts/current.next
mv -Tf /opt/bolts/current.next /opt/bolts/current
healthy=false
if systemctl daemon-reload && systemctl restart bolts.service; then
for attempt in $(seq 1 30); do
  if curl --fail --silent --max-time 3 http://127.0.0.1:8080/api/lobbies | python3 -c '
import json,sys
with open(sys.argv[1]) as source:
    config=json.load(source)
    # Legacy release configs predate the flag; new generated configs always set it.
    expected={location["id"] for location in config["locations"]} if config.get("extraLobbiesEnabled", True) is True else set()
data=json.load(sys.stdin)
assert data.get("version")==2
assert set(data["locations"])==expected
assert isinstance(data["lobbies"],list)
assert all((r.get("location") in expected if r.get("managed") else r.get("location")=="or") and not r["id"].startswith("new:") for r in data["lobbies"])
' "$config" 2>/dev/null; then healthy=true; break; fi
  sleep 1
done
fi
if [ "$healthy" != true ]; then
  systemctl stop bolts.service
  if [ -f "$checkpoint/gamelift.conf" ]; then cp "$checkpoint/gamelift.conf" "$dropin"; else rm -f "$dropin"; fi
  if [ -f "$checkpoint/host.json" ]; then cp "$checkpoint/host.json" /etc/bolts-gamelift.json; else rm -f /etc/bolts-gamelift.json; fi
  ln -sfn "$previous" /opt/bolts/current.next
  mv -Tf /opt/bolts/current.next /opt/bolts/current
  systemctl daemon-reload
  systemctl restart bolts.service
  echo 'Directory failed health checks; previous binaries and service configuration restored.' >&2
  exit 1
fi
systemctl start bolts-backup.service
echo 'Global directory healthy; regional gameplay still requires fleet smoke verification.'
