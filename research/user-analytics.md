# Visitor and multiplayer analytics

[`scripts/user-analytics.py`](../scripts/user-analytics.py) defaults to **visitor activity**, covering people opening Bolts, staying in the menus, and playing local-only or multiplayer games. It counts the separate browser visitor UUIDs recorded by first-party telemetry. Python 3.9 or later is required; there are no third-party Python packages.

```sh
# Production: visitor identities with recorded activity in the past 24 hours.
python3 scripts/user-analytics.py --aws --hours 24 --json

# Existing local database or a consistent backup; read-only, no AWS access.
python3 scripts/user-analytics.py --db server/data/bolts.sqlite --hours 24

# The explicit form of the default source.
python3 scripts/user-analytics.py --aws --source visitors --hours 6 --json

# The previous multiplayer-only connection metric remains available.
python3 scripts/user-analytics.py --aws --source multiplayer --hours 24 --json

# Reproduce a 90-minute window ending at a specified UTC instant.
python3 scripts/user-analytics.py --aws --hours 1.5 --as-of 2026-10-16T12:00:00Z --json
```

`--as-of` accepts ISO 8601 with an explicit timezone, including offsets such as `-07:00`. It defaults to the current UTC time captured once before querying. Hours must be positive and resolve to whole milliseconds. Future window ends and windows starting before the Unix epoch are rejected.

## Default: visitors

A visitor counts when at least one row in `visitor_activity` has `first_seen <= window_end` and `last_seen > window_start`. This defines `(window_start, window_end]`: a single receipt exactly at the start is excluded, and one exactly at the end is included. Repeated receipts in one minute share one `(visitor_id, bucket_start)` row. Multiple minutes, reloads and tabs using the same stored visitor UUID count once per report. A visitor need not request a multiplayer session or join a lobby.

The frontend sends an initial page-open receipt, roughly one heartbeat per minute while visible, and best-effort final activity on hide/page exit. Server receipt timestamps, not client-provided times, populate the database. Buckets preserve their earliest and latest receipt; the query treats that range as observed activity. Sub-minute boundaries are therefore approximate: a very short window between two receipts in one bucket can count that visitor. It does not infer continuous activity between separate buckets, use the visitor's entire first-to-last lifetime, or treat every historically seen visitor as online.

The `visitors` and `visitor_activity` tables contain UUIDs and timestamps only. The analytics query does not join them to names, multiplayer player IDs, IPs, user agents, bots, combat or leaderboard seeds. Server AI and seeded scores create no visitor records. Browser automation that sends normal telemetry can count; the metric does not claim it can reliably detect every automated visitor.

**Data begins when visitor tracking is deployed.** Earlier page visits and local-only games were not recorded and cannot be reconstructed. No rows or historical counts are backfilled from multiplayer records, leaderboard scores or guesses. When the requested window begins before the first recorded activity, the JSON flags that and the text output warns that earlier visits are unknown. An empty newly deployed table returns zero *recorded* identities and an explicit lack-of-history warning. Missing visitor tables are an error with migration guidance, never a silent zero or automatic fallback to multiplayer.

| Visitor JSON field | Meaning |
| --- | --- |
| `source` | Always `visitors` for this metric. |
| `unique_visitors` | Distinct qualifying visitor UUIDs after explicit exclusions. |
| `activity_buckets` | Qualifying visitor-minute rows after exclusions, not page views or sessions. |
| `new_identities_in_window` | Qualifying visitors whose `visitors.first_seen` falls inside the window. |
| `excluded_visitor_ids` | Number of distinct supplied exclusion UUIDs, active or not. |
| `excluded_active_visitors` | Otherwise qualifying visitor identities removed by those exclusions. |
| `first_recorded_activity` | Earliest retained visitor receipt across the database, or `null`; this is not a fabricated deployment timestamp. |
| `window_starts_before_first_recorded_activity` | Whether the requested start predates the first receipt; `null` when none exist. |
| `granularity_seconds` | `60`, identifying minute-bucket aggregation. |
| `identity`, `activity`, `coverage`, `limitations` | Metric definitions and limitations included with every JSON report. |

These are **browser identities, not verified distinct people**. Clearing browser storage, private browsing, another device or another frontend origin can create another UUID. Shared browsers can represent more than one person. Names and network addresses neither merge nor split identities. This is not a measure of active play, exact session duration or simultaneous online users.

The frontend respects Global Privacy Control (GPC) and Do Not Track (DNT); opted-out browsers do not contribute receipts. Blocked requests, offline play and failed delivery are also absent. Consequently the result is the number of recorded visitor identities, not a guarantee of counting every person who opened Bolts. Tracking can also be disabled for a page load with `?visits=0`. Development and QA/inspector pages skip tracking by default; `?visits=1` explicitly enables a local test but never overrides GPC/DNT. If local storage is unavailable, tracking is skipped to avoid inventing a fresh identity on each reload. Already recorded receipts are not retroactively erased by changing a browser preference. No IP or browser fingerprint deduplication is performed.

## Private network observations and single-player events

Schema migration 5 adds `visitor_networks` and `single_player_events` without changing the existing visitor reporting metric. Both are private first-party data with no public read endpoint. The migration preserves earlier visits and game records; it cannot backfill historical IP addresses or local-play sessions.

`visitor_networks` stores the raw, canonical observed IP address and first/last receipt times for each `(visitor_id, ip_address)`. This lets operators inspect a browser identity's observed networks without using the address as its identity or joining it to an authenticated multiplayer player. Addresses can be shared or change, so they do not establish a distinct person. Restrict access to the live database and its backups accordingly. The aggregate analytics script neither queries nor returns this table.

`single_player_events` stores a browser visitor UUID, a separate random UUIDv4 for the local play session, `single_player_start` or `single_player_stop`, the server receipt time, the observed IP when available, and an optional bounded stop reason: `quit`, `page_exit`, `restart`, or `round_end`. The unique `(visitor_id, session_id, event)` key preserves the first accepted receipt for each event type, so retries cannot create another start/stop or change the first reason. Start and stop may arrive out of order and are accepted independently. There are no local scores, player names, authentication tokens, URLs or arbitrary event properties in these records.

The browser sends a start when local play or local spectating begins, and a best-effort stop when it quits, restarts, finishes a round, or leaves the page. Pause and ordinary tab hiding do not end the local session. Restoring a page after `pagehide` can start a new session. These events use the same GPC/DNT, storage and page-tracking preferences as visitor receipts. They are optional telemetry; game startup never waits for delivery. A browser crash, network failure, blocked request, or opt-out can leave one side missing. Receipt timestamps reflect server arrival and can differ from client play order; they are not exact play durations or a reliable concurrent-player count.

`POST /api/visits` continues to accept `{visitorId}`. Lifecycle requests additionally include `{event, sessionId}` together and may include `reason` only for a stop. The 256-byte JSON limit, exact allowlisted Origin check, UUIDv4 validation and rejection of unknown fields still apply. Clients cannot submit an IP address or timestamp. Ordinary visitor receipts are limited to 60 requests per minute per network; lifecycle events have an independent 120-request budget, so a heartbeat burst cannot consume their quota. Optional database work stays outside the simulation mutex, and a failed analytics write returns 503 without ending gameplay.

IP addresses come from the direct socket peer unless the existing restricted ingress explicitly enables trusted-proxy mode. That mode uses only the final valid address appended to `X-Forwarded-For`, canonicalizing equivalent IPv6 and IPv4-mapped addresses. An unavailable or invalid trusted address stays unknown: the event address is `NULL` and no network row is invented. Client JSON and untrusted forwarding headers cannot supply the stored address. Raw IPs stay in the private first-party database and are never sent as Google Analytics event parameters.

## Google Analytics

The **Bolts** GA4 property uses web stream **Bolts web** for `https://play-bolts.github.io/`, measurement ID `G-Q6XEXWGVZP`. The public ID is in `.env.production`; a GitHub repository variable named `VITE_GA_MEASUREMENT_ID` can override it during Pages builds. Local builds can also set this Vite environment variable. An absent or invalid ID skips Google entirely.

The asynchronous Google tag records one page view and `single_player_start` / `single_player_stop` events. Its page URL omits queries and fragments, its referrer is empty, and the application sends no player names, first-party visitor/session UUIDs, chat, feedback, or explicit IP fields to GA. Google uses its normal analytics cookies and network metadata; GA identity and counts remain separate from the private database. Both trackers honor GPC, DNT, `?visits=0`, and the development/QA exclusions. Advertising personalization and Google Signals are disabled in the tag configuration. Enhanced Measurement is disabled on this stream, leaving standard page views and the explicitly instrumented events.

Configuration follows Google's [page-view documentation](https://developers.google.com/analytics/devguides/collection/ga4/views) and [privacy controls](https://developers.google.com/tag-platform/security/guides/privacy). GA never delays menu initialization or graphics preparation. Browser blockers or failed script requests leave gameplay available. Verify a production visit and session in GA Realtime after a release; ordinary reporting may take longer to populate.

## Separate source: multiplayer

`--source multiplayer` preserves the previous non-bot authenticated socket metric. A player has `players.is_bot=0` and at least one connection overlapping `(window_start, window_end]`. The identity key is `players.id`, separate from the visitor UUID. A single person can appear in both reports; do not add them together as distinct people.

Connections opened before the window count if still connected during it. Reconnects, name changes and tabs sharing the same player identity count once. `Unknown Soldier` and spectators count. Bots, leaderboard-only seeds and session creation without a socket do not. Invalid backwards or zero-length socket intervals are omitted. A socket closed exactly at the window start does not count. One opened exactly at the end counts if still open; one closed exactly at the end contributes to the window count but not `connected_at_end`.

| Multiplayer JSON field | Meaning |
| --- | --- |
| `source` | Always `multiplayer`. |
| `unique_players` | Distinct qualifying non-bot player UUIDs after exclusions. |
| `connections` | Qualifying connection intervals, including reconnects. |
| `connected_at_end` | Distinct qualifying identities with a socket open at the end. |
| `carried_into_window` | Qualifying identities with a socket opened on/before the start and still open after it. |
| `new_identities_in_window` | Qualifying identities created inside the window, not all requested session tokens. |
| `excluded_player_ids` / `excluded_active_players` | Supplied distinct exclusions / active identities actually removed. |

An idle open socket counts. Automated multiplayer QA clients use ordinary non-bot player identities unless explicitly excluded. `players.last_seen` is deliberately not used: session requests and profile changes update it, while a long-lived connection need not. This source does not include local-only games or menu visitors and does not depend on visitor telemetry/GPC/DNT preferences; it reports necessary multiplayer connection records.

## Excluding known tests and operators

Keep separate private, ignored JSON arrays for visitor and multiplayer UUIDs, for example `infra/.state/visitor-exclusions.json` and `infra/.state/player-exclusions.json`:

```json
[
  "00000000-0000-0000-0000-000000000001",
  "00000000-0000-0000-0000-000000000002"
]
```

The example UUIDs are placeholders. Record the appropriate IDs from your own test setup and replace them. Then run:

```sh
python3 scripts/user-analytics.py --aws --hours 24 --exclude-file infra/.state/visitor-exclusions.json --json
python3 scripts/user-analytics.py --aws --hours 24 --exclude-visitor-id 00000000-0000-0000-0000-000000000001 --json
python3 scripts/user-analytics.py --aws --source multiplayer --hours 24 --exclude-file infra/.state/player-exclusions.json --json
python3 scripts/user-analytics.py --aws --source multiplayer --hours 24 --exclude-player-id 00000000-0000-0000-0000-000000000001 --json
```

Exclusion flags can be repeated and combined with files; duplicates are removed. `--exclude-file` always refers to the selected `--source`. `--exclude-player-id` is rejected for visitors, and `--exclude-visitor-id` is rejected for multiplayer. The database does not join these identities or translate between them. Supplying player UUIDs in a visitor exclusion file will not exclude those people's separate visitor UUIDs.

There is no automatic name-prefix filter: a person can choose a test-looking name, and visitor records have no names. Historical QA identities without a recorded classification cannot reliably be separated from people. Explicit exclusions affect only that report and never modify stored records.

## Production operation and data handling

`--aws` (`--production`) uses the existing [`scripts/aws-command.py`](../scripts/aws-command.py) credential helper and AWS CLI. It defaults to `InstanceId` in ignored `infra/.state/outputs.json`. Without that deployment state, supply the existing server explicitly:

```sh
python3 scripts/user-analytics.py --aws --instance-id i-0bd1adb3fc8b01688 --hours 24 --json
```

The region is fixed to the deployed backend's `us-west-2`. The operator needs SSM `SendCommand`, `ListCommandInvocations` and `GetCommandInvocation` access. The command executes a compressed, base64-encoded snapshot of this same script with `runuser -u bolts -- python3`, preserving the selected source and exclusion arguments. It reads `/var/lib/bolts/bolts.sqlite` with `mode=ro` and `PRAGMA query_only=ON`, returning aggregates only. Running this reporting script does not restart the application, install a release, copy the database or apply a migration. Visitor tracking itself must already have been deployed.

Each query uses a read transaction and aggregates IDs on the server. Names, credentials, chat, feedback, IP/UA hashes and individual IDs are not returned or downloaded. Credentials stay in the existing local AWS credential chain. SSM history contains the script, selected source, requested window and explicitly supplied exclusion UUIDs; restrict that history as you do other operator data. Errors provide a command ID without dumping remote output or credential-helper stderr.

The script submits one SSM command and polls; it does not resubmit delayed commands. Inspect a timed-out command before retrying. It creates no scheduled job. Query cost grows with retained activity history; reporting does not add indexes to the running schema.

Use SQLite's backup API or the existing S3 backup workflow in [server/README.md](../server/README.md) for offline reports. Copying only a live `.sqlite` file can omit committed WAL data. Both query modes support live WAL reads; do not substitute SQLite's `immutable` mode on a running database. Set `--as-of` no later than an offline backup's capture time. For multiplayer, open sockets in a snapshot are treated as open through the requested end, and crash recovery can overstate their lifetime until interrupted sockets are closed. Visitor mode counts only recorded bucket ranges and does not extend open sessions forward.

## Verification

```sh
python3 -m unittest discover -s tests -p 'test_user_analytics.py' -v
cargo test --locked --manifest-path server/Cargo.toml visitor
```

Tests cover both sources, exact window boundaries, repeated visitor receipts and minute approximation, no activity invented between visits, no historical backfill, missing migration errors, source-specific exclusions, separate identity stores, multiplayer carryover/reconnects, default names, bot/session/seed exclusions, read-only WAL access, JSON privacy and the actual compressed source payload executed through SSM. Mocked SSM lifecycle checks cover delayed registration, completion and failure without resubmission.

The visitor backend tests also cover canonical observed IPs and forwarding-header trust, out-of-order lifecycle delivery and retry idempotency, independent network quotas, field/body validation, additive migration rollback and preservation, and analytics storage failure without blocking gameplay. API tests require permission to bind local loopback sockets.
