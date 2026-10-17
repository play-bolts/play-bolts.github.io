Bolts performance audit tools

These diagnostic entries and prototypes are outside src/ and are not imported
by the production application. They do not implement the proposed optimizations.
Run commands from the repository root. Keep the browser foreground, close other
active games, and run CPU probes only after browser measurements have finished.

Browser server (no automatic reloads; results persist after each scenario):
  npm run dev -- --config scripts/performance-vite.config.ts --port 5184 --strictPort

Open the following URLs one at a time in the same browser tab:
  http://127.0.0.1:5184/scripts/performance-device-profile.html
    Run matrix, then Repeat focused comparisons. 24 runs total, about 5 minutes.
    Renderer/effects only; three-second warmup and nine-second sample per run.
    Phone-sized buffers are pixel workloads, not actual phone emulation.
  http://127.0.0.1:5184/scripts/performance-session-profile.html?visits=0
    Run 30-second local session. Actual main loop, HUD, audio and offline AI.
    Five-second warmup. Scripted player, fixed settings, spawn protection reset
    after firing. Restores the original local preferences on normal completion.
    Check audioDiagnostic.clockProgressValid: a running AudioContext with a
    stalled clock can accumulate scheduled voices to the cap and invalidate
    ordinary-play audio conclusions. ?visits=0&routingHz=30 is an optional
    spatial-control cadence diagnostic, not an acoustically validated change.
  http://127.0.0.1:5184/scripts/performance-animation-profile.html
    Initialize assets, then Run animation audit. Real browser models, fresh rigs
    and pooled reuse; measures pose CPU and identifies lazy death ConvexHulls.

The profiling server accepts same-origin JSON at three fixed local endpoints
and saves browser-renderer.json, browser-session.json and browser-animation.json
under temp/performance-audit/. Download buttons also work with normal npm dev.
Copy results before rerunning an entry: each entry replaces its own JSON file.

CPU and source probes (Node; these are not mobile or end-to-end FPS estimates):
  node --import tsx scripts/performance-cpu-audit.ts
  node --import tsx scripts/performance-cpu-audit.ts --profile
  node --import tsx scripts/performance-cpu-audit.ts --instrument
  node --import tsx scripts/performance-navigation-prototype.ts
  node --import tsx scripts/performance-animation-audit.ts
  node --import tsx scripts/performance-audio-synthesis.ts
  python3 scripts/performance-asset-audit.py

The asset script requires Pillow. The Node animation probe stubs image textures;
the browser animation entry decodes the real images. Navigation's test-only
prototype verifies 528 exact path comparisons before timing. Shared scratch
arrays are not a production-ready concurrency/lifetime design.

Generate the detailed report from available measurements:
  python3 scripts/performance-report.py
  Open temp/performance-audit/report.html

Interpretation: CPU submission and GPU execution overlap; do not sum them to
derive frame time. Browser GPU timers may be unavailable. Long tasks and heap
snapshots do not independently identify a cause or establish a memory leak.
Resource counts are not VRAM bytes. Static texture estimates include unused
source images and must not be multiplied by actor count. Frozen shadows and
hidden actors are diagnostic upper bounds, not visually equivalent changes.
Use a production build, real Android/iOS and integrated-GPU hardware, sustained
sessions, and target refresh/thermal/network conditions before shipping presets.
