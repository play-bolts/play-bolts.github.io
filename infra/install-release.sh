#!/bin/bash
# Invoked as root through SSM after source checksum verification and extraction.
set -euo pipefail
umask 077
release=$1
source_dir=$2
origins=$3
case "$release" in (*[!a-f0-9]*|'') echo 'Invalid release identifier' >&2; exit 2;; esac
test "$#" -eq 3
test -f "$source_dir/server/Cargo.lock"
test -f /var/lib/bolts-bootstrap.ready

build_home=/opt/bolts-build
if [ ! -x "$build_home/.cargo/bin/rustc" ]; then
  curl --proto '=https' --tlsv1.2 --fail --silent --show-error https://sh.rustup.rs -o "$build_home/rustup-init.sh"
  chown bolts-build:bolts-build "$build_home/rustup-init.sh"
  runuser -u bolts-build -- env CARGO_HOME="$build_home/.cargo" RUSTUP_HOME="$build_home/.rustup" \
    sh "$build_home/rustup-init.sh" -y --profile minimal --default-toolchain 1.99.0 --no-modify-path
fi
chown -R bolts-build:bolts-build "$source_dir"
# Source archives normalize mtimes for reproducible hashes. A shared target can
# otherwise consider changed crate sources older than its cached artifacts.
# Rebuild our package explicitly while retaining compiled dependency artifacts.
runuser -u bolts-build -- env CARGO_HOME="$build_home/.cargo" RUSTUP_HOME="$build_home/.rustup" \
  CARGO_TARGET_DIR="$build_home/target" \
  "$build_home/.cargo/bin/cargo" +1.99.0 clean --release --locked --package bolts-server --manifest-path "$source_dir/server/Cargo.toml"
runuser -u bolts-build -- env CARGO_HOME="$build_home/.cargo" RUSTUP_HOME="$build_home/.rustup" \
  CARGO_TARGET_DIR="$build_home/target" CARGO_BUILD_JOBS=1 \
  "$build_home/.cargo/bin/cargo" +1.99.0 build --release --locked --manifest-path "$source_dir/server/Cargo.toml"

# Building can take several minutes. Recheck the running service immediately
# before installation so players who arrived during compilation are not kicked.
if systemctl is-active --quiet bolts.service; then
  curl --fail --silent --show-error --max-time 10 http://127.0.0.1:8080/api/lobbies | python3 -c '
import json, sys
data = json.load(sys.stdin)
rooms = data.get("lobbies")
if not isinstance(rooms, list) or any(not isinstance(room.get("players"), int) or room["players"] != 0 for room in rooms):
    raise SystemExit("Release deferred: a human seat is occupied; current service is unchanged.")
'
fi

install -d -m 0755 -o root -g root "/opt/bolts/releases/$release" /usr/local/libexec
install -m 0755 -o root -g root "$build_home/target/release/bolts-server" "/opt/bolts/releases/$release/bolts-server"
install -m 0755 -o root -g root "$source_dir/infra/backup.py" /usr/local/libexec/bolts-backup
install -m 0644 -o root -g root "$source_dir/infra/bolts.service" /etc/systemd/system/bolts.service
install -m 0644 -o root -g root "$source_dir/infra/bolts-backup.service" /etc/systemd/system/bolts-backup.service
install -m 0644 -o root -g root "$source_dir/infra/bolts-backup.timer" /etc/systemd/system/bolts-backup.timer
# Configuration updates preserve the original salt; it is never sent over SSM.
python3 - "$origins" <<'PY'
from pathlib import Path
import os, re, sys, tempfile
origins = sys.argv[1]
if not re.fullmatch(r'[A-Za-z0-9:/.,_-]+', origins):
    raise SystemExit('Invalid origin allowlist')
path = Path('/etc/bolts.env')
lines = path.read_text().splitlines()
data = '\n'.join('BOLTS_ORIGINS=' + origins if line.startswith('BOLTS_ORIGINS=') else line for line in lines) + '\n'
descriptor, temporary = tempfile.mkstemp(prefix='.bolts-env-', dir=path.parent)
try:
    os.fchmod(descriptor, 0o600)
    with os.fdopen(descriptor, 'w') as output:
        output.write(data)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
PY
systemctl daemon-reload
systemctl enable bolts.service bolts-backup.timer >/dev/null
# A rollback checkpoint is taken before replacing a running binary.
if [ -f /var/lib/bolts/bolts.sqlite ]; then systemctl start bolts-backup.service; fi
previous=$(readlink /opt/bolts/current || true)
ln -sfn "/opt/bolts/releases/$release" /opt/bolts/current.next
mv -Tf /opt/bolts/current.next /opt/bolts/current
systemctl restart bolts.service
healthy=false
for attempt in $(seq 1 30); do
  if curl --fail --silent --max-time 2 http://127.0.0.1:8080/api/health | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get("ok") is True and d.get("version")==1 else 1)' 2>/dev/null; then
    healthy=true
    break
  fi
  sleep 1
done
if [ "$healthy" != true ]; then
  systemctl stop bolts.service || true
  if [ -n "$previous" ]; then
    ln -sfn "$previous" /opt/bolts/current.next
    mv -Tf /opt/bolts/current.next /opt/bolts/current
    systemctl restart bolts.service
    echo 'New release failed health checks; restored previous binary.' >&2
  else
    echo 'First release failed health checks; service remains stopped.' >&2
  fi
  exit 1
fi
systemctl start bolts-backup.timer
systemctl start bolts-backup.service
printf 'Bolts release %s is healthy.\n' "$release"
