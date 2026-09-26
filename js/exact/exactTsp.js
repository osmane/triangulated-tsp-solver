(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    Object.assign(root, api);
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    /**
     * Kanıtlı optimum (exact) TSP çözücü.
     *
     * Neden düz Held-Karp DP değil: DP O(n^2 * 2^n)'dir; n=30'da 2^30, n=40'ta
     * 2^40 alt küme demektir, ne zaman ne bellek yeter. DP burada yalnızca çok
     * küçük n için (dpLimit) ve testlerde çapraz doğrulama için kullanılır.
     *
     * Asıl yöntem: Held-Karp 1-ağaç gevşemesi (Lagrange) + dallandır-sınırla.
     *   - Alt sınır: düğüm ağırlıkları pi ile değiştirilmiş maliyetlerde minimum
     *     1-ağaç (yoğun Prim, O(n^2)); subgradient tırmanışıyla pi optimize
     *     edilir. Bu sınır TSP'nin subtour LP gevşemesiyle aynı güçtedir.
     *   - Blossom relax-and-cut: kökte tırmanışın ortalama 1-ağacından 2-eşleşme
     *     (blossom) kesimleri ayrılır, çarpanları (mu) Lagrange'a eklenir ve her
     *     düğümde pi ile birlikte tırmanılır. Subtour LP'nin üstüne çıkar
     *     (h100-s79113 kök boşluğu %1.20 -> %0.50).
     *   - Üst sınır: nearest neighbour + 2-opt + Or-opt; arama sırasında bulunan
     *     turlar ve düğümün 1-ağacından kurulan Lagrange açgözlü turları
     *     2-opt + Or-opt ile cilalanıp incumbent'a sunulur.
     *   - Dallandırma: 1-ağaçta derecesi >= 3 olan p düğümünün iki serbest
     *     kenarı üzerinden 3 yollu ayrık bölme (Held-Karp / Volgenant-Jonker);
     *     en iyi 1-ağaç gevşek kesimli bir tursa serbest tur kenarı üzerinden
     *     ikili bölme.
     *   - Yayılım: derecesi dolan düğümün diğer kenarları yasaklanır, iki kenarı
     *     kalan düğümün kenarları zorunlu olur, zorunlu yolları erken kapatacak
     *     kenarlar (alt tur) yasaklanır.
     *
     * Sonuç: 30-40 noktalı Euclid örnekleri milisaniyelerde kanıtlı optimum;
     * yöntem birkaç yüz noktaya kadar ölçeklenir. Bütçe dolarsa çözücü durur ve
     * optimal:false + gerçek boşluk (gap) ile bulunan en iyi turu döndürür.
     */

    const EDGE_FREE = 0;
    const EDGE_FORCED = 1;
    const EDGE_BANNED = 2;

    const DEFAULTS = {
        dpLimit: 13,          // bu boyuta kadar Held-Karp DP (kesin, dallanmasız)
        timeLimitMs: 20000,
        maxNodes: 500000,
        rootAscentSteps: 300, // kök düğümde subgradient adım sayısı
        childAscentSteps: 60,
        ascentPatience: 5,    // kaç adım iyileşme olmazsa lambda yarılanır
        heuristicStarts: 16,
        dpHardLimit: 18,      // DP belleği için güvenlik sınırı
        blossomCuts: true,    // kökte blossom relax-and-cut (false: saf Held-Karp 1-ağaç)
        cutMinPoints: 8,
        cutRounds: 12,        // ayırma turu üst sınırı
        cutRoundSteps: 3000,  // kökte tur başına (pi, mu) subgradient adımı üst sınırı
        cutPatience: 20,      // kök kesim aşamasında lambda yarılama sabrı (dallarda ascentPatience)
        cutUsageDecay: 0.05,  // ortalama çözümün üstel ağırlığı
        cutChildLambda: 2,    // kesimli çocuk tırmanışının başlangıç adım çarpanı
        primalInterval: 32,   // her bu kadar düğümde 1-ağaç gezisinden tur (0: kapalı)
        primalPolishWindow: 0.05, // incumbent'ın bu oranı içindeki turlar 2-opt + Or-opt'tan geçer
        maxCuts: 150,
        exactBlossoms: false, // kökte Gomory-Hu tabanlı kesin blossom ayırma (deney)
        edgeElimination: false, // Lagrange indirgenmiş maliyetle alt ağaçta kenar yasaklama (deney)
        cutTolerances: [0.1, 0.25]
    };

    function euclideanDistance(a, b) {
        return Math.hypot(a.x - b.x, a.y - b.y);
    }

    function buildCostMatrix(points, costFn = euclideanDistance) {
        const n = points.length;
        const cost = new Float64Array(n * n);
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                const value = costFn(points[i], points[j]);
                if (!Number.isFinite(value) || value < 0) {
                    throw new TypeError(`Edge cost ${i}-${j} must be a finite non-negative number`);
                }
                cost[i * n + j] = value;
                cost[j * n + i] = value;
            }
        }
        return cost;
    }

    function tourLength(tour, cost, n = Math.round(Math.sqrt(cost.length))) {
        let total = 0;
        for (let at = 0; at < tour.length; at++) {
            total += cost[tour[at] * n + tour[(at + 1) % tour.length]];
        }
        return total;
    }

    // ---------------------------------------------------------------- heuristik

    function nearestNeighbourTour(n, cost, start) {
        const visited = new Uint8Array(n);
        const tour = [start];
        visited[start] = 1;
        let current = start;
        for (let step = 1; step < n; step++) {
            let best = -1;
            let bestCost = Infinity;
            for (let next = 0; next < n; next++) {
                if (visited[next]) continue;
                const value = cost[current * n + next];
                if (value < bestCost) { bestCost = value; best = next; }
            }
            visited[best] = 1;
            tour.push(best);
            current = best;
        }
        return tour;
    }

    function reverseSegment(tour, from, to) {
        while (from < to) {
            const swap = tour[from];
            tour[from] = tour[to];
            tour[to] = swap;
            from++;
            to--;
        }
    }

    /** Tam 2-opt taraması; iyileştirme kalmayana kadar tekrarlar. */
    function twoOptImprove(tour, n, cost, shouldStop = null) {
        const size = tour.length;
        let improved = true;
        while (improved) {
            improved = false;
            for (let i = 0; i < size - 1; i++) {
                if (shouldStop && shouldStop()) return tour;
                for (let j = i + 2; j < size; j++) {
                    if (shouldStop && (j & 1023) === 0 && shouldStop()) return tour;
                    if (i === 0 && j === size - 1) continue;
                    const a = tour[i];
                    const b = tour[i + 1];
                    const c = tour[j];
                    const d = tour[(j + 1) % size];
                    const delta = cost[a * n + c] + cost[b * n + d]
                        - cost[a * n + b] - cost[c * n + d];
                    if (delta < -1e-10) {
                        reverseSegment(tour, i + 1, j);
                        improved = true;
                    }
                }
            }
        }
        return tour;
    }

    /**
     * 1-3 noktalık parçaları her iki yönde taşıyan Or-opt taraması. Kazanç
     * doğrudan kenar farkından hesaplanır; aday başına tur uzunluğu yeniden
     * hesaplanmaz, aksi halde tarama O(n^3)'e çıkar.
     */
    function orOptImprove(tour, n, cost, shouldStop = null) {
        let improved = true;
        while (improved) {
            improved = false;
            const size = tour.length;
            for (let length = 1; length <= 3 && length + 2 <= size && !improved; length++) {
                if (shouldStop && shouldStop()) return tour;
                for (let start = 0; start + length <= size && !improved; start++) {
                    if (shouldStop && shouldStop()) return tour;
                    const head = tour[start];
                    const tail = tour[start + length - 1];
                    const previous = tour[(start - 1 + size) % size];
                    const next = tour[(start + length) % size];
                    if (previous === tail || next === head) continue;
                    const gain = cost[previous * n + head] + cost[tail * n + next]
                        - cost[previous * n + next];
                    if (gain <= 1e-10) continue;

                    const rest = tour.slice(0, start).concat(tour.slice(start + length));
                    for (let at = 0; at < rest.length && !improved; at++) {
                        if (shouldStop && (at & 1023) === 0 && shouldStop()) return tour;
                        const from = rest[at];
                        const to = rest[(at + 1) % rest.length];
                        if (from === previous && to === next) continue; // aynı yere geri koymak
                        const shared = cost[from * n + to];
                        const forward = cost[from * n + head] + cost[tail * n + to] - shared;
                        const backward = cost[from * n + tail] + cost[head * n + to] - shared;
                        const reversed = backward < forward;
                        if ((reversed ? backward : forward) - gain >= -1e-10) continue;

                        const piece = tour.slice(start, start + length);
                        if (reversed) piece.reverse();
                        const rebuilt = rest.slice(0, at + 1).concat(piece, rest.slice(at + 1));
                        tour.length = 0;
                        tour.push(...rebuilt);
                        improved = true;
                    }
                }
            }
        }
        return tour;
    }

    /**
     * Birkaç başlangıçtan nearest neighbour + 2-opt + Or-opt; en iyisini döndürür.
     * options.shouldStop dolarsa elde kalan en iyi turla erken çıkar: üst sınır
     * her zaman geçerli kalır, yalnızca kalitesi düşer.
     */
    function heuristicTour(n, cost, options = {}) {
        const starts = Math.max(1, Math.min(n, options.starts ?? DEFAULTS.heuristicStarts));
        const shouldStop = options.shouldStop;
        let bestTour = null;
        let bestLength = Infinity;
        for (let attempt = 0; attempt < starts; attempt++) {
            const start = Math.floor(attempt * n / starts);
            const tour = orOptImprove(twoOptImprove(nearestNeighbourTour(n, cost, start), n, cost, shouldStop), n, cost, shouldStop);
            const length = tourLength(tour, cost, n);
            if (length < bestLength) { bestLength = length; bestTour = tour; }
            if (shouldStop && shouldStop()) break;
        }
        return { tour: bestTour, length: bestLength };
    }

    // ------------------------------------------------------------- Held-Karp DP

    /**
     * Klasik bitmask DP: dp[mask][j] = 0'dan başlayıp mask kümesini gezip j'de
     * biten en kısa yol. O(n^2 * 2^n) zaman, O(n * 2^n) bellek -- yalnızca küçük
     * n için. Büyük n'de bilerek hata fırlatır; çağıran dallandır-sınırlaya düşer.
     */
    function heldKarpTour(n, cost, options = {}) {
        if (n <= 3) return Array.from({ length: n }, (_, index) => index);
        const limit = options.dpHardLimit ?? DEFAULTS.dpHardLimit;
        if (n > limit) {
            throw new RangeError(
                `Held-Karp DP needs O(n*2^n) memory; ${n} points exceeds the limit of ${limit}`);
        }
        const rest = n - 1;
        const size = 1 << rest;
        const dp = new Float64Array(size * rest).fill(Infinity);
        const from = new Int32Array(size * rest).fill(-1);

        for (let j = 0; j < rest; j++) {
            dp[(1 << j) * rest + j] = cost[j + 1];
        }
        for (let mask = 1; mask < size; mask++) {
            for (let j = 0; j < rest; j++) {
                if (!(mask & (1 << j))) continue;
                const base = dp[mask * rest + j];
                if (base === Infinity) continue;
                for (let k = 0; k < rest; k++) {
                    if (mask & (1 << k)) continue;
                    const next = mask | (1 << k);
                    const value = base + cost[(j + 1) * n + (k + 1)];
                    if (value < dp[next * rest + k]) {
                        dp[next * rest + k] = value;
                        from[next * rest + k] = j;
                    }
                }
            }
        }

        const full = size - 1;
        let bestEnd = -1;
        let bestLength = Infinity;
        for (let j = 0; j < rest; j++) {
            const value = dp[full * rest + j] + cost[(j + 1) * n];
            if (value < bestLength) { bestLength = value; bestEnd = j; }
        }

        const reversed = [];
        let mask = full;
        let end = bestEnd;
        while (end >= 0) {
            reversed.push(end + 1);
            const previous = from[mask * rest + end];
            mask ^= (1 << end);
            end = previous;
        }
        reversed.push(0);
        return reversed.reverse();
    }

    // --------------------------------------------------------- kısıt yayılımı

    function makeUnionFind(n) {
        const parent = new Int32Array(n);
        const size = new Int32Array(n).fill(1);
        for (let i = 0; i < n; i++) parent[i] = i;
        function find(x) {
            while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
            return x;
        }
        return {
            find,
            sizeOf: x => size[find(x)],
            union(a, b) {
                const first = find(a);
                const second = find(b);
                if (first === second) return false;
                if (size[first] < size[second]) { parent[first] = second; size[second] += size[first]; }
                else { parent[second] = first; size[first] += size[second]; }
                return true;
            }
        };
    }

    /** Kenar listesinden tek Hamilton çevrimi çıkarır; çevrim değilse null. */
    function tourFromEdgeList(n, edges, edgeCount) {
        if (edgeCount !== n) return null;
        const adjacency = new Int32Array(n * 2).fill(-1);
        const filled = new Int32Array(n);
        for (let at = 0; at < edgeCount; at++) {
            const i = edges[at * 2];
            const j = edges[at * 2 + 1];
            if (filled[i] > 1 || filled[j] > 1) return null;
            adjacency[i * 2 + filled[i]++] = j;
            adjacency[j * 2 + filled[j]++] = i;
        }
        const tour = [0];
        const seen = new Uint8Array(n);
        seen[0] = 1;
        let previous = -1;
        let current = 0;
        for (let step = 1; step < n; step++) {
            const first = adjacency[current * 2];
            const next = first === previous ? adjacency[current * 2 + 1] : first;
            if (next < 0 || seen[next]) return null;
            seen[next] = 1;
            tour.push(next);
            previous = current;
            current = next;
        }
        const last = tour[n - 1];
        if (adjacency[last * 2] !== 0 && adjacency[last * 2 + 1] !== 0) return null;
        return tour;
    }

    /**
     * Kenar durumlarını sabit noktaya kadar yayar. Döndürdüğü:
     *   {feasible:false}            -> alt problem boş, budanabilir
     *   {feasible:true, tour}       -> kısıtlar tek bir turu zorluyor
     *   {feasible:true, tour:null}  -> dallandırmaya devam
     * state yerinde değiştirilir.
     */
    function propagateState(n, state) {
        let dirty = true;
        while (dirty) {
            dirty = false;

            for (let i = 0; i < n; i++) {
                let forced = 0;
                let allowed = 0;
                for (let j = 0; j < n; j++) {
                    if (j === i) continue;
                    const value = state[i * n + j];
                    if (value === EDGE_BANNED) continue;
                    allowed++;
                    if (value === EDGE_FORCED) forced++;
                }
                if (forced > 2 || allowed < 2) return { feasible: false };
                if (forced === 2 && allowed > 2) {
                    for (let j = 0; j < n; j++) {
                        if (j !== i && state[i * n + j] === EDGE_FREE) {
                            state[i * n + j] = EDGE_BANNED;
                            state[j * n + i] = EDGE_BANNED;
                        }
                    }
                    dirty = true;
                } else if (allowed === 2 && forced < 2) {
                    for (let j = 0; j < n; j++) {
                        if (j !== i && state[i * n + j] === EDGE_FREE) {
                            state[i * n + j] = EDGE_FORCED;
                            state[j * n + i] = EDGE_FORCED;
                        }
                    }
                    dirty = true;
                }
            }
            if (dirty) continue;

            // Zorunlu kenarlar: yol ormanı mı, yoksa erken kapanan çevrim mi?
            const forcedEdges = [];
            for (let i = 0; i < n; i++) {
                for (let j = i + 1; j < n; j++) {
                    if (state[i * n + j] === EDGE_FORCED) forcedEdges.push([i, j]);
                }
            }
            if (forcedEdges.length > n) return { feasible: false };
            if (forcedEdges.length === n) {
                const flat = new Int32Array(n * 2);
                forcedEdges.forEach(([i, j], at) => { flat[at * 2] = i; flat[at * 2 + 1] = j; });
                const tour = tourFromEdgeList(n, flat, n);
                return tour ? { feasible: true, tour } : { feasible: false };
            }

            const unionFind = makeUnionFind(n);
            for (const [i, j] of forcedEdges) {
                if (!unionFind.union(i, j)) return { feasible: false };
            }

            // Bir zorunlu yolun iki ucunu birleştiren serbest kenar, tüm noktaları
            // kapsamıyorsa alt tur (subtour) üretir; yasaklanır.
            for (let i = 0; i < n; i++) {
                for (let j = i + 1; j < n; j++) {
                    if (state[i * n + j] !== EDGE_FREE) continue;
                    if (unionFind.find(i) !== unionFind.find(j)) continue;
                    if (unionFind.sizeOf(i) >= n) continue;
                    state[i * n + j] = EDGE_BANNED;
                    state[j * n + i] = EDGE_BANNED;
                    dirty = true;
                }
            }
        }
        return { feasible: true, tour: null };
    }

    // ------------------------------------------------------------- 1-ağaç sınır

    function createWorkspace(n) {
        return {
            n,
            degree: new Int32Array(n),
            edges: new Int32Array(2 * n),
            key: new Float64Array(n),
            keyFrom: new Int32Array(n),
            keyForced: new Uint8Array(n),
            inTree: new Uint8Array(n),
            bestPi: new Float64Array(n),
            bestDegree: new Int32Array(n),
            bestEdges: new Int32Array(2 * n)
        };
    }

    /**
     * Verilen pi ağırlıklarıyla minimum 1-ağacı kurar. 1-ağaç = root dışındaki
     * noktaların minimum yayılan ağacı + root'un en ucuz iki kenarı; zorunlu
     * kenarlar daima içinde, yasaklı kenarlar daima dışındadır. Döndürdüğü bound,
     * alt problemin gerçek optimumu için geçerli bir alt sınırdır.
     *
     * Yayılan ağaç tek geçişli yoğun Prim'dir, O(n^2): zorunlu kenar ağırlığı
     * -sonsuz sayılır (keyForced önceliği). Zorunlu kenarlar orman olduğu sürece
     * minimum ağaç hepsini içerir ve onları içeren ağaçlar arasında en ucuzudur.
     * Zorunlu kenarlar önceliklidir, dolayısıyla bir zorunlu bileşen serbest bir
     * kenar seçilmeden bütünüyle ağaca girer; ağaçtaki iki ayrı noktadan zorunlu
     * kenar alan nokta bu yüzden ancak zorunlu kenarların çevrim kurduğu anlamına
     * gelir ve alt problem boştur. (Eski sürüm bileşenleri union-find ile daraltıp
     * bileşen çifti matrisi kuruyordu: çağrı başına ~3n^2 iş ve iki tahsis.)
     */
    function computeOneTree(workspace, cost, state, root, pi) {
        const n = workspace.n;
        const degree = workspace.degree.fill(0);
        const edges = workspace.edges;
        const key = workspace.key;
        const keyFrom = workspace.keyFrom;
        const keyForced = workspace.keyForced.fill(0);
        const inTree = workspace.inTree.fill(0);
        let edgeCount = 0;
        let modifiedTotal = 0;

        const start = root === 0 ? 1 : 0;
        for (let v = 0; v < n; v++) key[v] = Infinity;
        inTree[root] = 1;
        let current = start;
        for (let added = 1; added < n - 1; added++) {
            inTree[current] = 1;
            const row = current * n;
            const piCurrent = pi[current];
            // Tek geçiş: anahtar güncellemesi ve sonraki noktanın seçimi birlikte.
            let pick = -1;
            let pickCost = Infinity;
            let forcedPick = -1;
            for (let v = 0; v < n; v++) {
                if (inTree[v]) continue;
                const edgeState = state[row + v];
                if (edgeState === EDGE_FORCED) {
                    if (keyForced[v]) return null; // zorunlu kenarlar çevrim kuruyor
                    keyForced[v] = 1;
                    key[v] = cost[row + v] + piCurrent + pi[v];
                    keyFrom[v] = current;
                } else if (edgeState !== EDGE_BANNED && !keyForced[v]) {
                    const value = cost[row + v] + piCurrent + pi[v];
                    if (value < key[v]) {
                        key[v] = value;
                        keyFrom[v] = current;
                    }
                }
                if (keyForced[v]) {
                    if (forcedPick < 0) forcedPick = v;
                } else if (key[v] < pickCost) {
                    pickCost = key[v];
                    pick = v;
                }
            }
            if (forcedPick >= 0) pick = forcedPick;
            if (pick < 0) return null; // yasaklar yüzünden bağlanamıyor
            const from = keyFrom[pick];
            modifiedTotal += key[pick];
            degree[pick]++;
            degree[from]++;
            edges[edgeCount * 2] = from;
            edges[edgeCount * 2 + 1] = pick;
            edgeCount++;
            current = pick;
        }
        // Son seçilen nokta taranmaz: ağaçtaki her nokta onu taradığında zorunlu
        // kenarını kaydetmiştir, ikinci zorunlu kenar yukarıda zaten null döndürdü.

        // root'un iki kenarı: önce zorunlular, sonra en ucuz serbestler.
        let first = -1;
        let second = -1;
        for (let j = 0; j < n; j++) {
            if (j === root || state[root * n + j] !== EDGE_FORCED) continue;
            if (first < 0) first = j;
            else if (second < 0) second = j;
            else return null;
        }
        while (second < 0) {
            let pick = -1;
            let pickCost = Infinity;
            for (let j = 0; j < n; j++) {
                if (j === root || j === first || state[root * n + j] !== EDGE_FREE) continue;
                const value = cost[root * n + j] + pi[root] + pi[j];
                if (value < pickCost) { pickCost = value; pick = j; }
            }
            if (pick < 0) return null;
            if (first < 0) first = pick;
            else second = pick;
        }
        for (const other of [first, second]) {
            modifiedTotal += cost[root * n + other] + pi[root] + pi[other];
            degree[root]++;
            degree[other]++;
            edges[edgeCount * 2] = root;
            edges[edgeCount * 2 + 1] = other;
            edgeCount++;
        }

        let piSum = 0;
        for (let i = 0; i < n; i++) piSum += pi[i];
        return { bound: modifiedTotal - 2 * piSum, edgeCount };
    }

    /**
     * Subgradient tırmanışı: pi'yi derece sapması yönünde iterler ve en yüksek
     * (en iyi) alt sınırı saklar. 1-ağaç tura dönerse alt problem çözülmüştür:
     * o turun maliyeti sınıra eşittir, yani alt problemin optimumudur.
     */
    function ascendBound(workspace, cost, state, root, pi, upperBound, steps, stats, shouldStop, options = {}) {
        const n = workspace.n;
        const patience = options.ascentPatience ?? DEFAULTS.ascentPatience;
        let bestBound = -Infinity;
        let bestEdgeCount = 0;
        let lambda = 2;
        let sinceImprovement = 0;
        const epsilon = 1e-9 * Math.max(1, Math.abs(upperBound));

        for (let step = 0; step < steps; step++) {
            // Butce kontrolu tirmanis icinde de yapilir: buyuk n'de tek dugumun
            // tirmanisi bile saniyeler surebilir, sinir erken kesilse de gecerlidir.
            if (step > 0 && (step & 7) === 0 && shouldStop && shouldStop()) break;
            const result = computeOneTree(workspace, cost, state, root, pi);
            stats.boundCalls++;
            if (!result) return { infeasible: true };

            let allTwo = true;
            for (let i = 0; i < n; i++) {
                if (workspace.degree[i] !== 2) { allTwo = false; break; }
            }
            if (allTwo) {
                const tour = tourFromEdgeList(n, workspace.edges, result.edgeCount);
                if (tour) return { tour, tourLength: result.bound, bound: result.bound, solved: true };
            }
            if (result.bound > bestBound) {
                bestBound = result.bound;
                bestEdgeCount = result.edgeCount;
                workspace.bestDegree.set(workspace.degree);
                workspace.bestEdges.set(workspace.edges);
                workspace.bestPi.set(pi);
                sinceImprovement = 0;
            } else if (++sinceImprovement >= patience) {
                lambda /= 2;
                sinceImprovement = 0;
            }
            if (bestBound >= upperBound - epsilon) break;
            if (lambda < 1e-6) break;

            // Ders kitabı Held-Karp adımı: pi += lambda * (UB - L) / ||d||^2 * d.
            // Ölçüldü (pr76 + rastgele n=80): subgradient'e momentum eklemek ve
            // patience'i buyutmek kok sinirini bir birim degistirmiyor, yalnizca
            // adim sayisini artiriyor; o yuzden duz sema korunuyor.
            let norm = 0;
            for (let i = 0; i < n; i++) {
                const deviation = workspace.degree[i] - 2;
                norm += deviation * deviation;
            }
            if (norm <= 0) break;

            const target = upperBound - result.bound;
            const stepSize = lambda * (target > 0 ? target : epsilon) / norm;
            for (let i = 0; i < n; i++) pi[i] += stepSize * (workspace.degree[i] - 2);
        }

        pi.set(workspace.bestPi); // çocuklara sıcak başlangıç: en iyi sınırın pi'si
        return { bound: bestBound, edgeCount: bestEdgeCount };
    }

    // ------------------------------------------------------ blossom kesimleri

    /**
     * 2-eşleşme (blossom) eşitsizliği: tutamaç H, dişler T (tek sayıda, >= 3,
     * uçları ikişer ikişer ayrık, her dişin tam bir ucu H'de):
     *     x(E(H)) + x(T) <= |H| + (|T| - 1) / 2.
     * Her tur için geçerlidir: H'nin dereceleri toplamı 2|H| = 2x(E(H)) + x(δ(H))
     * >= 2x(E(H)) + x(T), yani x(E(H)) + x(T) <= |H| + x(T)/2 <= |H| + |T|/2 ve
     * sol taraf tam sayı olduğundan |T| tekken |H| + (|T|-1)/2'ye iner.
     *
     * Held-Karp 1-ağaç sınırı subtour LP'ye eşittir; bu kesimler onun üstüne
     * çıkar. Ölçüldü (SciPy LP): pr76 boşluğu %2.81 -> %1.63, h100-s79113
     * %1.20 -> %0.60. Kesim Lagrange çarpanı mu >= 0 ile maliyete eklenir:
     * kenar maliyeti c_e + sum(mu_k a_ke), sınıra -sum(mu_k rhs_k). Her mu >= 0
     * ve her geçerli kesim için sınır geçerli kalır; ayırmanın kalitesi yalnız
     * sınırın gücünü etkiler, doğruluğunu değil.
     */
    function createBlossomCut(n, handle, teeth) {
        if (teeth.length < 3 || teeth.length % 2 === 0) throw new Error("Blossom: odd number (>= 3) of teeth required");
        const inHandle = new Uint8Array(n);
        for (const i of handle) inHandle[i] = 1;
        const toothMate = new Int32Array(n).fill(-1);
        for (const [i, j] of teeth) {
            if (inHandle[i] === inHandle[j]) throw new Error("Blossom: every tooth needs exactly one end in the handle");
            if (toothMate[i] >= 0 || toothMate[j] >= 0) throw new Error("Blossom: teeth must be pairwise disjoint");
            toothMate[i] = j;
            toothMate[j] = i;
        }
        return {
            handle: Int32Array.from(handle).sort(),
            teeth: teeth.map(([i, j]) => (i < j ? [i, j] : [j, i])),
            rhs: handle.length + (teeth.length - 1) / 2,
            inHandle,
            toothMate,
            mu: 0,
            subgradient: 0
        };
    }

    function blossomKey(cut) {
        return `${cut.handle.join(",")}|${cut.teeth.map(([i, j]) => `${i}-${j}`).sort().join(",")}`;
    }

    function applyBlossomMultiplier(adjusted, edgeList, delta) {
        for (let at = 0; at < edgeList.length; at++) adjusted[edgeList[at]] += delta;
    }

    /** Kenar listesindeki (1-ağaç) kesim sol tarafı: E(H) ∪ T içindeki kenar sayısı. */
    function blossomLhs(cut, edges, edgeCount) {
        let count = 0;
        for (let at = 0; at < edgeCount; at++) {
            const i = edges[at * 2];
            const j = edges[at * 2 + 1];
            if ((cut.inHandle[i] && cut.inHandle[j]) || cut.toothMate[i] === j) count++;
        }
        return count;
    }

    /**
     * Padberg-Hong heuristiği, tırmanış 1-ağaçlarının ortalaması x üzerinde:
     * tolerance < x < 1-tolerance kenarlarının bileşenleri tutamaç, tutamaçtan
     * çıkan x >= 1-tolerance kenarları (büyükten küçüğe, uçları ayrık) diş.
     * Diş sayısı çiftse en zayıfı atılır. x yalnız aday üretir; kesim her
     * durumda geçerlidir.
     */
    function separateBlossoms(n, usage, samples, tolerance, minViolation) {
        const x = (i, j) => usage[i * n + j] / samples;
        const unionFind = makeUnionFind(n);
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                const value = x(i, j);
                if (value > tolerance && value < 1 - tolerance) unionFind.union(i, j);
            }
        }
        const groups = new Map();
        for (let i = 0; i < n; i++) {
            const owner = unionFind.find(i);
            if (!groups.has(owner)) groups.set(owner, []);
            groups.get(owner).push(i);
        }
        const found = [];
        const inHandle = new Uint8Array(n);
        const used = new Uint8Array(n);
        for (const handle of groups.values()) {
            if (handle.length < 3 || handle.length > n - 3) continue;
            inHandle.fill(0);
            for (const i of handle) inHandle[i] = 1;
            const candidates = [];
            for (const i of handle) {
                for (let j = 0; j < n; j++) {
                    if (!inHandle[j] && x(i, j) >= 1 - tolerance) candidates.push([x(i, j), i, j]);
                }
            }
            candidates.sort((a, b) => b[0] - a[0]);
            used.fill(0);
            const teeth = [];
            for (const [value, i, j] of candidates) {
                if (used[i] || used[j]) continue;
                used[i] = 1;
                used[j] = 1;
                teeth.push([value, i, j]);
            }
            if (teeth.length % 2 === 0) teeth.pop();
            if (teeth.length < 3) continue;
            let lhs = 0;
            for (let a = 0; a < handle.length; a++) {
                for (let b = a + 1; b < handle.length; b++) lhs += x(handle[a], handle[b]);
            }
            for (const [value] of teeth) lhs += value;
            const rhs = handle.length + (teeth.length - 1) / 2;
            if (lhs > rhs + minViolation) {
                found.push(createBlossomCut(n, handle, teeth.map(([, i, j]) => [i, j])));
            }
        }
        return found;
    }

    /**
     * Gusfield Gomory-Hu kesim ağacı, seyrek yönsüz graf (eu, ev, cap). Her
     * ağaç kenarı (i, parent[i]) için ağaçtan çıkarınca i'nin tarafı gerçek bir
     * minimum i-parent[i] kesimidir. Maksimum akış Dinic, kalıntı kapasitede.
     */
    function gomoryHuTree(n, eu, ev, cap) {
        const m = eu.length;
        const degreeCount = new Int32Array(n + 1);
        for (let e = 0; e < m; e++) { degreeCount[eu[e] + 1]++; degreeCount[ev[e] + 1]++; }
        for (let i = 0; i < n; i++) degreeCount[i + 1] += degreeCount[i];
        const arcs = new Int32Array(2 * m);   // düğüm -> ark (ark 2e: eu->ev, 2e+1: ev->eu)
        const fill = degreeCount.slice(0, n);
        for (let e = 0; e < m; e++) { arcs[fill[eu[e]]++] = 2 * e; arcs[fill[ev[e]]++] = 2 * e + 1; }
        const head = a => (a & 1 ? eu[a >> 1] : ev[a >> 1]);
        const residual = new Float64Array(2 * m);
        const level = new Int32Array(n);
        const cursor = new Int32Array(n);
        const queue = new Int32Array(n);
        const parent = new Int32Array(n);
        const flow = new Float64Array(n);
        const side = new Uint8Array(n);
        const eps = 1e-12;

        const bfs = (s, t) => {
            level.fill(-1);
            level[s] = 0;
            let qh = 0;
            let qt = 0;
            queue[qt++] = s;
            while (qh < qt) {
                const v = queue[qh++];
                for (let p = degreeCount[v]; p < degreeCount[v + 1]; p++) {
                    const a = arcs[p];
                    const w = head(a);
                    if (level[w] < 0 && residual[a] > eps) { level[w] = level[v] + 1; queue[qt++] = w; }
                }
            }
            return t < 0 ? true : level[t] >= 0;
        };
        const dfs = (v, t, pushed) => {
            if (v === t) return pushed;
            for (; cursor[v] < degreeCount[v + 1]; cursor[v]++) {
                const a = arcs[cursor[v]];
                const w = head(a);
                if (level[w] !== level[v] + 1 || residual[a] <= eps) continue;
                const got = dfs(w, t, Math.min(pushed, residual[a]));
                if (got > eps) {
                    residual[a] -= got;
                    residual[a ^ 1] += got;
                    return got;
                }
            }
            return 0;
        };

        for (let s = 1; s < n; s++) {
            const t = parent[s];
            for (let e = 0; e < m; e++) { residual[2 * e] = cap[e]; residual[2 * e + 1] = cap[e]; }
            let value = 0;
            while (bfs(s, t)) {
                cursor.set(degreeCount.subarray(0, n));
                let got;
                while ((got = dfs(s, t, Infinity)) > eps) value += got;
            }
            bfs(s, -1);
            for (let i = 0; i < n; i++) side[i] = level[i] >= 0 ? 1 : 0;
            flow[s] = value;
            for (let i = 0; i < n; i++) {
                if (i !== s && side[i] && parent[i] === t) parent[i] = s;
            }
            if (side[parent[t]]) {
                parent[s] = parent[t];
                parent[t] = s;
                flow[s] = flow[t];
                flow[t] = value;
            }
        }
        return { parent, flow };
    }

    /**
     * Kesin blossom ayırma (Letchford-Reinelt-Theis): kapasite min(x, 1-x) ile
     * Gomory-Hu ağacı; her ağaç kesimi δ(H) için en iyi tek F (x > 1/2 kenarlar,
     * parite en ucuz kenarın çevrilmesiyle). x(δ(H) \ F) + sum_F (1 - x) < 1 ise
     * blossom ihlal edilir; x derece-2'yi sağlıyorsa ihlal edilen her blossom bu
     * n-1 kesimden birinde bulunur. F'nin uçları ortak olabilir (eşitsizlik yine
     * geçerlidir); ortak uç v'deki iki diş v tutamacın dışındaysa v'yi içeri,
     * içindeyse dışarı alarak atılır: derece-2 x'te ihlal azalmaz, dişler ayrık
     * olur. x ortalama 1-ağaç olduğundan son kontrol doğrudan sol tarafla yapılır.
     */
    function separateBlossomsExact(n, usage, samples, minViolation) {
        const eu = [];
        const ev = [];
        const xs = [];
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                const value = usage[i * n + j] / samples;
                if (value > 1e-6) { eu.push(i); ev.push(j); xs.push(Math.min(1, value)); }
            }
        }
        const m = eu.length;
        const cap = Float64Array.from(xs, value => Math.min(value, 1 - value));
        const { parent, flow } = gomoryHuTree(n, eu, ev, cap);

        // Kök 0'lı ağaçta her düğümün alt ağacı: Euler aralığı.
        const childStart = new Int32Array(n + 1);
        for (let i = 1; i < n; i++) childStart[parent[i] + 1]++;
        for (let i = 0; i < n; i++) childStart[i + 1] += childStart[i];
        const children = new Int32Array(Math.max(1, n - 1));
        const childFill = childStart.slice(0, n);
        for (let i = 1; i < n; i++) children[childFill[parent[i]]++] = i;
        const enter = new Int32Array(n);
        const leave = new Int32Array(n);
        const order = new Int32Array(n);
        {
            const stack = [0];
            const next = childStart.slice(0, n);
            let clock = 0;
            enter[0] = clock; order[clock++] = 0;
            while (stack.length) {
                const v = stack[stack.length - 1];
                if (next[v] < childStart[v + 1]) {
                    const child = children[next[v]++];
                    enter[child] = clock; order[clock++] = child;
                    stack.push(child);
                } else {
                    leave[v] = clock;
                    stack.pop();
                }
            }
        }

        const found = [];
        const inH = new Uint8Array(n);
        const endCount = new Int32Array(n);
        for (let s = 1; s < n; s++) {
            if (!(flow[s] < 1 - minViolation)) continue;
            const size = leave[s] - enter[s];
            const complement = size > n / 2;
            inH.fill(complement ? 1 : 0);
            for (let at = enter[s]; at < leave[s]; at++) inH[order[at]] = complement ? 0 : 1;
            let value = 0;
            let fixEdge = -1;
            let fixCost = Infinity;
            const teeth = [];
            for (let e = 0; e < m; e++) {
                if (inH[eu[e]] === inH[ev[e]]) continue;
                const x = xs[e];
                if (x > 0.5) { teeth.push(e); value += 1 - x; } else value += x;
                const flip = Math.abs(1 - 2 * x);
                if (flip < fixCost) { fixCost = flip; fixEdge = e; }
            }
            if (teeth.length % 2 === 0) {
                if (fixEdge < 0) continue;
                value += fixCost;
                const at = teeth.indexOf(fixEdge);
                if (at >= 0) teeth.splice(at, 1); else teeth.push(fixEdge);
            }
            if (!(value < 1 - minViolation) || teeth.length < 3) continue;

            // Ortak uçları at: v'deki iki diş kaldırılır, v tutamacın öbür tarafına geçer.
            let ok = true;
            for (;;) {
                endCount.fill(0);
                for (const e of teeth) { endCount[eu[e]]++; endCount[ev[e]]++; }
                let shared = -1;
                for (let v = 0; v < n; v++) {
                    if (endCount[v] >= 3) { ok = false; break; }
                    if (endCount[v] === 2) { shared = v; break; }
                }
                if (!ok || shared < 0) break;
                for (let k = teeth.length - 1; k >= 0; k--) {
                    if (eu[teeth[k]] === shared || ev[teeth[k]] === shared) teeth.splice(k, 1);
                }
                inH[shared] ^= 1;
            }
            if (!ok || teeth.length < 3) continue;
            const handle = [];
            for (let i = 0; i < n; i++) if (inH[i]) handle.push(i);
            if (handle.length < 2 || handle.length > n - 2) continue;
            let lhs = 0;
            for (let a = 0; a < handle.length; a++) {
                for (let b = a + 1; b < handle.length; b++) lhs += usage[handle[a] * n + handle[b]] / samples;
            }
            for (const e of teeth) lhs += xs[e];
            const rhs = handle.length + (teeth.length - 1) / 2;
            if (lhs > rhs + minViolation) {
                found.push(createBlossomCut(n, handle, teeth.map(e => [eu[e], ev[e]])));
            }
        }
        return found;
    }

    /**
     * Kesim kümesi: kesimler, sağ tarafları ve kenar -> kesim üyelik listesi
     * (CSR). Sol taraf hesabı 1-ağacın n kenarı üzerinden tek geçiştir; kesim
     * başına n kenar taramaz.
     */
    function createCutSet(n, cuts, state = null) {
        const counts = new Int32Array(n * n + 1);
        // state verilirse yasaklı kenarlar atlanır: 1-ağaç onları hiç okumaz, alt
        // ağaçta da yasaklı kalırlar. Kök kenar elemesi kenarların ~%80'ini atınca
        // mu güncellemesi (tutamaç çiftleri) buna göre ucuzlar.
        const each = (cut, visit) => {
            const handle = cut.handle;
            for (let a = 0; a < handle.length; a++) {
                for (let b = a + 1; b < handle.length; b++) {
                    if (!state || state[handle[a] * n + handle[b]] !== EDGE_BANNED) visit(handle[a], handle[b]);
                }
            }
            for (const [i, j] of cut.teeth) {
                if (!state || state[i * n + j] !== EDGE_BANNED) visit(i, j);
            }
        };
        cuts.forEach(cut => each(cut, (i, j) => { counts[i * n + j + 1]++; counts[j * n + i + 1]++; }));
        for (let at = 1; at <= n * n; at++) counts[at] += counts[at - 1];
        const members = new Int32Array(counts[n * n]);
        const fill = counts.slice(0, n * n);
        const edgeLists = cuts.map((cut, k) => {
            const list = [];
            each(cut, (i, j) => {
                members[fill[i * n + j]++] = k;
                members[fill[j * n + i]++] = k;
                list.push(i * n + j, j * n + i);
            });
            return Int32Array.from(list);
        });
        return {
            cuts,
            rhs: Float64Array.from(cuts, cut => cut.rhs),
            offsets: counts,
            members,
            edgeLists,
            lhs: new Float64Array(cuts.length),
            subgradient: new Float64Array(cuts.length)
        };
    }

    /**
     * Held-Karp + blossom Lagrange tırmanışı: pi (derece, serbest) ve mu (kesim,
     * >= 0) birlikte iterlenir. Sınır = 1-ağaç(c + pi + sum mu a) - 2 sum pi -
     * sum mu rhs; her pi ve her mu >= 0 için geçerlidir. mu düğüme özgüdür ve
     * ebeveynden sıcak başlar: dallanma kesimlerin yapısını bozduğunda mu sıfıra
     * inebilir, dolayısıyla sınır kesimsiz Held-Karp sınırının altında
     * kalmak zorunda değildir. (Kökte sabitlenmiş mu ile ölçüldü: kök sınırı
     * yükseldi ama çocuk sınırları çöktü, h80-s78057'de 2190 -> 79737 düğüm.)
     *
     * 1-ağaç tura dönerse gerçek uzunluğu onTour'a verilir; yalnız sınır o
     * uzunluğa ulaşmışsa (pozitif çarpanlı her kesim sıkı) düğüm çözülmüştür.
     * Gevşek kesimli turda tırmanış sürer: gevşek kesimin mu'su azalır.
     *
     * sampling ({usage, decay, patience}) kökteki kesim aşaması içindir: 1-ağaç
     * kenarları üstel ağırlıkla (sonraki adım 1/(1-decay) kat ağır) usage'a
     * toplanır; usage / weight tırmanışın ortalama çözümüdür ve kesim ayırmaya
     * girer. Bütün adımlar sayılır: tırmanış lambda küçülünce erken biterse
     * "ikinci yarı" penceresi boş kalıyor ve ayırma hiç koşmuyordu.
     */
    function ascendBoundWithCuts(workspace, cost, state, root, pi, mu, cutSet, upperBoundOf, steps, stats, shouldStop, options, onTour, sampling = null) {
        const n = workspace.n;
        const cuts = cutSet.cuts;
        const cutCount = cuts.length;
        const { rhs, offsets, members, lhs, subgradient } = cutSet;
        const patience = sampling ? sampling.patience : (options.ascentPatience ?? DEFAULTS.ascentPatience);
        const usage = sampling ? sampling.usage : null;
        const growth = sampling ? 1 / (1 - sampling.decay) : 1;
        let sampleWeight = 1;
        let weight = 0;
        const adjusted = workspace.adjusted || (workspace.adjusted = new Float64Array(n * n));
        adjusted.set(cost);
        for (let k = 0; k < cutCount; k++) {
            if (mu[k] > 0) applyBlossomMultiplier(adjusted, cutSet.edgeLists[k], mu[k]);
        }
        const bestMu = new Float64Array(mu);
        let bestBound = -Infinity;
        let bestEdgeCount = 0;
        let bestIsTour = false;
        let lambda = sampling ? 2 : (options.cutChildLambda ?? DEFAULTS.cutChildLambda);
        const splitNorm = !sampling && options.cutSplitNorm;
        let sinceImprovement = 0;

        for (let step = 0; step < steps; step++) {
            if (step > 0 && (step & 7) === 0 && shouldStop()) break;
            const result = computeOneTree(workspace, adjusted, state, root, pi);
            stats.boundCalls++;
            if (!result) return { infeasible: true };
            let muRhs = 0;
            for (let k = 0; k < cutCount; k++) muRhs += mu[k] * rhs[k];
            const bound = result.bound - muRhs;
            const upperBound = upperBoundOf();
            const epsilon = 1e-9 * Math.max(1, Math.abs(upperBound));

            let norm = 0;
            let allTwo = true;
            for (let i = 0; i < n; i++) {
                const deviation = workspace.degree[i] - 2;
                if (deviation !== 0) allTwo = false;
                norm += deviation * deviation;
            }
            const degreeNorm = norm;
            let isTour = false;
            if (allTwo) {
                const tour = tourFromEdgeList(n, workspace.edges, result.edgeCount);
                if (tour) {
                    isTour = true;
                    const length = tourLength(tour, cost, n);
                    onTour(tour, length);
                    if (bound >= length - epsilon) return { tour, tourLength: length, bound: length, solved: true };
                }
            }

            lhs.fill(0);
            const edges = workspace.edges;
            for (let at = 0; at < result.edgeCount; at++) {
                const e = edges[at * 2] * n + edges[at * 2 + 1];
                for (let m = offsets[e]; m < offsets[e + 1]; m++) lhs[members[m]]++;
            }
            for (let k = 0; k < cutCount; k++) {
                let value = lhs[k] - rhs[k];
                if (mu[k] <= 0 && value < 0) value = 0;
                subgradient[k] = value;
                norm += value * value;
            }

            if (bound > bestBound) {
                bestBound = bound;
                bestEdgeCount = result.edgeCount;
                bestIsTour = isTour;
                workspace.bestDegree.set(workspace.degree);
                workspace.bestEdges.set(workspace.edges);
                workspace.bestPi.set(pi);
                bestMu.set(mu);
                sinceImprovement = 0;
            } else if (++sinceImprovement >= patience) {
                lambda /= 2;
                sinceImprovement = 0;
            }
            if (usage) {
                for (let at = 0; at < result.edgeCount; at++) {
                    const i = edges[at * 2];
                    const j = edges[at * 2 + 1];
                    usage[i * n + j] += sampleWeight;
                    usage[j * n + i] += sampleWeight;
                }
                weight += sampleWeight;
                sampleWeight *= growth;
                if (weight > 1e150) {
                    for (let e = 0; e < usage.length; e++) usage[e] *= 1e-150;
                    weight *= 1e-150;
                    sampleWeight *= 1e-150;
                }
            }
            if (bestBound >= upperBoundOf() - epsilon) break;
            if (norm <= 0 || lambda < 1e-6) break;

            const target = upperBound - bound;
            const stepSize = lambda * (target > 0 ? target : epsilon) / norm;
            const piStep = splitNorm && degreeNorm > 0 ? lambda * (target > 0 ? target : epsilon) / degreeNorm : stepSize;
            for (let i = 0; i < n; i++) pi[i] += piStep * (workspace.degree[i] - 2);
            for (let k = 0; k < cutCount; k++) {
                if (subgradient[k] === 0) continue;
                const next = Math.max(0, mu[k] + stepSize * subgradient[k]);
                if (next !== mu[k]) {
                    applyBlossomMultiplier(adjusted, cutSet.edgeLists[k], next - mu[k]);
                    mu[k] = next;
                }
            }
        }

        pi.set(workspace.bestPi);
        mu.set(bestMu);
        return { bound: bestBound, edgeCount: bestEdgeCount, bestIsTour, weight };
    }

    /**
     * Kök düğümde relax-and-cut: kesimsiz Held-Karp tırmanışıyla başlar, her
     * turdan sonra tırmanışın ortalama 1-ağacından yeni blossom kesimleri ayrılır
     * ve (pi, mu) birlikte yeniden tırmanılır. Dönen kesim kümesi dallandır-
     * sınırla boyunca sabittir; mu düğüme özgü tırmanılır. Hiç kesim bulunmazsa
     * cutSet null döner ve arama saf Held-Karp olarak koşar. pi ve dönen mu en
     * iyi kök sınırının çarpanlarıdır.
     */
    function strengthenRootWithBlossoms(workspace, cost, state, root, pi, upperBoundOf, stats, shouldStop, options, onTour) {
        const n = workspace.n;
        const maxRounds = options.cutRounds ?? DEFAULTS.cutRounds;
        const roundSteps = options.cutRoundSteps ?? DEFAULTS.cutRoundSteps;
        const maxCuts = options.maxCuts ?? DEFAULTS.maxCuts;
        const tolerances = options.cutTolerances ?? DEFAULTS.cutTolerances;
        const usage = new Float64Array(n * n);
        const sampling = {
            usage,
            decay: options.cutUsageDecay ?? DEFAULTS.cutUsageDecay,
            patience: options.cutPatience ?? DEFAULTS.cutPatience
        };
        const keys = new Set();
        // options.initialCuts: dışarıdan verilen blossom'lar ({handle, teeth}); geçersizse
        // createBlossomCut hata atar. Teşhis ve testler için.
        let cuts = (options.initialCuts || []).map(cut => createBlossomCut(n, cut.handle, cut.teeth));
        for (const cut of cuts) keys.add(blossomKey(cut));
        let mu = new Float64Array(cuts.length);
        let boundWithoutCuts = null;
        let bound = -Infinity;
        let rounds = 0;

        for (let round = 0; ; round++) {
            usage.fill(0);
            const cutSet = createCutSet(n, cuts, state);
            const outcome = ascendBoundWithCuts(
                workspace, cost, state, root, pi, mu, cutSet, upperBoundOf, roundSteps,
                stats, shouldStop, options, onTour, sampling);
            rounds = round;
            if (outcome.infeasible || outcome.solved) break;
            bound = Math.max(bound, outcome.bound);
            if (round === 0) boundWithoutCuts = outcome.bound;
            if (bound >= upperBoundOf() - 1e-9 * Math.max(1, Math.abs(upperBoundOf()))) break;
            if (shouldStop() || round >= maxRounds || !(outcome.weight > 0) || cuts.length >= maxCuts) break;

            if (options.edgeElimination ?? DEFAULTS.edgeElimination) {
                // Kök kenar elemesi her turda: yasaklar bütün arama için geçerli, sonraki
                // turların 1-ağaçları ve kesim listeleri seyrekleşir. Yayılım boş ya da
                // tur çıkarırsa kesim aşaması biter; ana döngünün kök tırmanışı bunu görür.
                const upperBound = upperBoundOf();
                const banned = eliminateEdges(workspace, cost, cutSet, mu, pi, state, root,
                    upperBound - 1e-9 * Math.max(1, Math.abs(upperBound)));
                stats.rootCutEliminatedEdges = (stats.rootCutEliminatedEdges || 0) + banned;
                if (banned > 0) {
                    const propagation = propagateState(n, state);
                    if (!propagation.feasible || propagation.tour) break;
                }
            }

            const fresh = [];
            const offer = cut => {
                const key = blossomKey(cut);
                if (keys.has(key) || cuts.length + fresh.length >= maxCuts) return;
                keys.add(key);
                fresh.push(cut);
            };
            for (const tolerance of tolerances) {
                for (const cut of separateBlossoms(n, usage, outcome.weight, tolerance, 1e-3)) offer(cut);
            }
            if (options.exactBlossoms ?? DEFAULTS.exactBlossoms) {
                for (const cut of separateBlossomsExact(n, usage, outcome.weight, 1e-3)) offer(cut);
            }
            if (fresh.length === 0) break;
            cuts = cuts.concat(fresh);
            const grown = new Float64Array(cuts.length);
            grown.set(mu);
            mu = grown;
        }

        const report = { rounds, generated: cuts.length, active: 0, rootBoundWithoutCuts: boundWithoutCuts, rootBoundWithCuts: bound };
        if (cuts.length === 0) return { cutSet: null, mu: null, report };
        report.active = mu.reduce((count, value) => count + (value > 0 ? 1 : 0), 0);
        if (options.pruneInactiveCuts) {
            const keep = [];
            for (let k = 0; k < cuts.length; k++) if (mu[k] > 0) keep.push(k);
            if (keep.length === 0) return { cutSet: null, mu: null, report };
            cuts = keep.map(k => cuts[k]);
            mu = Float64Array.from(keep, k => mu[k]);
        }
        report.coefficients = cuts.reduce((sum, cut) => sum + cut.handle.length * (cut.handle.length - 1) / 2 + cut.teeth.length, 0);
        return { cutSet: createCutSet(n, cuts, state), mu, report };
    }

    // ------------------------------------------------------- dallandır-sınırla

    /**
     * Gevşek kesimli tur düğümü: en iyi 1-ağaç tur ama gerçek uzunluğu sınırın
     * üstünde. Dereceleri 2 olduğundan 3 yollu bölme uygulanamaz; serbest bir
     * tur kenarı üzerinden ikili ayrık bölme yapılır (yasak / zorunlu). Kesim
     * cezası (sum mu a_e) en büyük kenar seçilir. Her tur kenarı zorunlu olsaydı
     * yayılım turu zaten kapatırdı, dolayısıyla serbest kenar her zaman vardır.
     */
    function chooseSlackTourEdge(workspace, cutSet, mu, state) {
        const n = workspace.n;
        const edges = workspace.bestEdges;
        let best = null;
        let bestPenalty = -Infinity;
        for (let at = 0; at < n; at++) {
            const i = edges[at * 2];
            const j = edges[at * 2 + 1];
            if (state[i * n + j] !== EDGE_FREE) continue;
            let penalty = 0;
            const e = i * n + j;
            for (let m = cutSet.offsets[e]; m < cutSet.offsets[e + 1]; m++) penalty += mu[cutSet.members[m]];
            if (penalty > bestPenalty) { bestPenalty = penalty; best = [i, j]; }
        }
        if (!best) throw new Error("Exact TSP: slack tour node without a free edge");
        return best;
    }

    /**
     * Lagrange açgözlü tur: kenarlar c + pi_i + pi_j değiştirilmiş maliyetle
     * sıralanır; önce düğümün en iyi 1-ağaç kenarları, sonra kalan serbest ve
     * zorunlu kenarlar, en son yasaklılar. Derece <= 2 ve erken çevrim yok
     * kuralıyla eklenir; tam kenar listesi olduğundan her zaman bir tur kapanır.
     * Tur alt problemin kısıtlarına uymak zorunda değildir: yalnız üst sınırdır.
     */
    function lagrangianGreedyTour(n, cost, pi, state, treeEdges, treeEdgeCount) {
        const inTree = new Uint8Array(n * n);
        for (let at = 0; at < treeEdgeCount; at++) {
            const i = treeEdges[at * 2];
            const j = treeEdges[at * 2 + 1];
            inTree[i * n + j] = 1;
            inTree[j * n + i] = 1;
        }
        const pairs = [];
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                const tier = inTree[i * n + j] ? 0 : (state[i * n + j] === EDGE_BANNED ? 2 : 1);
                pairs.push([tier, cost[i * n + j] + pi[i] + pi[j], i, j]);
            }
        }
        pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        const degree = new Uint8Array(n);
        const unionFind = makeUnionFind(n);
        const adjacency = new Int32Array(n * 2).fill(-1);
        let added = 0;
        for (const [, , i, j] of pairs) {
            if (degree[i] >= 2 || degree[j] >= 2) continue;
            if (added < n - 1) {
                if (!unionFind.union(i, j)) continue;
            } else if (unionFind.find(i) !== unionFind.find(j)) {
                continue;
            }
            adjacency[i * 2 + degree[i]++] = j;
            adjacency[j * 2 + degree[j]++] = i;
            if (++added === n) break;
        }
        const tour = [0];
        let previous = -1;
        let current = 0;
        for (let step = 1; step < n; step++) {
            const first = adjacency[current * 2];
            const next = first === previous ? adjacency[current * 2 + 1] : first;
            tour.push(next);
            previous = current;
            current = next;
        }
        return tour;
    }

    /**
     * Lagrange indirgenmiş maliyetle kenar eleme. workspace.best* düğümün en iyi
     * 1-ağacıdır; pi ve mu o ağacın çarpanları. Ağaçta olmayan serbest e = (s, v)
     * için e'yi içeren en ucuz 1-ağaç, ağaca e eklenip çevrimdeki en pahalı
     * serbest kenar çıkarılarak elde edilir (zorunlu kenarlar çıkarılamaz); root
     * kenarında seçilmiş serbest root kenarının yerine geçer. Bu 1-ağacın sınırı
     * bu alt problemde e'yi içeren her turun alt sınırıdır; limit'e ulaşıyorsa e
     * alt ağaç boyunca yasaklanır. Budama kuralıyla aynı eşik: incumbent'tan
     * epsilon'dan fazla kısa tur kaybedilmez. Sınır, birikmiş artımlı maliyet
     * matrisinden değil maliyetler baştan hesaplanarak kurulur.
     */
    function eliminateEdges(workspace, cost, cutSet, mu, pi, state, root, limit) {
        const n = workspace.n;
        const edges = workspace.bestEdges;
        const modified = new Float64Array(n * n);
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                const e = i * n + j;
                let value = cost[e] + pi[i] + pi[j];
                if (cutSet) {
                    for (let m = cutSet.offsets[e]; m < cutSet.offsets[e + 1]; m++) value += mu[cutSet.members[m]];
                }
                modified[e] = value;
                modified[j * n + i] = value;
            }
        }
        let bound = 0;
        for (let at = 0; at < n; at++) bound += modified[edges[at * 2] * n + edges[at * 2 + 1]];
        for (let i = 0; i < n; i++) bound -= 2 * pi[i];
        if (cutSet) for (let k = 0; k < cutSet.cuts.length; k++) bound -= mu[k] * cutSet.rhs[k];

        const inTree = new Uint8Array(n * n);
        const adjacencyStart = new Int32Array(n + 1);
        const treeCount = n - 2;
        for (let at = 0; at < n; at++) {
            const i = edges[at * 2];
            const j = edges[at * 2 + 1];
            inTree[i * n + j] = 1;
            inTree[j * n + i] = 1;
            if (at < treeCount) { adjacencyStart[i + 1]++; adjacencyStart[j + 1]++; }
        }
        for (let i = 0; i < n; i++) adjacencyStart[i + 1] += adjacencyStart[i];
        const adjacency = new Int32Array(2 * treeCount);
        const fill = adjacencyStart.slice(0, n);
        for (let at = 0; at < treeCount; at++) {
            const i = edges[at * 2];
            const j = edges[at * 2 + 1];
            adjacency[fill[i]++] = j;
            adjacency[fill[j]++] = i;
        }

        let banned = 0;
        const ban = (i, j) => {
            state[i * n + j] = EDGE_BANNED;
            state[j * n + i] = EDGE_BANNED;
            banned++;
        };
        const pathMax = new Float64Array(n);
        const visited = new Int32Array(n).fill(-1);
        const stack = new Int32Array(n);
        for (let s = 0; s < n; s++) {
            if (s === root) continue;
            let top = 0;
            stack[top++] = s;
            visited[s] = s;
            pathMax[s] = -Infinity;
            while (top > 0) {
                const v = stack[--top];
                for (let p = adjacencyStart[v]; p < adjacencyStart[v + 1]; p++) {
                    const w = adjacency[p];
                    if (visited[w] === s) continue;
                    visited[w] = s;
                    const value = state[v * n + w] === EDGE_FREE ? modified[v * n + w] : -Infinity;
                    pathMax[w] = value > pathMax[v] ? value : pathMax[v];
                    stack[top++] = w;
                }
            }
            for (let v = s + 1; v < n; v++) {
                if (v === root || inTree[s * n + v] || state[s * n + v] !== EDGE_FREE) continue;
                if (pathMax[v] === -Infinity || bound + modified[s * n + v] - pathMax[v] >= limit) ban(s, v);
            }
        }

        // root kenarları: seçilmiş iki root kenarından serbest ve pahalı olanın yerine.
        const first = edges[treeCount * 2 + 1];
        const second = edges[(treeCount + 1) * 2 + 1];
        let replaced = -Infinity;
        for (const other of [first, second]) {
            if (state[root * n + other] === EDGE_FREE && modified[root * n + other] > replaced) replaced = modified[root * n + other];
        }
        for (let j = 0; j < n; j++) {
            if (j === root || inTree[root * n + j] || state[root * n + j] !== EDGE_FREE) continue;
            if (replaced === -Infinity || bound + modified[root * n + j] - replaced >= limit) ban(root, j);
        }
        return banned;
    }

    /** 1-ağaçta derecesi >= 3 olan düğümün en pahalı iki serbest kenarı. */
    function chooseBranchEdges(workspace, cost, state, edgeCount) {
        const n = workspace.n;
        const degree = workspace.bestDegree;
        const edges = workspace.bestEdges;
        let pick = -1;
        let pickDegree = 2;
        for (let i = 0; i < n; i++) {
            if (degree[i] > pickDegree) { pickDegree = degree[i]; pick = i; }
        }
        if (pick < 0) return null;

        const candidates = [];
        for (let at = 0; at < edgeCount; at++) {
            const i = edges[at * 2];
            const j = edges[at * 2 + 1];
            if (i !== pick && j !== pick) continue;
            const other = i === pick ? j : i;
            if (state[pick * n + other] !== EDGE_FREE) continue;
            candidates.push(other);
        }
        if (candidates.length === 0) return null;
        candidates.sort((a, b) => cost[pick * n + b] - cost[pick * n + a]);
        return { node: pick, first: candidates[0], second: candidates.length > 1 ? candidates[1] : -1 };
    }

    function solveByBranchAndBound(n, cost, options, stats, initial, startedAt, now) {
        const workspace = createWorkspace(n);
        const timeLimitMs = options.timeLimitMs ?? DEFAULTS.timeLimitMs;
        const maxNodes = options.maxNodes ?? DEFAULTS.maxNodes;

        // Kök düğüm: en yakın komşusu en uzak olan nokta; 1-ağaç sınırını güçlendirir.
        let root = 0;
        let rootScore = -Infinity;
        for (let i = 0; i < n; i++) {
            let nearest = Infinity;
            for (let j = 0; j < n; j++) {
                if (j !== i && cost[i * n + j] < nearest) nearest = cost[i * n + j];
            }
            if (nearest > rootScore) { rootScore = nearest; root = i; }
        }

        let bestTour = initial.tour;
        let upperBound = initial.length;

        const rootState = new Int8Array(n * n);
        for (let i = 0; i < n; i++) rootState[i * n + i] = EDGE_BANNED;
        const rootPropagation = propagateState(n, rootState);
        if (!rootPropagation.feasible) throw new Error("Exact TSP: the instance admits no tour");
        if (rootPropagation.tour) {
            const length = tourLength(rootPropagation.tour, cost, n);
            return { tour: rootPropagation.tour, length, optimal: true, lowerBound: length, rootBound: length, root, openNodes: 0 };
        }

        const shouldStop = () => now() - startedAt > timeLimitMs;
        const accept = (tour, length) => {
            if (length < upperBound - 1e-9 * Math.max(1, Math.abs(upperBound))) {
                upperBound = length;
                bestTour = tour;
                stats.incumbentUpdates++;
                return true;
            }
            return false;
        };
        // Aramanın ürettiği her tur (1-ağaç turu, yayılımla kapanan tur, 1-ağaç
        // gezisi) gerçek maliyetle 2-opt + Or-opt'tan geçirilip incumbent'a sunulur.
        // Kanıtı değiştirmez, yalnız üst sınırı erken indirir. Ölçüldü: kesimli
        // aramada 1-ağaçlar seyrek tura döndüğünden heuristik başlangıç (h100-s79043
        // %1.26 uzun) uzun süre incumbent kalıyor ve ağaç büyüyordu.
        const polishWindow = options.primalPolishWindow ?? DEFAULTS.primalPolishWindow;
        const offerTour = (tour, length, alwaysPolish = false) => {
            accept(tour, length);
            if (shouldStop() || (!alwaysPolish && !(length < upperBound * (1 + polishWindow)))) return;
            stats.primalPolishes++;
            const polished = orOptImprove(twoOptImprove(Array.from(tour), n, cost, shouldStop), n, cost, shouldStop);
            accept(polished, tourLength(polished, cost, n));
        };
        const primalInterval = options.primalInterval ?? DEFAULTS.primalInterval;
        stats.primalPolishes = 0;

        const rootPi = new Float64Array(n);
        let cutSet = null;
        let rootMu = null;
        let cutReport = null;
        // Relax-and-cut kök düğümün işidir: düğüm bütçesi 0 ise (dallanma kapalı)
        // koşmaz, dönen tur başlangıç incumbent'ı kalır.
        if (maxNodes > 0 && (options.blossomCuts ?? DEFAULTS.blossomCuts) && n >= (options.cutMinPoints ?? DEFAULTS.cutMinPoints)) {
            const strengthened = strengthenRootWithBlossoms(
                workspace, cost, rootState, root, rootPi, () => upperBound, stats, shouldStop, options, offerTour);
            cutSet = strengthened.cutSet;
            rootMu = strengthened.mu;
            cutReport = strengthened.report;
        }

        const stack = [{ state: rootState, pi: rootPi, mu: rootMu, bound: -Infinity }];
        let rootBound = -Infinity;
        let exhausted = true;
        let stopReason = null;
        stats.slackTourBranches = 0;
        stats.eliminatedEdges = 0;
        const eliminate = options.edgeElimination ?? DEFAULTS.edgeElimination;

        while (stack.length > 0) {
            if (stats.nodesExplored >= maxNodes) { exhausted = false; stopReason = "node budget"; break; }
            if (shouldStop()) { exhausted = false; stopReason = "time budget"; break; }

            const node = stack.pop();
            let epsilon = 1e-9 * Math.max(1, Math.abs(upperBound));
            if (node.bound >= upperBound - epsilon) { stats.nodesPruned++; continue; }
            stats.nodesExplored++;
            if (options.onProgress && stats.nodesExplored % 20000 === 0) {
                options.onProgress({ nodes: stats.nodesExplored, open: stack.length, upperBound, elapsedMs: now() - startedAt });
            }

            const steps = stats.nodesExplored === 1
                ? (options.rootAscentSteps ?? DEFAULTS.rootAscentSteps)
                : (options.childAscentSteps ?? DEFAULTS.childAscentSteps);
            const ascent = cutSet
                ? ascendBoundWithCuts(
                    workspace, cost, node.state, root, node.pi, node.mu, cutSet, () => upperBound, steps, stats,
                    shouldStop, options, offerTour)
                : ascendBound(
                    workspace, cost, node.state, root, node.pi, upperBound, steps, stats, shouldStop, options);
            if (stats.nodesExplored === 1) rootBound = ascent.infeasible ? Infinity : ascent.bound;
            // A long bound/polish call may consume the deadline. Keep this whole
            // subtree open so a partial search never claims proof or a false gap.
            if (shouldStop()) {
                stack.push(node);
                exhausted = false;
                stopReason = "time budget";
                break;
            }
            if (ascent.infeasible) { stats.nodesPruned++; continue; }

            if (ascent.solved) {
                // Sıkı: derecesi hep 2 olan 1-ağaç bu alt problemin optimum turu.
                offerTour(ascent.tour, ascent.tourLength);
                continue;
            }
            if (primalInterval > 0 && stats.nodesExplored % primalInterval === 1 && !ascent.bestIsTour) {
                // Lagrange primal heuristiği: düğümün en iyi 1-ağacı ve pi'si üzerinden
                // açgözlü tur, sonra her zaman 2-opt + Or-opt.
                const greedy = lagrangianGreedyTour(n, cost, node.pi, node.state, workspace.bestEdges, ascent.edgeCount);
                offerTour(greedy, tourLength(greedy, cost, n), true);
            }
            epsilon = 1e-9 * Math.max(1, Math.abs(upperBound));
            if (ascent.bound >= upperBound - epsilon) { stats.nodesPruned++; continue; }

            if (eliminate) {
                const banned = eliminateEdges(workspace, cost, cutSet, node.mu, node.pi, node.state, root, upperBound - epsilon);
                if (stats.nodesExplored === 1) stats.rootEliminatedEdges = banned;
                if (banned > 0) {
                    stats.eliminatedEdges += banned;
                    const propagation = propagateState(n, node.state);
                    if (!propagation.feasible) { stats.nodesPruned++; continue; }
                    if (propagation.tour) {
                        offerTour(propagation.tour, tourLength(propagation.tour, cost, n));
                        continue;
                    }
                    // Kökte yasaklanan kenarlar bütün aramada yasaklı: kesim listelerinden at.
                    if (cutSet && stats.nodesExplored === 1) cutSet = createCutSet(n, cutSet.cuts, node.state);
                }
            }

            let children;
            if (ascent.bestIsTour) {
                // En iyi 1-ağaç gevşek kesimli bir tur: 3 yollu bölme için derecesi
                // >= 3 düğüm yok, serbest tur kenarı üzerinden ikili bölme.
                const [i, j] = chooseSlackTourEdge(workspace, cutSet, node.mu, node.state);
                stats.slackTourBranches++;
                children = [[[i, j, EDGE_BANNED]], [[i, j, EDGE_FORCED]]];
            } else {
                const branch = chooseBranchEdges(workspace, cost, node.state, ascent.edgeCount);
                if (!branch) { stats.nodesPruned++; continue; }
                const p = branch.node;

                // 3 yollu ayrık bölme. En kısıtlı çocuk en sona itilir ki DFS onu
                // önce açsın: erken iyi tur = daha çok budama.
                children = [[[p, branch.first, EDGE_BANNED]]];
                if (branch.second >= 0) {
                    children.push([[p, branch.first, EDGE_FORCED], [p, branch.second, EDGE_BANNED]]);
                    children.push([[p, branch.first, EDGE_FORCED], [p, branch.second, EDGE_FORCED]]);
                } else {
                    children.push([[p, branch.first, EDGE_FORCED]]);
                }
            }

            for (const assignments of children) {
                const state = node.state.slice();
                for (const [i, j, value] of assignments) {
                    state[i * n + j] = value;
                    state[j * n + i] = value;
                }
                const propagation = propagateState(n, state);
                if (!propagation.feasible) { stats.nodesPruned++; continue; }
                if (propagation.tour) {
                    offerTour(propagation.tour, tourLength(propagation.tour, cost, n));
                    continue;
                }
                stack.push({ state, pi: node.pi.slice(), mu: node.mu ? node.mu.slice() : null, bound: ascent.bound });
                stats.nodesCreated++;
            }
        }

        let lowerBound = upperBound;
        if (!exhausted) {
            // Aranmamış bölge tam olarak yığındaki açık düğümlerdir (bütçe yalnız
            // döngü başında, işlenmekte olan düğüm yokken kesilir); her birinin
            // bound'u kendi alt problemi için geçerli alt sınırdır. En küçüğü ile
            // incumbent'ın küçüğü kanıtlanmış sınırdır. rootBound ile başlatmak
            // sınırı kökte kilitliyordu: arama ilerlese de gap hiç küçülmüyordu.
            // Kök hiç işlenmediyse yığında -sonsuz kalır: kanıt yok, null.
            for (const entry of stack) {
                if (entry.bound < lowerBound) lowerBound = entry.bound;
            }
            if (!Number.isFinite(lowerBound)) lowerBound = null;
        }
        return {
            tour: bestTour,
            length: upperBound,
            optimal: exhausted,
            lowerBound,
            rootBound,
            stopReason,
            openNodes: stack.length,
            root,
            cuts: cutReport
        };
    }

    function defaultClock() {
        return typeof performance === "object" && performance && typeof performance.now === "function"
            ? () => performance.now()
            : () => Date.now();
    }

    /**
     * Çağıranın elindeki turu üst sınır tohumu olarak kabul eder. Geçerli olması
     * için 0..n-1'in bir permütasyonu olması yeterlidir: her permütasyon gerçek
     * bir turdur, dolayısıyla üst sınır olarak kullanılması kanıtı bozmaz,
     * yalnızca aramayı baştan daraltır. Bozuk tohum sessizce yok sayılır.
     */
    function normalizeInitialTour(initialTour, n) {
        if (!Array.isArray(initialTour) && !ArrayBuffer.isView(initialTour)) return null;
        if (initialTour.length !== n) return null;
        const seen = new Uint8Array(n);
        const tour = new Array(n);
        for (let at = 0; at < n; at++) {
            const index = initialTour[at];
            if (!Number.isInteger(index) || index < 0 || index >= n || seen[index]) return null;
            seen[index] = 1;
            tour[at] = index;
        }
        return tour;
    }

    /**
     * Verilen noktalar için en kısa kapalı turu bulur.
     *
     * @param {{x:number,y:number}[]} points
     * @param {object} [options] costFn, timeLimitMs, maxNodes, dpLimit, now,
     *        initialTour (elde olan tur; üst sınır tohumu)
     * @returns {{tour:number[], length:number, optimal:boolean, method:string,
     *            lowerBound:number, gap:number, initialLength:number,
     *            seedLength:number|null, heuristicLength:number|null, stats:object}}
     *          tour, points dizisine indeks listesidir.
     */
    function solveExactTsp(points, options = {}) {
        if (!Array.isArray(points)) throw new TypeError("points must be an array");
        const n = points.length;
        const stats = { boundCalls: 0, nodesExplored: 0, nodesCreated: 0, nodesPruned: 0, incumbentUpdates: 0 };
        const now = options.now || defaultClock();
        const startedAt = now();

        if (n <= 3) {
            const tour = Array.from({ length: n }, (_, index) => index);
            const length = n > 1 ? tourLength(tour, buildCostMatrix(points, options.costFn), n) : 0;
            return {
                tour, length, optimal: true, method: "trivial", lowerBound: length, gap: 0,
                initialLength: length, elapsedMs: now() - startedAt, stats
            };
        }

        const cost = buildCostMatrix(points, options.costFn);
        const dpLimit = options.dpLimit ?? DEFAULTS.dpLimit;
        if (n <= dpLimit) {
            const tour = heldKarpTour(n, cost, options);
            const length = tourLength(tour, cost, n);
            return {
                tour, length, optimal: true, method: "held-karp-dp", lowerBound: length, gap: 0,
                initialLength: length, elapsedMs: now() - startedAt, stats
            };
        }

        const timeLimitMs = options.timeLimitMs ?? DEFAULTS.timeLimitMs;
        const heuristic = heuristicTour(n, cost, {
            ...options,
            shouldStop: () => now() - startedAt > timeLimitMs * 0.25
        });
        // Tohum, çağıranın elindeki turdur. Kısa olan incumbent olur; incumbent
        // arama boyunca yalnızca kısalabildiği için, bütçe dolsa bile sonuç
        // tohumdan uzun olamaz. Heuristik yine de koşar: bazen tohumu döver.
        const seedTour = normalizeInitialTour(options.initialTour, n);
        const seedLength = seedTour ? tourLength(seedTour, cost, n) : null;
        const initial = seedTour && seedLength < heuristic.length
            ? { tour: seedTour, length: seedLength }
            : heuristic;
        // One budget covers matrix construction, the initial heuristic and proof.
        // Restarting the clock here used to grant the search a second full budget.
        const solved = solveByBranchAndBound(n, cost, options, stats, initial, startedAt, now);
        let gap = 0;
        if (!solved.optimal) {
            gap = Number.isFinite(solved.lowerBound) && solved.length > 0
                ? Math.max(0, (solved.length - solved.lowerBound) / solved.length)
                : null; // kanıtlanmış alt sınır yok
        }
        return {
            tour: solved.tour,
            length: solved.length,
            optimal: solved.optimal,
            method: "held-karp-1tree-branch-and-bound",
            lowerBound: solved.lowerBound,
            rootBound: solved.rootBound,
            gap,
            stopReason: solved.stopReason,
            openNodes: solved.openNodes,
            initialLength: initial.length,
            seedLength,
            heuristicLength: heuristic.length,
            elapsedMs: now() - startedAt,
            cuts: solved.cuts || null,
            stats
        };
    }

    return {
        EDGE_BANNED,
        EDGE_FORCED,
        EDGE_FREE,
        buildCostMatrix,
        gomoryHuTree,
        heldKarpTour,
        heuristicTour,
        nearestNeighbourTour,
        normalizeInitialTour,
        orOptImprove,
        propagateState,
        solveExactTsp,
        tourFromEdgeList,
        tourLength,
        twoOptImprove
    };
});
