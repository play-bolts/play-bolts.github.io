#!/bin/bash
set -euo pipefail
chmod 0755 /local/game/bolts-server /local/game/bolts-host
# Each process creates its own mode-0700 directory below this shared log root.
install -d -m 1777 /local/game/sessionlogs
