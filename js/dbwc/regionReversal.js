(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.RegionReversal = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
"use strict";

// Region reversal: the gap between a DBWC Quality local optimum and the global optimum is the reversal
// of shared tour segments inside a region D. This module implements two experimental arms:
//   1. Candidate union U: Q ∪ (support of fractional 2-matchings with perturbed costs). The 2-matching
//      is solved as a min-cost flow on the bipartite double cover (successive shortest paths, early-stopping Dijkstra).
//   2a. "time" arm: the best tour within U is searched with exactTsp.js branch-and-bound (edges outside U get
//       a penalty larger than L(Q), Q is the starting incumbent) within a time budget. The result cannot be
//       longer than Q; exact recombination is exponential in general (tw(U) ≈ c·√n), hence the time budget.
//   2b. "bounded" arm: the production DBWC.search (unchanged) runs on the U candidate graph with a wide
//       subtour window; total search work is bounded by C·n^1.7.
// Both arms accept only a tour that is simple in both coordinate systems and shorter than Q; otherwise they return Q.

function dbwcApi() {
  if (root.DBWC) return root.DBWC;
  if (typeof require === "function") return require("./dbwcCore.js");
  throw new Error("RegionReversal requires dbwcCore.js");
}
function exactSolver() {
  if (typeof root.solveExactTsp === "function") return root.solveExactTsp;
  if (typeof require === "function") return require("../exact/exactTsp.js").solveExactTsp;
  throw new Error("RegionReversal time mode requires exactTsp.js");
}

const DEFAULTS = Object.freeze({
  samples: 30,
  noise: { time: 0.4, bounded: 0.25 },
  flip: false,
  seed: 20260923,
  workCoefficient: 5000,      // bounded: toplam DBWC arama işi <= workCoefficient * n^1.7
  exactPointLimit: 2000,      // time: exactTsp yoğun n x n matris kurar
  chainStages: [
    { name: "W", maxRun: 6, maxDepth: 60, patch: null, maxProbesPerStart: 100000, cyclePrune: false },
    { name: "Wz", maxRun: 6, maxDepth: 60, zeroCompsDeviation: true, maxProbesPerStart: 100000,
      patch: { maxRun: 6, maxDepth: 60, budget: 5000000, maxProbesPerStart: 100000, pool: 128, hops: 3 } }
  ]
});

class RrLimitError extends Error {
  constructor(reason) { super(reason); this.name = "RrLimitError"; this.reason = reason; }
}

// Tohumlu normal dağılım (mulberry32 + Box-Muller).
function normalSource(seed) {
  let s = seed >>> 0;
  const uniform = () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare = null;
  return () => {
    if (spare !== null) { const value = spare; spare = null; return value; }
    let u = 0;
    while (u <= 1e-12) u = uniform();
    const v = uniform();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
}

const dist = (tour, a, b) => Math.hypot(tour[a].x - tour[b].x, tour[a].y - tour[b].y);

// Aday kenarları (tur pozisyonları): Delaunay ∪ tur kenarları, isteğe bağlı dışbükey dörtgen karşı köşegenleri.
function candidateEdges(tour, options, work) {
  const DBWC = dbwcApi();
  const n = tour.length;
  const adjacency = DBWC.delaunayAdjacency(tour, work.delaunay = {});
  const keys = new Set();
  const add = (a, b) => { if (a !== b) keys.add(a < b ? a * n + b : b * n + a); };
  for (let i = 0; i < n; i++) { add(i, (i + 1) % n); for (const j of adjacency[i]) add(i, j); }
  if (options.flip) {
    const sets = adjacency.map(list => new Set(list));
    const orient = (a, b, c) => (tour[b].x - tour[a].x) * (tour[c].y - tour[a].y)
      - (tour[b].y - tour[a].y) * (tour[c].x - tour[a].x);
    for (let p = 0; p < n; p++) for (const q of adjacency[p]) {
      if (q < p) continue;
      const common = adjacency[p].filter(x => sets[q].has(x));
      work.flipTests = (work.flipTests || 0) + common.length * common.length;
      for (let i = 0; i < common.length; i++) for (let j = i + 1; j < common.length; j++) {
        const a = common[i], b = common[j];
        if (sets[a].has(b)) continue;
        if (Math.sign(orient(p, q, a)) * Math.sign(orient(p, q, b)) >= 0) continue;
        if (Math.sign(orient(a, b, p)) * Math.sign(orient(a, b, q)) >= 0) continue;
        add(a, b);
      }
    }
  }
  const edgeA = new Int32Array(keys.size), edgeB = new Int32Array(keys.size);
  let e = 0;
  for (const key of keys) { edgeA[e] = Math.floor(key / n); edgeB[e] = key % n; e++; }
  return { edgeA, edgeB, count: keys.size };
}

// Kesirli (yarım tamsayılı) en küçük 2-eşleşme: iki taraflı örtüde L_u -> R_v birim kapasiteli yaylar,
// her L arzı 2, her R talebi 2. Ardışık en kısa yol; her artırma bir arz düğümünden en yakın talep
// düğümüne erken duran Dijkstra ile bulunur (potansiyeller yalnız yerleşen düğümlerde güncellenir).
// Dönen: kenar başına akış (0, 1, 2). Destek = akışı > 0 olan kenarlar.
function fractionalTwoMatching(n, edges, cost, work, checkLimit) {
  const m = edges.count, A = edges.edgeA, B = edges.edgeB;
  const degree = new Int32Array(n);
  for (let e = 0; e < m; e++) { degree[A[e]]++; degree[B[e]]++; }
  const start = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) start[i + 1] = start[i] + degree[i];
  const incident = new Int32Array(2 * m), fill = start.slice(0, n);
  for (let e = 0; e < m; e++) { incident[fill[A[e]]++] = e; incident[fill[B[e]]++] = e; }
  // yay 2e: L_A -> R_B, yay 2e+1: L_B -> R_A
  const flow = new Uint8Array(2 * m);
  const excess = new Int32Array(n).fill(2), deficit = new Int32Array(n).fill(2);
  const pot = new Float64Array(2 * n);
  const distance = new Float64Array(2 * n), parentArc = new Int32Array(2 * n);
  const stamp = new Int32Array(2 * n), settledStamp = new Int32Array(2 * n);
  let epoch = 0;
  const heapNode = [], heapKey = [];
  const push = (node, key) => {
    let i = heapNode.length; heapNode.push(node); heapKey.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapKey[p] <= key) break;
      heapNode[i] = heapNode[p]; heapKey[i] = heapKey[p]; i = p;
    }
    heapNode[i] = node; heapKey[i] = key;
  };
  const pop = () => {
    const node = heapNode[0], key = heapKey[0];
    const lastNode = heapNode.pop(), lastKey = heapKey.pop();
    if (heapNode.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= heapNode.length) break;
        if (c + 1 < heapNode.length && heapKey[c + 1] < heapKey[c]) c++;
        if (heapKey[c] >= lastKey) break;
        heapNode[i] = heapNode[c]; heapKey[i] = heapKey[c]; i = c;
      }
      heapNode[i] = lastNode; heapKey[i] = lastKey;
    }
    return [node, key];
  };
  const settled = [];
  for (let source = 0; source < n; source++) {
    while (excess[source] > 0) {
      epoch++;
      heapNode.length = 0; heapKey.length = 0; settled.length = 0;
      stamp[source] = epoch; distance[source] = 0; parentArc[source] = -1;
      push(source, 0);
      let target = -1, targetDistance = 0;
      while (heapNode.length) {
        const [x, key] = pop();
        work.heapPops++;
        if (settledStamp[x] === epoch || key > distance[x]) continue;
        settledStamp[x] = epoch;
        if (x >= n && deficit[x - n] > 0) { target = x; targetDistance = key; break; }
        settled.push(x);
        if (x < n) {
          for (let k = start[x]; k < start[x + 1]; k++) {
            work.arcScans++;
            const e = incident[k];
            const arc = A[e] === x ? 2 * e : 2 * e + 1;
            if (flow[arc]) continue;
            const y = n + (A[e] === x ? B[e] : A[e]);
            if (settledStamp[y] === epoch) continue;
            const rc = Math.max(0, cost[e] + pot[x] - pot[y]);
            const nd = key + rc;
            if (stamp[y] !== epoch || nd < distance[y]) {
              stamp[y] = epoch; distance[y] = nd; parentArc[y] = arc; push(y, nd);
            }
          }
        } else {
          const v = x - n;
          for (let k = start[v]; k < start[v + 1]; k++) {
            work.arcScans++;
            const e = incident[k];
            const arc = B[e] === v ? 2 * e : 2 * e + 1; // L_other -> R_v
            if (!flow[arc]) continue;
            const y = B[e] === v ? A[e] : B[e];
            if (settledStamp[y] === epoch) continue;
            const rc = Math.max(0, -cost[e] + pot[x] - pot[y]);
            const nd = key + rc;
            if (stamp[y] !== epoch || nd < distance[y]) {
              stamp[y] = epoch; distance[y] = nd; parentArc[y] = arc; push(y, nd);
            }
          }
        }
      }
      if (target < 0) throw new Error("Fractional 2-matching is infeasible on the candidate graph");
      for (const v of settled) pot[v] += distance[v] - targetDistance;
      // artırma: hedeften kaynağa ebeveyn yayları boyunca
      let x = target;
      while (x !== source) {
        const arc = parentArc[x], e = arc >> 1, forward = (arc & 1) === 0;
        const tailL = forward ? A[e] : B[e], headR = n + (forward ? B[e] : A[e]);
        if (x === headR) { flow[arc] = 1; x = tailL; }       // ileri yay L -> R
        else { flow[arc] = 0; x = headR; }                   // geri yay R -> L
        work.augmentSteps++;
      }
      excess[source]--; deficit[target - n]--;
      work.augmentations++;
      if (checkLimit) checkLimit();
    }
  }
  const edgeFlow = new Uint8Array(m);
  for (let e = 0; e < m; e++) edgeFlow[e] = flow[2 * e] + flow[2 * e + 1];
  return edgeFlow;
}

function tourKey(n, a, b) { return a < b ? a * n + b : b * n + a; }

// U = Q ∪ ⋃ destek(F_k).
function buildUnion(tour, options, work, checkLimit) {
  const n = tour.length;
  const edges = candidateEdges(tour, options, work);
  const base = new Float64Array(edges.count);
  for (let e = 0; e < edges.count; e++) base[e] = dist(tour, edges.edgeA[e], edges.edgeB[e]);
  const normal = normalSource(options.seed);
  const inUnion = new Uint8Array(edges.count);
  for (let e = 0; e < edges.count; e++) {
    const f = (edges.edgeB[e] - edges.edgeA[e] + n) % n;
    if (f === 1 || f === n - 1) inUnion[e] = 1;
  }
  const cost = new Float64Array(edges.count);
  const perSample = [];
  for (let k = 0; k < options.samples; k++) {
    for (let e = 0; e < edges.count; e++) cost[e] = base[e] * Math.max(0.01, 1 + options.noise * normal());
    const flow = fractionalTwoMatching(n, edges, cost, work.flow, checkLimit);
    let added = 0;
    for (let e = 0; e < edges.count; e++) if (flow[e] > 0 && !inUnion[e]) { inUnion[e] = 1; added++; }
    perSample.push(added);
    work.samples++;
    if (options.onProgress) options.onProgress({ phase: "rr-sample", sample: k + 1, samples: options.samples });
  }
  const keys = new Set(), adjacency = Array.from({ length: n }, () => []);
  for (let e = 0; e < edges.count; e++) if (inUnion[e]) {
    const a = edges.edgeA[e], b = edges.edgeB[e];
    keys.add(tourKey(n, a, b)); adjacency[a].push(b); adjacency[b].push(a);
  }
  return { keys, adjacency, candidateEdges: edges.count, unionEdges: keys.size, extraEdges: keys.size - n, perSample };
}

function isTourEdge(n, a, b) { const f = (b - a + n) % n; return f === 1 || f === n - 1; }

// time kolu: U içindeki en iyi tur, exactTsp dal-sınırıyla (U dışı kenar cezalı), Q incumbent.
function recombineExact(tour, union, options) {
  const n = tour.length;
  if (n > options.exactPointLimit) {
    return { status: "SKIPPED_POINT_LIMIT", order: null, exact: null };
  }
  const DBWC = dbwcApi();
  const initialLength = DBWC.tourLength(tour);
  const penalty = initialLength + 1;
  const points = tour.map((p, k) => ({ x: p.x, y: p.y, k }));
  const costFn = (a, b) => {
    const base = Math.hypot(a.x - b.x, a.y - b.y);
    return union.keys.has(tourKey(n, a.k, b.k)) ? base : base + penalty;
  };
  const remaining = options.deadline - options.now();
  const timeLimitMs = Math.max(1, Math.floor(remaining * 0.9) - 250);
  const exact = exactSolver()(points, {
    initialTour: points.map((_, k) => k), costFn, timeLimitMs, edgeElimination: true, now: options.now,
    onProgress: options.onProgress ? progress => options.onProgress({ phase: "rr-exact", ...progress }) : undefined
  });
  const order = exact.tour;
  for (let i = 0; i < n; i++) {
    if (!union.keys.has(tourKey(n, order[i], order[(i + 1) % n]))) {
      return { status: "OUTSIDE_UNION", order: null, exact };
    }
  }
  return { status: exact.optimal ? "OPTIMAL_IN_UNION" : "TIME_LIMIT", order, exact };
}

// Yerel kenar indeksi (dbwcCore.search validate() için; makeEdgeIndex dışa açık değil).
function makeEdgeIndex(tour) {
  const n = tour.length;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of tour) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  const cell = Math.max(maxX - minX, maxY - minY) / Math.sqrt(n) || 1;
  const grid = new Map();
  const key = (gx, gy) => gx * 1000003 + gy;
  const range = (a, b, lo) => [Math.floor((Math.min(a, b) - lo) / cell), Math.floor((Math.max(a, b) - lo) / cell)];
  for (let i = 0; i < n; i++) {
    const a = tour[i], b = tour[(i + 1) % n];
    const [x0, x1] = range(a.x, b.x, minX), [y0, y1] = range(a.y, b.y, minY);
    for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) {
      const k = key(gx, gy); let list = grid.get(k); if (!list) grid.set(k, list = []); list.push(i);
    }
  }
  return { query(pa, pb) {
    const out = new Set();
    const [x0, x1] = range(pa.x, pb.x, minX), [y0, y1] = range(pa.y, pb.y, minY);
    for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) {
      const list = grid.get(key(gx, gy)); if (list) for (const i of list) out.add(i);
    }
    return out;
  } };
}

// bounded kolu: DBWC.search, aday grafı U, geniş alt-tur penceresi; toplam iş <= workLimit.
function recombineChain(tour, union, options, work) {
  const DBWC = dbwcApi();
  const n = tour.length;
  let current = tour.map((p, k) => ({ ...p, _k: k }));
  const candByK = union.adjacency; // orijinal Q pozisyonu (k) uzayında
  const scratch = { onChain: new Int32Array(n), label: new Int8Array(n), labelSet: new Uint8Array(n) };
  const log = [];
  let moves = 0, status = "NO_IMPROVEMENT";
  const tick = () => {
    work.search++;
    if (work.search > options.workLimit) throw new RrLimitError("WORK_LIMIT");
    if ((work.search & 4095) === 0 && options.now() > options.deadline) throw new RrLimitError("TIME_LIMIT");
  };
  tick.add = count => { for (let i = 0; i < count; i += 4096) { work.search += Math.min(4096, count - i); if (work.search > options.workLimit) throw new RrLimitError("WORK_LIMIT"); } };
  try {
    outer: while (moves < (options.maxMoves ?? 1000)) {
      const posOfK = new Int32Array(n);
      current.forEach((p, i) => { posOfK[p._k] = i; });
      const cand = current.map(p => candByK[p._k].map(k => posOfK[k])
        .sort((a, b) => Math.hypot(p.x - current[a].x, p.y - current[a].y) - Math.hypot(p.x - current[b].x, p.y - current[b].y) || a - b));
      const edgeIndex = makeEdgeIndex(current);
      for (const stage of options.chainStages) {
        if (options.onProgress) options.onProgress({ phase: "rr-chain", stage: stage.name, moves, work: work.search });
        const result = DBWC.search(current, { ...stage, cand, starts: current.map((_, i) => i), first: true,
          scratch, edgeIndex, tick, counters: {} });
        if (!result.best) continue;
        const before = DBWC.tourLength(current);
        const next = DBWC.applyMoveIds(current, result.best);
        const after = DBWC.tourLength(next);
        if (!(after < before - 1e-9) || !DBWC.isSimpleTour(next)
            || (options.display && !DBWC.isSimpleTour(next.map(p => options.display[p._k])))) {
          if (log.length < 60) log.push(`${stage.name}:reject`);
          continue;
        }
        current = next; moves++;
        if (log.length < 60) log.push(`${stage.name}:k${result.best.k}:+${(before - after).toFixed(3)}`);
        continue outer;
      }
      break;
    }
    if (moves >= (options.maxMoves ?? 1000)) status = "MOVE_LIMIT";
  } catch (error) {
    if (!(error instanceof RrLimitError)) throw error;
    status = error.reason;
  }
  return { status, moves, log, order: current.map(p => p._k) };
}

// Ana giriş. points: tur sırasındaki noktalar [{id, x, y, ...}]; x/y metrik koordinat.
function optimize(points, options = {}) {
  const DBWC = dbwcApi();
  const mode = options.mode === "bounded" ? "bounded" : "time";
  const now = options.now || (() => performance.now());
  const started = now();
  const n = points.length;
  if (n < 4) throw new Error("Region reversal requires at least four points");
  const tour = points.map(p => ({ x: Number(p.x), y: Number(p.y) }));
  if (tour.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) throw new Error("Region reversal coordinates must be finite");
  if (!DBWC.isSimpleTour(tour)) throw new Error("Region reversal requires a simple input tour");
  const hasDisplay = points.every(p => Number.isFinite(p.displayX) && Number.isFinite(p.displayY));
  const display = hasDisplay ? points.map(p => ({ x: Number(p.displayX), y: Number(p.displayY) })) : null;
  const settings = {
    mode, now, display,
    deadline: options.deadline ?? (started + (options.timeLimitMs ?? 120000)),
    samples: options.samples ?? DEFAULTS.samples,
    noise: options.noise ?? DEFAULTS.noise[mode],
    flip: options.flip ?? DEFAULTS.flip,
    seed: options.seed ?? DEFAULTS.seed,
    exactPointLimit: options.exactPointLimit ?? DEFAULTS.exactPointLimit,
    workLimit: Math.round((options.workCoefficient ?? DEFAULTS.workCoefficient) * Math.pow(n, 1.7)),
    chainStages: options.chainStages ?? DEFAULTS.chainStages,
    maxMoves: options.maxMoves,
    onProgress: options.onProgress
  };
  const work = { delaunay: null, flipTests: 0, samples: 0,
    flow: { heapPops: 0, arcScans: 0, augmentSteps: 0, augmentations: 0 }, search: 0 };
  const initialLength = DBWC.tourLength(tour);
  const timings = {};
  let status, order = null, detail = {};
  const checkLimit = () => { if (now() > settings.deadline) throw new RrLimitError("TIME_LIMIT"); };
  let union = null;
  try {
    const unionStarted = now();
    union = buildUnion(tour, settings, work, checkLimit);
    timings.unionMs = now() - unionStarted;
    const recombineStarted = now();
    if (mode === "time") {
      const exact = recombineExact(tour, union, settings);
      status = exact.status; order = exact.order;
      detail.exact = exact.exact && { optimal: exact.exact.optimal, lowerBound: exact.exact.lowerBound,
        gap: exact.exact.gap, stopReason: exact.exact.stopReason, nodes: exact.exact.stats?.nodesExplored,
        elapsedMs: exact.exact.elapsedMs, method: exact.exact.method };
    } else {
      const chain = recombineChain(tour, union, settings, work);
      status = chain.status; order = chain.order; detail.moves = chain.moves; detail.log = chain.log;
    }
    timings.recombineMs = now() - recombineStarted;
  } catch (error) {
    if (!(error instanceof RrLimitError)) throw error;
    status = union ? error.reason : `SAMPLING_${error.reason}`;
  }
  let result = points.slice(), finalLength = initialLength, improved = false;
  if (order) {
    const candidate = order.map(k => points[k]);
    const candidateMetric = order.map(k => tour[k]);
    const length = DBWC.tourLength(candidateMetric);
    if (length < initialLength - 1e-9 && DBWC.isSimpleTour(candidateMetric)) {
      if (!display || DBWC.isSimpleTour(order.map(k => display[k]))) {
        result = candidate; finalLength = length; improved = true;
      } else status = `${status}_DISPLAY_REJECTED`;
    }
  }
  return {
    mode, status, improved, tour: result, initialLength, finalLength,
    elapsedMs: now() - started, timings,
    union: union && { candidateEdges: union.candidateEdges, unionEdges: union.unionEdges,
      extraEdges: union.extraEdges, extraPerPoint: union.extraEdges / n, perSample: union.perSample },
    settings: { samples: settings.samples, noise: settings.noise, flip: settings.flip, seed: settings.seed,
      workLimit: mode === "bounded" ? settings.workLimit : null, exactPointLimit: settings.exactPointLimit },
    work: { flow: { ...work.flow }, flipTests: work.flipTests, samples: work.samples, search: work.search },
    ...detail
  };
}

return { optimize, buildUnion, fractionalTwoMatching, candidateEdges, DEFAULTS };
});
