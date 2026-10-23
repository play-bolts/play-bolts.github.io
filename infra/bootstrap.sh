#!/bin/bash
# CloudFormation Fn::Sub expands only the explicitly named template parameters.
set -euo pipefail
umask 077
dnf install -y gcc gcc-c++ make tar gzip sqlite python3 curl-minimal awscli-2
systemctl enable --now amazon-ssm-agent
id bolts >/dev/null 2>&1 || useradd --system --home-dir /var/lib/bolts --shell /sbin/nologin bolts
id bolts-build >/dev/null 2>&1 || useradd --system --home-dir /opt/bolts-build --shell /sbin/nologin bolts-build
install -d -m 0755 -o root -g root /opt/bolts /opt/bolts/releases
install -d -m 0700 -o bolts -g bolts /var/lib/bolts /var/lib/bolts-backup
install -d -m 0700 -o bolts-build -g bolts-build /opt/bolts-build
if [ ! -f /etc/bolts.env ]; then
  cat > /etc/bolts.env <<'BOLTS_CONFIG'
BOLTS_BIND=0.0.0.0:8080
BOLTS_DB=/var/lib/bolts/bolts.sqlite
BOLTS_ORIGINS=${AllowedOrigins}
BOLTS_TRUST_PROXY=true
BOLTS_EMPTY_SECONDS=300
BOLTS_RECONNECT_SECONDS=30
BOLTS_MAX_ROOMS=11
RUST_LOG=bolts_server=info,tower_http=warn
AWS_DEFAULT_REGION=${AWS::Region}
BOLTS_BACKUP_BUCKET=${StorageBucket}
BOLTS_BACKUP_PREFIX=backups/${AWS::StackName}
BOLTS_CONFIG
  python3 - <<'PY'
import secrets
with open('/etc/bolts.env', 'a') as config:
    config.write('BOLTS_IDENTITY_SALT=' + secrets.token_hex(32) + '\n')
PY
  chmod 0600 /etc/bolts.env
fi
# Rust's release linker can briefly exceed 2 GiB. Swap remains encrypted on EBS.
if [ ! -f /swapfile ]; then
  dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 0600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
touch /var/lib/bolts-bootstrap.ready
