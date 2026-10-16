# Bolts multiplayer operations

One Rust process owns every online lobby, player and combat decision. The TypeScript client remains a static web app. **Single player** runs the local AI simulation without a multiplayer connection. The main menu can fetch the public online count and leaderboard; feedback is submitted only on request.

The complete game and its assets are hosted at **https://play-bolts.github.io/**. Multiplayer uses **https://bolts-api.christopherkrapu.com** and its corresponding WSS endpoint. GitHub Pages serves the frontend; the existing Oregon AWS server handles the API, lobbies and persistence.

## Local development and verification

Use Rust with Cargo and Node 22.13 or newer. From the repository root:

```sh
cargo build --locked --manifest-path server/Cargo.toml
BOLTS_DB=server/data/bolts.sqlite cargo run --locked --manifest-path server/Cargo.toml
```

In a second terminal:

```sh
npm ci
VITE_MULTIPLAYER_URL=http://127.0.0.1:8080 npm run dev
```

Open `http://127.0.0.1:5173`. For two independent browser identities, use separate browser profiles or the separately allowed `http://localhost:5173` origin. Two tabs on the same origin share one identity; the newer connection replaces the older one. Team and weapon selection happen before joining, so the player cannot be killed while selecting the initial loadout.

```sh
npm test
npx tsc --noEmit
cargo test --locked --manifest-path server/Cargo.toml
python3 -m unittest discover -s tests -p 'test_origin_config.py'
node --import tsx scripts/test-multiplayer.mjs
node --import tsx scripts/test-spectator-lean.mjs
BOLTS_TEST_URL=http://127.0.0.1:8080 node --import tsx scripts/test-network-adapter.ts
```

`test-multiplayer.mjs` starts an isolated server/database by default and checks seven users, capacity allocation, room isolation, real movement and headshots, rate/sequence limits, reconnect, expiry and persisted event relationships. `test-network-adapter.ts` exercises two actual frontend networking adapters against an already running test server, including prediction, interpolation, ADS, reload, chat and returning to local AI. These scripts create real test identities and events. Setting `BOLTS_TEST_URL` on the first script targets an existing deployment; database inspection and accelerated idle-expiry checks are then omitted.

`test-spectator-lean.mjs` always starts an isolated local server and two real WebSocket clients. It checks spectator admission, rejected combat input, chat, mode transitions without deaths, persisted mode events, and ordinary movement to a wall followed by stable camera-safe lean. Its temporary database is removed afterward.

## Simulation and connection behavior

- The server simulates at **60 Hz** and normally broadcasts snapshots at **20 Hz**. It accepts movement/action intent, never client positions, hit claims, health or scores. Rate limits and monotonic input sequences prevent packet replay from multiplying actions. Input older than 250 ms becomes neutral.
- Clients predict local movement and provisional weapon presentation, then restore authoritative state and replay unacknowledged inputs. Other players interpolate roughly 100 ms behind the latest state. Hits use server-side obstruction/body tests and at most 200 ms of target-history rewind. Killcams use received authoritative snapshots and shot events.
- Each lobby has **six total slots**, including spectators. One or two connected humans receive two AI opponents; at three connected humans the AI leave, and empty rooms have no AI. Reconnecting/arriving humans take priority, and bot fill respects seats reserved during reconnection. Spectators count as humans for this threshold; disconnected reservations do not. Lobby names combine a German general and a Greek letter. Listing rooms maintains available capacity without creating a room on every refresh.
- Online bots use ordinary authoritative movement, ammunition, reload, damage and collision. Their perception samples line of sight and a forward view cone, with reaction delays, correlated aim error, limited memory, navigation and cover choices. They receive no client sockets or authentication credentials. Snapshots mark them with `bot: true`; lobby lists report their count separately from human seats.
- Spectators keep chat and room membership but have no colliding or damageable body. Entering spectator mode clears combat intent without changing kills/deaths; selecting a loadout returns them to a protected combat spawn. Spectator mode persists across reconnects and round restarts, and spectators are excluded from the round winner. Camera following and free movement are local presentation only.
- Lean sweeps a camera-clearance segment against cover and arena walls, preserving a stable partial lean when blocked. Client prediction, rendered eyes, and Rust authority share the same geometry and 0.16 m clearance; leaning changes position without rotating the view.
- Empty rooms close after **five minutes**. A disconnected player keeps their seat for **30 seconds**, with neutralized input; explicit departure releases it immediately. Client reconnection uses bounded backoff. Reconnecting within the grace period retains the actor, score and ammunition.
- Rounds last five minutes and restart after eight seconds. Online menus/chat stop local input while the server continues. A midmatch faction change costs a death and uses normal respawning, preventing free healing/ammunition resets.

The complete HTTP/WebSocket shapes are in [PROTOCOL.md](PROTOCOL.md). Authentication travels in the first WebSocket message rather than a URL parameter. Browser-origin checks, bounded messages and chat limits apply before broadcast. Chat is room-scoped, limited to 256 Unicode characters and three messages per five seconds; the UI renders chat bodies as text.

## Identity and persisted data

The server issues a random UUID plus a separate opaque secret. The browser keeps the secret in origin-scoped local storage; SQLite stores its SHA-256 hash. A UUID or display name alone cannot authenticate. Clearing browser storage creates a new anonymous identity. There is no browser fingerprinting or IP-derived player ID, so an IP change does not change the player's identity.

Connection metadata stores keyed HMAC-SHA256 values for the observed IP and user agent, not their raw values. `BOLTS_IDENTITY_SALT` remains on the server and inside private backup archives. Trusted proxy mode is valid only behind the restricted origin ingress; it must stay off for an unrestricted direct listener.

[Schema](schema.sql) uses foreign keys, WAL mode and `synchronous=FULL`. Timestamps are server-generated UTC epoch milliseconds. UUIDs identify entities and events; `events.seq` provides ordered pagination, while `schema_version` versions each event payload.

| Table | Meaning and relationships |
| --- | --- |
| `players` | Persistent UUID, credential hash, latest display name, indexed canonical `name_key`, first/last seen times and `is_bot` marker. Server-only bot keys reuse bot UUIDs without allowing authentication. |
| `connections` | Socket lifetime, end reason and keyed network metadata; references a player. |
| `lobbies` / `matches` | Room lifetime and successive rounds, including final winner and termination reason. |
| `memberships` | One continuous room visit, actor ID, name/faction at join and leave reason. A partial unique index prevents two active memberships for one identity. |
| `match_players` | Per-round participant names, factions and kills/deaths/shots/hits. |
| `events` | Typed append-only activity with optional room, match, connection, actor and target references, plus versioned JSON detail. |
| `chat_messages` | Chat body and display name at send time; its primary key also references the corresponding chat event. |
| `combat_events` | One kill record linking the killer, victim, weapon/headshot and separate `player_kill` / `player_death` events. |
| `leaderboard_names` | Canonical name primary key, plain display name and transactional all-time kills/deaths; ranking index orders kills, deaths and name. |
| `leaderboard_events` | Combat-time name and timestamp for each human kill/death role, unique per combat/role. Name/time and time/name indexes support rolling 24-hour totals. |
| `feedback_requests` | Private required message, optional email, keyed network pseudonym and submission time. Indexed by network/time for a persistent hourly limit. |
| `feedback_events` | Private append-only submitted event referencing its feedback request; committed with the request and containing no message/email copy. |
| `schema_migrations` | Applied schema version metadata. |

Event types cover server start/stop, player enter/leave/reconnect, profile/loadout changes, chat, kill/death and round end. Chat and its event commit together before broadcast. Kill/death pairs and their combat record commit in one transaction. Membership leave events are idempotent. A persistence failure stops the service instead of continuing matches without their event history.

Leaderboard rows aggregate by the name used at the time of combat. `^0`–`^9` color codes are removed, whitespace is collapsed, and lowercase keys group capitalization variants. The first plain spelling is retained for display. Equal names share a row; a name is not an account or proof of ownership. Renaming starts credit under the new name without moving historical totals. `Unknown Soldier`, blank names and bot rows are omitted. Human kills against bots and deaths to bots count. Self-kills, including faction changes, count as deaths and award no leaderboard kill. Both tables include named players with zero scores; ties sort by fewer deaths, then canonical name. The 24-hour table counts each role within the server's rolling UTC window, not a calendar day.

Schema migration 2 is additive and transactional. It adds bot/name columns and indexes to existing player tables, then backfills scores from existing combat records using ordered join/profile names. If an old combat has no name event, it falls back to its recorded round name and then the preserved player name. It never invents combat records or infers missing kills/deaths from incomplete round totals. A unique combat/role key and migration marker prevent double counting on restart; original UUIDs, credentials and events remain intact.

Feedback accepts 1–2000 trimmed Unicode characters and an optional validated email of at most 254 ASCII bytes. Requests are limited to three attempts per minute and five accepted submissions per hour per keyed network address, with the hourly limit surviving restarts. Browser origins use the same exact allowlist as multiplayer. No public API reads feedback or contact details, and responses return only the request UUID. Authorized operators can inspect these tables through the existing private database/backup path; no email is sent automatically.

Spectator admission is recorded in `player_enter.data.spectator`; later mode changes use `loadout_change` data containing `faction` and `spectator`. These transitions do not create combat records or synthetic deaths, and require no database schema migration.

Database rows currently have **no automatic expiry**. The S3 backup lifecycle is separate: expiring a backup does not delete live chat or event rows. Establish an application-data retention policy before adding a purge job; preserve or delete related rows transactionally rather than orphaning event, chat and combat references.

## Configuration

| Variable | Default / purpose |
| --- | --- |
| `BOLTS_BIND` | `127.0.0.1:8080`; AWS uses port 8080 behind private origin ingress. |
| `BOLTS_DB` | `data/bolts.sqlite`, relative to the process working directory. |
| `BOLTS_ORIGINS` | Production: `https://play-bolts.github.io,http://127.0.0.1:5173,http://localhost:5173`. Rust local defaults allow the two loopback origins. HTTP CORS and WebSocket upgrades use the same exact allowlist. |
| `BOLTS_IDENTITY_SALT` | Required stable secret of at least 32 characters for a non-loopback listener. Local loopback runs can generate an ephemeral salt. |
| `BOLTS_TRUST_PROXY` | `false`; deployed private CloudFront origin sets `true`. |
| `BOLTS_EMPTY_SECONDS` | `300`. |
| `BOLTS_RECONNECT_SECONDS` | `30`. |
| `BOLTS_MAX_ROOMS` | `32`. |
| `VITE_MULTIPLAYER_URL` | Frontend build-time HTTPS backend origin; loopback HTTP is accepted for development. It is public configuration, not a secret. |

The room cap permits at most 192 seated players, with a separate 256-connection guard. Those are admission limits, **not measured production capacity**. Tests exercise multiple real users and protocol correctness, not sustained full-capacity load, adverse mobile networks or regional failover. Monitor CPU, tick behavior, memory, bandwidth and database growth before increasing limits.

## AWS deployment

The [CloudFormation template](../infra/backend.template.json) places one `t3.small` server in **us-west-2a (Oregon)**. CloudFront provides the HTTPS/WSS endpoint and reaches port 8080 through a private VPC origin with caching disabled. The deployment narrows origin ingress to CloudFront's service security group. Administration and releases use Systems Manager, with no SSH ingress. The instance's public address supports outbound setup/management; it is not the game endpoint.

The encrypted 30 GiB gp3 root volume has `DeleteOnTermination=false`. The private, encrypted, versioned S3 bucket is retained on stack deletion/replacement. Source releases expire after 90 days. Current backup versions expire after 30 days; noncurrent versions expire 30 days after becoming noncurrent, so versioned backups can remain for approximately 60 days. Retained resources continue to incur storage charges until explicitly removed.

The deployment helper uses the existing laptop AWS credential chain through `scripts/aws-command.py`; it never puts credentials into the source archive. Its default mode only prepares a manifest, allowlisted release archive and rendered template in ignored `infra/.state/`:

```sh
python3 scripts/deploy-backend.py
python3 scripts/deploy-backend.py --apply --stack bolts-backend
```

`--apply` provisions/updates the stack, uploads the release, builds through SSM and verifies local plus public health. `--apply --provision-only` stops after infrastructure creation. The default browser origins are GitHub Pages plus both local development addresses. An explicit `--origins` replaces that exact allowlist. The reviewed VPC, subnet, Oregon AZ and region are pinned in the deployment helper; adapting it for another account requires reviewing those settings. Existing stack AMIs are preserved to avoid an implicit instance replacement.

To apply only the frontend-origin migration on the existing server:

```sh
python3 scripts/deploy-backend.py --origins-only
python3 scripts/deploy-backend.py --apply --origins-only --stack bolts-backend
```

The first command previews the operation locally. The second uses SSM to run [update-origins.py](../infra/update-origins.py), refuses occupied lobbies, atomically changes only `BOLTS_ORIGINS` in `/etc/bolts.env`, and restarts the existing binary. It verifies local health and CORS, then checks public health/CORS; a local startup or origin-check failure restores the previous configuration. The identity salt, database, binary, instance and CloudFront configuration remain unchanged. Origins are read at startup, so a brief service restart is necessary. No Rust rebuild or CloudFormation update occurs. The tracked template and deployment defaults provide the new allowlist for future normal deployments; the existing stack's stored parameter is unchanged by this runtime-only operation. Its SSM command ID is recorded in `infra/.state/last-origins-command.json`.

The custom backend domain is configured separately, without rebuilding or restarting the server:

```sh
python3 scripts/deploy-backend.py --apply --domain-only --custom-domain bolts-api.christopherkrapu.com
```

This creates or reuses `bolts-backend-edge-certificate` in **us-east-1**, using [edge-certificate.template.json](../infra/edge-certificate.template.json), then passes its issued ACM certificate ARN to the Oregon stack. [CloudFront requires viewer certificates in us-east-1](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cnames-and-https-requirements.html). CloudFormation manages DNS validation in the existing public zone `Z00983602PMUH0CDXDTFC`; the backend stack manages only the exact subdomain's A/AAAA aliases. The distribution uses SNI and `TLSv1.2_2021`. The deployment helper verifies public NS delegation, checks DNS conflicts, preserves existing stack parameters, and rejects change sets that modify anything beyond the alias/certificate and those two records. Keep the ACM validation CNAME for automatic certificate renewal. The retained certificate must be detached before any later explicit deletion.

Domain deployment records its reviewed change set and outputs in `infra/.state/domain-change-set.json` and `domain-outputs.json`. Standard subsequent deployments preserve the custom-domain parameters. The generated CloudFront hostname remains available.

Successful provisioning writes `infra/.state/outputs.json` with `InstanceId`, `StorageBucket`, `SecurityGroupId`, `DistributionId`, `VpcOriginId`, `BackendUrl`, `AvailabilityZone` and `IngressMode`. `last-command.json` identifies the last SSM release command. If a command times out while AWS is still working, inspect those resources before retrying instead of starting another deployment blindly.

Release installation compiles the locked Rust dependency set with Rust 1.99.0 on the instance, stages a versioned binary, takes a database checkpoint backup, atomically changes `/opt/bolts/current`, restarts `bolts.service` and checks health. Failed health checks restore the previous binary when one exists. The root-readable `/etc/bolts.env` holds configuration; releases preserve the identity salt. Backward-incompatible database changes require an explicit migration/restore plan; binary rollback alone is not a schema rollback.

Build the complete static frontend for GitHub Pages with the deployed backend origin, and publish the contents of `dist/`, including game assets:

```sh
VITE_MULTIPLAYER_URL=https://bolts-api.christopherkrapu.com npm run build
```

The build's public base path is `/` for `play-bolts.github.io`. See the repository [README](../README.md) for the GitHub Pages publication workflow. A browser identity belongs to the frontend origin's local storage, so moving hosts creates a fresh anonymous browser identity unless the user explicitly migrates its credential; no credential transfer is automatic.

Do not place AWS credentials, bearer tokens or the identity salt in Vite variables, source files or deployment command output.

## Service checks, backups and recovery

Use an authorized SSM session for host operations:

```sh
sudo systemctl status bolts.service bolts-backup.timer
sudo journalctl -u bolts.service -n 100 --no-pager
curl --fail http://127.0.0.1:8080/api/health
sudo systemctl start bolts-backup.service
sudo journalctl -u bolts-backup.service -n 20 --no-pager
```

`/api/health` returns `{ "ok": true, "version": 1 }` when the process and persistence path are healthy. The systemd service runs as a restricted `bolts` account and restarts on failure. Also check free disk space and actual S3 backup timestamps; a scheduled timer alone does not prove a successful backup.

The hourly backup timer adds up to two minutes of jitter. [backup.py](../infra/backup.py) uses SQLite's online-backup API, verifies the result with `quick_check`, and uploads a private encrypted archive. Each archive contains `bolts.sqlite` and `restore.json`; the latter carries the identity salt so restored network pseudonyms remain consistent. Do not copy just the live main SQLite file while WAL writers are running.

A server restart disconnects every match: this is a single-server deployment without seamless failover. Live positions, lobbies and round progress exist in memory and are not restored. On startup, recovery closes previously open connections, memberships, matches and rooms, recording outstanding player departures with reason `server_restart`. UUIDs, credentials and completed event history remain in SQLite. Clients may reconnect automatically, but an expired/restarted room requires joining a new lobby.

For a lost/replaced instance, either attach the retained encrypted volume in the same AZ and recover `/var/lib/bolts/bolts.sqlite` with its WAL plus `/etc/bolts.env`, or restore a verified S3 backup. Stop the new game service and backup timer before replacing data, preserve its previous files for rollback, restore the database and original identity salt with restrictive ownership/permissions, run SQLite integrity/foreign-key checks, then restart and verify both local and public health. Never merge two live database files. An S3 restore can lose events since the last successful backup; a retained-volume recovery can recover more recent WAL commits. Test recovery before relying on either path.
