#!/bin/bash
# Run as root via the existing private SSM release path after checksum validation.
# Arguments: release SHA256, unpacked Linux bundle, finalized directory host.json,
# optional expected-current release SHA256, optional private runtime-env update.
set -euo pipefail
umask 077
test "$#" -ge 3 -a "$#" -le 5
release=$1
bundle=$2
config=$3
expected_release=${4:-}
runtime_env=${5:-}
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
# Keep secrets in private files throughout validation, staging and rollback.
# The update contains exactly the two reviewed settings; all other environment
# bytes (including the identity salt) are retained unchanged.
runtime_environment() {
 python3 - "$@" <<'BOLTS_RUNTIME_ENV'
import json, os, re, stat, sys, tempfile, urllib.request
from pathlib import Path

def private_bytes(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077 or info.st_size > 65536:
            raise ValueError('Expected a private regular environment file')
        data = source.read(65537)
        if len(data) > 65536:
            raise ValueError('Environment file is too large')
        return data

def settings(path):
    result = {}
    for line in private_bytes(path).decode('ascii').splitlines():
        if not line or line.startswith('#'):
            continue
        name, separator, value = line.partition('=')
        if not separator or name not in ('BOLTS_ADMIN_API_KEY', 'BOLTS_MAX_ROOMS') or name in result:
            raise ValueError('Invalid runtime environment settings')
        result[name] = value
    key = result.get('BOLTS_ADMIN_API_KEY', '')
    if not 32 <= len(key) <= 128 or any(not 33 <= ord(c) <= 126 for c in key) or result.get('BOLTS_MAX_ROOMS') != '11':
        raise ValueError('Invalid runtime environment settings')
    return {'BOLTS_ADMIN_API_KEY': key, 'BOLTS_MAX_ROOMS': '11'}

def environment_value(value):
    # EnvironmentFile interprets quotes/backslashes, but does not expand $.
    # Hex keys remain unquoted for compatibility with existing operator tools.
    if re.fullmatch(r'[A-Za-z0-9_./:+@%=-]+', value):
        return value
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"') + '"'

def atomic_write(path, data):
    path = Path(path)
    descriptor, temporary = tempfile.mkstemp(prefix='.bolts-env-', dir=path.parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, 'wb') as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

try:
    operation = sys.argv[1]
    if operation == 'validate':
        settings(sys.argv[2])
    elif operation == 'prepare':
        updates = settings(sys.argv[2])
        original = private_bytes(sys.argv[3])
        preserved = b''.join(line for line in original.splitlines(keepends=True)
                             if line.split(b'=', 1)[0].strip() not in {name.encode() for name in updates})
        if preserved and not preserved.endswith(b'\n'):
            preserved += b'\n'
        data = preserved + ''.join(name + '=' + environment_value(value) + '\n' for name, value in updates.items()).encode('ascii')
        atomic_write(Path(sys.argv[4]) / 'bolts.env', original)
        atomic_write(Path(sys.argv[4]) / 'bolts.env.next', data)
    elif operation == 'replace':
        atomic_write(sys.argv[3], private_bytes(sys.argv[2]))
    elif operation == 'verify':
        key = settings(sys.argv[2])['BOLTS_ADMIN_API_KEY']
        headers = {'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'}
        for route, payload in (('/api/admin/status?minutes=1', None),
                               ('/api/admin/query', json.dumps({'sql': 'SELECT 1', 'maxRows': 1}).encode())):
            request = urllib.request.Request('http://127.0.0.1:8080' + route, data=payload, headers=headers)
            with urllib.request.urlopen(request, timeout=3) as response:
                if response.status != 200 or response.headers.get('Cache-Control') != 'no-store':
                    raise ValueError('Admin health check failed')
                result = json.load(response)
            if (payload is None and result.get('minutes') != 1) or (payload is not None and result.get('rows') != [[1]]):
                raise ValueError('Admin health check failed')
    else:
        raise ValueError('Invalid environment operation')
except (OSError, ValueError, UnicodeError):
    # Do not include exception details: malformed input may contain the key.
    raise SystemExit('Private runtime environment validation/update failed.')
BOLTS_RUNTIME_ENV
}
if [ -n "$runtime_env" ]; then runtime_environment validate "$runtime_env"; fi
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
if [ -n "$runtime_env" ]; then
  runtime_environment prepare "$runtime_env" /etc/bolts.env "$checkpoint"
fi
rollback_release() {
  result=$?
  trap - EXIT
  if [ "$result" -ne 0 ]; then
    # Handle setup errors as well as failed restarts/health checks. In
    # particular, never leave a new key or capacity setting after rollback.
    set +e
    systemctl stop bolts.service
    restored=true
    if [ -f "$checkpoint/gamelift.conf" ]; then cp "$checkpoint/gamelift.conf" "$dropin" || restored=false; else rm -f "$dropin" || restored=false; fi
    if [ -f "$checkpoint/host.json" ]; then cp "$checkpoint/host.json" /etc/bolts-gamelift.json || restored=false; else rm -f /etc/bolts-gamelift.json || restored=false; fi
    if [ -n "$runtime_env" ]; then
      runtime_environment replace "$checkpoint/bolts.env" /etc/bolts.env || restored=false
    fi
    ln -sfn "$previous" /opt/bolts/current.next && mv -Tf /opt/bolts/current.next /opt/bolts/current || restored=false
    systemctl daemon-reload || restored=false
    if [ "$restored" = true ] && systemctl restart bolts.service; then
      echo 'Directory release failed; previous binaries and service configuration restored.' >&2
    else
      echo 'Directory release failed; rollback needs operator attention. Service left stopped.' >&2
      systemctl stop bolts.service
    fi
  fi
  exit "$result"
}
trap rollback_release EXIT
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
if [ -n "$runtime_env" ]; then
  runtime_environment replace "$checkpoint/bolts.env.next" /etc/bolts.env
fi
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
' "$config" 2>/dev/null; then
    if [ -n "$runtime_env" ] && ! runtime_environment verify "$runtime_env"; then
      sleep 1
      continue
    fi
    healthy=true
    break
  fi
  sleep 1
done
fi
if [ "$healthy" != true ]; then
  exit 1
fi
systemctl start bolts-backup.service
trap - EXIT
echo 'Global directory healthy; regional gameplay still requires fleet smoke verification.'
