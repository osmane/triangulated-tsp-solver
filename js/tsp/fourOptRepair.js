(function (root, factory) {
    const api = factory(root);
    if (typeof module === "object" && module.exports) module.exports = api;
    Object.assign(root, api);
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
    "use strict";

    /**
     * Aday guduml u derinlik aramasi. Sabitler algoritmanin parcasidir, poligon
     * basina ayar dugmesi degildir.
     *
     * candidateNeighbors = 8: olcumle secildi. n=60'ta K=8 aday kisiti, kisitsiz
     * tam 4-opt ile vaka vaka BIREBIR ayni sonucu verir (%30.9 = %30.9); K=5'e
     * inildiginde kapatilan bosluk %19.1'e duser. Bu yuzden 8 tavan degil taban.
     *
     * maxDepth = 7: derinlik 4 tukendi. kbdb-gr-4opt-gap'teki 20 kacan
     * vakanin nihai turlarinda derinlik-4 zinciri 35-277 pozitif kazancli kapanis
     * uretiyor ve HEPSI alt tur cikiyor -- yani 4'te bulunacak sey kalmamis.
     * Ayni turlarda kacan hamlelerin tamami sirali, eklenen kenarlarin tamami
     * 8-NN icinde ve hicbiri kalan kenarlari kesmiyor: darbogaz aday listesi de
     * basitlik kapisi da degil, yalnizca derinlik. Tam kapsamli tarama gereken
     * en kucuk derinligi 4-7 arasi olcuyor.
     *
     * 6 -> 7'yi MUMKUN KILAN SEY erken elemedir, derinligin kendisi degil.
     * edgeRepeatPruning + subtourPrecheck acikken d7'nin 4-opt maliyeti eski
     * d6'nin maliyeti mertebesinde kaliyor (uctan uca):
     *   12 taze vaka (n=50..400)   4opt ms   sonda    dogrulama   akis ms
     *     taban d6                   20082    15.5M      91352     257143
     *     erken eleme d6             11837    10.2M        708     245618
     *     erken eleme d7             17331    23.8M        814     248851
     *   16 holdout vakasi (tohum 770000)
     *     taban d6                   20938    14.5M     120911     280781
     *     erken eleme d6             12219    10.7M        645     284462
     *     erken eleme d7             21160    31.5M        770     300048
     * Kalite: kanit kumesinde (20 zor vaka) ort. bosluk %0.261 -> %0.167,
     * optimuma ulasan 12/20 -> 15/20, kotulesen 0. Holdout'ta 7 vaka daha kisa,
     * 2 vaka daha uzun, toplam uzunluk orani 0.99692.
     *
     * chainBreadth = [8, 8, 8, 5, 3, 3]: derinligin bedelini genislik oder.
     * chainBreadth[i], (i+2). sokulen kenar secilirken taranacak aday sayisidir;
     * uzunlugu maxDepth - 1'dir.
     *
     * ILK UC GIRDININ K'ya ESIT OLMASI SARTTIR. Boylece arama, eski derinlik-4
     * aramasinin tam ust kumesidir ve genislik daraltmasi yuzunden hicbir vaka
     * kotulesemez. Daraltilmis programlar olculdu ve bu sartin gercek oldugu
     * gorulda: [8,5,3,3,3] bir vakayi (n=100 seed 13216) HEAD'in altina
     * dusuruyordu -- eski arama level 2'de 8 aday tarayip buldugu hamleyi yeni
     * arama 5 adayda kaciriyordu. Ilk uc seviye acik birakildiginda regresyon
     * sifir.
     *
     * Olculen (20 kacan vaka):
     *   derinlik 4     ort. bosluk %0.873, optimuma ulasan 0/20
     *   [8,5,3,3,3]    %0.382, 10/20, 1 regresyon
     *   [8,8,8,3,3]    %0.382, 10/20, 0 regresyon
     *   [8,8,8,5,3]    %0.261, 12/20, 0 regresyon
     *   [8,8,8,5,3,3]  %0.167, 15/20, 0 regresyon   <- secilen
     *
     * UST KUME OLMAK REGRESYONSUZLUK DEMEK DEGILDIR. Kural arama uzayi icindir;
     * daha derin arama daha buyuk anlik kazancli baska bir hamleyi secip baska
     * bir yerel optimuma gidebilir. Tasarimda kullanilmamis 16 vakalik holdout'ta
     * d7 iki vakada tabandan uzun tur verdi (n100-s770100 +%0.56,
     * n400-s770441 +%0.03) ve yedi vakada kisa (en iyisi -%2.83). Sevk karari
     * toplam bilanco uzerinedir. Erken elemenin KENDISI kayipsizdir: butun
     * kotalar kaldirildiginda aday kumesi birebir ayni (bkz. test).
     *
     * alpha-yakinlik (Helsgaun 2000) aday sirasi AYRICA olculdu ve varsayilan
     * YAPILMADI: aday listesini K=5'e daraltmasi, uctan uca akista 20 vakanin
     * 3'unde gerileme uretti. alpha ile kNN'in birlesimi kNN d7 ile ayni
     * kaliteyi verdi ama daha pahali on-hesap istedi.
     * options.candidateSource ile
     * deney olarak acilabilir.
     */
    const FOUR_OPT_POLICY = Object.freeze({
        candidateNeighbors: 8,
        maxDepth: 7,
        chainBreadth: Object.freeze([8, 8, 8, 5, 3, 3]),
        pointsPerCell: 2,
        epsilon: 1e-9,
        maxValidations: 4096,
        // Is butcesi yalnizca O(n) dogrulamayi degil ARAMANIN KENDISINI de
        // kapsamalidir (bolum 6): dejenere veya kumelenmis yerlesimde zincir sondasi,
        // dogrulama kotasi hic dolmadan patlayabilir. Tukenme NO_IMPROVEMENT
        // diye sunulmaz, kendi reason'iyla raporlanir.
        // Olculen en yogun tek cagri (n=400, derinlik 7) bunun cok altinda kaldi;
        // bu bir ayar dugmesi degil, patolojik girdiye karsi tavan.
        maxChainProbesPerNode: 20000,
        // ObjectOcc'ta gorunen bir kenar mesh'te yine de materialize edilemeyebilir.
        // Tek aday bulup pes etmek yerine bir avuc aday toplanir ve ilk commit
        // edilen kullanilir; arama basina maliyet yine sabit sinirlidir.
        maxCandidates: 12,
        // Kenarin ObjectOcc ray onbelleginde bulunmasi SART DEGIL. Buradaki
        // geometrik kapi isPatchSimple'dir: eklenen kenar KALAN tur kenarlarindan
        // hicbirini kesmiyorsa tur basit kalir. Ray onbellegini sart kosmak,
        // olcumde gecerli ve basit iyilestirmeleri eliyordu (orn. n=60 seed 9078:
        // delta -84.29'luk basit bir 3-opt, yalnizca ray yok diye reddediliyordu).
        // Transaction'in kendi degismezleri (Hamilton sirasi, delta esitligi, mesh
        // simetrisi) ve beforeCommit'teki turemis-nokta sayaci guvenlik agi olarak
        // durur; materialize edilemeyen aday zaten reddedilip siradakine gecilir.
        requireCachedRay: false,
        // Bir dal ayni yonsuz kenari ikinci kez soker/eklerse o daldaki HICBIR
        // kapanis gecerli olamaz: sokulen/eklenen kumeler dal boyunca yalnizca
        // buyur, tryClose de tekrari her zaman reddeder. Bu yuzden dali derhal
        // kesmek KAYIPSIZ bir budamadir -- bulunan hamle kumesi degismez.
        // Olculdu (20 kanit vakasi, tek atis zincir modeli): kNN d6'da sonda
        // -%34.4, alpha d7'de -%53.3, en iyi kazanc/derinlik farki 0/20.
        edgeRepeatPruning: true,
        // Kapanis adayinin tek Hamilton cevrimi verip vermedigini O(k log k)
        // parca grafiyla karara baglar; O(n) materializeOrder yalnizca bunu
        // gecen adaylar icin kosar. Kanit vakalarinda pozitif kazancli
        // kapanislarin neredeyse tamami alt tur cikiyordu, yani O(n) isin
        // neredeyse tamami bosa gidiyordu.
        subtourPrecheck: true,
        // "distance" = kNN (taban). "alpha" = 1-agac zorunluluk maliyeti
        // (Helsgaun 2000). "alpha+distance" = ikisinin sirali birlesimi.
        // Varsayilan taban olarak birakildi; alpha ayri deney politikasidir.
        candidateSource: "distance",
        // alpha on-hesabinda subgradient tirmanis adimi. Deney parametresidir.
        alphaAscentSteps: 300,
        // alpha yolunda tam O(n^2) matris kurmanin kabul edilir gorulda ust
        // sinir; ustunde alpha kapatilir ve mesafe adaylarina dusulur.
        alphaMaxPoints: 1200
    });

    const FOUR_OPT_EPSILON = FOUR_OPT_POLICY.epsilon;

    function clock() {
        return typeof root?.performance !== "undefined" ? root.performance.now() : Date.now();
    }

    function edgeKey(a, b) {
        return a < b ? `${a}:${b}` : `${b}:${a}`;
    }

    function sourceEdgeKey(points, a, b) {
        const left = points[a]?.sourcePointId ?? a;
        const right = points[b]?.sourcePointId ?? b;
        return left < right ? `${left}:${right}` : `${right}:${left}`;
    }

    function objectOccVisible(world, left, right) {
        const a = world.totalNoktaList[left];
        const b = world.totalNoktaList[right];
        if (!a || !b) return false;
        if (!(a.visibleList?.get(right) === true && b.visibleList?.get(left) === true)) return false;
        const ray = typeof root.getPointRay === "function"
            ? root.getPointRay(world, left, right)
            : world.pointRayIndex?.get(edgeKey(left, right));
        return !!ray;
    }

    /**
     * Removed-edge overlay: bir yamayi yalnizca KALAN sinir kenarlari engeller.
     * Ham ObjectOcc gorunurlugu burada yanlis kapidir, cunku sokulmek uzere olan
     * kenari da engelleyici sayar -- olcumde bu, iyilestiren hamlelerin buyuk
     * bolumunu sebepsiz eliyordu. Yalnizca kazanci pozitif adaylar icin calisir.
     */
    function isPatchSimple(world, order, removedEdges, addedEdges) {
        const points = world.totalNoktaList;
        const removed = new Set(removedEdges.map(([a, b]) => edgeKey(a, b)));
        const n = order.length;
        // Hem metrik hem mesh koordinatinda dogrula: loader jitter'i ikisini ayirir.
        for (const useMetric of [false, true]) {
            const at = id => useMetric
                ? (points[id].metricPosition || points[id].kendiYeri)
                : points[id].kendiYeri;
            for (let i = 0; i < addedEdges.length; i++) {
                const [a, b] = addedEdges[i];
                for (let j = 0; j < n; j++) {
                    const c = order[j], d = order[(j + 1) % n];
                    if (removed.has(edgeKey(c, d))) continue;
                    if (a === c || a === d || b === c || b === d) continue;
                    if (segmentsIntersectCoords(at(a), at(b), at(c), at(d))) return false;
                }
                for (let j = 0; j < i; j++) {
                    const [c, d] = addedEdges[j];
                    if (a === c || a === d || b === c || b === d) continue;
                    if (segmentsIntersectCoords(at(a), at(b), at(c), at(d))) return false;
                }
            }
        }
        return true;
    }

    /**
     * Duzgun izgara uzerinde K en yakin komsu. Halkalar, (r-1)*hucre mesafesi
     * mevcut K'inci adaydan buyuk olana kadar genisletilir; bu yuzden sonuc
     * gercek kNN'dir, izdusum yaklasikligi degil. Beklenen maliyet O(n*K).
     */
    function buildNearestNeighborCandidates(positions, K) {
        const n = positions.length;
        if (n <= 1) return positions.map(() => []);
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of positions) {
            if (p.x < minX) minX = p.x;
            if (p.x > maxX) maxX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.y > maxY) maxY = p.y;
        }
        const columns = Math.max(1, Math.floor(Math.sqrt(n / FOUR_OPT_POLICY.pointsPerCell)));
        const cellWidth = Math.max((maxX - minX) / columns, 1e-9);
        const cellHeight = Math.max((maxY - minY) / columns, 1e-9);
        // Chebyshev halkasi r'deki bir hucre, eksenlerden yalnizca BIRINDE r hucre
        // uzakta olabilir; guvenli alt sinir bu yuzden dar kenardir, genis kenar degil.
        const cellSize = Math.min(cellWidth, cellHeight);
        const columnOf = p => Math.min(columns - 1, Math.max(0, Math.floor((p.x - minX) / cellWidth)));
        const rowOf = p => Math.min(columns - 1, Math.max(0, Math.floor((p.y - minY) / cellHeight)));

        const buckets = new Map();
        for (let i = 0; i < n; i++) {
            const key = rowOf(positions[i]) * columns + columnOf(positions[i]);
            if (!buckets.has(key)) buckets.set(key, []);
            buckets.get(key).push(i);
        }

        const distance = (a, b) => Math.hypot(positions[a].x - positions[b].x, positions[a].y - positions[b].y);
        const candidates = [];
        for (let i = 0; i < n; i++) {
            const cx = columnOf(positions[i]);
            const cy = rowOf(positions[i]);
            const found = [];
            for (let ring = 0; ring < columns * 2; ring++) {
                if (found.length >= K) {
                    // Halkanin dokunabilecegi en yakin nokta (ring-1)*cellSize uzaktadir.
                    const kth = found[Math.min(K, found.length) - 1].d;
                    if ((ring - 1) * cellSize > kth) break;
                }
                let touched = false;
                for (let dy = -ring; dy <= ring; dy++) {
                    for (let dx = -ring; dx <= ring; dx++) {
                        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
                        const gx = cx + dx, gy = cy + dy;
                        if (gx < 0 || gy < 0 || gx >= columns || gy >= columns) continue;
                        touched = true;
                        const bucket = buckets.get(gy * columns + gx);
                        if (!bucket) continue;
                        for (const j of bucket) {
                            if (j === i) continue;
                            found.push({ j, d: distance(i, j) });
                        }
                    }
                }
                if (!touched && ring > 0) break;   // izgaranin disina cikildi
                found.sort((a, b) => a.d - b.d || a.j - b.j);
                if (found.length > K * 4) found.length = K * 4;
            }
            found.sort((a, b) => a.d - b.d || a.j - b.j);
            candidates.push(found.slice(0, K).map(entry => entry.j));
        }
        return candidates;
    }

    /**
     * ------------------------------------------------------------------
     * alpha-yakinlik (Helsgaun 2000)
     * ------------------------------------------------------------------
     * Bir kenarin iyiligini MESAFESIYLE degil, onu turda ZORUNLU kilmanin
     * 1-agac alt sinirina maliyetiyle olcer. Mesafe yerel, alpha globaldir:
     * olcumde optimum turun kenarlari icin gereken maksimum aday sirasi
     * kNN'de ort. 6.35 (bazi vakalarda 10), alpha'da ort. 3.50 (maks 6).
     *
     * UYARI: alpha sirali liste MESAFE SIRALI DEGILDIR. Zincirdeki
     * "kismi kazanc negatife dustu -> break" budamasi burada GECERSIZDIR;
     * yerine bolum 7.1'daki mesafe son-ek minimumu kullanilir (bkz. minTail).
     */

    /** pi agirliklariyla minimum 1-agac. Prim, O(n^2) zaman / O(n) bellek. */
    function buildOneTree(n, distanceRow, pi) {
        const cost = (i, j) => distanceRow(i)[j] + pi[i] + pi[j];
        const inTree = new Uint8Array(n);
        const key = new Float64Array(n).fill(Infinity);
        const dad = new Int32Array(n).fill(-1);
        const order = new Int32Array(n - 1);
        key[1] = 0;
        for (let step = 1; step < n; step++) {
            let best = -1;
            let bestValue = Infinity;
            for (let v = 1; v < n; v++) {
                if (!inTree[v] && key[v] < bestValue) { bestValue = key[v]; best = v; }
            }
            inTree[best] = 1;
            order[step - 1] = best;
            const row = distanceRow(best);
            for (let v = 1; v < n; v++) {
                if (inTree[v]) continue;
                const value = row[v] + pi[best] + pi[v];
                if (value < key[v]) { key[v] = value; dad[v] = best; }
            }
        }
        const degree = new Int32Array(n);
        let length = 0;
        for (let v = 1; v < n; v++) {
            if (dad[v] < 0) continue;
            length += cost(dad[v], v);
            degree[v]++;
            degree[dad[v]]++;
        }
        // Dugum 0 agaca degil, en ucuz IKI kenariyla baglanir: 1-agac tanimi.
        let first = -1, second = -1, firstValue = Infinity, secondValue = Infinity;
        const zeroRow = distanceRow(0);
        for (let v = 1; v < n; v++) {
            const value = zeroRow[v] + pi[0] + pi[v];
            if (value < firstValue) {
                secondValue = firstValue; second = first;
                firstValue = value; first = v;
            } else if (value < secondValue) { secondValue = value; second = v; }
        }
        length += firstValue + secondValue;
        degree[0] = 2;
        degree[first]++;
        degree[second]++;
        return { length, degree, dad, order, first, second, specialMax: Math.max(firstValue, secondValue) };
    }

    /**
     * Subgradient tirmanisi: 1-agac alt sinirini maksimize eden pi'yi arar.
     * upperBound YALNIZCA ilk adim boyunu olceklendirir; uretimde MEVCUT TUR
     * uzunlugu verilir -- exact sonuc aday uretimine sokulmaz.
     */
    function ascendNodeWeights(n, distanceRow, upperBound, steps) {
        const pi = new Float64Array(n);
        const bestPi = new Float64Array(n);
        let bestBound = -Infinity;
        let stepSize = upperBound / (2 * n);
        let stagnant = 0;
        for (let k = 0; k < steps; k++) {
            const tree = buildOneTree(n, distanceRow, pi);
            let piSum = 0;
            for (let i = 0; i < n; i++) piSum += pi[i];
            const bound = tree.length - 2 * piSum;
            if (bound > bestBound + 1e-12) { bestBound = bound; bestPi.set(pi); stagnant = 0; }
            else if (++stagnant > 20) { stepSize *= 0.7; stagnant = 0; }
            let norm = 0;
            for (let i = 0; i < n; i++) {
                const deviation = tree.degree[i] - 2;
                norm += deviation * deviation;
            }
            if (norm === 0) break;               // 1-agac zaten tur: alt sinir = optimum
            for (let i = 0; i < n; i++) pi[i] += stepSize * (tree.degree[i] - 2);
            if (stepSize < 1e-9) break;
        }
        return { pi: bestPi, bound: bestBound };
    }

    /**
     * Her dugum icin alpha'ya gore en iyi K aday. beta(i,j) = MST yolundaki en
     * pahali kenar; satir satir DFS ile O(n) hesaplanir, yani O(n^2) zaman ve
     * O(n) ek bellek -- tam beta matrisi kurulmaz.
     *
     * Donen liste {ids, dists}: dists HAM metrik mesafedir ve bolum 7.1'daki guvenli
     * durus kuralinin girdisidir.
     */
    function buildAlphaCandidates(n, distanceRow, upperBound, K, steps) {
        const { pi } = ascendNodeWeights(n, distanceRow, upperBound, steps);
        const tree = buildOneTree(n, distanceRow, pi);
        const { dad, first, second, specialMax } = tree;
        const cost = (i, j) => distanceRow(i)[j] + pi[i] + pi[j];

        // MST komsulugu (dugum 0 haric) + 0'in iki ozel kenari icin uyelik.
        const adjacencyHead = new Int32Array(n).fill(-1);
        const adjacencyNext = new Int32Array(2 * n).fill(-1);
        const adjacencyTo = new Int32Array(2 * n);
        let edgeCount = 0;
        const link = (a, b) => {
            adjacencyTo[edgeCount] = b;
            adjacencyNext[edgeCount] = adjacencyHead[a];
            adjacencyHead[a] = edgeCount++;
        };
        for (let v = 1; v < n; v++) {
            if (dad[v] < 0) continue;
            link(v, dad[v]);
            link(dad[v], v);
        }
        const inTreeEdge = new Set();
        for (let v = 1; v < n; v++) if (dad[v] >= 0) inTreeEdge.add(edgeKey(v, dad[v]));
        inTreeEdge.add(edgeKey(0, first));
        inTreeEdge.add(edgeKey(0, second));

        const beta = new Float64Array(n);
        const stack = new Int32Array(n);
        const stamp = new Int32Array(n);          // ziyaret damgasi: satir basina fill yok
        const scored = new Array(n - 1);
        for (let s = 0; s < n - 1; s++) scored[s] = { j: 0, alpha: 0, d: 0 };
        const lists = [];
        for (let i = 0; i < n; i++) {
            // beta[j] = i ile j arasindaki AGAC yolundaki en pahali kenar.
            // Dugum 0 agacin parcasi degildir; onunla ilgili alpha ozel kenardan
            // hesaplanir, bu yuzden i === 0 icin DFS'e hic gerek yoktur.
            if (i > 0) {
                let top = 0;
                stamp[i] = i + 1;
                beta[i] = -Infinity;
                stack[top++] = i;
                while (top > 0) {
                    const node = stack[--top];
                    for (let e = adjacencyHead[node]; e !== -1; e = adjacencyNext[e]) {
                        const next = adjacencyTo[e];
                        if (stamp[next] === i + 1) continue;
                        stamp[next] = i + 1;
                        beta[next] = Math.max(beta[node], cost(node, next));
                        stack[top++] = next;
                    }
                }
            }

            const row = distanceRow(i);
            let count = 0;
            for (let j = 0; j < n; j++) {
                if (j === i) continue;
                let alpha;
                if (inTreeEdge.has(edgeKey(i, j))) alpha = 0;
                else if (i === 0 || j === 0) {
                    const other = i === 0 ? j : i;
                    alpha = Math.max(0, cost(0, other) - specialMax);
                } else {
                    alpha = Math.max(0, cost(i, j) - beta[j]);
                }
                const slot = scored[count++];
                slot.j = j;
                slot.alpha = alpha;
                slot.d = row[j];
            }
            const picked = scored.slice(0, count)
                .sort((a, b) => a.alpha - b.alpha || a.d - b.d || a.j - b.j)
                .slice(0, K);
            lists.push({ ids: picked.map(entry => entry.j), dists: picked.map(entry => entry.d) });
        }
        return lists;
    }

    /**
     * alpha, TURUN SIRASINDAN degil NOKTA KUMESINDEN turer: ayni nokta kumesi
     * ve ayni metrik icin bir kez hesaplanip onbeleklenir. Imza, siralanmis
     * (kimlik, x, y) uclusudur -- nokta eklenir/silinir veya koordinat degisirse
     * onbellek kendiliginden gecersizlesir.
     *
     * Tirmanisin ust siniri MEVCUT TUR uzunlugudur; exact sonuc aday uretimine
     * girmez (bkz. bolum 7 "ust sinir girdisi denetimi").
     */
    function alphaCacheSignature(order, positions, K, steps) {
        const rows = new Array(order.length);
        for (let i = 0; i < order.length; i++) {
            rows[i] = `${order[i]}:${positions[i].x}:${positions[i].y}`;
        }
        rows.sort();
        return `${K}|${steps}|${rows.join(";")}`;
    }

    function alphaCandidatesByPointId(world, order, positions, K, steps) {
        const signature = alphaCacheSignature(order, positions, K, steps);
        const cache = world.fourOptAlphaCache;
        if (cache && cache.signature === signature) return { lists: cache.lists, cold: false };

        const n = order.length;
        // Mesafe matrisi tirmanisin O(steps * n^2) isini tasir; asil maliyet burada.
        const rows = [];
        for (let i = 0; i < n; i++) {
            const row = new Float64Array(n);
            const from = positions[i];
            for (let j = 0; j < n; j++) {
                row[j] = Math.hypot(from.x - positions[j].x, from.y - positions[j].y);
            }
            rows.push(row);
        }
        let upperBound = 0;
        for (let i = 0; i < n; i++) upperBound += rows[i][(i + 1) % n];
        const dense = buildAlphaCandidates(n, index => rows[index], upperBound, K, steps);
        const lists = new Map();
        for (let i = 0; i < n; i++) {
            lists.set(order[i], {
                ids: dense[i].ids.map(index => order[index]),
                dists: dense[i].dists
            });
        }
        world.fourOptAlphaCache = { signature, lists };
        return { lists, cold: true };
    }

    /**
     * Aramanin kullandigi aday listelerini POZISYON uzayinda kurar.
     *
     * minTail null ise liste mesafe siralidir ve zincirdeki "kismi kazanc
     * negatif -> break" budamasi gecerlidir. alpha sirasinda ise minTail[t],
     * t ve sonrasindaki en kucuk HAM mesafedir: gain - minTail[t] <= EPSILON
     * oldugunda kalan hicbir aday pozitif kismi kazanc kapisini gecemez, break
     * yeniden guvenlidir (bolum 7.1). Aradaki tek tek basarisizliklarda continue
     * gerekir; break etmek gercek adaylari kaybettirir.
     */
    function buildCandidateData(world, order, positions, K, source, options) {
        const n = order.length;
        const byDistance = () => ({
            lists: buildNearestNeighborCandidates(positions, K),
            minTail: null,
            source: "distance"
        });
        if (source !== "alpha" && source !== "alpha+distance") return byDistance();
        const cap = options.alphaMaxPoints ?? FOUR_OPT_POLICY.alphaMaxPoints;
        // alpha yolu O(n^2) is ve bellek ister; ustunde sessizce mesafeye duser.
        if (n < 5 || n > cap) {
            const fallback = byDistance();
            fallback.source = n < 5 ? "distance" : "distance(alpha-capped)";
            return fallback;
        }
        const steps = Math.min(n, options.alphaAscentSteps ?? FOUR_OPT_POLICY.alphaAscentSteps);
        const { lists: byPointId, cold } = alphaCandidatesByPointId(world, order, positions, K, steps);

        const positionOfId = new Map();
        for (let i = 0; i < n; i++) positionOfId.set(order[i], i);
        const distanceLists = source === "alpha+distance"
            ? buildNearestNeighborCandidates(positions, K)
            : null;
        const distance = (a, b) => Math.hypot(
            positions[a].x - positions[b].x, positions[a].y - positions[b].y);

        const lists = [];
        const minTail = [];
        for (let i = 0; i < n; i++) {
            const entry = byPointId.get(order[i]);
            const ids = [];
            const dists = [];
            const seen = new Set();
            for (let t = 0; entry && t < entry.ids.length; t++) {
                const at = positionOfId.get(entry.ids[t]);
                if (at === undefined || at === i || seen.has(at)) continue;
                seen.add(at);
                ids.push(at);
                dists.push(entry.dists[t]);
            }
            // Birlesim politikasi: alpha sirasi once, kNN'in getirdigi ekler sonra.
            // Bu liste sabit bir genislik altinda taban aramanin UST KUMESI DEGILDIR;
            // ayri bir deney politikasidir, kalite esitligi varsayilmaz.
            if (distanceLists) {
                for (const at of distanceLists[i]) {
                    if (at === i || seen.has(at)) continue;
                    seen.add(at);
                    ids.push(at);
                    dists.push(distance(i, at));
                }
            }
            const tail = new Float64Array(ids.length);
            let running = Infinity;
            for (let t = ids.length - 1; t >= 0; t--) {
                if (dists[t] < running) running = dists[t];
                tail[t] = running;
            }
            lists.push(ids);
            minTail.push(tail);
        }
        return { lists, minTail, source, alphaCold: cold };
    }

    /** Yonsuz kenar (a,b) listede var mi? Zincir derinligi <= 7, O(k) yeterli. */
    function pairInList(list, a, b) {
        for (let i = 0; i < list.length; i++) {
            const pair = list[i];
            if ((pair[0] === a && pair[1] === b) || (pair[0] === b && pair[1] === a)) return true;
        }
        return false;
    }

    /**
     * Kapanis adayi TEK Hamilton cevrimi veriyor mu? O(k log k), O(n) degil.
     *
     * k tur kenari sokulunce kalan tur k YOL PARCASINA ayrilir. Kesim
     * pozisyonlari siralanip her parcanin iki ucu bulunur; eklenen k kenar bu
     * uclari birlestirir. Tek dugumluk parcanin iki ucu AYNI dugumdur ve iki
     * yuvasi vardir -- tek dugum tasima (Or-opt(1)) ailesi tam olarak boyle
     * gorunur, yalnizca nokta kimligine bakan bir kontrol onu yanlis reddeder.
     *
     * Her uc yuvasi tam olarak bir eklemeyle dolarsa parca grafi 2-duzenlidir,
     * yani ayrik cevrimlerin birlesimidir; birlesik bilesen sayisi 1 ise tek
     * cevrim kalir ve butun dugumleri kapsar. Karar materializeOrder ile
     * AYNIDIR, yalnizca O(n) komsuluk kurulmaz.
     *
     * Yalnizca KAPANIS adayi icin kesindir. Kismi zincirde olusan alt tur
     * ileride baska kenar sokulerek acilabilir; orada dal reddedilemez.
     */
    function closesSingleTour(n, removedIndexPairs, addedIndexPairs) {
        const k = removedIndexPairs.length;
        if (k === 0 || addedIndexPairs.length !== k) return false;

        // Her sokulen tur kenarini kesim pozisyonuna cevir: (g, g+1 mod n) -> g.
        const gaps = new Int32Array(k);
        for (let i = 0; i < k; i++) {
            const a = removedIndexPairs[i][0], b = removedIndexPairs[i][1];
            const forward = ((b - a) % n + n) % n;
            if (forward === 1) gaps[i] = a;
            else if (forward === n - 1) gaps[i] = b;
            else return false;                       // tur kenari degil
        }
        gaps.sort();
        for (let i = 1; i < k; i++) if (gaps[i] === gaps[i - 1]) return false;

        // Parca j = gaps[j]+1 .. gaps[j+1] (dongusel). Uclarin yuvalari.
        const slotPath = new Map();
        const slotFree = new Map();
        for (let j = 0; j < k; j++) {
            const ends = [(gaps[j] + 1) % n, gaps[(j + 1) % k]];
            for (const node of ends) {
                slotPath.set(node, j);
                slotFree.set(node, (slotFree.get(node) || 0) + 1);
            }
        }

        const parent = new Int32Array(k);
        for (let i = 0; i < k; i++) parent[i] = i;
        const find = start => {
            let node = start;
            while (parent[node] !== node) node = parent[node] = parent[parent[node]];
            return node;
        };
        let components = k;
        for (let i = 0; i < k; i++) {
            const a = addedIndexPairs[i][0], b = addedIndexPairs[i][1];
            if (a === b) return false;
            const freeA = slotFree.get(a), freeB = slotFree.get(b);
            if (!freeA || !freeB) return false;      // uc degil, veya yuvasi dolu
            slotFree.set(a, freeA - 1);
            slotFree.set(b, freeB - 1);
            const rootA = find(slotPath.get(a)), rootB = find(slotPath.get(b));
            if (rootA !== rootB) { parent[rootA] = rootB; components--; }
        }
        if (components !== 1) return false;
        for (const free of slotFree.values()) if (free !== 0) return false;
        return true;
    }

    /**
     * Sokulen/eklenen kenar kumesinden tur kurar. Tek Hamilton cevrimi cikmazsa
     * (alt tur olusursa) null doner. Yalnizca kazanci pozitif adaylar icin
     * cagrildigindan O(n) maliyeti arama dongusune girmez.
     */
    function materializeOrder(order, removedEdges, addedEdges) {
        const n = order.length;
        const adjacency = new Map(order.map((id, index) =>
            [id, [order[(index + n - 1) % n], order[(index + 1) % n]]]));
        for (const [a, b] of removedEdges) {
            const left = adjacency.get(a), right = adjacency.get(b);
            if (!left || !right || !left.includes(b) || !right.includes(a)) return null;
            adjacency.set(a, left.filter(id => id !== b));
            adjacency.set(b, right.filter(id => id !== a));
        }
        for (const [a, b] of addedEdges) {
            const left = adjacency.get(a), right = adjacency.get(b);
            if (!left || !right || left.includes(b) || right.includes(a)) return null;
            left.push(b);
            right.push(a);
        }
        for (const list of adjacency.values()) if (list.length !== 2) return null;
        const after = [];
        const seen = new Set();
        let current = order[0], previous = null;
        while (!seen.has(current)) {
            seen.add(current);
            after.push(current);
            const [first, second] = adjacency.get(current);
            const next = first === previous ? second : first;
            previous = current;
            current = next;
        }
        return current === order[0] && after.length === n ? after : null;
    }

    /**
     * Lin-Kernighan tarzi ardisik zincir: her adimda sokulen kenardan kazanilan
     * pay, eklenen aday kenara harcanir ve kismi kazanc pozitif kaldigi surece
     * derinlesir. Adaylar mesafeye gore sirali oldugundan ilk negatif kismi
     * kazancta o dal biter; ayrica her seviyede yalnizca chainBreadth kadar aday
     * taranir -> O(n * PROD(chainBreadth)) ve pratikte bunun cok altinda.
     *
     * options.startPositions verilirse zincir yalnizca o pozisyonlardan baslar
     * (don't-look bits). Cagiran taraf, bos donen kisitli taramayi tam taramayla
     * tamamlamakla yukumludur -- bkz. optimizeFourOptRepair.
     */
    function findFourOptMove(world, order, options = {}) {
        const started = clock();
        const points = world.totalNoktaList;
        const n = order.length;
        const K = options.candidateNeighbors ?? FOUR_OPT_POLICY.candidateNeighbors;
        const maxDepth = options.maxDepth ?? FOUR_OPT_POLICY.maxDepth;
        const chainBreadth = options.chainBreadth ?? FOUR_OPT_POLICY.chainBreadth;
        const maxValidations = options.maxValidations ?? FOUR_OPT_POLICY.maxValidations;
        const maxChainProbes = options.maxChainProbes
            ?? (options.maxChainProbesPerNode ?? FOUR_OPT_POLICY.maxChainProbesPerNode) * n;
        const counters = {
            chainProbes: 0, closeAttempts: 0, positiveGainCloses: 0,
            subtourRejects: 0, crossingRejects: 0, visibilityMisses: 0, validationCount: 0,
            repeatPrunes: 0, subtourPrechecks: 0, precheckMisses: 0, tailScans: 0
        };
        const edgeRepeatPruning = options.edgeRepeatPruning
            ?? FOUR_OPT_POLICY.edgeRepeatPruning;
        const subtourPrecheck = options.subtourPrecheck ?? FOUR_OPT_POLICY.subtourPrecheck;

        const positions = order.map(id => points[id].metricPosition || points[id].kendiYeri);
        const candidateSource = options.candidateSource ?? FOUR_OPT_POLICY.candidateSource;
        const candidateData = buildCandidateData(world, order, positions, K, candidateSource, options);
        const candidates = candidateData.lists;
        const minTails = candidateData.minTail;
        const candidateBuildMs = clock() - started;

        const distance = (a, b) => Math.hypot(
            positions[a].x - positions[b].x, positions[a].y - positions[b].y);
        const mod = index => (index % n + n) % n;
        const tourEdges = new Set();
        for (let i = 0; i < n; i++) tourEdges.add(edgeKey(i, mod(i + 1)));
        const isTourEdge = (a, b) => tourEdges.has(edgeKey(a, b));

        const maxCandidates = options.maxCandidates ?? FOUR_OPT_POLICY.maxCandidates;
        // Yalnizca olcum/test icin kapatilabilir; uretim yolunda daima acik.
        const simplicityGate = options.simplicityGate !== false;
        const splitPool = subtourPrecheck ? options.splitPool || null : null;
        const found = [];
        const foundKeys = new Set();

        // Kazanci pozitif bir kapanis adayini gercek turda dogrular.
        function tryClose(removedIndexPairs, addedIndexPairs) {
            counters.closeAttempts++;
            const removedKeys = new Set(), addedKeys = new Set();
            for (const [a, b] of removedIndexPairs) {
                if (a === b || !isTourEdge(a, b)) return false;
                const key = edgeKey(a, b);
                if (removedKeys.has(key)) return false;
                removedKeys.add(key);
            }
            for (const [a, b] of addedIndexPairs) {
                if (a === b) return false;
                const key = edgeKey(a, b);
                if (addedKeys.has(key) || removedKeys.has(key) || isTourEdge(a, b)) return false;
                addedKeys.add(key);
            }
            // Once O(k) olan kesin delta ve tekrar kontrolu; O(n) dogrulamalar
            // ancak bunlari gecen adaylar icin calisir.
            const removedLength = removedIndexPairs.reduce((sum, [a, b]) => sum + distance(a, b), 0);
            const addedLength = addedIndexPairs.reduce((sum, [a, b]) => sum + distance(a, b), 0);
            const delta = addedLength - removedLength;
            if (!(delta < -FOUR_OPT_EPSILON)) return false;
            counters.positiveGainCloses++;

            const identity = [...addedKeys].sort().join("|");
            if (foundKeys.has(identity)) return false;

            // O(k log k) alt tur on kontrolu O(n) dogrulamadan ONCE gelir ve
            // dogrulama kotasini TUKETMEZ: kotanin O(n) isi temsil etmesi
            // gerekir. Karar materializeOrder ile ayni oldugu icin bu, ayni
            // kota altinda daha fazla GERCEK adayin denenmesi demektir --
            // bulunan hamle kumesi kotasiz kosuda birebir aynidir.
            if (subtourPrecheck) {
                counters.subtourPrechecks++;
                if (!closesSingleTour(n, removedIndexPairs, addedIndexPairs)) {
                    counters.subtourRejects++;
                    // Uzanti icin: turu tam IKI cevrime bolen pozitif kapanis atilmaz,
                    // havuza girer (alt-tur kredili kopru). Taban sonucu degismez.
                    if (splitPool) splitPool.offer(n, removedIndexPairs, addedIndexPairs, -delta);
                    return false;
                }
            }
            if (counters.validationCount >= maxValidations) return false;

            const removedEdges = removedIndexPairs.map(([a, b]) => [order[a], order[b]]);
            const addedEdges = addedIndexPairs.map(([a, b]) => [order[a], order[b]]);
            counters.validationCount++;
            const after = materializeOrder(order, removedEdges, addedEdges);
            if (!after) {
                counters.subtourRejects++;
                if (subtourPrecheck) counters.precheckMisses++;   // on kontrol ile fark: 0 olmali
                return false;
            }
            if (simplicityGate && !isPatchSimple(world, order, removedEdges, addedEdges)) {
                counters.crossingRejects++;
                return false;
            }
            if (!addedEdges.every(([a, b]) => objectOccVisible(world, a, b))) {
                counters.visibilityMisses++;   // kapi degil, yalnizca rapor
            }
            foundKeys.add(identity);
            found.push({
                delta, after, removedEdges, addedEdges,
                exchangeDepth: addedEdges.length,
                removedEdgeKeys: removedEdges.map(([a, b]) => sourceEdgeKey(points, a, b)),
                addedEdgeKeys: addedEdges.map(([a, b]) => sourceEdgeKey(points, a, b))
            });
            return found.length >= maxCandidates;   // yalnizca kota dolunca aramayi kes
        }

        // Don't-look bits: activePositions verildiginde zincir yalnizca kenari
        // degismis dugumlerden VE onlarin aday komsularindan baslar. Komsulari da
        // acmak sart: (a,b) kenari degistiginde a'ya baglanmak isteyen c'nin kendi
        // kenarlari degismemis olabilir, ama artik onun icin de yeni bir zincir
        // vardir. Genisletme O(|aktif| * K)'dir.
        const startPositions = (() => {
            if (options.startPositions) return options.startPositions;
            const active = options.activePositions;
            if (!active) return Array.from({ length: n }, (unused, index) => index);
            const expanded = new Set(active);
            for (const position of active) {
                for (const neighbour of candidates[position]) expanded.add(neighbour);
            }
            return [...expanded];
        })();
        const removedPairs = [];
        const addedPairs = [];
        let quotaFull = false;
        let probeBudgetSpent = false;

        /**
         * level = su ana kadar sokulen kenar sayisi (1 -> yalnizca (t1,t2)).
         * tEven = zincirin acik ucu; oradan bir aday kenar eklenip yeni bir tur
         * kenari sokulerek derinlesilir, her adimda t1'e kapanis denenir.
         */
        function extendChain(t1, tEven, gain, level) {
            const width = level - 1 < chainBreadth.length ? chainBreadth[level - 1] : 0;
            const list = candidates[tEven];
            const minTail = minTails ? minTails[tEven] : null;
            let scanned = 0;
            for (let index = 0; index < list.length; index++) {
                if (scanned >= width) break;
                if (counters.chainProbes >= maxChainProbes) { probeBudgetSpent = true; return; }
                const t3 = list[index];
                counters.chainProbes++;
                if (t3 === t1 || isTourEdge(tEven, t3)) continue;
                const gainAfterAdd = gain - distance(tEven, t3);
                if (gainAfterAdd <= FOUR_OPT_EPSILON) {
                    // Mesafe sirali listede sonrakiler daha da kotudur -> dur.
                    if (!minTail) break;
                    // alpha sirasinda sira mesafeye gore artmaz. Yine de kalan
                    // adaylarin EN KISASI bile kapiyi gecemiyorsa durmak guvenli.
                    if (gain - minTail[index] <= FOUR_OPT_EPSILON) break;
                    counters.tailScans++;
                    scanned++;
                    continue;
                }
                scanned++;
                // Ayni kenari ikinci kez EKLEMEK bu dalda kalicidir; tryClose
                // onu her derinlikte reddeder. Dali burada kesmek kayipsizdir.
                if (edgeRepeatPruning && pairInList(addedPairs, tEven, t3)) {
                    counters.repeatPrunes++;
                    continue;
                }

                for (const step of [1, -1]) {
                    const t4 = mod(t3 + step);
                    // Tek yasak, ayni kenari geri almak olurdu. Daha ONCE gorulmus
                    // bir t-dugumune donmek YASAK DEGIL: bir dugumun iki tur kenari
                    // da sokuluyorsa o dugum tasiniyor demektir (Or-opt(1)) ve bu
                    // hamle ailesi tam olarak boyle ifade edilir. Eski koddaki
                    // "t6 !== t3 / t8 !== t5" kisitlari bu aileyi tamamen eliyordu;
                    // tekrar eden kenar tutarsizliklarini zaten tryClose yakalar.
                    if (t4 === tEven) continue;
                    // Ayni tur kenarini ikinci kez sokmek de dal boyunca kalici
                    // bir tutarsizliktir. DUGUM tekrari yasak DEGIL: bir dugumun
                    // iki tur kenari da sokuluyorsa o dugum tasiniyor demektir.
                    if (edgeRepeatPruning && pairInList(removedPairs, t3, t4)) {
                        counters.repeatPrunes++;
                        continue;
                    }
                    removedPairs.push([t3, t4]);
                    addedPairs.push([tEven, t3]);

                    const gainAfterRemove = gainAfterAdd + distance(t3, t4);
                    if (gainAfterRemove - distance(t4, t1) > FOUR_OPT_EPSILON
                        && tryClose(removedPairs, addedPairs.concat([[t4, t1]]))) quotaFull = true;
                    if (!quotaFull && level + 1 < maxDepth) {
                        extendChain(t1, t4, gainAfterRemove, level + 1);
                    }

                    removedPairs.pop();
                    addedPairs.pop();
                    if (quotaFull || probeBudgetSpent) return;
                }
            }
        }

        for (const t1 of startPositions) {
            for (const firstStep of [1, -1]) {
                const t2 = mod(t1 + firstStep);
                removedPairs.length = 0;
                addedPairs.length = 0;
                removedPairs.push([t1, t2]);
                extendChain(t1, t2, distance(t1, t2), 1);
                if (quotaFull || probeBudgetSpent) break;
            }
            if (quotaFull || probeBudgetSpent) break;
        }

        found.sort((left, right) => left.delta - right.delta);
        counters.candidateMoveCount = found.length;
        counters.startPositionCount = startPositions.length;
        counters.alphaColdBuild = candidateData.alphaCold ? 1 : 0;
        counters.probeBudget = maxChainProbes;
        counters.probeBudgetSpent = probeBudgetSpent ? 1 : 0;
        return {
            candidates: found,
            best: found[0] || null,
            counters,
            reason: found.length ? "IMPROVEMENT_FOUND"
                : probeBudgetSpent ? "PROBE_BUDGET_EXHAUSTED"
                : counters.validationCount >= maxValidations ? "VALIDATION_BUDGET_EXHAUSTED"
                : "NO_IMPROVEMENT",
            candidateSource: candidateData.source,
            timings: { candidateBuildMs, searchMs: clock() - started - candidateBuildMs }
        };
    }

    /**
     * ------------------------------------------------------------------
     * UZANTI: taban zincir tikandiginda (tam tarama NO_IMPROVEMENT) calisir
     * ------------------------------------------------------------------
     * Teshis: kbdb-gr-4opt-gap vakalarinda yerel optimum
     * ile optimum arasindaki farkin alternating cycle ayristirmasi uc sinifa
     * dusuyor; hicbiri "daha genis ayni arama" ile ucuza kapanmiyor:
     *   (1) K=8 listesinin disinda kalan TEK aday (sira 9-10).
     *   (2) Derinlik 7'yi asan TEK cycle (k=8..33). Eklenen kenarlarin sirasi
     *       neredeyse hep 1-3 VE cogu rotasyonda her ara kapanis zaten tek tur.
     *   (3) ARDISIK OLMAYAN hamle: pozitif kazancli ama turu IKI cevrime bolen bir
     *       kapanis + iki cevrimi baglayan kisa, kendi basina negatif bir zincir.
     *       Taban arama bu kapanislari "alt tur" diye atiyordu.
     * Asamalar ucuzdan pahaliya, ilk bulan kazanir:
     *   genis-K taramasi -> alt-tur kredili kopru -> uygulanabilirlik agirlikli
     *   sinirli-sapma derin zincir -> derin turlarin yeni havuzuyla kopru.
     * Her asama n'e oranli sabit butceyle sinirlidir: cagri basina O(n).
     */
    const FOUR_OPT_EXTENSION_POLICY = Object.freeze({
        // (1) Taban programin aynisi, K=10 listelerle.
        wideNeighbors: 10,
        // (3) Bolunmus kapanis havuzu: kazanca gore en iyi P kayit.
        splitPoolSize: 128,
        bridge: Object.freeze({
            neighbors: 10,
            // Kopru zincirinin sokulen kenar sayisi (ilk kenar dahil) <= maxDepth.
            maxDepth: 5,
            breadth: Object.freeze([10, 5, 3, 2]),
            probesPerNode: 5000
        }),
        // (2) Yinelemeli sinirli sapma: round = 0..maxDiscrepancy.
        deep: Object.freeze({
            neighbors: 10,
            maxDiscrepancy: 6,
            maxDepth: 40,
            // Ara kapanisi tek tur olmayan (t3,t4) adiminin bedeli.
            infeasiblePenalty: 3,
            probesPerNode: 10000
        }),
        maxValidations: 4096,
        maxCandidates: 12
    });

    /**
     * Kapanis yapisi: sokulen k tur kenari k segment uretir; eklenen kenarlar
     * segment uclarini baglar. Donen: bilesen sayisi (>=1) veya 0 (derece/uc
     * hatasi). closesSingleTour ile AYNI karar, ek olarak segment -> kok bilgisi
     * scratch'te kalir. Map yok, tahsis yok (scratch yeniden kullanilir).
     */
    function createClosureScratch(capacity) {
        return {
            capacity,
            gaps: new Int32Array(capacity),
            parent: new Int32Array(capacity),
            used: new Uint8Array(2 * capacity),
            k: 0
        };
    }

    function closureStructure(n, removedPairs, addedPairs, scratch, extraRemoved = null, extraAdded = null) {
        const k = removedPairs.length + (extraRemoved ? 1 : 0);
        const addedCount = addedPairs.length + (extraAdded ? extraAdded.length : 0);
        if (k === 0 || addedCount !== k) return 0;
        if (k > scratch.capacity) {
            const grown = createClosureScratch(2 * k);
            Object.assign(scratch, grown);
        }
        const gaps = scratch.gaps;
        const gapOf = pair => {
            const a = pair[0], b = pair[1];
            const forward = ((b - a) % n + n) % n;
            return forward === 1 ? a : forward === n - 1 ? b : -1;
        };
        // Ekleme siralamasi: k kucuk (<= ~45).
        let count = 0;
        const insert = gap => {
            let i = count++;
            while (i > 0 && gaps[i - 1] > gap) { gaps[i] = gaps[i - 1]; i--; }
            gaps[i] = gap;
        };
        for (let i = 0; i < removedPairs.length; i++) {
            const gap = gapOf(removedPairs[i]);
            if (gap < 0) return 0;
            insert(gap);
        }
        if (extraRemoved) {
            const gap = gapOf(extraRemoved);
            if (gap < 0) return 0;
            insert(gap);
        }
        for (let i = 1; i < k; i++) if (gaps[i] === gaps[i - 1]) return 0;
        const parent = scratch.parent, used = scratch.used;
        for (let i = 0; i < k; i++) parent[i] = i;
        used.fill(0, 0, 2 * k);
        scratch.k = k;
        const find = node => {
            while (parent[node] !== node) node = parent[node] = parent[parent[node]];
            return node;
        };
        // p'yi iceren segment: en buyuk gaps[j] < p, yoksa k-1 (dongusel).
        const takeSlot = p => {
            let lo = 0, hi = k - 1, j = k - 1;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                if (gaps[mid] < p) { j = mid; lo = mid + 1; } else hi = mid - 1;
            }
            if (gaps[0] >= p) j = k - 1;
            const start = (gaps[j] + 1) % n, end = gaps[(j + 1) % k];
            if (p === start && !used[2 * j]) { used[2 * j] = 1; return j; }
            if (p === end && !used[2 * j + 1]) { used[2 * j + 1] = 1; return j; }
            return -1;
        };
        let components = k;
        // Ayni kenarin iki kez eklenmesi slot kontrolunu ancak iki uc da tek dugumluk
        // segmentse gecebilir; yalniz o nadir durumda onceki eklemelere bakilir.
        let singleEdges = null;
        const isSingleNode = j => (gaps[j] + 1) % n === gaps[(j + 1) % k];
        const connect = pair => {
            const a = pair[0], b = pair[1];
            if (a === b) return false;
            const sa = takeSlot(a);
            if (sa < 0) return false;
            const sb = takeSlot(b);
            if (sb < 0) return false;
            if (isSingleNode(sa) && isSingleNode(sb)) {
                const key = a < b ? a * n + b : b * n + a;
                if (singleEdges === null) singleEdges = [];
                else if (singleEdges.includes(key)) return false;
                singleEdges.push(key);
            }
            const ra = find(sa), rb = find(sb);
            if (ra !== rb) { parent[ra] = rb; components--; }
            return true;
        };
        for (let i = 0; i < addedPairs.length; i++) if (!connect(addedPairs[i])) return 0;
        if (extraAdded) for (let i = 0; i < extraAdded.length; i++) if (!connect(extraAdded[i])) return 0;
        for (let s = 0; s < 2 * k; s++) if (!used[s]) return 0;
        return components;
    }

    /** Scratch'teki son yapidan segment -> kok kopyasi (havuz kaydi icin). */
    function snapshotClosure(scratch) {
        const k = scratch.k;
        const gaps = Int32Array.from(scratch.gaps.subarray(0, k));
        const root = new Int32Array(k);
        for (let j = 0; j < k; j++) {
            let node = j;
            while (scratch.parent[node] !== node) node = scratch.parent[node];
            root[j] = node;
        }
        return { gaps, root };
    }

    /** Pozisyon p'nin segment indeksi (snapshot gaps uzerinde). */
    function segmentOfPosition(gaps, p) {
        const k = gaps.length;
        let lo = 0, hi = k - 1, j = k - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (gaps[mid] < p) { j = mid; lo = mid + 1; } else hi = mid - 1;
        }
        return gaps[0] >= p ? k - 1 : j;
    }

    /**
     * Bolunmus kapanis havuzu. offer() taban aramanin sicak yolunda cagrilir;
     * yalnizca tam 2 bilesenli kapanislari tutar, kazanca gore en iyi `size`
     * kayit kalir (tekrarlar kimlikle elenir).
     */
    function createSplitPool(size) {
        const scratch = createClosureScratch(64);
        const entries = [];
        const keys = new Set();
        let offers = 0;
        // Kirpmadan sonra tutulan en kotu kazanc; bunun altindaki teklifler giremez.
        let threshold = -Infinity;
        const trim = () => {
            entries.sort((a, b) => b.gain - a.gain || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
            if (entries.length > size) {
                for (const dropped of entries.splice(size)) keys.delete(dropped.key);
            }
            if (entries.length >= size) threshold = entries[size - 1].gain;
        };
        return {
            offer(n, removedPairs, addedPairs, gain) {
                offers++;
                if (gain <= threshold) return;
                if (closureStructure(n, removedPairs, addedPairs, scratch) !== 2) return;
                const key = addedPairs.map(([a, b]) => edgeKey(a, b)).sort().join("|")
                    + ">" + removedPairs.map(([a, b]) => edgeKey(a, b)).sort().join("|");
                if (keys.has(key)) return;
                keys.add(key);
                entries.push({
                    key, gain,
                    removed: removedPairs.map(pair => pair.slice()),
                    added: addedPairs.map(pair => pair.slice()),
                    structure: snapshotClosure(scratch)
                });
                if (entries.length > 2 * size) trim();
            },
            drain(taken) {
                trim();
                return entries.filter(entry => !taken.has(entry.key));
            },
            get offers() { return offers; },
            get size() { return entries.length; }
        };
    }

    /**
     * Taban tam taramasi bos donmus bir tur icin uzanti aramasi. Donen yapi
     * findFourOptMove ile ayni; her aday `stage` (wide|bridge|deep) tasir.
     */
    function findExtendedFourOptMove(world, order, options = {}) {
        const started = clock();
        const policy = { ...FOUR_OPT_EXTENSION_POLICY, ...(options.extensionPolicy || {}) };
        const bridgePolicy = { ...FOUR_OPT_EXTENSION_POLICY.bridge, ...(policy.bridge || {}) };
        const deepPolicy = { ...FOUR_OPT_EXTENSION_POLICY.deep, ...(policy.deep || {}) };
        const points = world.totalNoktaList;
        const n = order.length;
        const counters = {
            wideProbes: 0, wideValidations: 0, poolOffers: 0, poolSize: 0,
            bridgeSplits: 0, bridgeProbes: 0, bridgeCloses: 0,
            deepProbes: 0, deepFeasibilityChecks: 0, deepRoundReached: -1,
            validationCount: 0, subtourRejects: 0, crossingRejects: 0, budgetStops: 0
        };
        const pool = options.splitPool || createSplitPool(policy.splitPoolSize);
        const taken = new Set();

        // --- (1) genis-K taramasi: taban programin aynisi ---
        const wide = findFourOptMove(world, order, {
            ...options,
            candidateNeighbors: policy.wideNeighbors,
            activePositions: null,
            startPositions: null,
            splitPool: pool
        });
        counters.wideProbes = wide.counters.chainProbes;
        counters.wideValidations = wide.counters.validationCount;
        if (wide.best) {
            for (const candidate of wide.candidates) candidate.stage = "wide";
            counters.poolOffers = pool.offers;
            counters.poolSize = pool.size;
            return finish(wide.candidates, "IMPROVEMENT_FOUND");
        }

        const positions = order.map(id => points[id].metricPosition || points[id].kendiYeri);
        const distance = (a, b) => Math.hypot(positions[a].x - positions[b].x, positions[a].y - positions[b].y);
        const mod = index => (index % n + n) % n;
        const isTourEdge = (a, b) => mod(a - b) === 1 || mod(b - a) === 1;
        const K = Math.max(bridgePolicy.neighbors, deepPolicy.neighbors);
        const candidates = buildNearestNeighborCandidates(positions, K);
        const scratch = createClosureScratch(64);
        const found = [];
        const foundKeys = new Set();
        const epsilon = FOUR_OPT_EPSILON;

        function validate(removedPairs, addedPairs, delta, stage) {
            for (const [a, b] of addedPairs) if (a === b || isTourEdge(a, b)) return false;
            const identity = addedPairs.map(([a, b]) => edgeKey(a, b)).sort().join("|");
            if (foundKeys.has(identity)) return false;
            if (counters.validationCount >= policy.maxValidations) return false;
            const removedEdges = removedPairs.map(([a, b]) => [order[a], order[b]]);
            const addedEdges = addedPairs.map(([a, b]) => [order[a], order[b]]);
            counters.validationCount++;
            const after = materializeOrder(order, removedEdges, addedEdges);
            if (!after) { counters.subtourRejects++; return false; }
            if (!isPatchSimple(world, order, removedEdges, addedEdges)) { counters.crossingRejects++; return false; }
            foundKeys.add(identity);
            found.push({
                delta, after, removedEdges, addedEdges, stage,
                exchangeDepth: addedEdges.length,
                removedEdgeKeys: removedEdges.map(([a, b]) => sourceEdgeKey(points, a, b)),
                addedEdgeKeys: addedEdges.map(([a, b]) => sourceEdgeKey(points, a, b))
            });
            return found.length >= policy.maxCandidates;
        }

        function exchangeDelta(removedPairs, addedPairs) {
            let delta = 0;
            for (const [a, b] of addedPairs) delta += distance(a, b);
            for (const [a, b] of removedPairs) delta -= distance(a, b);
            return delta;
        }

        // --- (3) alt-tur kredili kopru ---
        const bridgeBudget = bridgePolicy.probesPerNode * n;
        // Aday kotasi dolana kadar birden cok bolunmus kapanis kopru dener; en iyi
        // delta secilir (ilk bulunan kopru cogu zaman en kazancli degil).
        function runBridges() {
            for (const split of pool.drain(taken)) {
                if (found.length >= policy.maxCandidates || counters.bridgeProbes >= bridgeBudget) break;
                taken.add(split.key);
                counters.bridgeSplits++;
                bridgeFrom(split);
            }
        }

        function bridgeFrom(split) {
            const { gaps, root } = split.structure;
            const k = gaps.length;
            const sizeByRoot = new Map();
            for (let j = 0; j < k; j++) {
                const length = mod(gaps[(j + 1) % k] - gaps[j]) || n;
                sizeByRoot.set(root[j], (sizeByRoot.get(root[j]) || 0) + length);
            }
            const [first, second] = [...sizeByRoot.keys()];
            const small = sizeByRoot.get(first) <= sizeByRoot.get(second) ? first : second;
            const inSmall = p => root[segmentOfPosition(gaps, p)] === small;
            const splitRemoved = new Set(split.removed.map(([a, b]) => edgeKey(a, b)));
            const splitAdded = new Set(split.added.map(([a, b]) => edgeKey(a, b)));
            const removed = [], added = [];
            const closing = [null];

            function chain(t1, tEven, gain, level) {
                const width = level - 1 < bridgePolicy.breadth.length ? bridgePolicy.breadth[level - 1] : 0;
                const list = candidates[tEven];
                let scanned = 0;
                for (let index = 0; index < list.length && scanned < width; index++) {
                    if (counters.bridgeProbes >= bridgeBudget) { counters.budgetStops++; return true; }
                    const t3 = list[index];
                    counters.bridgeProbes++;
                    if (t3 === t1 || isTourEdge(tEven, t3) || splitAdded.has(edgeKey(tEven, t3))) continue;
                    const gainAfterAdd = gain - distance(tEven, t3);
                    if (gainAfterAdd <= epsilon) break;
                    scanned++;
                    if (pairInList(added, tEven, t3)) continue;
                    for (const step of [1, -1]) {
                        const t4 = mod(t3 + step);
                        if (t4 === tEven || splitRemoved.has(edgeKey(t3, t4)) || pairInList(removed, t3, t4)) continue;
                        removed.push([t3, t4]);
                        added.push([tEven, t3]);
                        const gainAfterRemove = gainAfterAdd + distance(t3, t4);
                        if (gainAfterRemove - distance(t4, t1) > epsilon && !isTourEdge(t4, t1)) {
                            counters.bridgeCloses++;
                            closing[0] = [t4, t1];
                            const allRemoved = split.removed.concat(removed);
                            const allAdded = split.added.concat(added, closing);
                            if (closureStructure(n, allRemoved, allAdded, scratch) === 1
                                && validate(allRemoved, allAdded.map(pair => pair.slice()), exchangeDelta(allRemoved, allAdded), "bridge")) {
                                removed.pop(); added.pop();
                                return true;
                            }
                        }
                        if (level + 1 < bridgePolicy.maxDepth && chain(t1, t4, gainAfterRemove, level + 1)) {
                            removed.pop(); added.pop();
                            return true;
                        }
                        removed.pop(); added.pop();
                    }
                }
                return false;
            }

            for (let p = 0; p < n; p++) {
                if (!inSmall(p)) continue;
                for (const step of [1, -1]) {
                    const q = mod(p + step);
                    if (!inSmall(q) || splitRemoved.has(edgeKey(p, q))) continue;
                    removed.length = 0; added.length = 0;
                    removed.push([p, q]);
                    if (chain(p, q, split.gain + distance(p, q), 1)) return;
                }
            }
        }

        runBridges();

        // --- (2) uygulanabilirlik agirlikli sinirli-sapma derin zincir ---
        if (found.length === 0) {
            const deepBudget = deepPolicy.probesPerNode * n;
            const removedPairs = [], addedPairs = [];
            const closeBuffer = [null, null];
            let round = 0;
            let stop = false;
            const deepRecord = (removed, added, gain) => {
                // Pozitif kapanis: tek tur ise dogrula, iki cevrimse havuza.
                const components = closureStructure(n, removed, added, scratch);
                if (components === 1) return validate(removed, added.map(pair => pair.slice()), -gain, "deep");
                if (components === 2) pool.offer(n, removed, added, gain);
                return false;
            };

            function extend(t1, tEven, gain, level, baseTree, discrepancy) {
                const baseWidth = baseTree && level < FOUR_OPT_POLICY.maxDepth
                    && level - 1 < FOUR_OPT_POLICY.chainBreadth.length
                    ? FOUR_OPT_POLICY.chainBreadth[level - 1] : 0;
                const list = candidates[tEven];
                const pairs = [];
                let scanned = 0;
                for (let index = 0; index < list.length && scanned < deepPolicy.neighbors; index++) {
                    if (counters.deepProbes >= deepBudget) { counters.budgetStops++; stop = true; return; }
                    const t3 = list[index];
                    counters.deepProbes++;
                    if (t3 === t1 || isTourEdge(tEven, t3)) continue;
                    const gainAfterAdd = gain - distance(tEven, t3);
                    if (gainAfterAdd <= epsilon) break;
                    const rank = scanned++;
                    if (pairInList(addedPairs, tEven, t3)) continue;
                    for (const step of [1, -1]) {
                        const t4 = mod(t3 + step);
                        if (t4 === tEven || pairInList(removedPairs, t3, t4)) continue;
                        closeBuffer[0] = [tEven, t3];
                        closeBuffer[1] = [t4, t1];
                        counters.deepFeasibilityChecks++;
                        const feasible = closureStructure(n, removedPairs, addedPairs, scratch, [t3, t4], closeBuffer) === 1;
                        pairs.push({ t3, t4, rank, feasible, look: distance(t3, t4) - distance(tEven, t3), gainAfterAdd });
                    }
                }
                // Klasik LK sirasi: ara kapanisi tek tur olan ciftler |x|-|y| ile 0,1,2..
                // bedel alir; olmayanlar ceza + mesafe sirasi.
                let feasibleRank = 0;
                pairs.sort((a, b) => (b.feasible - a.feasible) || (b.look - a.look) || (a.rank - b.rank));
                for (const pair of pairs) pair.cost = pair.feasible ? feasibleRank++ : deepPolicy.infeasiblePenalty + pair.rank;
                pairs.sort((a, b) => a.cost - b.cost || b.look - a.look || a.rank - b.rank);
                for (const pair of pairs) {
                    const childDiscrepancy = discrepancy + pair.cost;
                    if (childDiscrepancy > round) break;
                    const childBase = baseTree && pair.rank < baseWidth;
                    removedPairs.push([pair.t3, pair.t4]);
                    addedPairs.push([tEven, pair.t3]);
                    const gainAfterRemove = pair.gainAfterAdd + distance(pair.t3, pair.t4);
                    // Bu turda yalniz tam sapmasi round olan ve taban agacinda denenmemis kapanislar.
                    const fresh = childDiscrepancy === round && !(childBase && level + 1 <= FOUR_OPT_POLICY.maxDepth);
                    const closeGain = gainAfterRemove - distance(pair.t4, t1);
                    if (fresh && closeGain > epsilon && !isTourEdge(pair.t4, t1)
                        && deepRecord(removedPairs, addedPairs.concat([[pair.t4, t1]]), closeGain)) stop = true;
                    if (!stop && level + 1 < deepPolicy.maxDepth) {
                        extend(t1, pair.t4, gainAfterRemove, level + 1, childBase, childDiscrepancy);
                    }
                    removedPairs.pop(); addedPairs.pop();
                    if (stop) return;
                }
            }

            for (round = 0; round <= deepPolicy.maxDiscrepancy && found.length === 0 && !stop; round++) {
                counters.deepRoundReached = round;
                for (let t1 = 0; t1 < n && !stop; t1++) {
                    for (const step of [1, -1]) {
                        removedPairs.length = 0; addedPairs.length = 0;
                        const t2 = mod(t1 + step);
                        removedPairs.push([t1, t2]);
                        extend(t1, t2, distance(t1, t2), 1, true, 0);
                        if (stop) break;
                    }
                }
            }
            // Derin turlarin havuza ekledigi bolunmus kapanislar icin son kopru.
            if (found.length === 0) runBridges();
        }

        counters.poolOffers = pool.offers;
        counters.poolSize = pool.size;
        return finish(found, found.length ? "IMPROVEMENT_FOUND" : "NO_IMPROVEMENT");

        function finish(list, reason) {
            list.sort((left, right) => left.delta - right.delta);
            return {
                candidates: list,
                best: list[0] || null,
                counters,
                reason,
                timings: { searchMs: clock() - started }
            };
        }
    }

    /**
     * Don't-look bits. Bir onceki aramadan bu yana tur kenari degismemis bir
     * dugumden zincir baslatmak, o zaman bulunamamis olani yeniden aramaktir.
     * Bu yuzden once yalnizca komsulugu degisen dugumlerden taranir.
     *
     * Imza dugum kimligiyle tutulur, pozisyonla degil: aradaki KBDB+GR turu da
     * turu degistirebilir ve o degisiklik de bu farkta gorunur. Imza yoksa veya
     * dugum kumesi degistiyse null doner -> tam tarama.
     */
    function changedStartPositions(world, order) {
        const n = order.length;
        const current = new Map();
        for (let index = 0; index < n; index++) {
            const left = order[(index + n - 1) % n];
            const right = order[(index + 1) % n];
            current.set(order[index], left < right ? `${left}:${right}` : `${right}:${left}`);
        }
        const previous = world.fourOptNeighborSignature;
        world.fourOptNeighborSignature = current;
        if (!previous || previous.size !== current.size) return null;
        const changed = [];
        for (let index = 0; index < n; index++) {
            const id = order[index];
            if (previous.get(id) !== current.get(id)) changed.push(index);
        }
        return changed.length === n ? null : changed;
    }

    /** Tek bir iyilestiren k-opt hamlesi bulur ve transaction icinde uygular. */
    function optimizeFourOptRepair(world, options = {}) {
        const started = clock();
        const points = world?.totalNoktaList;
        const startPoint = options.startPoint || points?.[options.startNodeId ?? 4];
        if (!startPoint) throw new RangeError("A current route start point is required");
        if (world.objectOccPrepared !== true) {
            return Object.freeze({
                committed: false,
                reason: "VISIBILITY_NOT_PREPARED",
                policy: FOUR_OPT_POLICY
            });
        }

        const beforeOrder = tourOrderFromBags(startPoint, world);
        const initialLength = tourLengthRaw(beforeOrder, points);
        const derivedPointCountBefore = points.filter(point => point?.turemis).length;

        // Kisitli tarama yalnizca hizlandirmadir: bos donerse tam tarama kosar,
        // yani NO_IMPROVEMENT karari her zaman tam taramanin kararidir.
        // Imza her cagrida guncellenir; kapali oldugunda bile bayat kalmamalidir.
        const changedPositions = changedStartPositions(world, beforeOrder);
        const useDontLookBits = options.dontLookBits !== false && !options.startPositions;
        const changed = useDontLookBits ? changedPositions : null;
        let search = null;
        let scanPasses = 0;
        if (changed && changed.length > 0) {
            scanPasses++;
            search = findFourOptMove(world, beforeOrder, { ...options, activePositions: changed });
        }
        const extensionEnabled = !!options.extension;
        const splitPool = extensionEnabled
            ? createSplitPool((options.extensionPolicy || {}).splitPoolSize ?? FOUR_OPT_EXTENSION_POLICY.splitPoolSize)
            : null;
        if (!search?.best) {
            scanPasses++;
            const full = findFourOptMove(world, beforeOrder, splitPool ? { ...options, splitPool } : options);
            full.counters.chainProbes += search?.counters.chainProbes ?? 0;
            full.counters.validationCount += search?.counters.validationCount ?? 0;
            search = full;
        }
        search.counters.scanPasses = scanPasses;
        // Uzanti yalniz tam taramanin kesin NO_IMPROVEMENT kararinda calisir; butce
        // tukenmesi yerel optimum degildir, orada uzanti devreye girmez.
        let extension = null;
        if (extensionEnabled && !search.best && search.reason === "NO_IMPROVEMENT") {
            extension = findExtendedFourOptMove(world, beforeOrder, {
                ...options, splitPool, activePositions: null, startPositions: null
            });
            extension.counters.searchMs = extension.timings.searchMs;
            if (extension.best) {
                extension.counters.baseChainProbes = search.counters.chainProbes;
                search = { ...extension, counters: { ...search.counters, extension: extension.counters } };
            } else {
                search.counters.extension = extension.counters;
            }
        }

        const report = {
            committed: false,
            reason: search.reason,
            extensionRan: extension !== null,
            initialLength,
            finalLength: initialLength,
            improvement: 0,
            move: null,
            counters: search.counters,
            timings: search.timings,
            policy: FOUR_OPT_POLICY,
            complexity: {
                candidateGraph: "O(n*K) grid kNN",
                chainSearch: "O(n*PROD(chainBreadth)) with positive-partial-gain pruning"
                    + " and don't-look bits (restricted pass, then full pass)",
                validation: "O(n) per positive-gain close only"
            },
            visibility: {
                source: "ObjectOcc",
                gate: "removed-edge overlay: added edges must not cross RETAINED tour edges",
                invalidatedAfterCommit: false
            },
            validity: {
                derivedPointCountBefore,
                derivedPointCountAfter: derivedPointCountBefore
            },
            elapsedMs: 0
        };

        if (!search.best) {
            report.elapsedMs = clock() - started;
            return Object.freeze(report);
        }

        // ObjectOcc gorunurlugu mesh'te materialize edilebilirligi garanti etmez.
        // Reddedilen aday atlanir; transaction geri alma atomik oldugu icin tur
        // bir sonraki denemede degismemis haldedir.
        let transaction = null;
        let committedCandidate = null;
        const rejections = [];
        for (const candidate of search.candidates) {
            const patch = buildDiffPatchRaw(beforeOrder, candidate.after, points);
            const attempt = applyTourDiffTransaction(world, patch, {
                ...(options.transactionOptions || {}),
                materializeMissingEdges: true,
                polygonNo: options.polygonNo ?? 0,
                deltaTolerance: 1e-6,
                collectVisibilityPatch: true,
                boundedVisibilityRollback: true,
                materializationOptions: options.materializationOptions
                    || { requireCachedRay: FOUR_OPT_POLICY.requireCachedRay },
                beforeCommit() {
                    // Ihlal transaction icinde firlatilir ki geri alma atomik olsun.
                    const derivedNow = points.filter(point => point?.turemis).length;
                    if (derivedNow !== derivedPointCountBefore) {
                        throw new Error("4-opt repair changed the derived point count");
                    }
                    if (options.beforeCommit) options.beforeCommit({ world, patch });
                }
            });
            if (attempt.committed) {
                transaction = attempt;
                committedCandidate = candidate;
                report.move = {
                    stage: candidate.stage || "base",
                    exchangeDepth: candidate.exchangeDepth,
                    removedEdgeKeys: candidate.removedEdgeKeys,
                    addedEdgeKeys: candidate.addedEdgeKeys,
                    deltaRaw: patch.immediateDelta
                };
                break;
            }
            rejections.push(attempt.error?.message || String(attempt.error));
        }
        search.counters.transactionRejects = rejections.length;

        if (!committedCandidate) {
            report.reason = "TRANSACTION_REJECTED";
            report.error = rejections[0];
            report.rejectedCandidateCount = rejections.length;
            report.elapsedMs = clock() - started;
            return Object.freeze(report);
        }

        const afterOrder = tourOrderFromBags(startPoint, world);
        report.committed = true;
        report.reason = "COMMITTED";
        report.finalLength = tourLengthRaw(afterOrder, points);
        report.improvement = initialLength - report.finalLength;
        report.validity.derivedPointCountAfter = points.filter(point => point?.turemis).length;
        report.visibility.invalidatedAfterCommit = true;
        report.visibilityPatch = transaction.visibilityPatch;
        resetObjectOccState(world);
        world.pocketTreeOverlay = null;
        report.elapsedMs = clock() - started;
        return Object.freeze(report);
    }

    /**
     * KBDB + Geometric Repair yakinsar, sonra 4-opt bir hamle arar. Hamle
     * commit edilirse butun makro akis bastan calisir -- kbdbGeometricRepair'in
     * "commit edildiyse restart" sozlesmesinin aynisi, cunku commit ObjectOcc'u
     * gecersiz kilar ve yeni tur KBDB/GR icin de yeni firsat acabilir.
     */
    function optimizeKbdbGrFourOpt(world, options = {}) {
        if (!world?.totalNoktaList?.length) throw new TypeError("A populated world is required");
        const started = clock();
        const maxRounds = options.maxRounds ?? 64;
        const rounds = [];
        let initialLength = null;
        let finalLength = null;
        let kbdbGeometricRepairImprovement = 0;
        let fourOptImprovement = 0;
        let status = "FOUR_OPT_NO_IMPROVEMENT";

        let baselineRecoveries = 0;
        for (let round = 1; round <= maxRounds; round++) {
            const baseline = optimizeKbdbAndGeometricRepair(world, options.baselineOptions || {});
            if (initialLength === null) initialLength = baseline.initialLength;
            kbdbGeometricRepairImprovement += baseline.initialLength - baseline.finalLength;
            finalLength = baseline.finalLength;
            // GR'nin adayi yalnizca mesh transaction'inda reddedildiyse transaction
            // atomik geri alinmistir: tur gecerli, KBDB yakinsamis durumdadir. Eskiden
            // akis burada 4-opt'u HIC calistirmadan duruyordu; kbdb-gr-4opt-gap'teki
            // 20 "kacan" vakanin 3'u (n30-s5663, n30-s5676, n100-s5013) hamle ailesi
            // boslugu degil, bu durmaydi ("Triangle-walk could not materialize bridge
            // edge"). Diger tamamlanmama sebepleri (butce vb.) eskisi gibi durdurur.
            const recoverable = !baseline.completed
                && baseline.status === "GEOMETRIC_REPAIR_INCOMPLETE"
                && baseline.geometricRepairReason === "TRANSACTION_REJECTED";
            if (!baseline.completed && !recoverable) {
                status = "BASELINE_INCOMPLETE";
                rounds.push(Object.freeze({ roundIndex: round, baseline, fourOpt: null }));
                break;
            }
            if (recoverable) {
                baselineRecoveries++;
                // Sinirli geri alma ObjectOcc durumunu sifirlar; 4-opt hazir gorunurluk ister.
                if (world.objectOccPrepared !== true) {
                    if (typeof root.objectOcc !== "function") throw new Error("objectOcc is required to recover the baseline");
                    root.objectOcc(world);
                }
            }

            const fourOpt = optimizeFourOptRepair(world, options.fourOptOptions || {});
            rounds.push(Object.freeze({
                roundIndex: round,
                afterBaselineLength: baseline.finalLength,
                finalLength: fourOpt.finalLength,
                fourOptImprovement: fourOpt.improvement,
                baseline,
                fourOpt
            }));
            if (fourOpt.committed !== true) {
                // Taban bu turda tamamlanmadiysa yerel optimum iddia edilmez.
                status = recoverable ? "BASELINE_INCOMPLETE"
                    : fourOpt.reason === "NO_IMPROVEMENT"
                        ? "FOUR_OPT_NO_IMPROVEMENT"
                        : `FOUR_OPT_${fourOpt.reason}`;
                break;
            }
            fourOptImprovement += fourOpt.improvement;
            finalLength = fourOpt.finalLength;
            if (round === maxRounds) status = "ROUND_LIMIT_REACHED";
        }

        const frozenRounds = Object.freeze(rounds.slice());
        return Object.freeze({
            status,
            completed: status === "FOUR_OPT_NO_IMPROVEMENT",
            distanceMetric: "EUCLIDEAN_RAW",
            initialLength,
            finalLength,
            kbdbGeometricRepairImprovement,
            fourOptImprovement,
            totalImprovement: initialLength === null ? 0 : initialLength - finalLength,
            fourOptCommitCount: frozenRounds.filter(entry => entry.fourOpt?.committed === true).length,
            extensionEnabled: !!(options.fourOptOptions && options.fourOptOptions.extension),
            extensionCommits: frozenRounds.reduce((tally, entry) => {
                const stage = entry.fourOpt?.committed === true ? entry.fourOpt.move?.stage : null;
                if (stage && stage !== "base") tally[stage] = (tally[stage] || 0) + 1;
                return tally;
            }, {}),
            baselineRecoveries,
            macroRoundCount: frozenRounds.length,
            policy: FOUR_OPT_POLICY,
            elapsedMs: clock() - started,
            rounds: frozenRounds
        });
    }

    return {
        FOUR_OPT_EPSILON,
        FOUR_OPT_POLICY,
        FOUR_OPT_EXTENSION_POLICY,
        closureStructure,
        createClosureScratch,
        createSplitPool,
        findExtendedFourOptMove,
        buildAlphaCandidates,
        buildNearestNeighborCandidates,
        closesSingleTour,
        isPatchSimple,
        materializeOrder,
        objectOccVisible,
        findFourOptMove,
        optimizeFourOptRepair,
        optimizeKbdbGrFourOpt
    };
});
