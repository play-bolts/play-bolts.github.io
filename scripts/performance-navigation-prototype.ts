/** Isolated A* prototype; production navigation remains untouched.
 * Reproduce: node --import tsx scripts/performance-navigation-prototype.ts
 * Compare full paths and unchanged cost/edge/tie ordering before benchmarking.
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import { ARENA, SPAWNS, blocked, dist } from '../src/config.ts';
import { findPath, type RouteRisk } from '../src/navigation.ts';
import { coverExposure } from '../src/aiCover.ts';

const CELL = .7, W = Math.floor(ARENA.width / CELL), D = Math.floor(ARENA.depth / CELL), N = W * D;
const points = Array.from({ length: N }, (_, i) => ({ x: (i % W + .5) * CELL - ARENA.width / 2, z: (Math.floor(i / W) + .5) * CELL - ARENA.depth / 2 }));
const walkable = points.map(p => !blocked(p.x, p.z, 0, .43));
const edges = points.map((_, current) => {
  const x = current % W, z = Math.floor(current / W), values: { node: number; cost: number }[] = [];
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dz) continue;
    const nx = x + dx, nz = z + dz;
    if (nx < 0 || nx >= W || nz < 0 || nz >= D) continue;
    const node = nz * W + nx;
    if (!walkable[node] || dx && dz && (!walkable[z * W + nx] || !walkable[nz * W + x])) continue;
    values.push({ node, cost: Math.hypot(dx, dz) * CELL });
  }
  return values;
});
function nearest(p: { x: number; z: number }) {
  let best = -1, distance = Infinity;
  for (let i = 0; i < N; i++) if (walkable[i]) {
    const next = dist(points[i], p);
    if (next < distance) { best = i; distance = next; }
  }
  return best;
}
const costs = new Float64Array(N), parents = new Int32Array(N), versions = new Uint32Array(N), order = new Uint32Array(N), active = new Uint8Array(N);
interface Entry { node: number; score: number; order: number; version: number }
const less = (a: Entry, b: Entry) => a.score < b.score || a.score === b.score && a.order < b.order;
function heapPath(from: { x: number; z: number }, to: { x: number; z: number }, risk?: RouteRisk) {
  const start = nearest(from), end = nearest(to);
  if (start < 0 || end < 0) return [];
  costs.fill(Infinity); parents.fill(-1); versions.fill(0); active.fill(0);
  costs[start] = 0; active[start] = 1; order[start] = 0;
  const heap: Entry[] = [{ node: start, score: dist(points[start], points[end]), order: 0, version: 0 }];
  function push(entry: Entry) {
    let index = heap.length; heap.push(entry);
    while (index > 0) { const parent = (index - 1) >> 1; if (!less(entry, heap[parent])) break; heap[index] = heap[parent]; index = parent; }
    heap[index] = entry;
  }
  function pop() {
    const top = heap[0], tail = heap.pop()!;
    if (heap.length) {
      let index = 0;
      while (index * 2 + 1 < heap.length) {
        let child = index * 2 + 1;
        if (child + 1 < heap.length && less(heap[child + 1], heap[child])) child++;
        if (!less(heap[child], tail)) break;
        heap[index] = heap[child]; index = child;
      }
      heap[index] = tail;
    }
    return top;
  }
  let count = 0, serial = 0;
  while (heap.length && count < 5000) {
    const entry = pop(), current = entry.node;
    if (!active[current] || entry.version !== versions[current]) continue;
    count++;
    if (current === end) {
      const path = [points[end]];
      for (let previous = current; parents[previous] >= 0;) { previous = parents[previous]; path.push(points[previous]); }
      return path.reverse().slice(1);
    }
    active[current] = 0;
    for (const edge of edges[current]) {
      const node = edge.node, candidate = costs[current] + edge.cost * (1 + (risk ? Math.max(0, risk(points[node])) : 0));
      if (candidate < costs[node]) {
        costs[node] = candidate; parents[node] = current;
        if (!active[node]) { active[node] = 1; order[node] = ++serial; }
        versions[node]++;
        push({ node, score: candidate + dist(points[node], points[end]), order: order[node], version: versions[node] });
      }
    }
  }
  return [];
}

const pairs = SPAWNS.flatMap(from => SPAWNS.map(to => ({ from, to })));
let seed = 9248;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
for (let i = 0; i < 200; i++) pairs.push({ from: { x: (random() - .5) * ARENA.width, z: (random() - .5) * ARENA.depth }, to: { x: (random() - .5) * ARENA.width, z: (random() - .5) * ARENA.depth } });
const threat = [{ id: 1, point: { x: -13, y: 1.65, z: 15 }, time: 1, confidence: 1 }];
const riskCache = new Map<string, number>();
const risk: RouteRisk = p => { const key = `${p.x}:${p.z}`; let value = riskCache.get(key); if (value === undefined) { value = coverExposure({ ...p, y: 0 }, threat) * 2.5; riskCache.set(key, value); } return value; };
for (const { from, to } of pairs) for (const mode of [undefined, risk]) assert.deepEqual(heapPath(from, to, mode), findPath(from, to, mode));
let sink: unknown;
function bench(path: typeof findPath, mode?: RouteRisk) {
  for (const pair of pairs) sink = path(pair.from, pair.to, mode);
  const samples = Array.from({ length: 7 }, () => {
    const started = performance.now();
    for (const pair of pairs) sink = path(pair.from, pair.to, mode);
    return (performance.now() - started) * 1000 / pairs.length;
  }).sort((a, b) => a - b);
  return { medianMicroseconds: samples[3], minMicroseconds: samples[0], maxMicroseconds: samples[6] };
}
const report = { date: new Date().toISOString(), runtime: process.version, head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), method: 'Isolated Node microbenchmark, 264 spawn/random endpoint pairs, seven warmed passes. Prototype preserves full-grid nearest lookup, node costs, heuristic, edge order and open insertion tie order; replaces Map state/linear Set minimum scan with reusable typed arrays, precomputed adjacency and binary heap. Risk field is precomputed and shared for both timing variants. No production code changed, no FPS claim, no device claim. Scratch storage is synchronous/non-reentrant; production integration requires ownership and regression tests.', exactPathComparisons: pairs.length * 2, baseline: bench(findPath), prototype: bench(heapPath), baselineRiskFieldCached: bench(findPath, risk), prototypeRiskFieldCached: bench(heapPath, risk) };
mkdirSync('temp/performance-audit', { recursive: true });
writeFileSync('temp/performance-audit/navigation-prototype.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
void sink;
