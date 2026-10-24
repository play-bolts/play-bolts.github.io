#!/bin/bash
set -euo pipefail
# GameLift runs this installer as a limited user; extracted binaries are owned
# by the service account. Fail instead of prompting if privilege is unavailable.
sudo -n chmod 0755 /local/game/bolts-server /local/game/bolts-host
# Each process creates its own mode-0700 directory below this shared log root.
sudo -n install -d -m 1777 /local/game/sessionlogs
