/** Reproduce: node --import tsx scripts/performance-cpu-audit.ts
 * Optional V8 sampling profile: append --profile.
 * Optional method timings (separate from sampling): append --instrument.
 * CPU-only Node microbenchmarks; no GPU, browser, network, or physical-device claims.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cpus, platform, arch } from 'node:os';
import { performance } from 'node:perf_hooks';
import { Session } from 'node:inspector';
import { execFileSync } from 'node:child_process';
import { Game, createActor, type Input } from '../src/engine.ts';
import { ARENA, BOXES, SPAWNS, visible, worldHit, type Difficulty, type Vec } from '../src/config.ts';
import { findPath } from '../src/navigation.ts';
import { selectTacticalCover, type TacticalThreat } from '../src/aiCover.ts';
import { sampleHitVolumes, rayHitVolumes } from '../src/hitboxes.ts';
import { resolveActorMovement } from '../src/actorCollision.ts';
import { initialMotion } from '../src/soldierMotionState.ts';
import { NetworkClient, type WireSnapshot } from '../src/network.ts';
import { decodeMessage, encodeInput } from '../src/networkCodec.ts';
import fixture from '../shared/fixtures/codec-v3.json';

const directory = 'temp/performance-audit';
const simulationHz = Number(process.argv.find(value => value.startsWith('--hz='))?.slice(5) ?? 120);
if (![60, 120].includes(simulationHz)) throw new Error('Expected --hz=60 or --hz=120');
const source = { head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), trackedDirtyPaths: execFileSync('git', ['diff', 'HEAD', '--name-only'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean), srcSha256: Object.fromEntries(execFileSync('git', ['ls-files', '-z', 'src'], { encoding: 'utf8' }).split('\0').filter(Boolean).map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])) };
mkdirSync(directory, { recursive: true });
let sink: unknown;
function quantiles(samples: number[]) {
  const sorted = samples.slice().sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  return { count: sorted.length, mean: sorted.reduce((a, b) => a + b, 0) / sorted.length, p50: at(.5), p95: at(.95), p99: at(.99), max: at(1) };
}
function benchmark(action: (i: number) => unknown, iterations: number, warmup = 1000) {
  for (let i = 0; i < warmup; i++) sink = action(i);
  const samples: number[] = [];
  for (let pass = 0; pass < 7; pass++) {
    const start = performance.now();
    for (let i = 0; i < iterations; i++) sink = action(i);
    samples.push((performance.now() - start) * 1000 / iterations);
  }
  return { units: 'microseconds/operation', iterationsPerPass: iterations, passes: 7, ...quantiles(samples) };
}
function createGame(difficulty: Difficulty, seed: number) {
  const original = Date.now;
  Date.now = () => seed;
  try { const game = new Game(); game.start('british', difficulty); return game; }
  finally { Date.now = original; }
}
function simulation(difficulty: Difficulty, seed: number, ticks: number, instrument = false) {
  const game = createGame(difficulty, seed), samples: number[] = [];
  const cumulative: Record<string, { count: number; totalMs: number; maxMs: number }> = {};
  if (instrument) for (const name of ['updateAI', 'move', 'fire', 'record', 'spawn'] as const) {
    const original = game[name].bind(game) as (...args: any[]) => any;
    (game as any)[name] = (...args: any[]) => {
      const started = performance.now();
      try { return original(...args); } finally {
        const elapsed = performance.now() - started, entry = cumulative[name] ??= { count: 0, totalMs: 0, maxMs: 0 };
        entry.count++; entry.totalMs += elapsed; entry.maxMs = Math.max(entry.maxMs, elapsed);
      }
    };
  }
  let kills = 0, shots = 0, playerDeaths = 0;
  const spikes: { tick: number; ms: number; time: number; events: string[] }[] = [];
  for (let i = 0; i < ticks; i++) {
    if (game.state === 'killcam') { game.skipReplay(); playerDeaths++; }
    game.player.yaw = i / (simulationHz * 3);
    const input: Input = { forward: 1, right: Math.sin(i / (simulationHz * 4)), jump: i % Math.round(simulationHz * 307 / 60) === 0, walk: false, lean: 0 };
    const start = performance.now();
    if (i % (simulationHz / 2) === 0) game.fire();
    game.update(1 / simulationHz, input);
    const elapsed = performance.now() - start;
    samples.push(elapsed);
    if (elapsed > 4) spikes.push({ tick: i, ms: elapsed, time: game.time, events: game.events.map(e => e.type) });
    for (const event of game.events) {
      if (event.type === 'shot') shots++;
      if (event.type === 'kill') kills++;
    }
    game.events.length = 0;
  }
  return { difficulty, seed, ticks, simulationHz, simulatedSeconds: ticks / simulationHz, units: 'milliseconds/tick', ...quantiles(samples), over4ms: samples.filter(v => v > 4).length, over16_67ms: samples.filter(v => v > 1000 / 60).length, shots, kills, playerDeaths, instrumentedInclusiveMethods: cumulative, largestSpikes: spikes.sort((a, b) => b.ms - a.ms).slice(0, 12) };
}

const profileMode = process.argv.includes('--profile');
const instrumentMode = process.argv.includes('--instrument');
if (profileMode && instrumentMode) throw new Error('Run --profile and --instrument separately to avoid mixed overhead');
if (profileMode) {
  const session = new Session(); session.connect();
  const post = (method: string, params: any = {}) => new Promise<any>((resolve, reject) => session.post(method as any, params, (error, result) => error ? reject(error) : resolve(result)));
  for (const difficulty of ['recruit', 'regular', 'veteran'] as const) simulation(difficulty, 12345, 3600);
  await post('Profiler.enable'); await post('Profiler.setSamplingInterval', { interval: 100 }); await post('Profiler.start');
  const results = ['recruit', 'regular', 'veteran'].map((difficulty, i) => simulation(difficulty as Difficulty, 8128 + i, 17990));
  const { profile } = await post('Profiler.stop'); session.disconnect();
  writeFileSync(`${directory}/simulation.cpuprofile`, JSON.stringify(profile));
  writeFileSync(`${directory}/simulation-profile-workloads.json`, JSON.stringify(results, null, 2) + '\n');
  const counts = new Map<number, number>();
  for (const id of profile.samples ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
  const total = (profile.samples ?? []).length;
  const top = profile.nodes.map((node: any) => ({ name: node.callFrame.functionName || '(anonymous)', url: node.callFrame.url, line: node.callFrame.lineNumber + 1, samples: counts.get(node.id) ?? 0, sharePercent: (counts.get(node.id) ?? 0) / total * 100 })).sort((a: any, b: any) => b.samples - a.samples).slice(0, 35);
  const nodeById = new Map(profile.nodes.map((node: any) => [node.id, node])), parents = new Map<number, number>();
  for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
  const inclusive = new Map<string, number>(), self = new Map<string, number>();
  for (const id of profile.samples ?? []) {
    const leaf: any = nodeById.get(id), name = leaf?.callFrame.functionName || '(anonymous)'; self.set(name, (self.get(name) ?? 0) + 1);
    const seen = new Set<string>();
    for (let current: number | undefined = id; current !== undefined; current = parents.get(current)) {
      const node: any = nodeById.get(current), name = node?.callFrame.functionName || '(anonymous)';
      if (!seen.has(name)) { inclusive.set(name, (inclusive.get(name) ?? 0) + 1); seen.add(name); }
    }
  }
  const shares = (values: Map<string, number>) => [...values].map(([name, samples]) => ({ name, samples, sharePercent: samples / total * 100 })).sort((a, b) => b.samples - a.samples);
  writeFileSync(`${directory}/simulation-profile-summary.json`, JSON.stringify({ source, simulationHz, intervalMicroseconds: 100, totalSamples: total, note: 'Sample shares, not device FPS. Inclusive shares overlap. tsx/esbuild inserts __name helpers and source positions are transformed; source line references require the original files.', inclusiveByFunction: shares(inclusive), selfByFunction: shares(self), top }, null, 2) + '\n');
  console.log(JSON.stringify({ results, top }, null, 2));
} else if (instrumentMode) {
  for (const difficulty of ['recruit', 'regular', 'veteran'] as const) simulation(difficulty, 12345, 3600);
  const results = ['recruit', 'regular', 'veteran'].map((difficulty, i) => simulation(difficulty as Difficulty, 8128 + i, 17990, true));
  writeFileSync(`${directory}/simulation-instrumented.json`, JSON.stringify({ source, method: 'Inclusive method timings with nested double-counting and instrumentation overhead; not a frame-time benchmark or CPU utilization breakdown.', results }, null, 2) + '\n');
  console.log(JSON.stringify(results, null, 2));
} else {
  for (const difficulty of ['recruit', 'regular', 'veteran'] as const) simulation(difficulty, 12345, 3600);
  const simulations = ['recruit', 'regular', 'veteran'].flatMap((difficulty, index) => [0, 1, 2].map(pass => simulation(difficulty as Difficulty, 8128 + index + pass * 100, 17990)));
  const origins = SPAWNS.map(p => ({ ...p, y: 0 }));
  const threats: TacticalThreat[] = origins.slice(1, 4).map((point, id) => ({ id, point: { ...point, y: 1.65 }, time: 10, confidence: 1 - id * .2 }));
  const actor = createActor(0, 'british', 'Benchmark'); actor.x = 0; actor.z = 0; actor.moving = 4; actor.yaw = .3;
  actor.pose = initialMotion(actor, 10);
  const samplePose = (i: number) => { actor.pose!.phase = i / 30; return sampleHitVolumes(actor, 10 + i / 60); };
  const actors = [actor, ...origins.slice(0, 5).map((p, i) => Object.assign(createActor(i + 1, 'russian', 'Benchmark'), p))];
  const volumes = sampleHitVolumes(actor, 10), origin = { x: 0, y: 1.5, z: -8 }, direction = { x: 0, y: 0, z: 1 };
  const binary = Buffer.from((fixture as any).snapshotHex, 'hex');
  const packet = decodeMessage(binary) as WireSnapshot;
  let now = 10000;
  const network = new NetworkClient(new Game(), { origin: 'http://localhost', now: () => now });
  // Test-only injection selects the fixture actor without a live server/session.
  Object.assign(network as any, { online: true, actorId: packet.actors[0].id, lobbyId: packet.lobbyId ?? '' });
  if (!network.receiveSnapshot(packet)) throw new Error('Fixture snapshot rejected');
  const microbenchmarks = {
    pathAcrossMap: benchmark(i => findPath(origins[i % origins.length], origins[(i + 3) % origins.length]), 300, 100),
    coverOneThreat: benchmark(i => selectTacticalCover(origins[i % origins.length], threats.slice(0, 1), { role: 0, retreat: true }), 100, 30),
    coverThreeThreats: benchmark(i => selectTacticalCover(origins[i % origins.length], threats, { role: 0, retreat: true }), 100, 30),
    hitVolumeSample: benchmark(samplePose, 10000),
    rayVolumesPrecomputed: benchmark(() => rayHitVolumes(origin, direction, volumes), 100000),
    rayVolumesWithPoseSample: benchmark(i => rayHitVolumes(origin, direction, samplePose(i)), 10000),
    worldRay22Boxes: benchmark(() => worldHit(origin, direction), 100000),
    visibility22Boxes: benchmark(i => visible({ ...origins[i % origins.length], y: 1.65 }, { ...origins[(i + 3) % origins.length], y: 1.65 }), 50000),
    collisionSixActorsClear: benchmark(() => resolveActorMovement(actor, actors, .08, 0), 100000),
    binarySnapshotDecodeSixActors: benchmark(() => decodeMessage(binary), 10000),
    binaryInputEncode: benchmark(() => encodeInput((fixture as any).inputs[0].input), 50000),
    networkPresentSixActors: benchmark(() => network.present(.5), 10000),
  };
  const report = { measuredAt: new Date().toISOString(), source, machine: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model }, method: `Warmed single-process CPU-only benchmark (3,600 warm-up ticks per difficulty). Each simulation is 17,990 ticks (${(17990 / simulationHz).toFixed(2)} simulated seconds), ${simulationHz} Hz, six actors, deterministic seed, continuously moving/firing player, killcam skipped immediately; event queue drained each tick. No rendering, audio, networking, browser scheduling, thermal soak, or device emulation. Per-tick timings include player fire when requested; microbenchmarks use seven batch passes. Do not convert these CPU times into device FPS. Instrumented/profile timings are recorded separately.`, map: { ...ARENA, boxes: BOXES.length, navigationCells: Math.floor(ARENA.width / .7) * Math.floor(ARENA.depth / .7) }, simulations, microbenchmarks, codecBytes: { snapshot: binary.length, input: encodeInput((fixture as any).inputs[0].input).length } };
  writeFileSync(`${directory}/cpu-benchmark-${simulationHz}hz.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
void sink;
