(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    Object.assign(root, api);
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const ADJACENT_BLOCK_MAX_LENGTH = 4;
    const ADJACENT_BLOCK_RAW_EPSILON = 1e-9;

    function edgeKey(a, b) {
        return a < b ? `${a}:${b}` : `${b}:${a}`;
    }

    function compareEdgeKeys(left, right) {
        const [leftA, leftB] = left.split(":").map(Number);
        const [rightA, rightB] = right.split(":").map(Number);
        return leftA - rightA || leftB - rightB;
    }

    /**
     * tsplib birincil, raw ikincil sözlüksel karşılaştırma. Deney motorundaki
     * compareLengths ile aynı: eşit tsplib'de raw farkı epsilon içindeyse berabere.
     */
    function compareLengths(left, right, rawEpsilon = ADJACENT_BLOCK_RAW_EPSILON) {
        if (left.tsplib !== right.tsplib) return left.tsplib - right.tsplib;
        if (Math.abs(left.raw - right.raw) <= rawEpsilon) return 0;
        return left.raw - right.raw;
    }

    /**
     * Kaldırılan ve eklenen kenarlardan ortak olanları sadeleştirir; bloklardan
     * biri turun tamamına yakınsa aynı kenar iki listede birden görünebilir.
     */
    function normalizeEdgeDiff(removedEdges, addedEdges) {
        const removed = new Map(removedEdges.map(([a, b]) => [edgeKey(a, b), a < b ? [a, b] : [b, a]]));
        const added = new Map(addedEdges.map(([a, b]) => [edgeKey(a, b), a < b ? [a, b] : [b, a]]));
        for (const key of [...removed.keys()]) {
            if (!added.has(key)) continue;
            removed.delete(key);
            added.delete(key);
        }
        const sorted = entries => entries.sort(([left], [right]) => compareEdgeKeys(left, right));
        const removedEntries = sorted([...removed.entries()]);
        const addedEntries = sorted([...added.entries()]);
        return {
            removedEdgeKeys: removedEntries.map(([key]) => key),
            addedEdgeKeys: addedEntries.map(([key]) => key),
            removedEdges: removedEntries.map(([, edge]) => edge),
            addedEdges: addedEntries.map(([, edge]) => edge)
        };
    }

    /**
     * boundaryIndex'ten sonra gelen p uzunluklu B bloğu ile onu izleyen q uzunluklu
     * C bloğunun yerini değiştirir. Her iki blok da kendi içinde yönünü korur, yani
     * a-B-C-d turu a-C-B-d olur ve yalnız üç kenar değişir.
     */
    function candidateAt(order, points, boundaryIndex, p, q) {
        const count = order.length;
        const at = offset => order[(boundaryIndex + offset) % count];
        const a = at(0);
        const bFirst = at(1);
        const bLast = at(p);
        const cFirst = at(p + 1);
        const cLast = at(p + q);
        const d = at(p + q + 1);
        const diff = normalizeEdgeDiff(
            [[a, bFirst], [bLast, cFirst], [cLast, d]],
            [[a, cFirst], [cLast, bFirst], [bLast, d]]
        );
        const sum = (edges, metric) => edges.reduce(
            (total, [left, right]) => total + metric(left, right, points), 0);
        return {
            boundaryIndex,
            p,
            q,
            ...diff,
            cycleKey: `${diff.removedEdgeKeys.join(",")}|${diff.addedEdgeKeys.join(",")}`,
            delta: {
                tsplib: sum(diff.addedEdges, routeEdgeCost) - sum(diff.removedEdges, routeEdgeCost),
                raw: sum(diff.addedEdges, routeEdgeLengthRaw) - sum(diff.removedEdges, routeEdgeLengthRaw)
            }
        };
    }

    /**
     * Seçilen adayı gerçek tur sırasına çevirir ve turu özgün başlangıç noktasına
     * geri döndürür; bag zinciri başlangıç noktasından okunduğu için sıra kaymamalı.
     */
    function materializeCandidate(order, descriptor) {
        const { boundaryIndex, p, q } = descriptor;
        const count = order.length;
        const at = offset => order[(boundaryIndex + offset) % count];
        const rotated = [at(0)];
        for (let offset = p + 1; offset <= p + q; offset++) rotated.push(at(offset));
        for (let offset = 1; offset <= p; offset++) rotated.push(at(offset));
        for (let offset = p + q + 1; offset < count; offset++) rotated.push(at(offset));
        const startIndex = rotated.indexOf(order[0]);
        if (startIndex < 0) throw new Error("Adjacent block swap lost the route start point");
        return rotated.slice(startIndex).concat(rotated.slice(0, startIndex));
    }

    /**
     * Sınırlı tek geçişli tarama: her sınır konumu icin p,q <= maxBlockLength olan
     * tüm blok çiftlerini bir kez dener ve turu kısaltan tek en iyi hamleyi döndürür.
     * Yinelemez, hiçbir noktayı yeniden ziyaret etmez; aday sayısı n*L*L ile sınırlı.
     */
    function findAdjacentBlockSwap(order, points, options = {}) {
        if (!Array.isArray(order) || order.length < 4) {
            throw new TypeError("order must contain at least four route points");
        }
        const maxBlockLength = options.maxBlockLength ?? ADJACENT_BLOCK_MAX_LENGTH;
        const rawEpsilon = options.rawEpsilon ?? ADJACENT_BLOCK_RAW_EPSILON;
        const count = order.length;
        const initialLengths = {
            tsplib: tourLength(order, points),
            raw: tourLengthRaw(order, points)
        };
        const seenCycleKeys = new Set();
        const counters = {
            candidateVisitCount: 0,
            duplicateCycleCount: 0,
            objectiveRejectCount: 0,
            improvingCandidateCount: 0
        };
        let bestDescriptor = null;
        let bestLengths = { ...initialLengths };

        for (let boundaryIndex = 0; boundaryIndex < count; boundaryIndex++) {
            for (let p = 1; p <= maxBlockLength; p++) {
                for (let q = 1; q <= maxBlockLength; q++) {
                    if (p + q > count - 2) continue;
                    const candidate = candidateAt(order, points, boundaryIndex, p, q);
                    counters.candidateVisitCount++;

                    if (seenCycleKeys.has(candidate.cycleKey)) {
                        counters.duplicateCycleCount++;
                        continue;
                    }
                    seenCycleKeys.add(candidate.cycleKey);

                    const finalLengths = {
                        tsplib: initialLengths.tsplib + candidate.delta.tsplib,
                        raw: initialLengths.raw + candidate.delta.raw
                    };
                    if (compareLengths(finalLengths, initialLengths, rawEpsilon) >= 0) {
                        counters.objectiveRejectCount++;
                        continue;
                    }
                    counters.improvingCandidateCount++;
                    if (bestDescriptor && compareLengths(finalLengths, bestLengths, rawEpsilon) >= 0) continue;
                    bestDescriptor = { ...candidate, finalLengths };
                    bestLengths = { ...finalLengths };
                }
            }
        }

        return {
            initialLengths,
            bestLengths,
            bestDescriptor,
            bestOrder: bestDescriptor ? materializeCandidate(order, bestDescriptor) : null,
            counters,
            candidateVisitLimit: count * maxBlockLength * maxBlockLength
        };
    }

    function countAddedEdgeCrossings(patch, points) {
        let checkedPairCount = 0;
        let crossingCount = 0;
        for (let left = 0; left < patch.addedEdges.length; left++) {
            const [aId, bId] = patch.addedEdges[left];
            for (let right = left + 1; right < patch.addedEdges.length; right++) {
                const [cId, dId] = patch.addedEdges[right];
                if (aId === cId || aId === dId || bId === cId || bId === dId) continue;
                checkedPairCount++;
                if (segmentsIntersectCoords(
                    points[aId].kendiYeri, points[bId].kendiYeri,
                    points[cId].kendiYeri, points[dId].kendiYeri, 1e-9)) {
                    crossingCount++;
                }
            }
        }
        return { checkedPairCount, crossingCount };
    }

    /**
     * Turu tarar, bulunan tek en iyi blok takasını kesişim denetiminden geçirir ve
     * kabul edilirse tek bir işlem (transaction) olarak dünyaya uygular.
     */
    function optimizeAdjacentBlockSwap(world, options = {}) {
        const points = world.totalNoktaList;
        const startPoint = options.startPoint || points[options.startNodeId ?? 4];
        if (!startPoint) throw new RangeError("A current route start point is required");
        const beforeOrder = tourOrderFromBags(startPoint, world);
        const search = findAdjacentBlockSwap(beforeOrder, points, options);

        const report = {
            committed: false,
            reason: "NO_IMPROVEMENT",
            initialTsplibLength: search.initialLengths.tsplib,
            initialLength: search.initialLengths.raw,
            finalTsplibLength: search.initialLengths.tsplib,
            finalLength: search.initialLengths.raw,
            move: null,
            geometry: { checkedPairCount: 0, crossingCount: 0 },
            counters: search.counters,
            candidateVisitLimit: search.candidateVisitLimit
        };
        if (!search.bestOrder) return report;

        report.move = {
            blockLengths: [search.bestDescriptor.p, search.bestDescriptor.q],
            removedEdgeKeys: search.bestDescriptor.removedEdgeKeys,
            addedEdgeKeys: search.bestDescriptor.addedEdgeKeys,
            deltaTsplib: search.bestDescriptor.delta.tsplib,
            deltaRaw: search.bestDescriptor.delta.raw
        };

        const patch = buildDiffPatch(beforeOrder, search.bestOrder, points);
        report.geometry = countAddedEdgeCrossings(patch, points);
        if (report.geometry.crossingCount > 0) {
            report.reason = "ADDED_EDGE_INTERSECTION";
            return report;
        }

        const transaction = applyTourDiffTransaction(world, patch, {
            materializeMissingEdges: true,
            polygonNo: 0,
            deltaTolerance: 1e-6,
            // Tur uzunluğu tsplib yuvarlamasında eşit kaldığında yalnız raw kısalır;
            // işlem katmanı bunu iyileşme saymadığı için açıkça izin veriyoruz.
            allowNonImproving: patch.immediateDelta === 0 && patch.rawImmediateDelta < -1e-9
        });
        if (!transaction.committed) {
            report.reason = "TRANSACTION_REJECTED";
            report.error = transaction.error ? (transaction.error.message || String(transaction.error)) : null;
            return report;
        }

        resetObjectOccState(world);
        objectOcc(world);

        const afterOrder = tourOrderFromBags(startPoint, world);
        report.committed = true;
        report.reason = "COMMITTED";
        report.finalTsplibLength = tourLength(afterOrder, points);
        report.finalLength = tourLengthRaw(afterOrder, points);
        return report;
    }

    return {
        ADJACENT_BLOCK_MAX_LENGTH,
        ADJACENT_BLOCK_RAW_EPSILON,
        compareAdjacentBlockLengths: compareLengths,
        findAdjacentBlockSwap,
        materializeAdjacentBlockSwap: materializeCandidate,
        optimizeAdjacentBlockSwap
    };
});
