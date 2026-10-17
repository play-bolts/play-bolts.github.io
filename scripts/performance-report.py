#!/usr/bin/env python3
"""Build the local audit report from existing evidence; never runs benchmarks.

From the repository root: python3 scripts/performance-report.py
Optional measurements are incorporated automatically when present.
"""
from html import escape
import json
from pathlib import Path
import statistics

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "temp/performance-audit"


def read(name, default=None):
    path = DEST / name
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError:
        return default


def text(value):
    return escape(str(value))


def number(value, places=2):
    return f"{value:,.{places}f}" if isinstance(value, (float, int)) else "—"


def link(name, label=None):
    return f'<a href="{text(name)}">{text(label or name)}</a>'


def code(path, line):
    return link(f"../../{path}#L{line}", f"{path}:{line}")


def locate(path, token, fallback):
    """Keep links useful while concurrent local edits move an audited block."""
    try:
        return next(i for i,line in enumerate((ROOT/path).read_text().splitlines(),1) if token in line)
    except (OSError, StopIteration):
        return fallback


def table(headers, rows):
    return '<div class="table-scroll"><table><thead><tr>' + ''.join(
        f'<th>{text(h)}</th>' for h in headers
    ) + '</tr></thead><tbody>' + ''.join(
        '<tr>' + ''.join(f'<td>{cell}</td>' for cell in row) + '</tr>' for row in rows
    ) + '</tbody></table></div>'


def absent(label):
    return f'<p class="pending">{text(label)} has not been saved yet. Rerun this generator after measurement; no result is inferred.</p>'


renderer = read("browser-renderer.json", {})
runs = renderer.get("runs", [])
inventory = read("asset-inventory.json", [])
node_animation = read("animation-node-microbenchmark.json", {})
animation = read("browser-animation.json")
session = read("browser-session.json")
session_reports = []
session_signatures = set()
for path in sorted(DEST.glob('browser-session*.json')):
    data = read(path.name)
    if not data:
        continue
    signature = json.dumps(data, sort_keys=True)
    if signature in session_signatures:
        continue
    session_signatures.add(signature)
    session_reports.append((path.name, data))
session_name = next((name for name in ('browser-session-original.json','browser-session-baseline.json','browser-session.json') if read(name)), 'browser-session.json')
session = read(session_name)
cpu = read("cpu-benchmark-120hz.json")
profile = read("simulation-profile-summary.json")
navigation = read("navigation-prototype.json")
audio = read("audio-synthesis-microbench.json", {})
manifest = read('source-manifest.json', {})
death_hull_line = locate('src/soldierAnimation.ts','const cache=hand.hand.userData.deathHull',294)


def first_run(name):
    return next((r for r in runs if r.get("scenario", {}).get("name") == name), None)


def metric(run, key, statistic="mean"):
    values = (run or {}).get("metrics", {}).get(key, {})
    if key == "gpu" and not values.get("n"):
        return None
    return values.get(statistic)


baseline = first_run("desktop-medium")
shadow_savings = []
for i, run in enumerate(runs):
    if run.get("scenario", {}).get("name") != "medium-world1024" or not run.get("valid"):
        continue
    control = runs[i + 1] if i + 1 < len(runs) and runs[i + 1].get("scenario", {}).get("name") == "desktop-medium" else baseline
    before, after = metric(control, "gpu"), metric(run, "gpu")
    if before and after is not None and control.get("valid"):
        shadow_savings.append(100 * (before - after) / before)
shadow_summary = (f'{number(min(shadow_savings), 1)}–{number(max(shadow_savings), 1)}%'
                  if shadow_savings else 'not yet quantified')

legacy_paths = {
    'public/assets/makehuman/human-head.glb',
    'public/assets/details/model-details.glb',
}
legacy = [r for r in inventory if r['path'] in legacy_paths or
          r['path'].endswith('.jpg') and any(f'/{family}/' in r['path'] for family in ('fabric', 'soldier', 'steel'))]
legacy_bytes = sum(r['bytes'] for r in legacy)
embedded_bytes = sum(sum(i['rgba8_mips'] for i in r.get('images', [])) for r in inventory)
rifle_bytes = sum(sum(i['rgba8_mips'] for i in r.get('images', []))
                  for r in inventory if '/imported-weapons/' in r['path'] and r.get('kind') == 'glb')
legacy_base = sum(r.get('width', 0) * r.get('height', 0) * 4
                  + sum(i['width'] * i['height'] * 4 for i in r.get('images', [])) for r in legacy)

env = renderer.get('environment', {})
measured_date = 'October 16, 2026 · America/Los_Angeles'
body = []
body.append(f'''<header><p class="eyebrow">BOLTS / PERFORMANCE ENGINEERING</p>
<h1>Fix cold-start waste and combat hitches; build real device tiers.</h1>
<p class="deck">A deep profile of startup, graphics, animation, simulation, audio and server architecture. Production behavior was not changed by this audit.</p>
<p class="meta">{measured_date}<br>{text(env.get('renderer', 'Browser GPU unavailable'))}<br>{text(env.get('userAgent', 'Browser details unavailable'))}</p>
</header>
<nav><a href="#priorities">Priorities</a><a href="#graphics">Graphics</a><a href="#hitches">Hitches</a><a href="#assets">Assets</a><a href="#simulation">Simulation</a><a href="#devices">Devices</a><a href="#method">Method &amp; evidence</a></nav>
<section class="lead"><p><strong>The clearest low-risk improvement is removing {number(legacy_bytes / 1e6, 1)} MB of assets from successful imported-model startup.</strong>
First-death hand-hull construction deserves immediate smoothness work. Sustained graphics work needs separate texture, model and shadow budgets: the existing Low setting mainly removes shadows, while high-resolution imported assets remain loaded. Full-session audio results are limited by a stalled output clock discovered during diagnostics.</p>
<p>All browser measurements come from this Apple M3 Pro. Smaller drawing buffers represent pixel workloads, not physical phones. No cross-device FPS uplift, thermal result or production server capacity is established. Rankings below combine measured evidence with implementation scope; proposed settings require validation.</p></section>
<div class="cards"><article><span class="badge arithmetic">Source bytes</span><strong>{number(legacy_bytes / 1e6, 1)} MB</strong><span>avoidable legacy preload</span></article>
<article><span class="badge arithmetic">Storage arithmetic</span><strong>{number(rifle_bytes / 1048576, 0)} MiB</strong><span>three rifle image sets, RGBA8 + mips</span></article>
<article><span class="badge measured">Local GPU timing</span><strong>{shadow_summary}</strong><span>world 2048 → 1024 improvement</span></article></div>''')

priority_rows = [
    ('1 · Startup', 'Remove unused legacy preloads', 'Static dependency proof + exact file bytes',
     f'{code("src/main.ts",38)}; {code("src/soldier.ts",242)}; {code("src/rifle.ts",174)}; {code("src/modelDetails.ts",25)}',
     'Split imported-soldier loading from legacy details; defer head/fabric/leather/steel assets to explicit procedural tools. Keep canvas and walnut. Validate all faction loads and failure paths. Low visual risk.'),
    ('2 · Combat tails', 'Precompute death-hand hulls', 'Browser-confirmed fresh/pool contrast; Node corroboration' if animation and animation.get('runs') else 'Node measurements; browser confirmation pending',
     f'{code("src/soldierAnimation.ts",death_hull_line)}; {code("src/renderer.ts",130)}',
     'Bake or safely prewarm the exact relaxed hand envelopes for each held item. Cache immutable results independently of disposable rigs. Compare fresh and pooled deaths, prone/lean/reload and both weapons. Medium complexity.'),
    ('3 · Device reach', 'Add texture and model tiers', 'Source dimensions + live renderer ablation',
     f'{code("src/soldierModelAssets.ts",187)}; {code("src/importedWeapons.ts",108)}; {code("src/renderer.ts",69)}',
     'Compress appropriate imported atlases; generate smaller world-actor textures and distance LODs, including simplified hands/shadow casters. Preserve first-person sights and gameplay hitboxes. High asset/visual-QA effort.'),
    ('4 · GPU', 'Make world shadows quality-aware', 'Repeated local GPU A/B; modest 1024 benefit',
     f'{code("src/renderer.ts",55)}; {code("src/renderer.ts",69)}; {code("src/renderer.ts",249)}',
     'Medium currently retains the 2048 world map while shrinking only the weapon map. Trial 1024, then isolate static/dynamic shadow work if warranted. Frozen moving shadows are diagnostic only. Check contact and distant aliasing.'),
    ('5 · GPU recovery', 'Allow lower desktop adaptive resolution', 'Configuration gap; workload-dependent benefit',
     f'{code("src/main.ts",72)}; {code("src/adaptiveResolution.ts",5)}; {code("src/adaptiveResolution.ts",14)}',
     'Desktop floor 1.5 makes medium/DPR1 fixed and limits high to 1.75→1.5; touch already permits .75. Trial a user-visible 1.0 or .75 floor and pixel-count cap with hysteresis. Do not lower resolution to fix CPU bottlenecks.'),
    ('6 · Local CPU', 'Integrate parity-tested A* improvements', 'Prototype evidence below; production integration pending',
     f'{code("src/navigation.ts",5)}; {code("src/navigation.ts",9)}; {code("src/aiCover.ts",106)}',
     'Use stable heap ordering, reusable indexed arrays and static adjacency; preserve full path output and risk semantics. Stagger only nonurgent planning if device traces still show tails. Keep simulation cadence unchanged.'),
    ('7 · Smaller wins', 'Remove duplicate presentation work', 'Code audit; measure before broad refactor',
     f'{code("src/materials.ts",82)}; {code("src/network.ts",285)}; {code("src/audio.ts",73)}',
     'Overlap non-KTX surface loads, preprocess immutable geometry once, and normalize network names at ingestion. Profile real multiplayer separately.'),
    ('8 · Conditional audio', 'Repeat on working audio hardware first', 'Stalled clock and saturated voice cap invalidate ordinary-audio inference',
     f'{code("src/audio.ts",57)}; {code("src/audio.ts",73)}; {code("src/audio.ts",79)}',
     'Verify clock progression and release lifecycle; inspect graceful stalled/interrupted handling. If ordinary hardware confirms control overhead, cache one time per batch, skip unchanged parameters and group emitters. Cadence changes need acoustic validation. Obstruction rays are already cached.'),
]
body.append('<section id="priorities"><h2>Ranked implementation backlog</h2>' + table(
    ['Priority', 'Change', 'Evidence', 'Code location', 'Implementation and acceptance'],
    [[text(a), f'<strong>{text(b)}</strong>', text(c), d, text(e)] for a,b,c,d,e in priority_rows]) + '</section>')

graphics_names = ['desktop-high-1.75','desktop-high-1.5','desktop-high-1','desktop-medium',
                 'medium-world1024','medium-world512','medium-no-world-shadow',
                 'medium-no-weapon-shadow','medium-frozen-world-shadow-diagnostic',
                 'medium-no-soldiers-diagnostic','desktop-low','phone-pixels-medium',
                 'phone-pixels-medium-0.75','phone-pixels-medium-world1024','phone-pixels-low','desktop-medium-repeat']
graphics_rows = []
for name in graphics_names:
    run = first_run(name)
    if not run:
        continue
    graphics_rows.append([text(name), ' × '.join(map(str,run.get('drawingBuffer', []))),
                          number(metric(run,'cpu')), number(metric(run,'gpu')),
                          number(metric(run,'frame','p95'),1), number(metric(run,'drawCalls'),0),
                          number(metric(run,'triangles'),0), 'valid' if run.get('valid') else '<strong>invalid</strong>'])
body.append(f'''<section id="graphics"><h2>Graphics: distinguish submission, GPU work and frame delivery</h2>
<p><span class="badge measured">Measured</span> {len(runs)} trials contain {number(sum(r.get('metrics',{}).get('gpu',{}).get('n',0) for r in runs),0)} GPU samples. Each uses six actors, scripted poses/effects, three seconds of warmup and nine measured seconds. The table preserves the first matrix pass; interleaved repeats remain in {link("browser-renderer.json", "raw renderer evidence")}. CPU includes presentation and submission; GPU queries measure execution asynchronously. Neither should be added directly to the frame interval.</p>''')
chart_names = ['desktop-medium','medium-world1024','medium-no-world-shadow','medium-frozen-world-shadow-diagnostic','medium-no-soldiers-diagnostic','desktop-low']
chart = []
for name in chart_names:
    value = metric(first_run(name),'gpu')
    if value is not None:
        chart.append(f'<div class="bar-row"><span>{text(name.replace("-diagnostic",""))}</span><div class="bar-track"><i style="width:{min(100,value / 6 * 100):.2f}%"></i></div><b>{value:.2f} ms</b></div>')
body.append('<figure aria-label="GPU execution time by renderer scenario"><figcaption>GPU mean · first matrix pass · lower is better</figcaption>' + ''.join(chart) + '</figure>')
body.append(table(['Scenario','Drawing buffer','CPU mean ms','GPU mean ms','Frame p95 ms','Draws mean','Triangles mean','Validity'], graphics_rows))
body.append(f'''<p><strong>World shadow resolution is a modest improvement, not the main solution.</strong> The 1024 trial saves {shadow_summary} GPU time against its initial or adjacent repeated medium control. It leaves geometry submissions essentially unchanged. Removing world shadows or freezing their updates removes much more work; that establishes the cost of an additional pass, not a shippable visual result. Shadow maps render casters from the light’s viewpoint, as described in the {link("https://threejs.org/manual/pages/shadows.html", "Three.js shadow manual")}.</p>
<p>The initial high-1.75 CPU result, 10.38 ms, is anomalous against later roughly 2.5 ms runs: first-scenario/host variance prevents attributing that gap to resolution. GPU time at 1.5 is not monotonically faster than 1.75. The .75 phone-shaped buffer also demonstrated no consistent benefit on this M3. Removing soldiers cuts animation and rendering together. Use repeated trials and bottleneck traces; preserve silhouettes and collision when implementing LOD.</p></section>''')

body.append('<section id="hitches"><h2>Animation hitches and the real main loop</h2>')
if animation and animation.get('runs'):
    animation_rows = []
    for run in animation['runs']:
        animation_rows.append([text(run.get('faction')),text(run.get('mode')),number(run.get('constructionMs')),
            number(run.get('alive',{}).get('p50'),3),number(run.get('death',{}).get('max')),
            str(run.get('worstDeathFrame','—')),str(len(run.get('hulls',[]))),
            number(sum(h.get('cpuMs',0) for h in run.get('hulls',[]))),
            'valid' if run.get('valid') else '<strong>invalid</strong>'])
    body.append(f'<p><span class="badge measured">Browser measured</span> Fresh rigs are compared with two actual pool reuses per faction. Timed pose calls exclude rendering; death rAF intervals include it. Scope is a standing rifle death, not every death/weapon combination. {link("browser-animation.json", "Raw animation evidence")}</p>')
    body.append(table(['Faction','Model state','Construct ms','Alive p50 ms','Death max ms','Worst frame','Hull calls','Hull CPU total ms','Validity'],animation_rows))
    fresh=[r for r in animation['runs'] if r.get('valid') and r.get('mode')=='fresh']
    reused=[r for r in animation['runs'] if r.get('valid') and str(r.get('mode','')).startswith('pooled')]
    if fresh and reused:
        fresh_summary=', '.join(f'{text(r["faction"].title())} {number(r["death"]["max"],1)} ms' for r in fresh)
        pooled_min=min(r['death']['max'] for r in reused)
        pooled_max=max(r['death']['max'] for r in reused)
        body.append(f'<p><strong>Retained warmed browser evidence confirms the first-death hitch:</strong> fresh rigs peaked at {fresh_summary}. Pool reuse peaks were {number(pooled_min,1)}–{number(pooled_max,1)} ms. Fresh runs each built two hand hulls at frame 5; reused rigs kept the same faction model UUID and built none. These figures describe the saved warmed pass; unretained exploratory cold observations are excluded.</p>')
else:
    body.append(absent('Browser fresh/pooled animation evidence'))
node_results = node_animation.get('results',[])
if node_results:
    death_maxes = [r['firstDeathFirst100']['max'] for r in node_results]
    body.append(f'<p><span class="badge measured">Node corroboration</span> First-death worst pose calls span {number(min(death_maxes))}–{number(max(death_maxes))} ms across the saved trials. These use actual geometry with image stubs and no GPU; they are not browser frame times. {link("animation-node-microbenchmark.json", "Raw Node animation evidence")}</p>')
body.append(f'''<p>The first release of each hand traverses skinned vertices and builds a convex hull at {code("src/soldierAnimation.ts",death_hull_line)}. The result is cached on that hand and weapon slot. Startup warms shaders and ordinary poses but does not exercise this branch. Move exact envelope work out of visible combat and verify that cache ownership survives pooling without sharing mutable skeletons. A first-death spike is more actionable than an isolated maximum from a long mixed workload.</p>''')
if session:
    body.append(f'<p><span class="badge measured">Actual main loop / environment-limited</span> {link(session_name, "Original full-session evidence")}: foreground/game-state validity <strong>{text(session.get("valid"))}</strong>; state samples {text(session.get("states",{}))}; player deaths {text(session.get("playerDeaths","unrecorded"))}. Offline simulation, rendering, HUD and effects ran with scripted turning/fire. A later diagnostic found stalled audio output; these frame/stage timings describe this harness setup, not typical gameplay with functioning audio. The validity flag does not check audio-clock progression.</p>')
    body.append(table(['Timed scope','Calls','Mean ms','p95 ms','p99 ms','Max ms'],[
        [text(k),number(v.get('n'),0),number(v.get('mean'),3),number(v.get('p95'),3),number(v.get('p99'),3),number(v.get('max'),3)]
        for k,v in session.get('measurementsMs',{}).items()]))
else:
    body.append(absent('Real main-loop session evidence'))
if session_reports:
    body.append('<h3>Audio diagnostics: stalled output, not a typical-play bottleneck</h3>')
    rows=[]
    for name,data in session_reports:
        diagnostic=data.get('audioDiagnostic',{})
        cadence=diagnostic.get('routingHz','every frame / count not recorded')
        audio_stats=data.get('measurementsMs',{}).get('audioRouting',{})
        elapsed=diagnostic.get('audioElapsedSeconds')
        acoustic_status='invalid — clock stalled' if elapsed == 0 else 'not established — clock unmeasured' if elapsed is None else 'requires acoustic validation'
        rows.append([link(name),text(cadence),number(audio_stats.get('mean'),3),number(audio_stats.get('p95'),3),
                     number(diagnostic.get('routingCalls'),0),number(diagnostic.get('voices',{}).get('mean'),1),
                     number(elapsed,3),text(diagnostic.get('contextStates','not recorded')),text(acoustic_status)])
    body.append(table(['Session evidence','Routing cadence','Mean / frame ms','p95 ms','Actual routes','Mean voices','Audio elapsed s','Context samples','Ordinary-audio inference'],rows))
    body.append(f'''<p><strong>The 30 Hz experiment’s AudioContext reported “running” but its clock stayed at 0.005333 seconds for the entire 30-second window.</strong> Voices averaged 95.67 against a cap of 96. The instrumented baseline also averaged 95.82 voices; its clock was not measured, so the same stall is suspected rather than directly established. Earlier sessions lack both checks. Scheduled short sources therefore cannot be assumed to have normal playback/release behavior.</p>
<p>The diagnostic measured 900 routing updates and 0.224 ms/frame versus the saturated baseline’s 3,600 updates and 1.984 ms/frame. <strong>This is not a validated ordinary-game optimization or an acoustic comparison.</strong> Repeat with working output hardware, progressing currentTime and expected voice lifetimes before prioritizing audio. Inspect graceful stalled/interrupted handling. Only then test change-only parameters and a shared batch time at {code("src/audio.ts",79)}, preserving immediate initial placement and existing obstruction caching. No leak or normal-game savings percentage is inferred.</p>''')
body.append('''<p>Per-method samples are per call: offline simulation runs at 120 Hz and can run several updates in one frame. HUD timing covers UI.update only; audio routing covers endSceneUpdate only. Event handling, voice creation, audio-thread DSP, other DOM updates and deferred layout/paint are outside those categories. Session seed is fixed after initial spawn placement; the session is comparable, not an exact replay. Invalid or paused runs must not support an active-play conclusion.</p></section>''')

body.append(f'''<section id="assets"><h2>Startup and memory: source bytes are not resident memory</h2>
<p><span class="badge arithmetic">Inventory</span> Successful imported model paths bypass {number(legacy_bytes,0)} bytes of legacy assets that still block startup; browser resource timing confirms all 11 requests. Their dimensions imply {number(legacy_base / 1048576,0)} MiB of RGBA base-level decoded storage, <em>not measured process memory or GPU savings</em>. Unused textures may never upload. GLB/JPEG dependencies total 87.40 MB of source files; compressed replacements plus Basis raise that to 95.02 MB before JS, profiles, menu and fonts. {link("asset-inventory.json", "Asset inventory")}; {link("startup-findings.txt", "dependency trace")}</p>''')
asset_rows=[]
for row in inventory:
    if row.get('kind') != 'glb' or not any(x in row['path'] for x in ('imported-weapons/','imported-soldiers/','makehuman/')):
        continue
    asset_rows.append([text(row['path'].replace('public/assets/','')),number(row['bytes']/1e6),
                      number(row['triangles'],0),str(len(row['images'])),
                      number(sum(i['rgba8_mips'] for i in row['images'])/1048576)])
body.append(table(['Asset','Source MB','Source triangles','Embedded images','RGBA8 + mips MiB'],asset_rows))
startup=renderer.get('startup',{})
body.append(f'''<p>The local renderer harness recorded {number(startup.get('postModuleReadyMs',startup.get('readyMs')))} ms from post-module initialization to ready, including {number(startup.get('viewConstructionMs'))} ms View construction and {number(startup.get('prepareMs'))} ms preparation. Static imports have already executed when that clock starts. Loopback delivery and unknown disk-cache state do not establish cold navigation time on a mobile network.</p>
<p>All embedded GLB images sum to {number(embedded_bytes/1048576,2)} MiB under RGBA8/mipmap arithmetic; this includes unused or runtime-removed images. Compressed GPU formats change that budget. File compression alone does not shrink decoded dimensions; see the {link("https://threejs.org/manual/pages/textures.html", "Three.js texture-memory explanation")}. Create explicit texture tiers, atlas/compression variants and world-model LODs. Share immutable geometry with safe disposal, and retain independent rigs. Three r180 can share GPU backing for cloned textures with the same source/sampler; counting clones is insufficient.</p>
<p>Start non-KTX maps while compressed surfaces download/transcode, instead of waiting at {code("src/materials.ts",82)}. Stage menu readiness separately from selected-loadout readiness. Existing KTX files save roughly 60 MiB for six maps but add about 7.6 MB including Basis to source payload; compression must be judged on both upload memory and cold loading.</p></section>''')

body.append('<section id="simulation"><h2>Simulation, networking, audio and server limits</h2>')
if cpu:
    body.append(f'<p><span class="badge measured">Node / actual 120 Hz step</span> {link("cpu-benchmark-120hz.json", "Primary CPU evidence")}. Three seeds per difficulty; no renderer, audio, browser scheduling or networking. These later runs record dirty core source paths during concurrent edits, so they are not exact same-revision comparisons with the earlier loaded browser renderer.</p>')
    groups={}
    for run in cpu.get('simulations',[]):
        groups.setdefault(run.get('difficulty','unknown'),[]).append(run)
    body.append(table(['Difficulty','Runs','Mean tick ms¹','Per-run p99 range ms','Worst tick ms'],[
        [text(name),str(len(group)),number(statistics.mean(r['mean'] for r in group),3),
         f'{number(min(r["p99"] for r in group),3)}–{number(max(r["p99"] for r in group),3)}',
         number(max(r['max'] for r in group))] for name,group in groups.items()]))
    body.append('<p class="caption">¹ Mean of equal-sized runs. Percentiles are ranges across runs, not pooled percentiles. OS scheduling and GC can affect maxima.</p>')
    simulations=cpu.get('simulations',[])
    if simulations:
        body.append(f'<p>The nine saved workloads averaged {number(min(r["mean"] for r in simulations),3)}–{number(max(r["mean"] for r in simulations),3)} ms per tick; worst tick {number(max(r["max"] for r in simulations),2)} ms, with {sum(r.get("over16_67ms",0) for r in simulations)} ticks over 16.67 ms. Local simulation is not a sustained bottleneck on this host in this probe. Planner improvements provide headroom; low-end-device benefit remains to be measured.</p>')
else:
    body.append(absent('Exclusive actual-120-Hz CPU evidence'))
if navigation:
    body.append(f'<p><span class="badge prototype">Prototype, not shipped</span> Exact complete paths matched in {text(navigation.get("exactPathComparisons"))} comparisons. A stable heap, reusable typed arrays and precomputed adjacency replace current maps and linear open-set selection. Full-grid nearest lookup remains. Risk costs were cached equally for both timing variants. {link("navigation-prototype.json", "Prototype evidence")}</p>')
    nav_rows=[]
    for label,a,b in [('Ordinary path','baseline','prototype'),('Cached risk field','baselineRiskFieldCached','prototypeRiskFieldCached')]:
        before=navigation.get(a,{}).get('medianMicroseconds');after=navigation.get(b,{}).get('medianMicroseconds')
        nav_rows.append([label,number(before),number(after),f'{number(before/after)}×' if before and after else '—'])
    body.append(table(['Warmed batch-pass median','Current µs/path','Prototype µs/path','Ratio'],nav_rows))
else:
    body.append(absent('Navigation prototype timing/parity evidence'))
if profile:
    body.append(f'<details><summary>Separate V8 CPU sampling attribution · {number(profile.get("totalSamples"),0)} samples</summary><p>Self-sample shares are workload-specific, not end-to-end frame attribution. tsx transforms can produce anonymous/helper names and line-1 locations; these are not exact original-source line attribution. {link("simulation-profile-summary.json", "Sampling summary")}</p>' + table(
        ['Function','V8 transformed line','Self-sample share %'],[[text(r.get('name')),text(r.get('line')),number(r.get('sharePercent'))] for r in profile.get('top',[])[:8]]) + '</details>')
body.append(f'''<p>Bot planners synchronously search a 2,016-cell grid; tactical cover can request three risk-aware paths. Integrate algorithm improvements with exact route ordering tests, then consider bounded planning only if physical-device tails remain. Cache immutable collision math and use conservative broad-phase rejection before exact hit-volume construction. Six actors and 22 boxes do not justify a complex spatial index by themselves. {link("simulation-findings.txt", "Detailed simulation/network/server findings")}</p>
<p>Multiplayer already uses compact full MessagePack snapshots. Repeated interpolation and name/object rebuilding at {code("src/network.ts",487)} are allocation candidates; preserve delayed authority presentation. Worker-backed audio, obstruction caching and a 96-voice cap already exist. The synchronous rifle fallback measured roughly 9–10 ms at 48 kHz in Node; prioritize first-use sample readiness, not a wholesale audio rewrite. {link("audio-synthesis-microbench.json", "Audio evidence")}</p>
<p><strong>Server capacity remains unmeasured.</strong> One Hub mutex surrounds sequential room updates ({code("server/src/main.rs",60)}, {code("server/src/hub.rs",724)}). Duplicate history snapshots and per-room navigation allocation are candidates, not demonstrated saturation. Benchmark release Rust with increasing occupied rooms, realistic bots/shots and network jitter; record p95/p99 tick time, lock wait, input lateness and queue age before sharding. Admission caps are not capacity guarantees.</p></section>''')

body.append('<section id="devices"><h2>Device tiers: starting proposals, not validated defaults</h2><p>Choose tiers from measured budgets and user override; touch input alone is not a GPU class. Keep movement, recoil, authoritative hitboxes and network timing identical across visual tiers.</p>')
body.append(table(['Initial test tier','Resolution policy','Shadow trial','Assets / target'],[
    ['Constrained phone / older integrated GPU','DPR cap 1; adaptive floor .75; test output-pixel cap','Off or 512 world; optional contact-only weapon','512–1024 world maps, compressed atlases, aggressive distant LOD; test sustainable 30/60 Hz'],
    ['Midrange phone / integrated laptop','DPR cap 1–1.25; adaptive floor .75–1','1024 world, 512–1024 weapon','1024 world maps, selected close-up detail, medium LOD; target 60 Hz with headroom'],
    ['Strong laptop / desktop / flagship phone','DPR cap 1.5–1.75 with recoverable 1.0 floor','1024/2048 based on measurement; retain close contacts','Higher close-up textures; distance LOD still active; optional 120 Hz target'],
]))
body.append('<h3>Required physical-device validation</h3>')
body.append(table(['Representative hardware','Browser / concern','Required workloads'],[
    ['Older supported iPhone and current iPhone','Safari/WebKit; context pressure, thermal throttling','Cold/warm load, touch, all factions, fresh/pool deaths, 15-minute soak'],
    ['Low/mid Android, 4–6 GB; flagship Android','Chrome, Adreno and Mali where available','Same combat plus low-memory pressure, background/resume and battery mode'],
    ['Older Windows integrated laptop; modern integrated laptop','Chrome + Edge; shared memory, AC versus battery','1080p/1440p, high DPI, shadow/LOD tiers, 60 Hz target'],
    ['Discrete GPU desktop; current Apple laptop','Chrome/Safari where supported; 60/120/144 Hz','Regression reference, first-person sight quality, high-refresh CPU cost'],
]))
body.append('''<p>For every combination record CPU/GPU frame p50/p95/p99, missed frame budgets, first-shot/first-death spikes, context losses, startup bytes/decode/upload, temperature and sustained performance. Run offline and six-player online sessions with controlled latency/jitter, team changes, respawn, replay and background recovery. Use cold-cache and warm-cache runs separately, repeated A/B ordering and screenshots at equivalent camera poses. Release criteria should include no visual/contact regressions and no hitbox or timing changes.</p>
<p>Browser device mode approximates selected properties; it cannot reproduce another phone’s processor, GPU, memory pressure or thermal behavior. The <a href="https://developer.chrome.com/docs/devtools/device-mode">official Chrome Device Mode guide</a> recommends real-device testing for those limitations. Smaller viewports and CPU throttling are useful diagnostics, not certification.</p></section>''')

body.append(f'''<section id="method"><h2>Method, existing work and reproducibility</h2>
<p>Existing optimizations include static batching, conservative offscreen pose culling, effect/model pooling, hidden front-menu rendering, shader/texture warmup, bounded adaptive resolution, six KTX surface maps, change-driven HUD updates and worker audio synthesis. Server transport already bounds stale snapshots and moves encoding/storage outside critical work. Preserve these; the older {link("../../research/performance.md", "performance report")} is historical evidence, not a current whole-game baseline. WebGPU still requires custom-material migration and has no demonstrated complete-game win here.</p>
<p><strong>This was a working-tree audit during concurrent edits, not a clean release baseline.</strong> The renderer pass retained its loaded modules with HMR disabled; its {link('source-manifest.json','source manifest')} records HEAD {text(manifest.get('head','af968c6231539f5e4edc059b85149adebdc87ccd')[:7])}, hashes and the infrastructure-only dirty state at capture. Later CPU exports record dirty soldier animation/gait/motion and hitbox sources as foot-roll work proceeded. Do not infer identical source across subsystems or make exact cross-subsystem comparisons. The legacy-preload, quality-setting and death-hull logic underlying the rankings remained applicable.</p>
<p>Renderer scenarios exclude AI/network/UI; Node probes exclude browser/GPU. No result measures production server load. First-matrix versus repeat timings vary; source bytes, isolated microseconds and ablations cannot establish a promised FPS percentage. Current source links locate audited logic; later edits can move lines.</p>
<p>Heap start/end readings are snapshots without forced GC; native images, AudioContext and GPU allocations are not fully represented. One shared View accumulates warm shader/effect caches across scenarios. Renderer resource counts are counts, not bytes. Therefore neither heap deltas nor the source-image inventory demonstrate a leak. A leak investigation needs repeated lifecycle cycles, post-GC retained objects and native/GPU corroboration.</p>
<p>Browser JSON timestamps may use UTC on October 17; this report uses the requested local date, October 16. Timing exports include their own environment and method. Source links identify exact inspected lines, which may move after implementation.</p>
<h3>Reproduce in separate measurement windows</h3><pre><code>npm run dev -- --config scripts/performance-vite.config.ts --port 5184
# Open each page, keep foreground, click its run controls:
# /scripts/performance-device-profile.html
# /scripts/performance-animation-profile.html
# /scripts/performance-session-profile.html?visits=0
# /scripts/performance-session-profile.html?visits=0&amp;routingHz=30  # diagnostic

python3 scripts/performance-asset-audit.py       # requires Pillow
node --import tsx scripts/performance-animation-audit.ts
node --import tsx scripts/performance-audio-synthesis.ts
node --import tsx scripts/performance-cpu-audit.ts
node --import tsx scripts/performance-cpu-audit.ts --profile
node --import tsx scripts/performance-navigation-prototype.ts
python3 scripts/performance-report.py           # reads evidence only</code></pre>
<p>Do not overlap CPU probes with browser timing. The profiling server disables HMR and saves same-origin measurements under temp/performance-audit. Run application regression checks after any optimization; this report generator does not modify production assets or execute benchmarks.</p>''')
evidence_names = [
    'source-manifest.json','browser-renderer.json','browser-animation.json','browser-session.json','asset-inventory.json',
    'asset-summary.json','source-assets.json','animation-node-microbenchmark.json',
    'audio-synthesis-microbench.json','cpu-benchmark-120hz.json','simulation-profile-summary.json',
    'navigation-prototype.json','startup-findings.txt','simulation-findings.txt',
]
evidence_names += [name for name,_ in session_reports if name not in evidence_names]
body.append('<div class="evidence">' + ''.join(link(name) for name in evidence_names if (DEST/name).exists()) + '</div></section>')

css = '''
:root{color-scheme:light;--ink:#182e36;--muted:#576b73;--line:#d7e2e5;--teal:#167877;--paper:#f3f7f7}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.58 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:1380px;margin:auto;padding:48px 38px 70px}header{max-width:1040px;padding-bottom:26px}.eyebrow{font-size:12px;letter-spacing:.17em;font-weight:800;color:var(--teal)}h1{font-size:clamp(32px,4vw,54px);letter-spacing:-.035em;line-height:1.12;margin:12px 0 20px;max-width:1000px}.deck{font-size:21px;line-height:1.5;color:var(--muted);max-width:900px}.meta{font-size:12px;color:var(--muted)}
nav{display:flex;flex-wrap:wrap;gap:10px 23px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:16px 0;margin-bottom:30px}a{color:#0b686c;text-underline-offset:3px}nav a{font-weight:650;text-decoration:none}.lead{background:#e3efec;border-left:5px solid var(--teal);padding:20px 24px;border-radius:4px}.lead p:first-child{margin-top:0}.lead p:last-child{margin-bottom:0}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin:24px 0 38px}.cards article{display:flex;flex-direction:column;align-items:flex-start;background:white;border:1px solid var(--line);border-radius:8px;padding:22px}.cards strong{font-size:38px;letter-spacing:-.04em;margin:8px 0}.cards article>span:last-child{color:var(--muted);font-size:14px}
section{margin:36px 0}section p{max-width:1080px}h2{font-size:28px;letter-spacing:-.025em;margin:40px 0 16px}h3{font-size:20px;margin:28px 0 12px}.badge{display:inline-block;border-radius:3px;padding:3px 7px;font-size:10px;line-height:1.4;letter-spacing:.06em;text-transform:uppercase;font-weight:800;vertical-align:middle;margin-right:4px}.measured{background:#d4eee7;color:#115b4b}.arithmetic{background:#e2e8f9;color:#2c4c8b}.prototype{background:#f8e7c6;color:#79500a}.pending{background:#fff4de;border:1px solid #e8d8b4;border-radius:5px;padding:14px;color:#785719}
.table-scroll{overflow:auto;border:1px solid var(--line);border-radius:7px;background:white;margin:17px 0 20px}table{width:100%;border-collapse:collapse;font-size:12px;line-height:1.5}th{text-align:left;background:#e9eff0;color:#3c545e;white-space:nowrap;padding:12px}td{vertical-align:top;padding:12px;border-top:1px solid #e6edee}tr:nth-child(even) td{background:#fafcfc}td a{overflow-wrap:anywhere}#priorities th:nth-child(5){min-width:320px}#priorities td:nth-child(1){white-space:nowrap}#priorities td:nth-child(4){min-width:180px}
figure{background:white;border:1px solid var(--line);border-radius:7px;padding:20px 24px;margin:23px 0}figcaption{font-size:14px;font-weight:750;margin-bottom:16px}.bar-row{display:grid;grid-template-columns:290px 1fr 80px;gap:15px;align-items:center;margin:11px 0;font-size:12px}.bar-track{background:#eaf0ef;height:19px;border-radius:3px;overflow:hidden}.bar-track i{display:block;height:100%;background:var(--teal);border-radius:3px}.bar-row b{text-align:right;font-variant-numeric:tabular-nums}.caption{font-size:12px;color:var(--muted)}pre{overflow:auto;background:#142d36;color:#e1efec;border-radius:7px;padding:22px;font:12px/1.65 ui-monospace,SFMono-Regular,monospace}details{background:white;border:1px solid var(--line);border-radius:6px;padding:15px;margin:20px 0}summary{cursor:pointer;font-weight:650}.evidence{display:flex;flex-wrap:wrap;gap:10px 20px;font-size:12px;border-top:1px solid var(--line);padding-top:20px}
@media(max-width:800px){main{padding:24px 16px}.cards{grid-template-columns:1fr}.cards strong{font-size:30px}.bar-row{grid-template-columns:1fr 80px}.bar-row>span{grid-column:1/-1}.deck{font-size:18px}h2{font-size:24px}figure{padding:16px}}
@media print{body{background:white}main{padding:0}nav{display:none}h2{break-after:avoid}tr,figure,.cards{break-inside:avoid}a{color:inherit}.table-scroll{overflow:visible}pre{white-space:pre-wrap}}
'''
document = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Bolts performance audit · October 16, 2026</title><style>' + css + '</style></head><body><main>' + ''.join(body) + '</main></body></html>'
DEST.mkdir(parents=True, exist_ok=True)
(DEST / 'report.html').write_text(document)
print(f'Wrote {DEST / "report.html"} ({len(document):,} characters; {len(runs)} renderer trials).')
