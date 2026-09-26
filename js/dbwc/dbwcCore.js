/* DBWC browser core, adapted from the frozen v1f/v3 research code.
 * No reference tours, Node I/O, or mesh dependencies.
 * Work counters/time limits are operational limits, not an O(n^1.7) proof.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.DBWC = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
"use strict";

// Hizli kapanis bilesen sayisi: removed pozisyon ciftleri (tur kenarlari), added ciftler.
// Donen: bilesen sayisi (>=1) veya 0 (gecersiz). Scratch diziler yeniden kullanilir.
function makeClosure(n, maxK) {
  const gaps = new Int32Array(maxK), parent = new Int32Array(maxK), used = new Uint8Array(2 * maxK);
  function segOf(k, p) { // en buyuk gaps[j] < p, yoksa k-1
    let lo = 0, hi = k - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (gaps[mid] < p) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans === -1 ? k - 1 : ans;
  }
  function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
  function components(remA, remB, addA, addB, k, segRootOut) {
    for (let i = 0; i < k; i++) {
      const a = remA[i], b = remB[i];
      const f = b - a;
      if (f === 1 || f === 1 - n) gaps[i] = a; else if (f === -1 || f === n - 1) gaps[i] = b; else return 0;
    }
    for (let i = 1; i < k; i++) { const v = gaps[i]; let j = i - 1; while (j >= 0 && gaps[j] > v) { gaps[j + 1] = gaps[j]; j--; } gaps[j + 1] = v; }
    for (let i = 1; i < k; i++) if (gaps[i] === gaps[i - 1]) return 0;
    for (let i = 0; i < k; i++) parent[i] = i;
    used.fill(0, 0, 2 * k);
    let comps = k;
    for (let i = 0; i < k; i++) {
      const a = addA[i], b = addB[i];
      if (a === b) return 0;
      const ja = segOf(k, a), jb = segOf(k, b);
      const startA = (gaps[ja] + 1) % n, endA = gaps[(ja + 1) % k];
      const startB = (gaps[jb] + 1) % n, endB = gaps[(jb + 1) % k];
      let sa;
      if (a === startA && !used[2 * ja]) sa = 2 * ja; else if (a === endA && !used[2 * ja + 1]) sa = 2 * ja + 1; else return 0;
      used[sa] = 1;
      let sb;
      if (b === startB && !used[2 * jb]) sb = 2 * jb; else if (b === endB && !used[2 * jb + 1]) sb = 2 * jb + 1; else return 0;
      used[sb] = 1;
      const ra = find(ja), rb = find(jb);
      if (ra !== rb) { parent[ra] = rb; comps--; }
    }
    for (let i = 0; i < 2 * k; i++) if (!used[i]) return 0;
    if (segRootOut) for (let j = 0; j < k; j++) segRootOut[j] = find(j);
    return comps;
  }
  return { components, gaps };
}


// Artimsal Delaunay: uzamsal (Hilbert) sirayla ekleme, son ucgenden yuruyerek konum bulma, Lawson cevirme.
// Beklenen O(n log n). Donen: kenar listesi (komsuluk) -- pozisyon indeksleriyle.
function hilbertIndex(x, y, order, metrics) {
  let d = 0;
  for (let s = order >> 1; s > 0; s >>= 1) {
    if (metrics) metrics.hilbertIndexSteps = (metrics.hilbertIndexSteps || 0) + 1;
    const rx = (x & s) > 0 ? 1 : 0, ry = (y & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) { if (rx === 1) { x = s - 1 - x; y = s - 1 - y; } const t = x; x = y; y = t; }
  }
  return d;
}

function delaunayAdjacency(pos, metrics) {
  const n = pos.length;
  let orientationTests = 0, inCircleTests = 0, locateSteps = 0;
  let hilbertComparisons = 0, emittedEdges = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pos) {
    if (metrics) metrics.boundsPointVisits = (metrics.boundsPointVisits || 0) + 1;
    if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
  }
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const PX = new Float64Array(n + 3), PY = new Float64Array(n + 3);
  for (let i = 0; i < n; i++) {
    if (metrics) metrics.coordinateCopies = (metrics.coordinateCopies || 0) + 1;
    PX[i] = pos[i].x; PY[i] = pos[i].y;
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, M = span * 50;
  PX[n] = cx - M; PY[n] = cy - M; PX[n + 1] = cx + M; PY[n + 1] = cy - M; PX[n + 2] = cx; PY[n + 2] = cy + M;
  const cap = 2 * (n + 3) + 16;
  const V = new Int32Array(3 * cap), NB = new Int32Array(3 * cap).fill(-1);
  const alive = new Uint8Array(cap);
  let tc = 0;
  const orient = (a, b, c) => {
    orientationTests++;
    return (PX[b] - PX[a]) * (PY[c] - PY[a]) - (PY[b] - PY[a]) * (PX[c] - PX[a]);
  };
  function incircle(a, b, c, d) {
    inCircleTests++;
    // a,b,c CCW; d icerde ise > 0
    const adx = PX[a] - PX[d], ady = PY[a] - PY[d], bdx = PX[b] - PX[d], bdy = PY[b] - PY[d], cdx = PX[c] - PX[d], cdy = PY[c] - PY[d];
    return (adx * adx + ady * ady) * (bdx * cdy - cdx * bdy) - (bdx * bdx + bdy * bdy) * (adx * cdy - cdx * ady) + (cdx * cdx + cdy * cdy) * (adx * bdy - bdx * ady);
  }
  function newTri(a, b, c) { const t = tc++; V[3 * t] = a; V[3 * t + 1] = b; V[3 * t + 2] = c; NB[3 * t] = NB[3 * t + 1] = NB[3 * t + 2] = -1; alive[t] = 1; return t; }
  // NB[3t+i]: V[3t+i]'nin karsisindaki kenarin komsusu (kenar V[3t+(i+1)%3]-V[3t+(i+2)%3])
  function setNb(t, i, u) { NB[3 * t + i] = u; }
  function edgeIndex(t, a, b) { // t ucgeninde (a,b) kenarinin karsisindaki kose indeksi
    for (let i = 0; i < 3; i++) {
      if (metrics) metrics.edgeLookupSteps = (metrics.edgeLookupSteps || 0) + 1;
      const p = V[3 * t + (i + 1) % 3], q = V[3 * t + (i + 2) % 3];
      if ((p === a && q === b) || (p === b && q === a)) return i;
    }
    return -1;
  }
  const root = newTri(n, n + 1, n + 2);
  if (orient(n, n + 1, n + 2) < 0) { V[3 * root + 1] = n + 2; V[3 * root + 2] = n + 1; }
  // Hilbert sirasi
  const order = 1 << 16;
  const idx = Array.from({ length: n }, (_, i) => {
    if (metrics) metrics.indexInitVisits = (metrics.indexInitVisits || 0) + 1;
    return i;
  });
  const hk = idx.map(i => {
    if (metrics) metrics.hilbertKeyVisits = (metrics.hilbertKeyVisits || 0) + 1;
    return hilbertIndex(Math.floor((PX[i] - minX) / span * (order - 1)),
      Math.floor((PY[i] - minY) / span * (order - 1)), order, metrics);
  });
  idx.sort((a, b) => { hilbertComparisons++; return hk[a] - hk[b]; });
  let last = root;
  const stack = [];
  // tekrar kullanilan ucgen slotlari
  const freeList = [];
  function alloc(a, b, c) {
    if (freeList.length) { const t = freeList.pop(); V[3 * t] = a; V[3 * t + 1] = b; V[3 * t + 2] = c; NB[3 * t] = NB[3 * t + 1] = NB[3 * t + 2] = -1; alive[t] = 1; return t; }
    return newTri(a, b, c);
  }
  function locate(p) {
    let t = last, guard = 0;
    for (;;) {
      locateSteps++;
      if (++guard > 4 * (tc + 10)) throw new Error("locate loop");
      let moved = false;
      for (let i = 0; i < 3; i++) {
        const a = V[3 * t + (i + 1) % 3], b = V[3 * t + (i + 2) % 3];
        if (orient(a, b, p) < 0) { const u = NB[3 * t + i]; if (u >= 0) { t = u; moved = true; break; } }
      }
      if (!moved) return t;
    }
  }
  function replaceNb(u, oldT, newT) {
    if (u < 0) return;
    for (let i = 0; i < 3; i++) {
      if (metrics) metrics.neighborLookupSteps = (metrics.neighborLookupSteps || 0) + 1;
      if (NB[3 * u + i] === oldT) { NB[3 * u + i] = newT; return; }
    }
  }
  function legalize(t, i) {
    stack.push(t, i);
    while (stack.length) {
      if (metrics) metrics.legalizeStackEntries = (metrics.legalizeStackEntries || 0) + 1;
      const ii = stack.pop(), tt = stack.pop();
      if (!alive[tt]) continue;
      const u = NB[3 * tt + ii];
      if (u < 0) continue;
      const p = V[3 * tt + ii], a = V[3 * tt + (ii + 1) % 3], b = V[3 * tt + (ii + 2) % 3];
      const j = edgeIndex(u, a, b);
      const q = V[3 * u + j];
      if (incircle(p, a, b, q) <= 0) continue;
      // cevir: (p,a,b),(q,b,a) -> (p,a,q),(p,q,b)
      const nA = NB[3 * tt + (ii + 2) % 3]; // karsi b -> kenar (p,a)
      const nB = NB[3 * tt + (ii + 1) % 3]; // karsi a -> kenar (b,p)
      const uA = NB[3 * u + edgeIndexOpp(u, j, a)]; // u'da a'nin karsisi -> kenar (q,b)
      const uB = NB[3 * u + edgeIndexOpp(u, j, b)]; // u'da b'nin karsisi -> kenar (a,q)
      // tt := (p,a,q), u := (p,q,b)
      V[3 * tt] = p; V[3 * tt + 1] = a; V[3 * tt + 2] = q;
      V[3 * u] = p; V[3 * u + 1] = q; V[3 * u + 2] = b;
      // tt komsulari: karsi p -> (a,q) = uB; karsi a -> (q,p) = u; karsi q -> (p,a) = nA
      NB[3 * tt] = uB; NB[3 * tt + 1] = u; NB[3 * tt + 2] = nA;
      // u komsulari: karsi p -> (q,b) = uA; karsi q -> (b,p) = nB; karsi b -> (p,q) = tt
      NB[3 * u] = uA; NB[3 * u + 1] = nB; NB[3 * u + 2] = tt;
      replaceNb(uB, u, tt);
      replaceNb(nB, tt, u);
      stack.push(tt, 0, u, 0);
    }
  }
  function edgeIndexOpp(u, j, vtx) {
    for (let i = 0; i < 3; i++) {
      if (metrics) metrics.oppositeVertexSteps = (metrics.oppositeVertexSteps || 0) + 1;
      if (V[3 * u + i] === vtx) return i;
    }
    return -1;
  }
  for (const p of idx) {
    if (metrics) metrics.pointInsertions = (metrics.pointInsertions || 0) + 1;
    const t = locate(p);
    last = t;
    const a = V[3 * t], b = V[3 * t + 1], c = V[3 * t + 2];
    const nA = NB[3 * t], nB = NB[3 * t + 1], nC = NB[3 * t + 2];
    // t := (p,b,c)? t'yi uc ucgene bol: t0=(a,b,p), t1=(b,c,p), t2=(c,a,p)
    alive[t] = 0; freeList.push(t);
    const t0 = alloc(a, b, p), t1 = alloc(b, c, p), t2 = alloc(c, a, p);
    // t0=(a,b,p): karsi a -> (b,p) = t1; karsi b -> (p,a) = t2; karsi p -> (a,b) = nC
    NB[3 * t0] = t1; NB[3 * t0 + 1] = t2; NB[3 * t0 + 2] = nC;
    NB[3 * t1] = t2; NB[3 * t1 + 1] = t0; NB[3 * t1 + 2] = nA;
    NB[3 * t2] = t0; NB[3 * t2 + 1] = t1; NB[3 * t2 + 2] = nB;
    replaceNb(nC, t, t0); replaceNb(nA, t, t1); replaceNb(nB, t, t2);
    // p'nin karsisindaki kenarlar (index 2) mesru mu
    legalize(t0, 2); legalize(t1, 2); legalize(t2, 2);
    last = t0;
  }
  const adj = Array.from({ length: n }, () => []);
  const seen = new Set();
  for (let t = 0; t < tc; t++) {
    if (metrics) metrics.adjacencyTriangleVisits = (metrics.adjacencyTriangleVisits || 0) + 1;
    if (!alive[t]) continue;
    for (let i = 0; i < 3; i++) {
      if (metrics) metrics.adjacencyEdgeVisits = (metrics.adjacencyEdgeVisits || 0) + 1;
      const a = V[3 * t + i], b = V[3 * t + (i + 1) % 3];
      if (a >= n || b >= n) continue;
      const key = a < b ? a * n + b : b * n + a;
      if (seen.has(key)) continue;
      seen.add(key); adj[a].push(b); adj[b].push(a); emittedEdges++;
    }
  }
  if (metrics) Object.assign(metrics, {
    orientationTests, inCircleTests, locateSteps, hilbertComparisons, emittedEdges
  });
  return adj;
}


// S5 (v3): S4 + duzeltilmis kopru tahmini + sinir baslangiclari. S4 (v2 adayi): S3 + bolen modu (splitMode) -- pencere yalniz >=3 bileseni sapma sayar; 2 bilesenli kapanislar havuza.
//  - Aday: Delaunay komsulari (tur disi), mesafe sirali.
//  - Kazanc kriteri: G_i > 0.
//  - Pencere: ara kapanisi tek tur olmayan ardışık adim sayisi <= maxRun.
//  - R1: basamak taraf tutarliligi.
//  - Kapanis: tek tur + basit -> aday; 2 bilesen + pozitif -> yama havuzu.
// Optimum bilgisi ALMAZ.



function segTouch(a, b, c, d) {
  const o = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
  const on = (p, q, r) => Math.min(p.x, q.x) <= r.x && r.x <= Math.max(p.x, q.x) && Math.min(p.y, q.y) <= r.y && r.y <= Math.max(p.y, q.y);
  return (o1 === 0 && on(a, b, c)) || (o2 === 0 && on(a, b, d)) || (o3 === 0 && on(c, d, a)) || (o4 === 0 && on(c, d, b));
}

function search(pos, opt = {}) {
  const n = pos.length;
  const maxDepth = opt.maxDepth ?? 20, maxRun = opt.maxRun ?? 1, useR1 = opt.r1 !== false;
  const cand = opt.cand;
  const tick = opt.tick || (() => {});
  if (!cand) throw new Error("DBWC candidate graph required");
  // Yama zincirleri ayri bir aday kumesi kullanabilir (patch.candSet); baslangic komsulugu (hops) asamanin kumesinden sayilir.
  const patchCand = opt.patchCand || cand;
  const firstImprovement = opt.first !== false;
  const maxK = maxDepth + 4 + (opt.patch ? (opt.patch.maxDepth ?? 12) + 2 : 0);
  const CL = makeClosure(n, maxK + 4);
  const remA = new Int32Array(maxK + 4), remB = new Int32Array(maxK + 4), addA = new Int32Array(maxK + 4), addB = new Int32Array(maxK + 4);
  const { onChain, label, labelSet } = opt.scratch;
  const d = (a, b) => Math.hypot(pos[a].x - pos[b].x, pos[a].y - pos[b].y);
  const mod = i => (i < 0 ? i + n : i >= n ? i - n : i);
  const isT = (a, b) => { const f = b - a; return f === 1 || f === -1 || f === n - 1 || f === 1 - n; };
  const eps = 1e-9;
  const C = Object.assign(opt.counters || {}, { nodes: 0, pairs: 0, closes: 0, validations: 0, r1Prunes: 0, runPrunes: 0, poolPushes: 0, found: 0, budgetStarts: 0, patchPairs: 0, patchBudgetStarts: 0, byDepth: new Array(maxDepth + 2).fill(0) });

  const found = [];
  const pool = [];
  const poolKeys = new Set();
  let t1 = -1;
  const budgetPerStart = opt.maxProbesPerStart ?? 1e7;
  let startProbes = 0, budgetHit = false, stop = false;

  function side(v, p, q, c) {
    const aq = Math.atan2(pos[q].y - pos[v].y, pos[q].x - pos[v].x);
    let ap = Math.atan2(pos[p].y - pos[v].y, pos[p].x - pos[v].x) - aq;
    let ac = Math.atan2(pos[c].y - pos[v].y, pos[c].x - pos[v].x) - aq;
    if (ap <= 0) ap += 2 * Math.PI;
    if (ac <= 0) ac += 2 * Math.PI;
    return ac < ap ? 1 : -1;
  }
  function removedAt(v, w, k) {
    for (let i = 0; i < k; i++) if ((remA[i] === v && remB[i] === w) || (remA[i] === w && remB[i] === v)) return true;
    return false;
  }
  function keptNeighbor(v, k) {
    const a = mod(v - 1), b = mod(v + 1);
    const ra = removedAt(v, a, k), rb = removedAt(v, b, k);
    if (ra === rb) return -1;
    return ra ? b : a;
  }
  function hasAdded(a, b, k) {
    for (let i = 0; i < k; i++) if ((addA[i] === a && addB[i] === b) || (addA[i] === b && addB[i] === a)) return true;
    return false;
  }
  function r1PairOk(v, lab, c, k) {
    if (c < 0 || !labelSet[c]) return true;
    if (keptNeighbor(c, k) !== v) return true;
    return label[c] === lab;
  }
  function validate(k, delta, tag) {
    C.validations++; tick("validations");
    const rem = new Set();
    for (let i = 0; i < k; i++) { const a = remA[i], b = remB[i]; rem.add(a < b ? a * n + b : b * n + a); }
    for (let i = 0; i < k; i++) {
      const a = addA[i], b = addB[i];
      for (const j of opt.edgeIndex.query(pos[a], pos[b])) {
        tick();
        const c = j, e = mod(j + 1); const key = c < e ? c * n + e : e * n + c;
        if (rem.has(key) || a === c || a === e || b === c || b === e) continue;
        if (segTouch(pos[a], pos[b], pos[c], pos[e])) return false;
      }
      for (let j = 0; j < i; j++) {
        const c = addA[j], e = addB[j];
        if (a === c || a === e || b === c || b === e) continue;
        if (segTouch(pos[a], pos[b], pos[c], pos[e])) return false;
      }
    }
    found.push({ delta, k, tag, removed: Array.from({ length: k }, (_, i) => [remA[i], remB[i]]), added: Array.from({ length: k }, (_, i) => [addA[i], addB[i]]) });
    C.found++;
    if (firstImprovement) stop = true;
    return true;
  }

  function extend(tE, prevOfTE, gain, level, run) {
    if (level >= maxDepth || stop || budgetHit) return;
    C.nodes++; tick();
    const list = cand[tE];
    const cE = onChain[tE] === 1 ? keptNeighbor(tE, level) : -1;
    const children = [];
    for (let idx = 0; idx < list.length; idx++) {
      tick();
      const t3 = list[idx];
      if (t3 === t1 || isT(tE, t3)) continue;
      const g1 = gain - d(tE, t3);
      if (g1 <= eps) break;
      if (hasAdded(tE, t3, level - 1)) continue;
      let labE = 0;
      if (useR1 && cE >= 0) {
        labE = side(tE, prevOfTE, t3, cE);
        if (!r1PairOk(tE, labE, cE, level)) { C.r1Prunes++; continue; }
      }
      for (let st = -1; st <= 1; st += 2) {
        const t4 = mod(t3 + st);
        if (t4 === tE || removedAt(t3, t4, level)) continue;
        C.pairs++; startProbes++; tick("pairs");
        if (startProbes > budgetPerStart) { budgetHit = true; C.budgetStarts++; return; }
        remA[level] = t3; remB[level] = t4; addA[level - 1] = tE; addB[level - 1] = t3;
        let lab3 = 0, c3 = -1;
        if (useR1 && onChain[t3] === 0) {
          c3 = keptNeighbor(t3, level + 1);
          if (c3 >= 0) {
            lab3 = side(t3, tE, t4, c3);
            if (cE >= 0) { label[tE] = labE; labelSet[tE] = 1; }
            const ok = r1PairOk(t3, lab3, c3, level + 1);
            if (cE >= 0) labelSet[tE] = 0;
            if (!ok) { C.r1Prunes++; continue; }
          }
        }
        addA[level] = t4; addB[level] = t1;
        const comps = CL.components(remA, remB, addA, addB, level + 1, null);
        // Bolen modu (v2): 1 ya da 2 bilesen normal, >=3 (ya da gecersiz) sapma
        const base = opt.splitMode ? 2 : 1;
        const childRun = (comps >= 1 && comps <= base) ? 0 : run + 1;
        const g2 = g1 + d(t3, t4);
        const closeGain = g2 - d(t4, t1);
        // kapanis (her durumda denenir: kapanis feasible ise aday)
        if (closeGain > eps && !isT(t4, t1) && !hasAdded(t4, t1, level)) {
          if (comps === 1) {
            C.closes++;
            if (validate(level + 1, -closeGain, "chain") && stop) return;
          } else if (comps === 2 && (opt.patch || opt.collectPool)) {
            const keys = [];
            for (let i = 0; i <= level; i++) { const a = addA[i], b = addB[i]; keys.push(a < b ? a * n + b : b * n + a); }
            const key = keys.sort((x, y) => x - y).join(",");
            if (!poolKeys.has(key) && pool.length < (opt.maxPoolRecords ?? 32768)) {
              poolKeys.add(key);
              pool.push({ gain: closeGain, removed: Array.from({ length: level + 1 }, (_, i) => [remA[i], remB[i]]), added: Array.from({ length: level + 1 }, (_, i) => [addA[i], addB[i]]) });
              C.poolPushes++; tick("poolRecords");
            }
          }
        }
        if (childRun > maxRun) { C.runPrunes++; continue; }
        // j = comps-1 cevrim; her adim en fazla bir cevrimi yutar -> r + j - 1 <= maxRun sart (comps=0: gecersiz)
        // zeroCompsDeviation: comps=0 yalniz bu seviyedeki (t4, t1) kapanis probunun gecersizligidir, zincirin degil; pencere
        // sapmasi sayilir (childRun zaten run+1). Tek dugum tasima / or-opt 3-degisimleri 1. seviyede bu durumdan gecer.
        if (opt.cyclePrune !== false && ((comps === 0 && !opt.zeroCompsDeviation) || (comps > base && childRun + comps - base - 1 > maxRun))) { C.cyclePrunes = (C.cyclePrunes || 0) + 1; continue; }
        children.push({ t3, t4, g2, labE, lab3, c3, childRun, look: d(t3, t4) - d(tE, t3), comps });
      }
    }
    // cocuk sirasi: uygulanabilir once, sonra ileriye bakis
    children.sort((a, b) => (a.comps === 1 ? 0 : 1) - (b.comps === 1 ? 0 : 1) || b.look - a.look);
    for (const ch of children) {
      if (stop || budgetHit) return;
      const { t3, t4 } = ch;
      remA[level] = t3; remB[level] = t4; addA[level - 1] = tE; addB[level - 1] = t3;
      onChain[t3]++; onChain[t4]++;
      let setE = false, set3 = false;
      if (useR1) {
        if (cE >= 0) { label[tE] = ch.labE; labelSet[tE] = 1; setE = true; }
        if (ch.c3 >= 0 && onChain[t3] === 1) { label[t3] = ch.lab3; labelSet[t3] = 1; set3 = true; }
      }
      C.byDepth[level + 1]++;
      extend(t4, t3, ch.g2, level + 1, ch.childRun);
      if (setE) labelSet[tE] = 0;
      if (set3) labelSet[t3] = 0;
      onChain[t4]--; onChain[t3]--;
    }
  }

  // ---- yama: S icin kucuk bilesenden baslayan uygulanabilirlik pencereli zincir ----
  function patchFrom(S, P) {
    tick();
    const k0 = S.removed.length;
    const load = () => { for (let i = 0; i < k0; i++) { remA[i] = S.removed[i][0]; remB[i] = S.removed[i][1]; addA[i] = S.added[i][0]; addB[i] = S.added[i][1]; } };
    load();
    const segRoot = new Int32Array(k0 + 2);
    if (CL.components(remA, remB, addA, addB, k0, segRoot) !== 2) return false;
    const gaps = Array.from(CL.gaps.slice(0, k0));
    const segOf = p => { let lo = 0, hi = k0 - 1, ans = -1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (gaps[mid] < p) { ans = mid; lo = mid + 1; } else hi = mid - 1; } return ans === -1 ? k0 - 1 : ans; };
    const size = new Map();
    for (let j = 0; j < k0; j++) { const len = mod(gaps[(j + 1) % k0] - gaps[j]) || n; size.set(segRoot[j], (size.get(segRoot[j]) || 0) + len); }
    const roots = [...size.keys()];
    const small = size.get(roots[0]) <= size.get(roots[1]) ? roots[0] : roots[1];
    const compOf = p => segRoot[segOf(p)];
    let spent = 0, hit = false, ok = false, startSpent = 0, startHit = false;
    const budget = P.budget ?? 100000;
    const pMax = k0 + (P.maxDepth ?? 12);
    const pRun = P.maxRun ?? 1;
    function chain(pt1, tE, gain, level, run) {
      if (level >= pMax || hit || ok || startHit) return;
      const list = patchCand[tE];
      const children = [];
      for (const t3 of list) {
        tick();
        if (t3 === pt1 || isT(tE, t3)) continue;
        const g1 = gain - d(tE, t3);
        if (g1 <= eps) break;
        if (hasAdded(tE, t3, level - 1)) continue;
        for (let st = -1; st <= 1; st += 2) {
          const t4 = mod(t3 + st);
          if (t4 === tE || removedAt(t3, t4, level)) continue;
          if (++spent > budget) { hit = true; return; }
          if (++startSpent > (P.maxProbesPerStart ?? Infinity)) { startHit = true; C.patchBudgetStarts++; return; }
          C.patchPairs++; tick("patchPairs");
          remA[level] = t3; remB[level] = t4; addA[level - 1] = tE; addB[level - 1] = t3; addA[level] = t4; addB[level] = pt1;
          const cc = CL.components(remA, remB, addA, addB, level + 1, null);
          const g2 = g1 + d(t3, t4), cg = g2 - d(t4, pt1);
          if (cc === 1 && cg > eps && !isT(t4, pt1) && !hasAdded(t4, pt1, level)) {
            if (validate(level + 1, -cg, "patch")) { ok = true; return; }
          }
          // Yamada referans durum S'nin 2 bileseni: 1 ya da 2 bilesen "normal", >=3 (ya da gecersiz) sapma.
          const r = (cc === 1 || cc === 2) ? 0 : run + 1;
          if (r > pRun) continue;
          if ((cc === 0 && !opt.zeroCompsDeviation) || (cc >= 3 && r + cc - 3 > pRun)) continue;
          children.push({ t3, t4, g2, r, feas: cc === 1, look: d(t3, t4) - d(tE, t3) });
        }
      }
      children.sort((a, b) => (a.feas ? 0 : 1) - (b.feas ? 0 : 1) || b.look - a.look);
      for (const ch of children) {
        remA[level] = ch.t3; remB[level] = ch.t4; addA[level - 1] = tE; addB[level - 1] = ch.t3;
        chain(pt1, ch.t4, ch.g2, level + 1, ch.r);
        if (hit || ok || startHit) return;
      }
    }
    const sRem = new Set(S.removed.map(([a, b]) => (a < b ? a * n + b : b * n + a)));
    // Baslangic koseleri: kucuk bilesenin tamami (eski davranis) + S'nin koselerine Delaunay'da <= hops adim
    // yakin koseler (iki bilesende de). Kucuk bilesen once.
    const hops = P.hops ?? 2;
    // Yama kaydi basina iki n-boyutlu dizi ayirmak ve baslangic listesini kurmak icin
    // tum turu taramak buyuk n'de baskin olabiliyor. Nesil damgalari search cagrilari
    // arasinda scratch icinde yeniden kullanilir; liste sirasi eski p=0..n-1 sirasi ile aynidir.
    const nextEpoch = (field, marks) => {
      let value = ((opt.scratch[field] || 0) + 1) >>> 0;
      if (value === 0) { marks.fill(0); value = 1; }
      opt.scratch[field] = value;
      return value;
    };
    const nearMark = opt.scratch.patchNearMark || (opt.scratch.patchNearMark = new Uint32Array(n));
    const inListMark = opt.scratch.patchStartMark || (opt.scratch.patchStartMark = new Uint32Array(n));
    const nearEpoch = nextEpoch("patchNearEpoch", nearMark);
    const listEpoch = nextEpoch("patchStartEpoch", inListMark);
    const nearList = [];
    let frontier = [];
    const pushNear = v => {
      if (nearMark[v] === nearEpoch) return;
      nearMark[v] = nearEpoch; nearList.push(v); frontier.push(v);
    };
    for (const [a, b] of S.removed) { pushNear(a); pushNear(b); }
    for (let h = 0; h < hops; h++) {
      const next = [];
      for (const v of frontier) for (const w of cand[v]) if ((tick(), nearMark[w] !== nearEpoch)) {
        nearMark[w] = nearEpoch; nearList.push(w); next.push(w);
      }
      frontier = next;
    }
    nearList.sort((a, b) => a - b);

    // compOf(p) === small olan konumlari, k0 kesim araligi uzerinden uret.
    // Araliklar konuma gore siralandiginda eski tam p taramasiyla birebir ayni sira elde edilir.
    const intervals = [];
    for (let j = 0; j < k0; j++) if (segRoot[j] === small) {
      const begin = (gaps[j] + 1) % n, end = gaps[(j + 1) % k0];
      if (begin <= end) intervals.push([begin, end]);
      else { intervals.push([0, end]); intervals.push([begin, n - 1]); }
    }
    intervals.sort((a, b) => a[0] - b[0]);
    const smallPositions = [];
    for (const [begin, end] of intervals) for (let p = begin; p <= end; p++) smallPositions.push(p);

    const startList = [];
    const pushStart = p => {
      if (inListMark[p] === listEpoch) return;
      inListMark[p] = listEpoch; startList.push(p);
    };
    const tickSkipped = count => {
      if (!(count > 0)) return;
      if (typeof tick.add === "function") tick.add(count);
      else for (let i = 0; i < count; i++) tick();
    };
    const visitInFullScanOrder = (positions, visit) => {
      let cursor = 0;
      for (const p of positions) {
        tickSkipped(p - cursor); tick(); visit(p); cursor = p + 1;
      }
      tickSkipped(n - cursor);
    };
    // v3 sirasi: S'ye yakin koseler (iki bilesen) -> kucuk bilesene Delaunay-komsu buyuk bilesen koseleri (sinir) -> kucuk bilesenin geri kalani
    visitInFullScanOrder(nearList, pushStart);
    visitInFullScanOrder(smallPositions, p => {
      for (const w of cand[p]) if (compOf(w) !== small) pushStart(w);
    });
    visitInFullScanOrder(smallPositions, pushStart);
    // Teshis: kalan tum koseler (varsayilan kapali; baslangic listesinin kor noktasini olcmek icin).
    if (P.startAll) for (let p = 0; p < n; p++) if ((tick(), inListMark[p] !== listEpoch)) pushStart(p);
    for (const p of startList) {
      if (ok || hit) break;
      for (let st = -1; st <= 1; st += 2) {
        const q = mod(p + st);
        const key = p < q ? p * n + q : q * n + p;
        if (compOf(q) !== compOf(p) || sRem.has(key)) continue;
        load();
        remA[k0] = p; remB[k0] = q;
        startSpent = 0; startHit = false;
        chain(p, q, S.gain + d(p, q), k0 + 1, 0);
        if (ok || hit) break;
      }
    }
    return ok;
  }

  const starts = opt.starts || Array.from({ length: n }, (_, i) => i);
  let completedStarts = 0;
  for (const s1 of starts) {
    tick();
    let truncated = false;
    for (let st = -1; st <= 1; st += 2) {
      t1 = s1; const t2 = mod(t1 + st);
      remA[0] = t1; remB[0] = t2;
      onChain[t1]++; onChain[t2]++;
      startProbes = 0; budgetHit = false;
      extend(t2, t1, d(t1, t2), 1, 0);
      truncated = truncated || budgetHit;
      budgetHit = false;
      onChain[t1]--; onChain[t2]--;
      if (stop) break;
    }
    if (stop) break;
    // Baslangic butcesine takilan tamamlanmis baslangic: optimizeDBWC bunu asamanin derin kopyasina aktarabilir.
    if (truncated) (C.truncatedStarts ??= []).push(s1);
    completedStarts++;
  }
  // Havuz onceligi: net = kazanc - S'nin iki bilesenini birlestiren en ucuz 2-degisim koprusu
  // (yalniz S koselerine <= 2 Delaunay adimi yakin bolgede; O(k * deg^2) / kayit).
  function bridgeNet(S) {
    tick();
    const k0 = S.removed.length;
    for (let i = 0; i < k0; i++) { remA[i] = S.removed[i][0]; remB[i] = S.removed[i][1]; addA[i] = S.added[i][0]; addB[i] = S.added[i][1]; }
    const segRoot = new Int32Array(k0 + 2);
    if (CL.components(remA, remB, addA, addB, k0, segRoot) !== 2) return -Infinity;
    const gaps = Array.from(CL.gaps.slice(0, k0));
    const segOf = p => { let lo = 0, hi = k0 - 1, ans = -1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (gaps[mid] < p) { ans = mid; lo = mid + 1; } else hi = mid - 1; } return ans === -1 ? k0 - 1 : ans; };
    const compOf = p => segRoot[segOf(p)];
    const remSet = new Set(S.removed.map(([a, b]) => (a < b ? a * n + b : b * n + a)));
    const addNb = new Map();
    for (const [a, b] of S.added) { if (!addNb.has(a)) addNb.set(a, []); if (!addNb.has(b)) addNb.set(b, []); addNb.get(a).push(b); addNb.get(b).push(a); }
    const nbrs = v => {
      const out = [];
      for (const w of [mod(v - 1), mod(v + 1)]) if (!remSet.has(v < w ? v * n + w : w * n + v)) out.push(w);
      // v3: kopru tahmini S'nin ekledigi kenarlari kullanmaz (aksi halde en ucuz kopru S'yi geri almak olur, net = 0)
      return out;
    };
    const near = new Set();
    let frontier = [];
    for (const [a, b] of S.removed) { for (const v of [a, b]) if (!near.has(v)) { near.add(v); frontier.push(v); } }
    for (let h = 0; h < 2; h++) {
      const next = [];
      for (const v of frontier) for (const w of cand[v]) if ((tick(), !near.has(w))) {
        near.add(w); next.push(w);
      }
      frontier = next;
    }
    let best = Infinity;
    for (const u of near) {
      const cu = compOf(u);
      for (const v of cand[u]) {
        if (compOf(v) === cu) continue;
        for (const u2 of nbrs(u)) for (const v2 of nbrs(v)) {
          const cost = d(u, v) + d(u2, v2) - d(u, u2) - d(v, v2);
          if (cost < best) best = cost;
        }
      }
    }
    return S.gain - best;
  }
  if (!found.length && opt.patch && pool.length) {
    if (opt.patch.order === "gain") pool.sort((a, b) => b.gain - a.gain);
    else { for (const S of pool) S.net = bridgeNet(S); pool.sort((a, b) => b.net - a.net); }
    const limit = opt.patch.pool ?? 256;
    for (let i = 0; i < pool.length && i < limit; i++) {
      if (firstImprovement && found.length) break;
      patchFrom(pool[i], opt.patch);
    }
  }
  found.sort((a, b) => a.delta - b.delta);
  return { best: found[0] || null, found, counters: C, pool, completedStarts };
}



// DBWC v1f: v1 asamalari + v3 cekirdegi (s5: duzeltilmis kopru tahmini ve yama baslangiclari) + baslangic basina butce.
const V1F_STAGES = Object.freeze([
  { name: "A", maxRun: 1, maxDepth: 16, patch: null, maxProbesPerStart: 50000 },
  { name: "Ap", maxRun: 1, maxDepth: 16, patch: { maxRun: 1, maxDepth: 12, budget: 100000, pool: 32, hops: 2 }, maxProbesPerStart: 50000 },
  { name: "B", maxRun: 2, maxDepth: 16, patch: { maxRun: 1, maxDepth: 12, budget: 100000, pool: 32, hops: 2 }, maxProbesPerStart: 100000 },
  { name: "C", maxRun: 3, maxDepth: 20, patch: { maxRun: 2, maxDepth: 12, budget: 200000, pool: 64, hops: 2 }, maxProbesPerStart: 150000 }
]);

// DBWC v3 asama tanimi (v2 ile ayni asamalar; cekirdek s5: kopru tahmini + yama baslangiclari duzeltildi) (gelistirme-2: 22 vaka + holdout-1'de v1'in cozemedigi 15 vaka).
// Degisiklikler v1'e gore: A/Ap derinlik 24; bolen modu asamasi S; flip kosegenli asama F;
// baslangic basina cift butcesi (O(n) garantisi icin).
const V3_STAGES = Object.freeze([
  { name: "A", maxRun: 1, maxDepth: 24, patch: null, maxProbesPerStart: 50000 },
  { name: "Ap", maxRun: 1, maxDepth: 24, patch: { maxRun: 1, maxDepth: 12, budget: 100000, pool: 32, hops: 2 }, maxProbesPerStart: 50000 },
  { name: "B", maxRun: 2, maxDepth: 16, patch: { maxRun: 1, maxDepth: 12, budget: 100000, pool: 32, hops: 2 }, maxProbesPerStart: 100000 },
  { name: "S", maxRun: 1, maxDepth: 24, splitMode: true, patch: { maxRun: 2, maxDepth: 16, budget: 200000, pool: 64, hops: 2 }, maxProbesPerStart: 150000 },
  { name: "C", maxRun: 3, maxDepth: 20, patch: { maxRun: 2, maxDepth: 12, budget: 200000, pool: 64, hops: 2 }, maxProbesPerStart: 150000 },
  { name: "F", maxRun: 1, maxDepth: 24, candSet: "flip", patch: { maxRun: 2, maxDepth: 16, budget: 200000, pool: 64, hops: 2 }, maxProbesPerStart: 150000 }
]);

// DBWC v4 (2026-09-12): v3 cekirdegi, farkli butce dagilimi.
// - P: kisa bolen zincir (derinlik 4, pencere 2, flip adaylari) + derin yama; yamada baslangic basina butce.
// - A..C: baslangic basina 10k cift, kucuk yama havuzu (16); F (flip) B'den once.
// - Yama adaleti: tum yamalarda baslangic basina sinir (2k). Ap..C'de toplam 100k: n=400'de 20k toplam butce dogru yama
//   baslangicina varmadan tukeniyordu (91001, B:patch:k14); n<=200'de kalite ve is degismedi.
// - F2: flip adaylariyla 50k; yama toplam 200k.
// - deepen 5: yalniz 10k'ya takilan baslangiclar (Ap/B/S/C) 50k ile yeniden taranir; v3'un pahali yama ayarlari geri
//   gelmez. v3'un baslangic butceleri (B 100k, S/C 150k) 267 vakada ayni kaliteyi daha fazla isle verdi.
const V4_STAGES = Object.freeze([
  { name: "P", maxRun: 2, maxDepth: 4, candSet: "flip", patch: { maxRun: 3, maxDepth: 24, budget: 100000, maxProbesPerStart: 2000, pool: 128, hops: 2 }, maxProbesPerStart: 10000 },
  { name: "A", maxRun: 1, maxDepth: 24, patch: null, maxProbesPerStart: 10000 },
  { name: "Ap", maxRun: 1, maxDepth: 24, patch: { maxRun: 1, maxDepth: 12, budget: 100000, maxProbesPerStart: 2000, pool: 16, hops: 2 }, maxProbesPerStart: 10000, deepen: 5 },
  { name: "F", maxRun: 1, maxDepth: 24, candSet: "flip", patch: { maxRun: 2, maxDepth: 16, budget: 100000, maxProbesPerStart: 2000, pool: 16, hops: 2 }, maxProbesPerStart: 10000 },
  { name: "B", maxRun: 2, maxDepth: 16, patch: { maxRun: 1, maxDepth: 12, budget: 100000, maxProbesPerStart: 2000, pool: 16, hops: 2 }, maxProbesPerStart: 10000, deepen: 5 },
  { name: "S", maxRun: 1, maxDepth: 24, splitMode: true, patch: { maxRun: 2, maxDepth: 16, budget: 100000, maxProbesPerStart: 2000, pool: 16, hops: 2 }, maxProbesPerStart: 10000, deepen: 5 },
  { name: "C", maxRun: 3, maxDepth: 20, patch: { maxRun: 2, maxDepth: 12, budget: 100000, maxProbesPerStart: 2000, pool: 16, hops: 2 }, maxProbesPerStart: 10000, deepen: 5 },
  { name: "F2", maxRun: 1, maxDepth: 24, candSet: "flip", patch: { maxRun: 2, maxDepth: 16, budget: 200000, maxProbesPerStart: 2000, pool: 64, hops: 2 }, maxProbesPerStart: 50000 }
]);
function applyMoveIds(tour, move) {
  const n = tour.length;
  const adj = new Int32Array(2 * n);
  for (let i = 0; i < n; i++) { adj[2 * i] = (i + n - 1) % n; adj[2 * i + 1] = (i + 1) % n; }
  const del = (a, b) => { if (adj[2 * a] === b) adj[2 * a] = -1; else if (adj[2 * a + 1] === b) adj[2 * a + 1] = -1; else throw new Error("remove missing"); };
  const put = (a, b) => { if (adj[2 * a] === -1) adj[2 * a] = b; else if (adj[2 * a + 1] === -1) adj[2 * a + 1] = b; else throw new Error("degree overflow"); };
  for (const [a, b] of move.removed) { del(a, b); del(b, a); }
  for (const [a, b] of move.added) { put(a, b); put(b, a); }
  const out = new Array(n); const seen = new Uint8Array(n); let prev = -1, cur = 0, c = 0;
  while (!seen[cur]) { seen[cur] = 1; out[c++] = tour[cur]; const p = adj[2 * cur], q = adj[2 * cur + 1]; const nx = p === prev ? q : p; prev = cur; cur = nx; }
  if (c !== n) throw new Error("applyMove: not a single tour");
  return out;
}


// v2: Delaunay + kisa flip kosegenleri (iki komsu ucgenin olusturdugu dis bukey dortgenin diger kosegeni)
function addFlipDiagonals(t, adj, opt, metrics) {
  if (!opt || !opt.flipDiag) return adj;
  const n = t.length;
  const sets = adj.map(l => {
    if (metrics) {
      metrics.adjacencySetVisits = (metrics.adjacencySetVisits || 0) + 1;
      metrics.adjacencySetEntries = (metrics.adjacencySetEntries || 0) + l.length;
    }
    return new Set(l);
  });
  const d = (a, b) => Math.hypot(t[a].x - t[b].x, t[a].y - t[b].y);
  const orient = (a, b, c) => (t[b].x - t[a].x) * (t[c].y - t[a].y) - (t[b].y - t[a].y) * (t[c].x - t[a].x);
  const factor = opt.flipFactor ?? 1.0;
  let commonNeighborTests = 0, flipPairTests = 0;
  for (let p = 0; p < n; p++) for (const q of adj[p]) {
    if (metrics) metrics.outerAdjacencyVisits = (metrics.outerAdjacencyVisits || 0) + 1;
    if (q < p) continue;
    const common = adj[p].filter(x => { commonNeighborTests++; return sets[q].has(x); });
    for (let i = 0; i < common.length; i++) for (let j = i + 1; j < common.length; j++) {
      flipPairTests++;
      const a = common[i], b = common[j];
      if (sets[a].has(b)) continue;
      const s1 = orient(p, q, a), s2 = orient(p, q, b);
      if (!((s1 > 0 && s2 < 0) || (s1 < 0 && s2 > 0))) continue;
      const s3 = orient(a, b, p), s4 = orient(a, b, q);
      if (!((s3 > 0 && s4 < 0) || (s3 < 0 && s4 > 0))) continue; // dis bukey dortgen
      if (d(a, b) > factor * d(p, q)) continue;
      sets[a].add(b); sets[b].add(a);
    }
  }
  if (metrics) {
    metrics.commonNeighborTests = commonNeighborTests;
    metrics.flipPairTests = flipPairTests;
  }
  return sets.map(x => {
    if (metrics) {
      metrics.outputSetVisits = (metrics.outputSetVisits || 0) + 1;
      metrics.outputSetEntries = (metrics.outputSetEntries || 0) + x.size;
    }
    return [...x];
  });
}


class DbwcLimitError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "DbwcLimitError";
    this.reason = reason;
  }
}

function tourLength(tour, metrics) {
  let total = 0;
  for (let i = 0; i < tour.length; i++) {
    if (metrics) metrics.lengthEdgeVisits = (metrics.lengthEdgeVisits || 0) + 1;
    const a = tour[i], b = tour[(i + 1) % tour.length];
    total += Math.hypot(a.x - b.x, a.y - b.y);
  }
  return total;
}

function isSimpleTour(tour, metrics) {
  const n = tour.length;
  const orient = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const on = (a, b, p) => Math.min(a.x, b.x) <= p.x && p.x <= Math.max(a.x, b.x)
    && Math.min(a.y, b.y) <= p.y && p.y <= Math.max(a.y, b.y);
  const touches = (a, b, c, d) => {
    const abC = orient(a, b, c), abD = orient(a, b, d);
    const cdA = orient(c, d, a), cdB = orient(c, d, b);
    if (((abC > 0 && abD < 0) || (abC < 0 && abD > 0))
      && ((cdA > 0 && cdB < 0) || (cdA < 0 && cdB > 0))) return true;
    return (abC === 0 && on(a, b, c)) || (abD === 0 && on(a, b, d))
      || (cdA === 0 && on(c, d, a)) || (cdB === 0 && on(c, d, b));
  };
  const index = makeEdgeIndex(tour, metrics);
  let segmentPairTests = 0;
  for (let i = 0; i < n; i++) for (const j of index.query(tour[i], tour[(i + 1) % n])) {
    if (metrics) metrics.candidateEdgeVisits = (metrics.candidateEdgeVisits || 0) + 1;
    if (j <= i || j === (i + 1) % n || i === (j + 1) % n) continue;
    segmentPairTests++;
    if (touches(tour[i], tour[(i + 1) % n], tour[j], tour[(j + 1) % n])) {
      if (metrics) metrics.segmentPairTests = segmentPairTests;
      return false;
    }
  }
  if (metrics) metrics.segmentPairTests = segmentPairTests;
  return true;
}

function makeEdgeIndex(tour, metrics) {
  const n = tour.length;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of tour) {
    if (metrics) metrics.indexPointVisits = (metrics.indexPointVisits || 0) + 1;
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  const span = Math.max(maxX - minX, maxY - minY, 1);
  const side = Math.max(1, Math.ceil(Math.sqrt(n)));
  const cell = span / side;
  const buckets = new Map(), longEdges = [];
  const key = (x, y) => `${x}:${y}`;
  const range = (a, b) => {
    if (metrics) metrics.indexRangeCalls = (metrics.indexRangeCalls || 0) + 1;
    const x0 = Math.max(0, Math.min(side - 1, Math.floor((Math.min(a.x, b.x) - minX) / cell)));
    const x1 = Math.max(0, Math.min(side - 1, Math.floor((Math.max(a.x, b.x) - minX) / cell)));
    const y0 = Math.max(0, Math.min(side - 1, Math.floor((Math.min(a.y, b.y) - minY) / cell)));
    const y1 = Math.max(0, Math.min(side - 1, Math.floor((Math.max(a.y, b.y) - minY) / cell)));
    return { x0, x1, y0, y1 };
  };
  for (let i = 0; i < n; i++) {
    if (metrics) metrics.indexEdgeVisits = (metrics.indexEdgeVisits || 0) + 1;
    const r = range(tour[i], tour[(i + 1) % n]);
    if ((r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1) > 64) { longEdges.push(i); continue; }
    for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) {
      if (metrics) metrics.indexCellVisits = (metrics.indexCellVisits || 0) + 1;
      const k = key(x, y), list = buckets.get(k);
      if (list) list.push(i); else buckets.set(k, [i]);
    }
  }
  return {
    query(a, b) {
      const r = range(a, b), seen = new Set(longEdges), out = longEdges.slice();
      if (metrics) metrics.longEdgeCopies = (metrics.longEdgeCopies || 0) + 2 * longEdges.length;
      for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) {
        if (metrics) metrics.queryCellVisits = (metrics.queryCellVisits || 0) + 1;
        for (const edge of buckets.get(key(x, y)) || []) {
          if (metrics) metrics.queryBucketEntryVisits = (metrics.queryBucketEntryVisits || 0) + 1;
          if (!seen.has(edge)) { seen.add(edge); out.push(edge); }
        }
      }
      return out;
    }
  };
}

function optimizeDBWC(tour, options = {}) {
  if (!Array.isArray(tour) || tour.length < 3) throw new Error("DBWC requires at least three points");
  const ids = new Set(tour.map(p => p.id));
  if (ids.size !== tour.length) throw new Error("DBWC point ids must be unique");
  const stages = options.stages || V1F_STAGES;
  const n = tour.length;
  const lengthWork = {};
  const initialLength = tourLength(tour, lengthWork);
  const maxMoves = options.maxMoves ?? Math.max(32, Math.min(n, 4096));
  const maxWork = options.maxWork ?? Math.max(2000000, n * 400000);
  const deadline = options.deadline ?? (performance.now() + (options.timeLimitMs ?? 120000));
  const started = performance.now();
  let work = 0, lastProgress = started;
  const tagged = { pairs: 0, patchPairs: 0, validations: 0, poolRecords: 0 };
  const checkLimit = () => {
    if (work > maxWork) throw new DbwcLimitError("WORK_LIMIT");
    if (performance.now() > deadline) throw new DbwcLimitError("TIME_LIMIT");
  };
  const tick = tag => {
    work++;
    if (tag) tagged[tag]++;
    if ((work & 2047) !== 0) return;
    checkLimit();
  };
  // Sonucu etkilemeyen tam-tur tarama muhasebesini gercek bir JS dongusu olmadan koru.
  // Ilk kontrol sinirinda sureyi, maxWork'u asan ilk 2048'lik sinirda is butcesini denetler.
  tick.add = count => {
    if (!(count > 0)) return;
    const end = work + count;
    const firstCheck = (Math.floor(work / 2048) + 1) * 2048;
    if (firstCheck <= end) {
      work = firstCheck;
      checkLimit();
      const firstOverWork = (Math.floor(maxWork / 2048) + 1) * 2048;
      if (firstOverWork <= end) {
        work = firstOverWork;
        throw new DbwcLimitError("WORK_LIMIT");
      }
    }
    work = end;
  };

  let current = tour.map((p, k) => ({ x: Number(p.x), y: Number(p.y), id: p.id, k }));
  if (current.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) throw new Error("DBWC coordinates must be finite");
  const delaunayStarted = performance.now();
  const preparationWork = { delaunay: {}, candidate: { sortComparisons: 0,
      candidateEdges: 0, offsetPointVisits: 0, materializedEntries: 0,
      viewPointVisits: 0, refreshPointVisits: 0, refreshEntryVisits: 0,
      refreshViewVisits: 0 },
    validation: {}, length: lengthWork };
  const delaunay = delaunayAdjacency(current, preparationWork.delaunay);
  const delaunayMs = performance.now() - delaunayStarted;
  const setNames = new Set(stages.flatMap(stage => [stage.candSet || "del", ...(stage.patch?.candSet ? [stage.patch.candSet] : [])]));
  const posOf = new Int32Array(n);
  const sets = {};
  for (const name of setNames) {
    // "flip" options.flipFactor'u kullanir (varsayilan 1.2); "flip:<f>" faktoru adinda tasir (or. yalniz yama zinciri icin 1.5).
    const flipMatch = /^flip(?::([0-9.]+))?$/.exec(name);
    if (!flipMatch && name !== "del") throw new Error(`Unknown DBWC candidate set ${name}`);
    const adjacency = flipMatch
      ? addFlipDiagonals(current, delaunay, { flipDiag: true, flipFactor: flipMatch[1] ? Number(flipMatch[1]) : (options.flipFactor ?? 1.2) },
        preparationWork.candidate[name] = {})
      : delaunay;
    const offsets = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) {
      preparationWork.candidate.offsetPointVisits++;
      offsets[i + 1] = offsets[i] + adjacency[i].length;
    }
    const stable = new Int32Array(offsets[n]);
    for (let i = 0; i < n; i++) {
      const p = current[i];
      preparationWork.candidate.candidateEdges += adjacency[i].length;
      preparationWork.candidate.materializedEntries += adjacency[i].length;
      const sorted = adjacency[i].slice().sort((a, b) => {
        preparationWork.candidate.sortComparisons++;
        return Math.hypot(p.x - current[a].x, p.y - current[a].y)
          - Math.hypot(p.x - current[b].x, p.y - current[b].y) || a - b;
      });
      stable.set(sorted, offsets[i]);
    }
    const positions = new Int32Array(offsets[n]);
    sets[name] = {
      stable, positions,
      views: Array.from({ length: n }, (_, k) => {
        preparationWork.candidate.viewPointVisits++;
        return positions.subarray(offsets[k], offsets[k + 1]);
      }),
      candidates: new Array(n)
    };
  }
  const scratch = {
    onChain: new Int32Array(n), label: new Int8Array(n), labelSet: new Uint8Array(n)
  };
  let edgeIndex;
  function refresh() {
    for (let i = 0; i < n; i++) {
      preparationWork.candidate.refreshPointVisits++;
      posOf[current[i].k] = i;
    }
    for (const set of Object.values(sets)) {
      for (let j = 0; j < set.stable.length; j++) {
        preparationWork.candidate.refreshEntryVisits++;
        set.positions[j] = posOf[set.stable[j]];
      }
      for (let i = 0; i < n; i++) {
        preparationWork.candidate.refreshViewVisits++;
        set.candidates[i] = set.views[current[i].k];
      }
    }
    edgeIndex = makeEdgeIndex(current);
  }
  refresh();

  // Derinlestirme: `deepen` tasiyan asamada baslangic butcesine takilan baslangiclar, ayni asamanin butcesi `deepen`
  // kat buyutulmus kopyasinda (listenin sonunda) yeniden taranir. Kopya yalniz bu baslangiclari alir; tum turu taramaz.
  // `tail` asamalari derin kopyalardan sonra gelir: onlardan onceki plan, tail yokmus gibi ayni sirayla ayni hamleleri
  // bulur; tail yalniz o plan yakinsadiginda (butun kuyruklar bos) calisir. Tail asamasi deepen tasiyamaz.
  const head = stages.filter(stage => !stage.tail), tail = stages.filter(stage => stage.tail);
  if (tail.some(stage => stage.deepen > 1)) throw new Error("DBWC tail stages cannot deepen");
  const plan = head.map(stage => ({ stage, deep: -1, deepOnly: false }));
  for (let si = 0; si < head.length; si++) {
    const stage = head[si];
    if (!(stage.deepen > 1)) continue;
    plan[si].deep = plan.length;
    plan.push({
      stage: { ...stage, name: `${stage.name}*`, deepen: undefined, maxProbesPerStart: (stage.maxProbesPerStart ?? 1e7) * stage.deepen },
      deep: -1, deepOnly: true
    });
  }
  for (const stage of tail) plan.push({ stage, deep: -1, deepOnly: false });
  const active = plan.map(entry => new Uint8Array(n).fill(entry.deepOnly ? 0 : 1));
  const queues = plan.map(entry => ({ values: entry.deepOnly ? [] : Array.from({ length: n }, (_, k) => k), head: 0 }));
  const stats = plan.map(({ stage }) => ({ name: stage.name, calls: 0, pairs: 0, patchPairs: 0, found: 0, startsScanned: 0, budgetStarts: 0, patchBudgetStarts: 0 }));
  const log = [];
  let moves = 0, status = "NO_IMPROVEMENT";
  const activate = (s, k) => {
    if (!active[s][k]) { active[s][k] = 1; queues[s].values.push(k); }
  };
  // Hamle sonrasi derin kopyalar kendiliginden acilmaz: yuzeysel asama ayni baslangicta yeniden kesilirse beslenir.
  const touch = k => {
    for (let s = 0; s < plan.length; s++) if (!plan[s].deepOnly) activate(s, k);
  };

  try {
    outer: while (moves < maxMoves) {
      for (let si = 0; si < plan.length; si++) {
        const stage = plan[si].stage;
        const queue = queues[si];
        while (queue.head < queue.values.length) {
          const end = Math.min(queue.values.length, queue.head + (options.chunk ?? 32));
          const chunk = queue.values.slice(queue.head, end);
          queue.head = end;
          const starts = chunk.map(k => posOf[k]);
          if (options.onProgress && performance.now() - lastProgress > 200) {
            options.onProgress({ stage: stage.name, moves, work, startsScanned: stats[si].startsScanned });
            lastProgress = performance.now();
          }
          const stat = stats[si];
          const counters = {};
          let result;
          try {
            result = search(current, {
              ...stage, candidates: undefined,
              cand: sets[stage.candSet || "del"].candidates,
              patchCand: stage.patch?.candSet ? sets[stage.patch.candSet].candidates : undefined,
              starts, first: true, scratch, edgeIndex, tick, counters,
              maxPoolRecords: options.maxPoolRecords ?? 32768
            });
          } finally {
            // Include the interrupted chunk; previously WORK_LIMIT lost its counters.
            stat.calls++; stat.pairs += counters.pairs || 0; stat.patchPairs += counters.patchPairs || 0;
            stat.budgetStarts += counters.budgetStarts || 0;
            stat.patchBudgetStarts += counters.patchBudgetStarts || 0;
          }
          const completed = result.best ? result.completedStarts : chunk.length;
          stat.startsScanned += completed;
          for (let j = 0; j < completed; j++) active[si][chunk[j]] = 0;
          // Kesilen baslangiclar hamle uygulanmadan once kimlige cevrilir (pozisyonlar hamleyle degisir).
          if (plan[si].deep >= 0) for (const pos of counters.truncatedStarts || []) activate(plan[si].deep, current[pos].k);
          if (!result.best) continue;
          if (completed < chunk.length) {
            // chunk kuyrugun ardışık bir dilimidir. Kopyalayip yeni dizi kurmak yerine
            // tamamlanmayan suffix'in basina geri don; sonraki okuma sirasi birebir aynidir.
            queue.head -= chunk.length - completed;
          }
          stat.found++;
          const changed = new Set();
          for (const [a, b] of result.best.removed) { changed.add(current[a].k); changed.add(current[b].k); }
          for (const [a, b] of result.best.added) { changed.add(current[a].k); changed.add(current[b].k); }
          if (log.length < (options.logLimit ?? 80)) {
            log.push(`${stage.name}:${result.best.tag}:k${result.best.k}:+${(-result.best.delta).toFixed(3)}`);
          }
          current = applyMoveIds(current, result.best);
          moves++;
          refresh();
          for (const k of changed) {
            touch(k);
            const p = posOf[k];
            touch(current[(p + 1) % n].k); touch(current[(p + n - 1) % n].k);
          }
          status = "IMPROVED";
          continue outer;
        }
      }
      break;
    }
    if (moves >= maxMoves) status = "MOVE_LIMIT";
  } catch (error) {
    if (!(error instanceof DbwcLimitError)) throw error;
    status = error.reason;
  }
  const finalTour = current.map(p => ({ x: p.x, y: p.y, id: p.id }));
  const simple = isSimpleTour(finalTour, preparationWork.validation);
  return {
    tour: finalTour, status, moves, initialLength,
    finalLength: tourLength(finalTour, preparationWork.length),
    elapsedMs: performance.now() - started, delaunayMs, work, workByType: tagged,
    stats, log, simple, preparationWork
  };
}

function hilbertOrder(points, metrics) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  const span = Math.max(maxX - minX, maxY - minY, 1), order = 1 << 16;
  let sortComparisons = 0;
  const ordered = points.slice().sort((a, b) => {
    sortComparisons++;
    const ax = Math.max(0, Math.min(order - 1, Math.floor((a.x - minX) / span * (order - 1))));
    const ay = Math.max(0, Math.min(order - 1, Math.floor((a.y - minY) / span * (order - 1))));
    const bx = Math.max(0, Math.min(order - 1, Math.floor((b.x - minX) / span * (order - 1))));
    const by = Math.max(0, Math.min(order - 1, Math.floor((b.y - minY) / span * (order - 1))));
    return hilbertIndex(ax, ay, order, metrics)
      - hilbertIndex(bx, by, order, metrics) || String(a.id).localeCompare(String(b.id));
  });
  if (metrics) metrics.sortComparisons = sortComparisons;
  return ordered;
}

const WARM_STAGES = Object.freeze([
  { name: "W0", maxRun: 0, maxDepth: 7, patch: null, maxProbesPerStart: 20000 },
  { name: "W1", maxRun: 1, maxDepth: 7, patch: null, maxProbesPerStart: 30000 }
]);

return {
  optimizeDBWC, tourLength, isSimpleTour, hilbertOrder,
  WARM_STAGES, V1F_STAGES, V3_STAGES, V4_STAGES,
  search, makeClosure, delaunayAdjacency, applyMoveIds
};
});
