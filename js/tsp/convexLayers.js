(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    Object.assign(root, api);
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    function crossZ(origin, first, second) {
        return (first.x - origin.x) * (second.y - origin.y) - (first.y - origin.y) * (second.x - origin.x);
    }

    /**
     * Andrew's monotone chain. Girdi dizisine indeks döndürür; sıralama tutarlı
     * yönlüdür (ardışık her üçlünün cross çarpımı pozitif). Kenar üzerindeki
     * collinear ara noktalar hull'a alınmaz.
     */
    function convexHullIndices(points) {
        const order = points.map((_, index) => index)
            .sort((a, b) => points[a].x - points[b].x || points[a].y - points[b].y);
        if (order.length < 3) return order;

        const lower = [];
        for (const index of order) {
            while (lower.length >= 2
                && crossZ(points[lower[lower.length - 2]], points[lower[lower.length - 1]], points[index]) <= 0) {
                lower.pop();
            }
            lower.push(index);
        }

        const upper = [];
        for (let at = order.length - 1; at >= 0; at--) {
            const index = order[at];
            while (upper.length >= 2
                && crossZ(points[upper[upper.length - 2]], points[upper[upper.length - 1]], points[index]) <= 0) {
                upper.pop();
            }
            upper.push(index);
        }

        lower.pop();
        upper.pop();
        return lower.concat(upper);
    }

    /**
     * Onion peeling: kalan noktaların hull'u alınıp çıkarılır. Hull 3'ten az
     * nokta verdiğinde (kalanlar doğrusal) veya 3'ten az nokta kaldığında,
     * kalanların tamamı tek bir dejenere son katman olarak eklenir; hiçbir
     * nokta kaybolmaz. Dönen katmanlar girdi dizisine indeks listeleridir.
     */
    function computeConvexLayers(points) {
        const layers = [];
        let remaining = points.map((_, index) => index);
        while (remaining.length >= 3) {
            const hull = convexHullIndices(remaining.map(index => points[index]));
            if (hull.length < 3) break;
            layers.push(hull.map(hullIndex => remaining[hullIndex]));
            const taken = new Set(hull);
            remaining = remaining.filter((_, position) => !taken.has(position));
        }
        if (remaining.length > 0) layers.push(remaining);
        return layers;
    }

    function distanceBetween(a, b) {
        return Math.hypot(a.x - b.x, a.y - b.y);
    }

    /**
     * İki doğru parçasının uç değmesi hariç gerçek (proper) kesişimi.
     * Ortak uç nokta paylaşan kenarlar kesişmiş sayılmaz.
     */
    function segmentsProperlyIntersect(p1, p2, q1, q2) {
        const d1 = crossZ(q1, q2, p1);
        const d2 = crossZ(q1, q2, p2);
        const d3 = crossZ(p1, p2, q1);
        const d4 = crossZ(p1, p2, q2);
        return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0))
            && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
    }

    function insertionKeepsCycleSimple(cycle, at, candidate, points) {
        const edgeStart = points[cycle[at]];
        const edgeFinish = points[cycle[(at + 1) % cycle.length]];
        for (let edge = 0; edge < cycle.length; edge++) {
            if (edge === at) continue;
            const otherStart = points[cycle[edge]];
            const otherFinish = points[cycle[(edge + 1) % cycle.length]];
            if (segmentsProperlyIntersect(edgeStart, candidate, otherStart, otherFinish)) return false;
            if (segmentsProperlyIntersect(candidate, edgeFinish, otherStart, otherFinish)) return false;
        }
        return true;
    }

    /**
     * computeConvexLayers'ın dejenere son katmanını (hull kuramayan 1-2 nokta
     * veya doğrusal kalanlar) bir önceki gerçek katmanın çevrimine yedirir.
     * Artık noktalar her zaman en içteki hull'un içinde kaldığından en yakın
     * kenar daima bu katmandadır. Her nokta, cheapest-insertion maliyetini
     * (|a-p| + |p-b| - |a-b|) en aza indiren ve çevrimi basit bırakan (yeni
     * kenarlar hiçbir mevcut kenarı kesmeyen) kenara eklenir; böylece yeniden
     * çizimde kesişimden türemiş nokta oluşmaz.
     */
    function absorbRemainderIntoLastLayer(layers, points) {
        if (layers.length < 2) return layers;
        const remainder = layers[layers.length - 1];
        if (remainder.length >= 3) return layers;

        const cycle = [...layers[layers.length - 2]];
        const pending = [...remainder];

        while (pending.length > 0) {
            let best = null;
            for (const pointIndex of pending) {
                const candidate = points[pointIndex];
                for (let at = 0; at < cycle.length; at++) {
                    const edgeStart = points[cycle[at]];
                    const edgeFinish = points[cycle[(at + 1) % cycle.length]];
                    const cost = distanceBetween(edgeStart, candidate)
                        + distanceBetween(candidate, edgeFinish)
                        - distanceBetween(edgeStart, edgeFinish);
                    if (best && cost >= best.cost) continue;
                    if (!insertionKeepsCycleSimple(cycle, at, candidate, points)) continue;
                    best = { pointIndex, at, cost };
                }
            }
            if (!best) break;
            cycle.splice(best.at + 1, 0, best.pointIndex);
            pending.splice(pending.indexOf(best.pointIndex), 1);
        }

        const result = layers.slice(0, layers.length - 2);
        result.push(cycle);
        if (pending.length > 0) {
            console.warn(`absorbRemainderIntoLastLayer: ${pending.length} nokta için geçerli kenar bulunamadı; ayrı katman olarak bırakıldı`);
            result.push(pending);
        }
        return result;
    }

    /**
     * Dıştan içe sıralı katman çevrimlerini tek bir tura birleştirir. Ayrık iki
     * çevrimi birleştirmek için TEK köprü yeterlidir: dıştan bir kenar (a-b) ve
     * içten bir kenar (c-d) sökülür, iki çapraz kenar eklenir (a-c/b-d veya
     * a-d/b-c; delta'sı küçük olan eşleşme seçilir). Köprünün dış ayağı bir
     * önceki katmanın kenarlarıyla sınırlıdır: delta sökülen kenarı da
     * içerdiğinden, dış halkalardaki uzun bir kenarı söküp ara halkaları kesen
     * köprüler aksi halde "kârlı" görünebilir. 3 noktadan küçük katmanlar köprü
     * kuramaz; noktaları cheapest-insertion ile tura yedirilir.
     * `cost(pointA, pointB)` karar metriğidir (ör. metricPosition Öklid).
     */
    function mergeLayerCycles(cycles, points, cost = distanceBetween) {
        const populated = cycles.filter(cycle => cycle.length > 0);
        if (populated.length === 0) return { cycle: [], merges: [] };

        const tour = [...populated[0]];
        const merges = [];
        let previousLayer = new Set(populated[0]);

        // Aday kenar (p,q) tur kenarlarından veya henüz birleşmemiş halkaların
        // kenarlarından birini keserse, yeniden çizim Ucgenle'nin self-intersection
        // yoluna girip türemiş nokta üretir. Uç değmeleri kesişim sayılmadığından
        // sökülen kenarların ayrıca dışlanması gerekmez.
        const crossesExisting = (p, q, fromLayerNo) => {
            for (let at = 0; at < tour.length; at++) {
                if (segmentsProperlyIntersect(p, q,
                    points[tour[at]], points[tour[(at + 1) % tour.length]])) return true;
            }
            for (let layerAt = fromLayerNo; layerAt < populated.length; layerAt++) {
                const ring = populated[layerAt];
                if (ring.length < 2) continue;
                for (let j = 0; j < ring.length; j++) {
                    if (segmentsProperlyIntersect(p, q,
                        points[ring[j]], points[ring[(j + 1) % ring.length]])) return true;
                }
            }
            return false;
        };

        const findBestBridge = (inner, layerNo, outerFilter, requireSimple) => {
            let best = null;
            for (let at = 0; at < tour.length; at++) {
                const aIndex = tour[at];
                const bIndex = tour[(at + 1) % tour.length];
                if (outerFilter && !(outerFilter.has(aIndex) && outerFilter.has(bIndex))) continue;
                const a = points[aIndex];
                const b = points[bIndex];
                const outerRemoved = cost(a, b);
                for (let j = 0; j < inner.length; j++) {
                    const cIndex = inner[j];
                    const dIndex = inner[(j + 1) % inner.length];
                    const c = points[cIndex];
                    const d = points[dIndex];
                    const removed = outerRemoved + cost(c, d);
                    for (const flip of [false, true]) {
                        const first = flip ? [a, d] : [a, c];   // a-d | a-c
                        const second = flip ? [b, c] : [b, d];  // b-c | b-d
                        const delta = cost(first[0], first[1]) + cost(second[0], second[1]) - removed;
                        if (best && delta >= best.delta) continue;
                        if (requireSimple) {
                            if (segmentsProperlyIntersect(first[0], first[1], second[0], second[1])) continue;
                            if (crossesExisting(first[0], first[1], layerNo)) continue;
                            if (crossesExisting(second[0], second[1], layerNo)) continue;
                        }
                        best = { at, j, flip, delta, aIndex, bIndex, cIndex, dIndex };
                    }
                }
            }
            return best;
        };

        for (let layerNo = 1; layerNo < populated.length; layerNo++) {
            const inner = populated[layerNo];

            if (inner.length < 3) {
                const pending = [...inner];
                while (pending.length > 0) {
                    let best = null;
                    for (const pointIndex of pending) {
                        const candidate = points[pointIndex];
                        for (let at = 0; at < tour.length; at++) {
                            const a = points[tour[at]];
                            const b = points[tour[(at + 1) % tour.length]];
                            const delta = cost(a, candidate) + cost(candidate, b) - cost(a, b);
                            if (best && delta >= best.delta) continue;
                            if (crossesExisting(a, candidate, layerNo) || crossesExisting(candidate, b, layerNo)) continue;
                            best = { pointIndex, at, delta };
                        }
                    }
                    if (!best) {
                        console.warn(`mergeLayerCycles: katman ${layerNo} noktaları için kesişimsiz kenar yok; kontrolsüz eklenecek`);
                        for (const pointIndex of pending) {
                            const candidate = points[pointIndex];
                            for (let at = 0; at < tour.length; at++) {
                                const a = points[tour[at]];
                                const b = points[tour[(at + 1) % tour.length]];
                                const delta = cost(a, candidate) + cost(candidate, b) - cost(a, b);
                                if (!best || delta < best.delta) best = { pointIndex, at, delta };
                            }
                        }
                    }
                    tour.splice(best.at + 1, 0, best.pointIndex);
                    pending.splice(pending.indexOf(best.pointIndex), 1);
                    merges.push({ type: "insertion", layer: layerNo, pointIndex: best.pointIndex, delta: best.delta });
                }
                continue;
            }

            // Kademeli arama: önce önceki katman kenarları + kesişimsizlik; aday
            // çıkmazsa kısıtlar tek tek gevşetilir ki birleşme her koşulda tamamlansın.
            let best = findBestBridge(inner, layerNo, previousLayer, true)
                || findBestBridge(inner, layerNo, null, true);
            if (!best) {
                console.warn(`mergeLayerCycles: katman ${layerNo} için kesişimsiz köprü yok; kontrolsüz köprü kurulacak`);
                best = findBestBridge(inner, layerNo, previousLayer, false)
                    || findBestBridge(inner, layerNo, null, false);
            }

            // İç çevrim, sökülen (c,d) kenarının d ucundan ileri yönde açılır
            // (d..c). a-c eşleşmesinde a'dan sonra c gelmeli: yol ters çevrilir.
            const path = [];
            for (let step = 1; step <= inner.length; step++) {
                path.push(inner[(best.j + step) % inner.length]);
            }
            if (!best.flip) path.reverse();
            tour.splice(best.at + 1, 0, ...path);

            merges.push({
                type: "bridge",
                layer: layerNo,
                delta: best.delta,
                removedOuter: [best.aIndex, best.bIndex],
                removedInner: [best.cIndex, best.dIndex],
                added: best.flip
                    ? [[best.aIndex, best.dIndex], [best.bIndex, best.cIndex]]
                    : [[best.aIndex, best.cIndex], [best.bIndex, best.dIndex]]
            });
            previousLayer = new Set(inner);
        }

        return { cycle: tour, merges };
    }

    /**
     * Ucgenle, eklenen nokta poligonun ilk noktasına snapDistance'tan yakınsa
     * poligonu erken kapatır. Katman çevrimi, aynı katmanda bu mesafede komşusu
     * olmayan bir noktadan başlayacak şekilde döndürülür; çevrim sırası korunur.
     */
    function rotateLayerForSafeClosure(layer, points, snapDistance = 5) {
        const snapSq = snapDistance * snapDistance;
        for (let start = 0; start < layer.length; start++) {
            const origin = points[layer[start]];
            const unsafe = layer.some((index, at) => {
                if (at === start) return false;
                const candidate = points[index];
                const dx = candidate.x - origin.x;
                const dy = candidate.y - origin.y;
                return dx * dx + dy * dy < snapSq;
            });
            if (!unsafe) {
                return start === 0 ? layer : layer.slice(start).concat(layer.slice(0, start));
            }
        }
        console.warn("rotateLayerForSafeClosure: snap-safe başlangıç noktası yok; erken kapanma olabilir");
        return layer;
    }

    return {
        absorbRemainderIntoLastLayer,
        computeConvexLayers,
        convexHullIndices,
        mergeLayerCycles,
        rotateLayerForSafeClosure,
        segmentsProperlyIntersect
    };
});
