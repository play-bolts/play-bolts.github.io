# Netcode audit and protocol v2

Assessed and implemented 2026-10-16. The release retains authoritative Rust simulation at 60 Hz, 20 Hz snapshots, immediate local prediction, replay after reconciliation, and server-side hit resolution. The main changes address timing recovery and queued work. They are independently implemented; no Quake or Source code was copied.

## Diagnosis

The previous client already predicted movement correctly under steady latency. Its failures appeared during changes in delivery timing:

- Expired commands were rejected and missing ticks became neutral movement. A fixed two-tick cushion and three-second RTT sampling could leave many consecutive commands arriving too late after a latency increase.
- The remote presentation clock combined gradual adjustment with a hard lower bound at the newest snapshot timestamp. After its interpolation buffer ran dry, an arriving burst bypassed gradual recovery and moved opponents forward abruptly.
- A 64-message FIFO retained obsolete snapshots. The same socket loop awaited writes and read inputs, so a blocked outgoing write also delayed incoming commands.
- Synchronous SQLite operations held the shared game mutex. The timer skipped missed wakeups without accounting for the lost simulation time.
- Camera correction removed roughly 60% of its offset per 60 Hz frame. Rendering stalls also interrupted input generation; client and server could agree on neutral missing ticks, making a zero-correction test pass despite lost movement.

The [baseline diagnostic notes](../artifacts/netcode-audit/README.txt), [client measurements](../artifacts/netcode-audit/prediction-results.jsonl), and [actual Rust probe](../artifacts/netcode-audit/server/result.json) preserve the evidence. These ignored local artifacts are not published in the repository; tracked regression tests below reproduce the relevant scenarios. Baseline scripts require the pre-v2 source recorded in their metadata.

## Implemented changes and their rationale

| Area | Implementation | Relevant precedent |
| --- | --- | --- |
| Local prediction | Required tick/generation inputs; one command owns one simulation interval. Restore authority and replay later ticks without repeating audiovisual effects. Missing input remains neutral; no speculative repeat of fire, melee, reload, or jump. | Quake III's [`CG_PredictPlayerState`](https://github.com/id-Software/Quake-III-Arena/blob/master/code/cgame/cg_predict.c#L432) starts from received state and reprocesses later commands. Valve's [latency-compensation paper](https://developer.valvesoftware.com/w/index.php?title=Latency_Compensating_Methods_in_Client%2FServer_In-game_Protocol_Design_and_Optimization&uselang=en) describes the same prediction/replay pattern and the need to suppress repeated effects. |
| Input scheduling | [Adaptive lead](../src/networkTiming.ts) grows from two up to eight ticks using authority-reported late/missing commands and arrival slack. It decreases after sustained healthy arrivals. RTT probes run every second. Learned lead survives respawns; per-life counters reset. | Riot reports that insufficient buffering causes corrections while excessive buffering adds processing latency invisible in ordinary ping. Its [consistency investigation](https://playvalorant.com/en-gb/news/game-updates/valorant-gameplay-consistency-update-2/) motivates measuring both directions' buffering and testing latency/FPS transitions. The Bolts constants are engineering choices, not values prescribed by Riot. |
| Remote playback | A separate monotonic clock uses a 100–180 ms jitter-aware target and 90–110% playback speed. Ordinary packet arrivals cannot jump the clock. It freezes at the newest available state; accumulated lag exceeding one second explicitly resynchronizes. | Quake III's [`CL_AdjustTimeDelta`](https://github.com/id-Software/Quake-III-Arena/blob/master/code/client/cl_cgame.c#L779) separates normal time adjustment from exceptional resets. Our controller differs, but preserves that distinction. |
| Transport queues | [Independent reader/writer](../server/src/transport.rs), one replaceable unsent state, and a bounded reliable queue. Reliable event batches carry sequence, round, generation, and captured names. Events wait for matching/newer state, deduplicate, and survive roster changes; stale body effects cannot affect another life. Client input stops adding backlog above 4 KiB. | Valve's [GameNetworkingSockets](https://github.com/ValveSoftware/GameNetworkingSockets) separates message reliability and supports prioritized lanes. This supports distinguishing replaceable state from durable events; Bolts still uses TCP WebSockets and does not acquire UDP's delivery properties. |
| Simulation/persistence | [SQLite worker](../server/src/storage.rs) executes outside the game mutex. Bounded queues reserve capacity for gameplay, preserve gameplay ordering, and publish kill/chat notifications after commit. [TickClock](../server/src/tick_clock.rs) accounts for elapsed time, runs at most eight catch-up ticks per batch, and retains at most 30 ticks of debt. Excess overload is reported. | Quake III's [`SV_Frame`](https://github.com/id-Software/Quake-III-Arena/blob/master/code/server/sv_main.c#L722) accumulates elapsed time and consumes fixed simulation chunks. Bolts adds explicit bounds and yielding to prevent catch-up monopolizing the process. Database isolation is a fix for our measured blocking path, not a borrowed FPS rule. |
| Presentation and payload | [Camera correction](../src/localPredictionView.ts) now decays over 45 ms, clears after 200 ms, and sweeps 12 cm world clearance. It changes neither physics nor aim; life changes and corrections over 1 m reset it. [Actor tuples](../src/networkCodec.ts) remove repeated field names while preserving full floating-point values and independently decodable snapshots. | Source's [prediction implementation](https://github.com/ValveSoftware/source-sdk-2013/blob/master/src/game/client/prediction.cpp#L1456) preserves authoritative prediction boundaries. The accompanying [networking documentation](https://developer.valvesoftware.com/wiki/Source_Multiplayer_Networking?language=uk) distinguishes prediction, interpolation, and error smoothing. Our tuple format is structural JSON compression, not binary encoding or delta compression. |

The horizon intentionally uses snapshot age **plus full RTT**: a received snapshot is already approximately one-way latency old, and a newly submitted command needs another one-way transit. Halving RTT in that formula would remove necessary lead. This is an estimate, not a claim that real routes are symmetric; arrival diagnostics correct scheduling slack.

## Measurements

These are deterministic synthetic regressions, not production telemetry or user-study results. Movement tests use the actual `NetworkClient`, `Game.move`, and camera code with a TypeScript authority reproducing the Rust scheduling rules. Initial snapshots include physical one-way transit. Delivery remains ordered to model a stalled TCP path; this is not a packet-loss emulator. Separate Rust tests cover authority rules and persistence boundaries.

| Scenario | Before | v2 |
| --- | --- | --- |
| Stable 50/120/150 ms RTT | Zero movement corrections | Zero movement corrections |
| 150 ms extra snapshot delay; opponent at 4.8 m/s; 60 Hz presentation | 32.0 cm maximum frame movement; nine frozen frames | 8.51 cm; five frozen frames |
| 250 ms extra snapshot delay, same setup | 80.0 cm maximum frame movement; 15 frozen frames | 8.8 cm; 11 frozen frames |
| RTT rises from 50 to 150 ms with ±9 ms jitter and a stale 50 ms estimate | 81 late inputs | 19 late inputs with authority feedback |
| Same RTT-rise scenario, maximum backward camera movement while forward is held | 7.13 cm | 2.31 cm; actual prediction correction can still reach 24 cm |
| Six-actor state enriched with v2 fields, lossless encoding comparison | 6,130 bytes as named objects | 3,121 bytes as tuples: 49.1% smaller; 62,420 bytes/s at 20 Hz before framing/TLS |

Sources: [baseline remote results](../artifacts/netcode-audit/remote-results.jsonl), [baseline movement results](../artifacts/netcode-audit/prediction-results.jsonl), [v2 results and source hashes](../artifacts/netcode-audit/post-v2/client-results.json), and [codec-size calculation](../artifacts/netcode-audit/implementation/codec-size.json). The feedback regression also compares the same v2 client with timing feedback withheld; that control produces the same 81 late inputs. Camera improvement includes the timing and smoothing changes together. The payload comparison transforms a recorded snapshot; it is not a throughput benchmark.

The original actual-Rust probe imposed a 250 ms SQLite writer lock and observed a 299.6 ms snapshot-delivery gap while simulation advanced only 50 ms. The new [blocked-visitor regression](../server/src/visitor_api_tests.rs) keeps that write blocked while acquiring the Hub lock and executing 18 ticks, publishing six snapshots. It verifies isolation rather than claiming a measured production percentile. A [seven-connection integration run](../artifacts/netcode-audit/implementation/multiplayer-seven-users.log) passed 24 checks including room capacity, movement, authoritative shooting, reconnect, and linked persisted kill/death records.

Reproduce the tracked checks from the repository root:

```sh
node --import tsx --test tests/network*.test.ts tests/local-prediction-view.test.ts
cargo test --manifest-path server/Cargo.toml
```

## Limits and next measurements

The **200 ms rewind cap remains unchanged** in [sim.rs](../server/src/sim.rs). Interpolation, input lead, and transit together can exceed it even on a stable connection: the baseline diagnostic measured approximately 267 ms target-view age at 120 ms RTT. `shotAgeMs` and `rewindClamped` now expose that boundary. Increasing the cap requires separate hit-registration and cover-fairness evaluation; it is not a remedy for movement jitter. Valve explicitly includes interpolation in its [lag-compensation calculation](https://developer.valvesoftware.com/wiki/Source_Multiplayer_Networking?language=uk).

More buffering trades responsiveness for consistency. The [2022 ACM survey by Liu, Xu, and Claypool](https://web.cs.wpi.edu/~claypool/papers/lag-taxonomy/paper.pdf) distinguishes prediction, interpolation/extrapolation, delay, and rewind; it does not supply universal optimal constants. [Tokey et al., FDG 2024](https://web.cs.wpi.edu/~claypool/papers/peeker-fdg-24/paper.pdf) found defender latency materially affected corner engagements in their experimental FPS. Our inference is to test asymmetric connections and peeker/defender roles before enlarging latency budgets.

Remaining work is specific:

- **First unpredictable stalls:** a finite buffer cannot cover every gap. Severe RTT increases still cause corrections; prolonged gaps still freeze remote bodies. Playback can reset after exceptional suspension.
- **TCP head-of-line blocking:** replacing unsent state cannot retract bytes already queued in TCP. A [WebTransport](https://www.w3.org/TR/webtransport/) prototype could use datagrams for replaceable state and reliable streams for events. Verify negotiated unreliable support and build a compatible endpoint; protocol v2 currently has no WebTransport path.
- **Main-thread stalls:** input generation still follows the rendering loop. A worker-based input/transport scheduler is a follow-up, with explicit focus/release semantics and the same server movement budget. A worker must not fabricate repeated one-shot actions or unlimited catch-up.
- **Moving-player collision:** prediction samples authoritative collider history with only 100 ms extrapolation. Two players reversing or crossing under asymmetric latency remain a source of legitimate misprediction; open-corridor results do not validate those encounters.
- **Persistence and overload:** accepted queued writes remain memory-resident until commit. Critical persistence failure stops the service rather than silently losing confirmed events. Catch-up and queue limits protect the process but cannot make sustained overload disappear.
- **Production validation:** collect p95/p99 correction distance, backward camera steps, command arrival slack, late/missing inputs, playback underruns, snapshot queue age, server lock/tick duration, and rewind clipping. Exercise two/six players, 30/60/144 FPS, 50–250 ms ordered bursts, latency rises/falls, release during stalls, and real loss under a network emulator. Current deterministic checks prove mechanisms and bounds, not their frequency in the deployed game.

Wire details and coordinated deployment requirements are in [server/PROTOCOL.md](../server/PROTOCOL.md). Protocol 1 is rejected; browser identity tokens and the existing database are retained.
