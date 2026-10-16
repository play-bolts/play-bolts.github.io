# Deployed backend

Verified on 2026-10-16. Endpoint: **https://bolts-api.christopherkrapu.com**

Application release `4cfe8f0052a101d7fe41b2edba2aa0ebe6abb5c085a72a09f4fca9a172e68286` adds anonymous visitor tracking (`6a20ae7`). It was installed on the existing Oregon server after empty-lobby checks and a guard against concurrent deployment changes; no infrastructure was provisioned. Backup and health checks passed. Read-only verification confirmed migrations 1–3, SQLite integrity `ok`, zero foreign-key violations, preserved game records and all three leaderboard seed rows. Repeated live requests produced one visitor and one minute bucket; the reporting script excluded the known QA identity correctly. Visitor records contain only a random UUID and server receipt times, independent of multiplayer accounts. Counts begin at rollout and include menus and local-only play; see [analytics and privacy](../research/user-analytics.md).

Previous application release `826b677833a77551e50ab522af8a5d28ff9f7c7d57ac4065e5bfc7b6c3bfc9e2` adds server-controlled lobby AI, online counts, private feedback storage, and name-indexed leaderboards. It was deployed to the existing instance without CloudFormation changes after verifying empty human seats; the installer rechecks occupancy after compilation before replacing the running service. Both database backups completed successfully. Read-only production verification confirmed schema migrations 1 and 2, SQLite integrity `ok`, zero foreign-key violations, and healthy application/backup services. The community endpoints accept the GitHub Pages origin and reject lookalike origins. Backend verification evidence is saved locally in `artifacts/community-backend-verification.json` (ignored by Git).

Frontend hosting: **https://play-bolts.github.io/**. The live production origin allowlist contains this exact origin plus `http://127.0.0.1:5173` and `http://localhost:5173`. The origin-only update completed on 2026-10-15 with empty lobbies, preserving the existing binary, database, and AWS infrastructure. All 21 public HTTP, CORS preflight, and WebSocket origin checks passed: GitHub Pages and local development origins are accepted; the retired hosting origin and lookalike origins are rejected. No players joined during verification. Future origin-only updates follow [server/README.md](../server/README.md).

The generated endpoint remains available at https://d34rt6eezr7e5v.cloudfront.net.

| Resource | Identifier |
| --- | --- |
| CloudFormation stack | `bolts-backend` |
| Region / availability zone | `us-west-2` / `us-west-2a` |
| EC2 instance | `i-0bd1adb3fc8b01688` |
| Instance type / CPU credits | `t3.small` / standard |
| CloudFront distribution | `E1MT909KTPVXKW` |
| Certificate stack / region | `bolts-backend-edge-certificate` / `us-east-1` |
| ACM viewer certificate | `arn:aws:acm:us-east-1:780705957578:certificate/cf813415-f0d5-4d9b-9bbd-5b4441dabb4f` |
| Public DNS hosted zone | `Z00983602PMUH0CDXDTFC` |
| Retained encrypted root volume | `vol-0c9e99229c420acfb` |
| Private backup / release bucket | `bolts-backend-storagebucket-knjq5mfjcxi7` |

HTTPS and WebSockets reach the single Rust server through a CloudFront VPC origin. The instance accepts application traffic only from the CloudFront VPC origin service security group; administration uses SSM, with no SSH ingress. The earlier failed deployment's resources were removed.

The custom hostname uses a DNS-validated ACM certificate, SNI, and CloudFront's `TLSv1.2_2021` policy. The certificate stack manages its validation CNAME; the Oregon backend stack manages the exact `bolts-api.christopherkrapu.com` A/AAAA aliases. The domain-only change set modified only the distribution and added those two aliases, with no replacements or application restart. The zone's public NS delegation was checked against its Route 53 nameservers. Other DNS names remain unchanged.

The live service passed 17 multiplayer protocol checks and a two-browser-client adapter test. Browser verification also covered the automatic round restart.

The hourly backup service was run successfully through SSM. Backup `backups/bolts-backend/20261014T070510.628381Z.tar.gz` was downloaded to a private temporary directory and restored independently. Verification confirmed AES256 encryption, an exact two-file archive allowlist (`bolts.sqlite`, `restore.json`), a present identity salt without exposing it, SQLite integrity `ok`, and zero foreign key violations. The restored database contained 9 players, 11 connections, 11 memberships, 30 events, 3 chat messages, and 1 combat record with correctly linked kill and death events. All temporary recovery files were removed.

Current backup versions expire after 30 days; noncurrent versions expire 30 days after becoming noncurrent, so versioned objects can remain for approximately 60 days. The bucket and root volume are retained if the stack is deleted. Recovery instructions and operational limits are in [server/README.md](../server/README.md).
