# Player activity analytics

[`scripts/user-analytics.py`](../scripts/user-analytics.py) reports distinct non-bot **browser identities** whose authenticated multiplayer WebSocket lifetime overlaps the past N hours. It uses the existing SQLite connection history and requires Python 3.9 or later, with no third-party Python packages.

```sh
# Existing local database or a consistent backup; no AWS access.
python3 scripts/user-analytics.py --db server/data/bolts.sqlite --hours 24

# Production: run the same read-only query through Systems Manager.
python3 scripts/user-analytics.py --aws --hours 24 --json

# Reproduce a historical 90-minute window ending at a specific UTC instant.
python3 scripts/user-analytics.py --aws --hours 1.5 --as-of 2026-10-16T12:00:00Z --json
```

`--as-of` accepts ISO 8601 with an explicit timezone, including offsets such as `-07:00`. It defaults to the current UTC time captured once before querying. Hours must be positive and resolve to whole milliseconds. The script rejects future window ends and windows starting before the Unix epoch.

## What counts

- A player has `players.is_bot=0` and at least one recorded connection overlapping `(window_start, window_end]`. The identity key is `players.id`, not a name or network address.
- Connections opened before the window count if still connected during it. Multiple connections, reconnects, name changes and simultaneous tabs sharing an identity count once.
- `Unknown Soldier` and spectators count. Bots, leaderboard-only seed records and session creation without a socket do not. Zero-length and invalid backwards connection intervals are omitted.
- A connection closed exactly at `window_start` does not count. One opened exactly at `window_end` counts if not already closed. A connection closed exactly at `window_end` contributes to the window's users but not its end-of-window connected count.

The report contains only these aggregates and the time-window definition:

| JSON field | Meaning |
| --- | --- |
| `unique_players` | Distinct qualifying browser UUIDs after explicit exclusions. |
| `connections` | Qualifying connection intervals, including reconnects. |
| `connected_at_end` | Distinct qualifying identities with a socket open at the window end. |
| `carried_into_window` | Distinct qualifying identities with a socket opened on/before the window start and still open after it. |
| `new_identities_in_window` | Qualifying identities whose `players.created_at` is inside the window; this is not a count of all newly requested session tokens. |
| `excluded_player_ids` | Number of distinct UUIDs supplied for exclusion, whether active or not. |
| `excluded_active_players` | Number of otherwise qualifying active identities removed by those exclusions. |

This measures multiplayer connections, not verified people or human engagement. One person using separate browsers, cleared storage, another frontend origin or another device can have several identities. An idle open socket counts. Automated QA clients use ordinary non-bot identities unless explicitly excluded. A shared name does not merge identities, and an IP change does not split them. There is no fingerprint-based or IP-based deduplication.

**Local-only single-player activity and page/menu visits are not recorded by this metric.** It adds no frontend tracking. `players.last_seen` is deliberately not used: session requests and profile changes update it, while a long-lived connection need not.

## Excluding known tests and operators

Keep known QA/operator UUIDs in a private, ignored JSON file, for example `infra/.state/analytics-exclusions.json`:

```json
[
  "00000000-0000-0000-0000-000000000001",
  "00000000-0000-0000-0000-000000000002"
]
```

These are illustrative UUIDs; replace them with the identities your test harness recorded. Then run:

```sh
python3 scripts/user-analytics.py --aws --hours 24 --exclude-file infra/.state/analytics-exclusions.json --json
python3 scripts/user-analytics.py --db server/data/bolts.sqlite --hours 6 --exclude-player-id 00000000-0000-0000-0000-000000000001
```

Both exclusion flags can be repeated and combined; duplicate UUIDs are removed. There is intentionally no automatic name-prefix filter: a real player can choose a test-looking name. Historical QA sessions without recorded UUID classifications cannot be reliably separated from human sessions. Reports without a complete exclusion list must be described as non-bot browser identities, not a verified human-user count. Exclusions affect only that report and do not change database records.

## Production operation and data handling

`--aws` (`--production`) uses the existing [`scripts/aws-command.py`](../scripts/aws-command.py) credential helper and AWS CLI. It defaults to the EC2 `InstanceId` in ignored `infra/.state/outputs.json`. If that deployment state is unavailable, supply the existing instance explicitly:

```sh
python3 scripts/user-analytics.py --aws --instance-id i-0bd1adb3fc8b01688 --hours 24 --json
```

The region is fixed to the deployed backend's `us-west-2`. The operator needs SSM `SendCommand`, `ListCommandInvocations` and `GetCommandInvocation` access to this instance. The command executes a base64-encoded snapshot of this script with `runuser -u bolts -- python3`, reads `/var/lib/bolts/bolts.sqlite` using `mode=ro` and `PRAGMA query_only=ON`, and returns aggregate JSON. No application restart, release, installation, database copy or schema change is performed. Reading the live WAL is supported; do not substitute SQLite's `immutable` mode on the running database.

The query runs in a read transaction and selects identity IDs only to aggregate them on the server. Names, credentials, chat, feedback, IP/UA hashes and the database itself are neither returned nor downloaded. AWS credentials stay in the existing local credential chain. SSM command history contains the script, requested time window and explicitly supplied exclusion UUIDs, so restrict SSM history access as you do other operator data. Errors return a command ID for investigation without dumping remote output or credential-helper stderr.

The script submits one SSM command and polls for completion; it does not resubmit on delays. If it times out, inspect that command before retrying. It does not create a scheduled job. A large connection history may make this operator query slower; it currently scans connection history without adding indexes to the running application schema.

For an offline report, use a consistent SQLite backup made with SQLite's backup API or the existing S3 backup workflow in [server/README.md](../server/README.md). Copying only a live `.sqlite` file can omit committed WAL data. Use `--as-of` no later than the backup's capture time. Open connections in a snapshot are treated as open through the requested end time; the database does not provide a durable per-socket heartbeat. A crash can overstate connection lifetime until startup recovery closes interrupted connections, so these timestamps are not exact active-play duration measurements.

## Verification

```sh
python3 -m unittest discover -s tests -p 'test_user_analytics.py' -v
```

The tests cover timestamp boundaries, current and carryover connections, reconnection deduplication, default names, bot/session/seed exclusions, explicit QA exclusions, independent same-name identities, malformed intervals, committed WAL reads without database changes, missing-file refusal, JSON privacy, and the actual source payload executed by SSM. Mocked SSM lifecycle checks cover delayed registration, completion and errors without resubmission.
