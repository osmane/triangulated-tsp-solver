(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    Object.assign(root, api);
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    function now() {
        return typeof performance !== "undefined" ? performance.now() : Date.now();
    }

    function measured(timings, name, operation) {
        const start = now();
        const value = operation();
        timings[name] = (timings[name] || 0) + now() - start;
        return value;
    }

    function pointRay(world, a, b) {
        return (typeof getPointRay === "function"
            ? getPointRay(world, a, b)
            : world.pointRayIndex?.get(a < b ? `${a}:${b}` : `${b}:${a}`)) || null;
    }

    function edgeKey(a, b) {
        return a < b ? `${a}:${b}` : `${b}:${a}`;
    }

    function frozenEdge(a, b) {
        return Object.freeze([a, b]);
    }

    function frozenEdges(edges) {
        return Object.freeze(edges.map(([a, b]) => frozenEdge(a, b)));
    }

    function rayPolygonSide(world, context, a, b, ray) {
        const key = edgeKey(a, b);
        if (context.raySideCache.has(key)) return context.raySideCache.get(key);
        const side = classifyRayAgainstOutside(
            world,
            ray,
            context.outside,
            context.meshEdgeClasses
        );
        context.raySideCache.set(key, side);
        return side;
    }

    function edgesMatchInteriorState(world, context, edges, expectedInterior) {
        const expectedSide = expectedInterior ? "interior" : "exterior";
        for (const [a, b] of edges) {
            const ray = pointRay(world, a, b);
            if (!ray) return { matches: false, reason: "missing-ray" };
            if (rayPolygonSide(world, context, a, b, ray) !== expectedSide) {
                return { matches: false, reason: expectedInterior ? "not-interior" : "not-exterior" };
            }
        }
        return { matches: true, reason: null };
    }

    function extractSecondAddedEdges(fixedAddedEdges, splitAddedEdges) {
        return fixedAddedEdges.filter(([a, b]) => !splitAddedEdges.some(
            ([c, d]) => edgeKey(a, b) === edgeKey(c, d)));
    }

    function edgePosition(world, pointId) {
        return world.totalNoktaList[pointId]?.kendiYeri;
    }

    function secondBridgeIntersectsFirst(world, secondEdges, firstEdges) {
        for (const [a, b] of secondEdges) {
            const aLoc = edgePosition(world, a);
            const bLoc = edgePosition(world, b);
            if (!aLoc || !bLoc) return true;
            for (const [c, d] of firstEdges) {
                const cLoc = edgePosition(world, c);
                const dLoc = edgePosition(world, d);
                if (!cLoc || !dLoc || segmentsIntersectCoords(aLoc, bLoc, cLoc, dLoc)) return true;
            }
        }
        return false;
    }

    function compareEdgePairs(left, right) {
        const leftA = Math.min(left[0], left[1]);
        const leftB = Math.max(left[0], left[1]);
        const rightA = Math.min(right[0], right[1]);
        const rightB = Math.max(right[0], right[1]);
        return leftA - rightA || leftB - rightB;
    }

    function edgeListKey(edges) {
        return edges.slice().sort(compareEdgePairs).map(([a, b]) => edgeKey(a, b)).join(",");
    }

    // The three distinct component cycles on four contracted arcs.  Every simple
    // reconnection realises one of them; the reverse traversal of a cycle yields
    // the same matchings under a flip of the port roles, so one direction each is
    // exhaustive.
    const FOUR_CUT_COMPONENT_CYCLES = Object.freeze([
        Object.freeze([0, 1, 2, 3]),
        Object.freeze([0, 1, 3, 2]),
        Object.freeze([0, 2, 1, 3])
    ]);

    /**
     * Enumerate the exact four-cut reconnections whose delta clears the `epsilon`
     * improvement threshold.  The four retained route arcs are contracted to nodes carrying an
     * entry and an exit port.  Rather than filtering all 105 port matchings after
     * building them, only the 3 * 2^4 = 48 that are single cycles by construction
     * are walked, and each is abandoned as soon as its partial added length can no
     * longer improve -- remaining edges cannot be negative.  The search size still
     * depends only on the eight ports, never on polygon size.
     */
    function enumerateSimpleFourCutReconnections(world, order, cuts, routeEdgeByKey, epsilon, stats) {
        const removedEdges = cuts.map(cut => [order[cut], order[(cut + 1) % order.length]]);
        const removedKeys = new Set(removedEdges.map(edge => edgeKey(...edge)));
        let removedSum = 0;
        for (const [a, b] of removedEdges) removedSum += routeEdgeLengthRawCached(world, a, b);
        // ports[c] = [exit of arc c, entry of arc c]
        const ports = cuts.map((cut, componentId) => [
            order[(cut + 1) % order.length],
            order[cuts[(componentId + 1) % cuts.length]]
        ]);

        const results = [];
        const seen = new Set();
        const pairs = [null, null, null, null];
        for (const cycle of FOUR_CUT_COMPONENT_CYCLES) {
            for (let bits = 0; bits < 16; bits++) {
                let addedSum = 0;
                let rejected = false;
                for (let step = 0; step < 4 && !rejected; step++) {
                    const from = cycle[step];
                    const to = cycle[(step + 1) % 4];
                    const a = ports[from][(bits >> from) & 1];
                    const b = ports[to][1 - ((bits >> to) & 1)];
                    if (a === b) {
                        rejected = true;
                        break;
                    }
                    const key = edgeKey(a, b);
                    if (routeEdgeByKey.has(key) || removedKeys.has(key)) {
                        rejected = true;
                        break;
                    }
                    addedSum += routeEdgeLengthRawCached(world, a, b);
                    // Every remaining edge has non-negative length, so a partial
                    // sum that already fails the threshold can never recover.
                    if (!(addedSum - removedSum < -epsilon)) {
                        stats.generalizedObjectiveRejects++;
                        rejected = true;
                        break;
                    }
                    pairs[step] = [a, b];
                }
                if (rejected) continue;
                const addedEdges = pairs.map(pair => pair.slice()).sort(compareEdgePairs);
                // Two ports of a degenerate single-point arc can pair into the same
                // edge twice; that would double an edge instead of adding four.
                const addedKeys = new Set(addedEdges.map(([a, b]) => edgeKey(a, b)));
                if (addedKeys.size !== 4) continue;
                const key = edgeListKey(addedEdges);
                if (seen.has(key)) continue;
                seen.add(key);
                results.push({
                    key,
                    removedEdges,
                    addedEdges,
                    deltaRaw: addedSum - removedSum
                });
            }
        }
        return results;
    }

    /**
     * Exact lower bound on the delta of every simple reconnection of one cut set.
     * Each of the eight ports carries degree one in the added set, so the added
     * length equals half the sum of the matched port distances and is therefore
     * at least half the sum of each port's nearest legal partner.  Partners in the
     * same arc are excluded because such a pair would close that arc into its own
     * subtour.  This costs 28 cached distances instead of 105 matchings, and is
     * the all-simple counterpart of `secondCutDeltaLowerBound`.
     */
    function generalizedCutSetDeltaLowerBound(world, order, cuts) {
        const ports = [];
        for (let componentId = 0; componentId < cuts.length; componentId++) {
            ports.push({ pointId: order[(cuts[componentId] + 1) % order.length], componentId });
            ports.push({ pointId: order[cuts[(componentId + 1) % cuts.length]], componentId });
        }
        let nearestSum = 0;
        for (let index = 0; index < ports.length; index++) {
            let nearest = Infinity;
            for (let other = 0; other < ports.length; other++) {
                if (ports[other].componentId === ports[index].componentId) continue;
                const distance = routeEdgeLengthRawCached(
                    world, ports[index].pointId, ports[other].pointId);
                if (distance < nearest) nearest = distance;
            }
            if (!Number.isFinite(nearest)) return -Infinity;
            nearestSum += nearest;
        }
        let removedSum = 0;
        for (const cut of cuts) {
            removedSum += routeEdgeLengthRawCached(
                world, order[cut], order[(cut + 1) % order.length]);
        }
        return nearestSum / 2 - removedSum;
    }

    function generalizedFourCutCandidates(world, context, order, cutIndices, stats, epsilon) {
        const cuts = cutIndices.slice().sort((left, right) => left - right);
        const cacheKey = cuts.join(":");
        const cached = context.fourCutReconnectionCache.get(cacheKey);
        if (cached) {
            stats.generalizedFourCutCacheHits++;
            return cached;
        }
        // Reject the whole cut set before enumerating when no matching of its
        // ports can reach the improvement threshold.  The empty result is cached
        // like any other, so a repeated visit costs one map lookup.
        if (!(generalizedCutSetDeltaLowerBound(world, order, cuts) < -epsilon)) {
            stats.generalizedCutSetBoundRejects++;
            const empty = [];
            context.fourCutReconnectionCache.set(cacheKey, empty);
            return empty;
        }
        const candidates = [];
        for (const reconnection of enumerateSimpleFourCutReconnections(
            world, order, cuts, context.routeEdgeByKey, epsilon, stats)) {
            stats.generalizedReconnectionsEnumerated++;
            const deltaRaw = reconnection.deltaRaw;
            if (reconnection.addedEdges.some(([a, b]) => !pointRay(world, a, b))) {
                stats.generalizedMissingRayRejects++;
                continue;
            }
            let intersects = false;
            for (let first = 0; first < reconnection.addedEdges.length && !intersects; first++) {
                const [a, b] = reconnection.addedEdges[first];
                const aLoc = edgePosition(world, a);
                const bLoc = edgePosition(world, b);
                if (!aLoc || !bLoc) {
                    intersects = true;
                    break;
                }
                for (let second = first + 1; second < reconnection.addedEdges.length; second++) {
                    const [c, d] = reconnection.addedEdges[second];
                    if (a === c || a === d || b === c || b === d) continue;
                    const cLoc = edgePosition(world, c);
                    const dLoc = edgePosition(world, d);
                    if (!cLoc || !dLoc) {
                        intersects = true;
                        break;
                    }
                    if (segmentsIntersectCoords(
                        aLoc, bLoc, cLoc, dLoc)) {
                        intersects = true;
                        break;
                    }
                }
            }
            if (intersects) {
                stats.generalizedIntersectionRejects++;
                continue;
            }
            candidates.push(reconnection);
        }
        candidates.sort((left, right) => left.deltaRaw - right.deltaRaw
            || left.key.localeCompare(right.key, "en", { numeric: true }));
        context.fourCutReconnectionCache.set(cacheKey, candidates);
        return candidates;
    }

    function collectVisibleRouteEdgeIndices(world, context, sourceEdge, stats) {
        const memoized = context.visibleRouteEdgeCache.get(sourceEdge.index);
        if (memoized) return memoized;
        const candidateIndices = new Set();
        for (const endpointId of [sourceEdge.from, sourceEdge.to]) {
            const visibleList = world.totalNoktaList[endpointId]?.visibleList;
            if (!(visibleList instanceof Map)) continue;
            for (const visiblePointId of visibleList.keys()) {
                stats.visibleEntriesVisited++;
                const incidentEdges = context.pointRouteEdges[visiblePointId] || [];
                for (const edge of incidentEdges) {
                    if (edge.index !== sourceEdge.index) candidateIndices.add(edge.index);
                }
            }
        }
        const result = [...candidateIndices];
        context.visibleRouteEdgeCache.set(sourceEdge.index, result);
        return result;
    }

    /**
     * The broad visibility walk above only proves that at least one endpoint can
     * see a point incident to the counter edge.  A fixed first split needs both
     * cross rays.  Cache that exact, result-preserving filter once per source edge
     * so missing-ray pairs never enter the nested bridge search.
     */
    function collectFixedFirstCounterIndices(world, context, sourceEdge, stats) {
        const memoized = context.fixedFirstCounterCache.get(sourceEdge.index);
        if (memoized) return memoized;
        const result = [];
        for (const counterIndex of collectVisibleRouteEdgeIndices(world, context, sourceEdge, stats)) {
            const counterEdge = context.routeEdges[counterIndex];
            if (!counterEdge
                || !pointRay(world, counterEdge.from, sourceEdge.to)
                || !pointRay(world, sourceEdge.from, counterEdge.to)) {
                stats.firstBridgeRayPairPrefilterRejects++;
                continue;
            }
            result.push(counterIndex);
        }
        context.fixedFirstCounterCache.set(sourceEdge.index, result);
        return result;
    }

    function collectVisibleRouteEdgeIndicesByTree(world, context, sourceEdge, stats) {
        const memoized = context.visibleRouteEdgeTreeCache.get(sourceEdge.index);
        if (memoized) return memoized;
        const allIndices = collectVisibleRouteEdgeIndices(world, context, sourceEdge, stats);
        const byTreeId = new Map();
        for (const edgeIndex of allIndices) {
            const treeId = context.routeEdges[edgeIndex]?.treeId ?? -1;
            let treeIndices = byTreeId.get(treeId);
            if (!treeIndices) {
                treeIndices = [];
                byTreeId.set(treeId, treeIndices);
            }
            treeIndices.push(edgeIndex);
        }
        for (const [treeId, treeIndices] of byTreeId) {
            byTreeId.set(treeId, Object.freeze(treeIndices));
        }
        const result = Object.freeze({
            allCount: allIndices.length,
            byTreeId
        });
        context.visibleRouteEdgeTreeCache.set(sourceEdge.index, result);
        return result;
    }

    function edgePairFromIndices(context, indices) {
        return indices.map(index => {
            const edge = context.routeEdges[index];
            return [edge.from, edge.to];
        });
    }

    function secondCutDeltaLowerBound(world, context, pairKey, walkEdge, targetEdge, stats) {
        const cached = context.secondCutDeltaLowerBoundCache.get(pairKey);
        if (cached !== undefined) {
            stats.secondDeltaLowerBoundCacheHits++;
            return cached;
        }
        const points = world.totalNoktaList;
        const removedCost = routeEdgeLengthRaw(walkEdge.from, walkEdge.to, points)
            + routeEdgeLengthRaw(targetEdge.from, targetEdge.to, points);
        const parallelCost = routeEdgeLengthRaw(walkEdge.from, targetEdge.from, points)
            + routeEdgeLengthRaw(walkEdge.to, targetEdge.to, points);
        const crossedCost = routeEdgeLengthRaw(walkEdge.from, targetEdge.to, points)
            + routeEdgeLengthRaw(walkEdge.to, targetEdge.from, points);
        const result = Math.min(parallelCost, crossedCost) - removedCost;
        context.secondCutDeltaLowerBoundCache.set(pairKey, result);
        return result;
    }

    /**
     * Keep the legacy target order, but cache the exact lower bound for every
     * entry and the minimum of every remaining suffix.  If a suffix cannot beat
     * the first-bridge delta, none of its entries can reach fixed topology.  This
     * is the order-preserving counterpart of Geometric Repair's monotone breaks.
     */
    function secondTargetBoundSeries(world, context, walkEdge, treeId, targetIndices, stats) {
        const cacheKey = `${walkEdge.index}|${treeId}`;
        const cached = context.secondTargetBoundSeriesCache.get(cacheKey);
        if (cached) return cached;
        const bounds = targetIndices.map(targetIndex => secondCutDeltaLowerBound(
            world,
            context,
            walkEdge.index < targetIndex
                ? walkEdge.index * context.order.length + targetIndex
                : targetIndex * context.order.length + walkEdge.index,
            walkEdge,
            context.routeEdges[targetIndex],
            stats
        ));
        const suffixMin = new Array(bounds.length + 1).fill(Infinity);
        for (let index = bounds.length - 1; index >= 0; index--) {
            suffixMin[index] = Math.min(bounds[index], suffixMin[index + 1]);
        }
        const result = { bounds, suffixMin };
        context.secondTargetBoundSeriesCache.set(cacheKey, result);
        return result;
    }

    function buildOrderedRootTreeWalks(context, split, walkSides) {
        const walks = [];
        for (const side of walkSides) {
            for (const direction of [-1, 1]) {
                const baseWalk = getRootTreeWalk(context, side.firstCutIndex, direction);
                if (!Number.isInteger(baseWalk?.entryEdgeIndex)
                    || baseWalk.testEdgeIndices.length === 0) continue;
                const cycleId = split.cycleOfRouteEdge(baseWalk.entryEdgeIndex);
                if (cycleId < 0) continue;

                const segmentEdgeIndices = [];
                for (const edgeIndex of baseWalk.segmentEdgeIndices) {
                    if (split.cycleOfRouteEdge(edgeIndex) !== cycleId) break;
                    segmentEdgeIndices.push(edgeIndex);
                }
                if (segmentEdgeIndices.length <= 1) continue;

                walks.push(Object.freeze({
                    label: side.label,
                    sideRank: side.sideRank,
                    firstCutIndex: side.firstCutIndex,
                    direction,
                    regionId: side.regionId,
                    treeId: baseWalk.treeId,
                    k1PointId: baseWalk.k1PointId,
                    y1PointId: baseWalk.y1PointId,
                    entryEdgeIndex: baseWalk.entryEdgeIndex,
                    cycleId,
                    cyclePointCount: split.cyclePointCounts[cycleId],
                    treewardPreferred: side.treewardDirection === direction,
                    segmentEdgeIndices: Object.freeze(segmentEdgeIndices),
                    testEdgeIndices: Object.freeze(segmentEdgeIndices.slice(1))
                }));
            }
        }
        walks.sort((a, b) => {
            const aCycleRank = a.cycleId === split.shorterCycleId ? 0 : 1;
            const bCycleRank = b.cycleId === split.shorterCycleId ? 0 : 1;
            return aCycleRank - bCycleRank
                || a.segmentEdgeIndices.length - b.segmentEdgeIndices.length
                || Number(b.treewardPreferred) - Number(a.treewardPreferred)
                || a.sideRank - b.sideRank
                || a.direction - b.direction;
        });
        return walks;
    }

    function createSearchStats() {
        return {
            firstBridgeEdgesVisited: 0,
            firstCounterEdgesVisited: 0,
            firstBridgeCandidates: 0,
            firstBridgeRayPairPrefilterRejects: 0,
            firstBridgeMissingRayRejects: 0,
            firstBridgeExteriorRejects: 0,
            secondWalkSidesVisited: 0,
            secondWalkEdgesVisited: 0,
            secondTargetEdgesVisited: 0,
            secondBridgeCandidates: 0,
            secondBridgeMissingRayRejects: 0,
            secondBridgeInteriorRejects: 0,
            secondBridgeVirtualIntersectionRejects: 0,
            secondTargetTreeRejects: 0,
            secondWalkEdgeDuplicateRejects: 0,
            secondCutPairDuplicateRejects: 0,
            secondDeltaLowerBoundRejects: 0,
            secondDeltaSuffixBreaks: 0,
            secondDeltaSuffixPrunedTargets: 0,
            secondDeltaLowerBoundCacheHits: 0,
            secondFixedTopologyChecks: 0,
            generalizedFourCutChecks: 0,
            generalizedReconnectionsEnumerated: 0,
            generalizedFourCutCacheHits: 0,
            generalizedCutSetBoundRejects: 0,
            generalizedDuplicateRejects: 0,
            generalizedObjectiveRejects: 0,
            generalizedMissingRayRejects: 0,
            generalizedIntersectionRejects: 0,
            beamCandidatesRetained: 0,
            beamStateExpansions: 0,
            beamStatePrunes: 0,
            beamDuplicateStateRejects: 0,
            beamCandidatesRetired: 0,
            visibleEntriesVisited: 0,
            negativeDeltaCandidates: 0,
            transactionAttempts: 0,
            transactionRejects: 0,
            sourceRegionsVisited: 0,
            sourceRegionsWithCandidate: 0,
            regionCandidatesScanned: 0,
            candidatesExamined: 0,
            batchConflictRejects: 0,
            batchRejectReasons: {},
            existingRouteEdgeRejects: 0,
            arcCompatibilityChecks: 0,
            arcWalkSteps: 0,
            subtourRejects: 0,
            roundContextBuildCount: 0,
            visibilityReusedRoundCount: 0,
            objectOccRebuildCount: 0,
            worldCaptureCount: 0,
            worldCaptureObjectCount: 0
        };
    }

    function freezeCandidate(candidate) {
        const removedEdges = frozenEdges(candidate.removedEdges);
        const addedEdges = frozenEdges(candidate.addedEdges);
        return Object.freeze({
            ownerRegionId: candidate.ownerRegionId,
            ownerTreeId: candidate.ownerTreeId,
            sourceLeafTriangleId: candidate.sourceLeafTriangleId,
            firstBridge: Object.freeze({
                sourceEdge: frozenEdge(...candidate.firstBridge.sourceEdge),
                counterEdge: frozenEdge(...candidate.firstBridge.counterEdge),
                addedEdges: frozenEdges(candidate.firstBridge.addedEdges),
                regionA: candidate.firstBridge.regionA,
                regionB: candidate.firstBridge.regionB,
                exitAnchorA: candidate.firstBridge.exitAnchorA,
                exitAnchorB: candidate.firstBridge.exitAnchorB,
                cyclePointCounts: Object.freeze(candidate.firstBridge.cyclePointCounts.slice()),
                shorterCycleId: candidate.firstBridge.shorterCycleId
            }),
            secondBridge: Object.freeze({
                walkEdge: frozenEdge(...candidate.secondBridge.walkEdge),
                targetEdge: frozenEdge(...candidate.secondBridge.targetEdge),
                addedEdges: frozenEdges(candidate.secondBridge.addedEdges),
                walkSide: candidate.secondBridge.walkSide,
                walkMode: candidate.secondBridge.walkMode,
                walkCycleId: candidate.secondBridge.walkCycleId,
                walkCyclePointCount: candidate.secondBridge.walkCyclePointCount,
                rootTreeWalkEdgeCount: candidate.secondBridge.rootTreeWalkEdgeCount,
                treewardPreferred: candidate.secondBridge.treewardPreferred,
                pocketTreeId: candidate.secondBridge.pocketTreeId,
                walkRegionId: candidate.secondBridge.walkRegionId,
                targetRegionId: candidate.secondBridge.targetRegionId,
                direction: candidate.secondBridge.direction,
                k1PointId: candidate.secondBridge.k1PointId,
                y1PointId: candidate.secondBridge.y1PointId,
                entryEdgeIndex: candidate.secondBridge.entryEdgeIndex,
                detachedSegmentEdgeIndices: Object.freeze(candidate.secondBridge.detachedSegmentEdgeIndices.slice()),
                detachedSegmentEdges: frozenEdges(candidate.secondBridge.detachedSegmentEdges)
            }),
            removedEdges,
            addedEdges,
            removedEdgeKeys: Object.freeze(removedEdges.map(([a, b]) => edgeKey(a, b))),
            addedEdgeKeys: Object.freeze(addedEdges.map(([a, b]) => edgeKey(a, b))),
            immediateDelta: candidate.immediateDelta,
            reconnectionPolicy: candidate.reconnectionPolicy || "fixed",
            reconnectionRank: candidate.reconnectionRank ?? 0,
            reconnectionKey: candidate.reconnectionKey || edgeListKey(addedEdges),
            discoveryCutIndices: Object.freeze(candidate.discoveryCutIndices.slice()),
            discoveryOrderKey: candidate.discoveryOrderKey
        });
    }

    function buildCommonCandidate(context, details) {
        const detachedSegment = details.rootWalk.segmentEdgeIndices.slice(
            0, details.walkRank + 2);
        return {
            ownerRegionId: details.leaf.regionId,
            ownerTreeId: details.leaf.treeId,
            sourceLeafTriangleId: details.leaf.triangleId,
            firstBridge: {
                sourceEdge: [details.sourceEdge.from, details.sourceEdge.to],
                counterEdge: [details.counterEdge.from, details.counterEdge.to],
                addedEdges: details.split.addedEdges,
                regionA: details.regionA,
                regionB: details.regionB,
                exitAnchorA: details.leaf.exitAnchorTriangleId,
                exitAnchorB: context.regions.get(details.regionB)?.exitAnchorTriangleId ?? -1,
                cyclePointCounts: details.split.cyclePointCounts,
                shorterCycleId: details.split.shorterCycleId
            },
            secondBridge: {
                walkEdge: [details.walkEdge.from, details.walkEdge.to],
                targetEdge: [details.targetEdge.from, details.targetEdge.to],
                walkSide: details.rootWalk.label,
                walkMode: "root-tree",
                walkCycleId: details.rootWalk.cycleId,
                walkCyclePointCount: details.rootWalk.cyclePointCount,
                rootTreeWalkEdgeCount: details.rootWalk.segmentEdgeIndices.length,
                treewardPreferred: details.rootWalk.treewardPreferred,
                pocketTreeId: details.rootWalk.treeId,
                walkRegionId: details.rootWalk.regionId,
                targetRegionId: details.targetEdge.regionId,
                direction: details.rootWalk.direction,
                k1PointId: details.rootWalk.k1PointId,
                y1PointId: details.rootWalk.y1PointId,
                entryEdgeIndex: details.rootWalk.entryEdgeIndex,
                detachedSegmentEdgeIndices: detachedSegment,
                detachedSegmentEdges: edgePairFromIndices(context, detachedSegment)
            },
            discoveryCutIndices: details.discoveryCutIndices,
            discoveryOrderKey: [
                details.leafIndex,
                details.sourceRank,
                details.counterRank,
                details.walkOrderRank,
                details.walkRank,
                details.targetBucketRank,
                details.targetRank
            ].join(":")
        };
    }

    function* iterateBranchedDoubleBridgeCandidates(
        world,
        context,
        order,
        leaves,
        stats,
        epsilon,
        searchOptions = {}
    ) {
        const reconnectionPolicy = searchOptions.reconnectionPolicy ?? "fixed";
        const leafOrder = new Map(context.leaves.map((leaf, index) => [leaf, index]));
        const generalizedYieldedKeys = new Set();
        for (const leaf of leaves) {
            const leafIndex = leafOrder.get(leaf);
            for (let sourceRank = 0; sourceRank < leaf.bridgeTestEdges.length; sourceRank++) {
                const sourceEdge = leaf.bridgeTestEdges[sourceRank];
                stats.firstBridgeEdgesVisited++;
                const firstCounterIndices = reconnectionPolicy === "fixed"
                    ? collectFixedFirstCounterIndices(world, context, sourceEdge, stats)
                    : collectVisibleRouteEdgeIndices(world, context, sourceEdge, stats);
                for (let counterRank = 0; counterRank < firstCounterIndices.length; counterRank++) {
                    stats.firstCounterEdgesVisited++;
                    const counterCutIndex = firstCounterIndices[counterRank];
                    const counterEdge = context.routeEdges[counterCutIndex];
                    if (!counterEdge?.regionId || counterEdge.index === sourceEdge.index) continue;
                    if (isTriangleInLeafForbiddenCorridor(context, leaf, counterEdge.ownerTriangleId)) continue;
                    const regionA = leaf.regionId;
                    const regionB = counterEdge.regionId;
                    if (!regionA || regionA === regionB) continue;

                    let split;
                    try {
                        split = buildVirtualTwoCycle(order, sourceEdge.index, counterEdge.index);
                    } catch (_) {
                        continue;
                    }
                    if (reconnectionPolicy === "fixed") {
                        const firstRayState = edgesMatchInteriorState(world, context, split.addedEdges, true);
                        if (!firstRayState.matches) {
                            if (firstRayState.reason === "missing-ray") stats.firstBridgeMissingRayRejects++;
                            else stats.firstBridgeExteriorRejects++;
                            continue;
                        }
                    }
                    stats.firstBridgeCandidates++;

                    const walkSides = [
                        {
                            label: "source",
                            sideRank: 0,
                            firstCutIndex: sourceEdge.index,
                            regionId: regionA,
                            treewardDirection: getTreewardPocketWalk(
                                context,
                                sourceEdge.index,
                                regionA
                            )?.direction ?? null
                        },
                        {
                            label: "counter",
                            sideRank: 1,
                            firstCutIndex: counterEdge.index,
                            regionId: regionB,
                            treewardDirection: getTreewardPocketWalk(
                                context,
                                counterEdge.index,
                                regionB
                            )?.direction ?? null
                        }
                    ];
                    const rootWalks = buildOrderedRootTreeWalks(context, split, walkSides);
                    if (!rootWalks.length) continue;
                    const allowedTreeIds = new Set([sourceEdge.treeId, counterEdge.treeId]);
                    const testedWalkCutIndices = new Set();
                    const testedSecondCutPairs = new Set();
                    const firstBridgeCostDelta = split.addedEdges.reduce(
                        (sum, [a, b]) => sum + routeEdgeLengthRawCached(world, a, b),
                        0
                    ) - routeEdgeLengthRawCached(world, sourceEdge.from, sourceEdge.to)
                        - routeEdgeLengthRawCached(world, counterEdge.from, counterEdge.to);

                    for (let walkOrderRank = 0; walkOrderRank < rootWalks.length; walkOrderRank++) {
                        const rootWalk = rootWalks[walkOrderRank];
                        stats.secondWalkSidesVisited++;

                        for (let walkRank = 0; walkRank < rootWalk.testEdgeIndices.length; walkRank++) {
                            const walkCutIndex = rootWalk.testEdgeIndices[walkRank];
                            if (testedWalkCutIndices.has(walkCutIndex)) {
                                stats.secondWalkEdgeDuplicateRejects++;
                                continue;
                            }
                            testedWalkCutIndices.add(walkCutIndex);
                            stats.secondWalkEdgesVisited++;
                            const walkEdge = context.routeEdges[walkCutIndex];
                            const visibleByTree = collectVisibleRouteEdgeIndicesByTree(
                                world,
                                context,
                                walkEdge,
                                stats
                            );
                            const targetBuckets = [{
                                treeId: rootWalk.treeId,
                                indices: visibleByTree.byTreeId.get(rootWalk.treeId) || []
                            }];
                            for (const treeId of allowedTreeIds) {
                                if (treeId !== rootWalk.treeId) {
                                    targetBuckets.push({
                                        treeId,
                                        indices: visibleByTree.byTreeId.get(treeId) || []
                                    });
                                }
                            }
                            const allowedTargetCount = targetBuckets.reduce(
                                (sum, bucket) => sum + bucket.indices.length,
                                0
                            );
                            stats.secondTargetTreeRejects += visibleByTree.allCount - allowedTargetCount;

                            for (let targetBucketRank = 0; targetBucketRank < targetBuckets.length; targetBucketRank++) {
                                const targetBucket = targetBuckets[targetBucketRank];
                                const targetIndices = targetBucket.indices;
                                const boundSeries = reconnectionPolicy === "fixed"
                                    ? secondTargetBoundSeries(
                                        world,
                                        context,
                                        walkEdge,
                                        targetBucket.treeId,
                                        targetIndices,
                                        stats
                                    )
                                    : null;
                                for (let targetRank = 0; targetRank < targetIndices.length; targetRank++) {
                                    if (boundSeries
                                        && firstBridgeCostDelta + boundSeries.suffixMin[targetRank] >= -epsilon) {
                                        stats.secondDeltaSuffixBreaks++;
                                        stats.secondDeltaSuffixPrunedTargets += targetIndices.length - targetRank;
                                        break;
                                    }
                                    stats.secondTargetEdgesVisited++;
                                    const targetCutIndex = targetIndices[targetRank];
                                    const targetCycle = split.cycleOfRouteEdge(targetCutIndex);
                                    if (targetCycle < 0 || rootWalk.cycleId === targetCycle) continue;
                                    const targetEdge = context.routeEdges[targetCutIndex];
                                    const secondCutPairKey = walkCutIndex < targetCutIndex
                                        ? walkCutIndex * order.length + targetCutIndex
                                        : targetCutIndex * order.length + walkCutIndex;
                                    if (testedSecondCutPairs.has(secondCutPairKey)) {
                                        stats.secondCutPairDuplicateRejects++;
                                        continue;
                                    }
                                    testedSecondCutPairs.add(secondCutPairKey);
                                    stats.secondBridgeCandidates++;
                                    if (reconnectionPolicy === "all-simple") {
                                        const discoveryCutIndices = [
                                            sourceEdge.index,
                                            counterEdge.index,
                                            walkCutIndex,
                                            targetCutIndex
                                        ];
                                        stats.generalizedFourCutChecks++;
                                        const reconnections = generalizedFourCutCandidates(
                                            world,
                                            context,
                                            order,
                                            discoveryCutIndices,
                                            stats,
                                            epsilon
                                        );
                                        if (!reconnections.length) continue;
                                        const commonCandidate = buildCommonCandidate(context, {
                                            leaf,
                                            leafIndex,
                                            sourceEdge,
                                            sourceRank,
                                            counterEdge,
                                            counterRank,
                                            split,
                                            regionA,
                                            regionB,
                                            rootWalk,
                                            walkOrderRank,
                                            walkRank,
                                            walkEdge,
                                            targetEdge,
                                            targetBucketRank,
                                            targetRank,
                                            discoveryCutIndices
                                        });
                                        const cutSetKey = discoveryCutIndices
                                            .slice()
                                            .sort((left, right) => left - right)
                                            .join(":");
                                        for (let reconnectionRank = 0;
                                            reconnectionRank < reconnections.length;
                                            reconnectionRank++) {
                                            const reconnection = reconnections[reconnectionRank];
                                            const yieldKey = `${leaf.regionId}|${cutSetKey}|${reconnection.key}`;
                                            if (generalizedYieldedKeys.has(yieldKey)) {
                                                stats.generalizedDuplicateRejects++;
                                                continue;
                                            }
                                            generalizedYieldedKeys.add(yieldKey);
                                            stats.negativeDeltaCandidates++;
                                            stats.regionCandidatesScanned++;
                                            yield freezeCandidate({
                                                ...commonCandidate,
                                                secondBridge: {
                                                    ...commonCandidate.secondBridge,
                                                    addedEdges: reconnection.addedEdges
                                                },
                                                removedEdges: reconnection.removedEdges,
                                                addedEdges: reconnection.addedEdges,
                                                immediateDelta: reconnection.deltaRaw,
                                                reconnectionPolicy,
                                                reconnectionRank,
                                                reconnectionKey: reconnection.key,
                                                discoveryOrderKey: `${commonCandidate.discoveryOrderKey}:g${reconnectionRank}`
                                            });
                                        }
                                        continue;
                                    }

                                    const secondDeltaBound = boundSeries
                                        ? boundSeries.bounds[targetRank]
                                        : secondCutDeltaLowerBound(
                                            world,
                                            context,
                                            secondCutPairKey,
                                            walkEdge,
                                            targetEdge,
                                            stats
                                        );
                                    if (!(firstBridgeCostDelta + secondDeltaBound < -epsilon)) {
                                        stats.secondDeltaLowerBoundRejects++;
                                        continue;
                                    }
                                    stats.secondFixedTopologyChecks++;

                                    let fixedEdges;
                                    try {
                                        fixedEdges = fixedDoubleBridgeEdges(order, [
                                            sourceEdge.index,
                                            counterEdge.index,
                                            walkCutIndex,
                                            targetCutIndex
                                        ]);
                                    } catch (_) {
                                        continue;
                                    }
                                    if (split.addedEdges.some(
                                        ([a, b]) => !fixedEdges.addedEdges.some(
                                            ([c, d]) => edgeKey(a, b) === edgeKey(c, d))
                                    )) continue;
                                    const reconnectEdges = extractSecondAddedEdges(
                                        fixedEdges.addedEdges,
                                        split.addedEdges
                                    );
                                    if (reconnectEdges.length !== 2) continue;
                                    const cachedDelta = fourEdgeDeltaRawCached(
                                        world,
                                        fixedEdges.removedEdges,
                                        fixedEdges.addedEdges
                                    );
                                    if (!(cachedDelta < -epsilon)) continue;
                                    const secondRayState = edgesMatchInteriorState(
                                        world,
                                        context,
                                        reconnectEdges,
                                        false
                                    );
                                    if (!secondRayState.matches) {
                                        if (secondRayState.reason === "missing-ray") {
                                            stats.secondBridgeMissingRayRejects++;
                                        } else {
                                            stats.secondBridgeInteriorRejects++;
                                        }
                                        continue;
                                    }
                                    if (secondBridgeIntersectsFirst(
                                        world,
                                        reconnectEdges,
                                        split.addedEdges
                                    )) {
                                        stats.secondBridgeVirtualIntersectionRejects++;
                                        continue;
                                    }
                                    stats.negativeDeltaCandidates++;
                                    stats.regionCandidatesScanned++;

                                    const discoveryCutIndices = [
                                        sourceEdge.index,
                                        counterEdge.index,
                                        walkCutIndex,
                                        targetCutIndex
                                    ];
                                    const commonCandidate = buildCommonCandidate(context, {
                                        leaf,
                                        leafIndex,
                                        sourceEdge,
                                        sourceRank,
                                        counterEdge,
                                        counterRank,
                                        split,
                                        regionA,
                                        regionB,
                                        rootWalk,
                                        walkOrderRank,
                                        walkRank,
                                        walkEdge,
                                        targetEdge,
                                        targetBucketRank,
                                        targetRank,
                                        discoveryCutIndices
                                    });
                                    yield freezeCandidate({
                                        ...commonCandidate,
                                        secondBridge: {
                                            ...commonCandidate.secondBridge,
                                            addedEdges: reconnectEdges,
                                        },
                                        removedEdges: fixedEdges.removedEdges,
                                        addedEdges: fixedEdges.addedEdges,
                                        immediateDelta: cachedDelta,
                                        reconnectionPolicy: "fixed"
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    function summarizeCandidate(candidate) {
        // Under "all-simple" the four cuts are reconnected as one unit, so the
        // virtual split edges that guided discovery are not necessarily committed.
        // Report them as what they are instead of listing them as added edges.
        const generalized = candidate.reconnectionPolicy === "all-simple";
        return {
            reconnectionPolicy: candidate.reconnectionPolicy,
            reconnectionKey: candidate.reconnectionKey,
            firstBridge: {
                cuts: candidate.discoveryCutIndices.slice(0, 2),
                cutEdges: [candidate.firstBridge.sourceEdge.slice(), candidate.firstBridge.counterEdge.slice()],
                addedEdges: generalized
                    ? []
                    : candidate.firstBridge.addedEdges.map(edge => edge.slice()),
                virtualSplitEdges: candidate.firstBridge.addedEdges.map(edge => edge.slice()),
                regionA: candidate.firstBridge.regionA,
                regionB: candidate.firstBridge.regionB,
                exitAnchorA: candidate.firstBridge.exitAnchorA,
                exitAnchorB: candidate.firstBridge.exitAnchorB,
                cyclePointCounts: candidate.firstBridge.cyclePointCounts.slice(),
                shorterCycleId: candidate.firstBridge.shorterCycleId
            },
            secondBridge: {
                cuts: candidate.discoveryCutIndices.slice(2),
                cutEdges: [candidate.secondBridge.walkEdge.slice(), candidate.secondBridge.targetEdge.slice()],
                addedEdges: candidate.secondBridge.addedEdges.map(edge => edge.slice()),
                walkSide: candidate.secondBridge.walkSide,
                walkMode: candidate.secondBridge.walkMode,
                walkCycleId: candidate.secondBridge.walkCycleId,
                walkCyclePointCount: candidate.secondBridge.walkCyclePointCount,
                rootTreeWalkEdgeCount: candidate.secondBridge.rootTreeWalkEdgeCount,
                treewardPreferred: candidate.secondBridge.treewardPreferred,
                pocketTreeId: candidate.secondBridge.pocketTreeId,
                walkRegionId: candidate.secondBridge.walkRegionId,
                targetRegionId: candidate.secondBridge.targetRegionId,
                k1PointId: candidate.secondBridge.k1PointId,
                y1PointId: candidate.secondBridge.y1PointId,
                direction: candidate.secondBridge.direction,
                entryEdgeIndex: candidate.secondBridge.entryEdgeIndex,
                detachedSegmentEdgeIndices: candidate.secondBridge.detachedSegmentEdgeIndices.slice(),
                detachedSegmentEdges: candidate.secondBridge.detachedSegmentEdges.map(edge => edge.slice())
            }
        };
    }

    function makeBaseReport(
        context,
        initialLength,
        finalLength,
        initialTsplibLength,
        finalTsplibLength,
        stats,
        timings,
        rejectedTransactionCount,
        lastRejectedReason,
        visibilityRebuildCount,
        visibilityReusedFromKopt
    ) {
        return {
            distanceMetric: "EUCLIDEAN_RAW",
            initialLength,
            finalLength,
            improvement: initialLength - finalLength,
            tsplibDistanceMetric: "TSPLIB_EUC_2D",
            initialTsplibLength,
            finalTsplibLength,
            tsplibImprovement: initialTsplibLength - finalTsplibLength,
            rootTreeCount: context.forest.pockets.length,
            regionCount: context.regions.size,
            leafCount: context.leaves.length,
            bridgeTestEdgeCount: context.leaves.reduce((sum, leaf) => sum + leaf.bridgeTestEdges.length, 0),
            rejectedTransactionCount,
            lastRejectedReason,
            visibilityRebuildCount,
            visibilityReusedFromKopt,
            stats,
            timings
        };
    }

    function prepareRound(world, options, stats, timings) {
        const startPoint = options.startPoint || world.totalNoktaList[options.startNodeId ?? 4];
        if (!startPoint) throw new RangeError("A current route start point is required");
        const order = tourOrderFromBags(startPoint, world);
        const initialLength = Number.isFinite(options.initialLength)
            ? options.initialLength
            : tourLengthRaw(order, world.totalNoktaList);
        const initialTsplibLength = Number.isFinite(options.initialTsplibLength)
            ? options.initialTsplibLength
            : tourLength(order, world.totalNoktaList);
        const visibilityReusedFromKopt = options.visibilityPrepared === true;
        if (visibilityReusedFromKopt) {
            timings.objectOccMs = 0;
            stats.visibilityReusedRoundCount++;
        } else {
            measured(timings, "objectOccMs", () => objectOcc(world));
            stats.objectOccRebuildCount++;
        }
        const visibilityRebuildCount = visibilityReusedFromKopt ? 0 : 1;
        stats.roundContextBuildCount++;
        const context = measured(timings, "roundContextMs", () => buildBranchedBridgeRoundContext(world, order));
        world.pocketTreeOverlay = buildPocketTreeOverlay(world, context);
        return {
            startPoint,
            order,
            initialLength,
            initialTsplibLength,
            visibilityReusedFromKopt,
            visibilityRebuildCount,
            context
        };
    }

    function reconnectionPolicyFromOptions(options) {
        const policy = options.reconnectionPolicy ?? "fixed";
        if (policy !== "fixed" && policy !== "all-simple") {
            throw new RangeError('reconnectionPolicy must be "fixed" or "all-simple"');
        }
        return policy;
    }

    function optimizeBranchedDoubleBridge(world, options = {}) {
        if (!world?.totalNoktaList?.length) throw new TypeError("A populated world is required");
        const epsilon = Number.isFinite(options.epsilon) ? options.epsilon : DEFAULT_IMPROVEMENT_EPSILON;
        const reconnectionPolicy = reconnectionPolicyFromOptions(options);
        const timings = {};
        const stats = createSearchStats();
        const round = prepareRound(world, options, stats, timings);
        let rejectedTransactionCount = 0;
        let lastRejectedReason = null;
        const searchStart = now();
        const candidates = iterateBranchedDoubleBridgeCandidates(
            world,
            round.context,
            round.order,
            round.context.leaves,
            stats,
            epsilon,
            { reconnectionPolicy }
        );

        for (const candidate of candidates) {
            let patch;
            try {
                if (reconnectionPolicy === "fixed") {
                    patch = buildBranchedRoutePatchRaw(
                        round.order,
                        candidate.discoveryCutIndices.slice(0, 2),
                        candidate.discoveryCutIndices.slice(2),
                        world.totalNoktaList,
                        epsilon
                    );
                } else {
                    const singleBatch = createBatchAccumulator(round.order);
                    const compatibility = checkBatchCompatibility(
                        world, round.order, singleBatch, candidate, stats);
                    if (!compatibility.compatible) continue;
                    addCandidateToBatch(singleBatch, candidate, compatibility.arcState);
                    patch = buildBatchedBranchedRoutePatchRaw(
                        round.order, singleBatch, world, epsilon);
                }
            } catch (_) {
                continue;
            }
            if (Math.abs(patch.immediateDelta - candidate.immediateDelta) > Math.max(epsilon, 1e-9)) {
                throw new Error("Cached branched delta does not match the fixed route patch");
            }
            stats.transactionAttempts++;
            const transactionStart = now();
            const transactionFunction = reconnectionPolicy === "fixed"
                ? applyRoutePatchTransaction
                : applyTourDiffTransaction;
            const transaction = transactionFunction(world, patch, {
                ...(options.transactionOptions || {}),
                materializeMissingEdges: true,
                polygonNo: options.polygonNo ?? 0
            });
            timings.transactionMs = (timings.transactionMs || 0) + now() - transactionStart;
            if (!transaction.committed) {
                stats.transactionRejects++;
                rejectedTransactionCount++;
                lastRejectedReason = transaction.error?.message || "transaction rejected";
                continue;
            }

            timings.searchMs = Math.max(0, now() - searchStart - (timings.transactionMs || 0));
            const finalOrder = tourOrderFromBags(round.startPoint.noktaNo, world);
            const finalLength = tourLengthRaw(finalOrder, world.totalNoktaList);
            const finalTsplibLength = tourLength(finalOrder, world.totalNoktaList);
            const bridges = summarizeCandidate(candidate);
            resetObjectOccState(world);
            world.pocketTreeOverlay = null;
            const report = {
                status: "committed",
                committed: true,
                ...makeBaseReport(
                    round.context,
                    round.initialLength,
                    finalLength,
                    round.initialTsplibLength,
                    finalTsplibLength,
                    stats,
                    timings,
                    rejectedTransactionCount,
                    lastRejectedReason,
                    round.visibilityRebuildCount,
                    round.visibilityReusedFromKopt
                ),
                immediateDelta: patch.immediateDelta,
                tsplibImmediateDelta: patch.tsplibImmediateDelta,
                removedEdges: patch.removedEdges.map(edge => edge.slice()),
                addedEdges: patch.addedEdges.map(edge => edge.slice()),
                visibilityInvalidatedAfterCommit: true,
                reconnectionPolicy,
                ...bridges
            };
            world.lastDoubleBridgeReport = report;
            if (options.log !== false && typeof console !== "undefined") console.table(report.timings);
            return report;
        }

        timings.searchMs = Math.max(0, now() - searchStart - (timings.transactionMs || 0));
        const finalOrder = tourOrderFromBags(round.startPoint.noktaNo, world);
        const finalLength = tourLengthRaw(finalOrder, world.totalNoktaList);
        const finalTsplibLength = tourLength(finalOrder, world.totalNoktaList);
        const report = {
            status: "no-improvement",
            committed: false,
            ...makeBaseReport(
                round.context,
                round.initialLength,
                finalLength,
                round.initialTsplibLength,
                finalTsplibLength,
                stats,
                timings,
                rejectedTransactionCount,
                lastRejectedReason,
                round.visibilityRebuildCount,
                round.visibilityReusedFromKopt
            ),
            visibilityInvalidatedAfterCommit: false,
            reconnectionPolicy,
            firstBridge: null,
            secondBridge: null,
            removedEdges: null,
            addedEdges: null
        };
        world.lastDoubleBridgeReport = report;
        if (options.log !== false && typeof console !== "undefined") console.table(report.timings);
        return report;
    }

    function groupLeavesByRegion(leaves) {
        const groups = [];
        const groupById = new Map();
        for (const leaf of leaves) {
            if (!leaf.regionId) continue;
            let group = groupById.get(leaf.regionId);
            if (!group) {
                group = { regionId: leaf.regionId, leaves: [] };
                groupById.set(leaf.regionId, group);
                groups.push(group);
            }
            group.leaves.push(leaf);
        }
        return groups;
    }

    function createBatchAccumulator(order) {
        const baseRouteEdgeMap = new Map();
        for (let index = 0; index < order.length; index++) {
            const pair = [order[index], order[(index + 1) % order.length]];
            baseRouteEdgeMap.set(edgeKey(...pair), { index, pair });
        }
        return {
            candidates: [],
            ownerRegionIds: new Set(),
            removedEdgeOwners: new Map(),
            addedEdgeOwners: new Map(),
            removedEdges: new Map(),
            addedEdges: new Map(),
            delta: 0,
            candidateDeltaSum: 0,
            baseRouteEdgeMap,
            arcState: null,
            candidateEdgeOwners: null
        };
    }

    function addedEdgesIntersect(world, candidate, batch) {
        for (const [a, b] of candidate.addedEdges) {
            const aLoc = edgePosition(world, a);
            const bLoc = edgePosition(world, b);
            if (!aLoc || !bLoc) return true;
            for (const [c, d] of batch.addedEdges.values()) {
                if (a === c || a === d || b === c || b === d) continue;
                const cLoc = edgePosition(world, c);
                const dLoc = edgePosition(world, d);
                if (!cLoc || !dLoc || segmentsIntersectCoords(aLoc, bLoc, cLoc, dLoc)) return true;
            }
        }
        return false;
    }

    function validateCompactArcCycle(order, removedEdges, addedEdges, baseRouteEdgeMap, stats) {
        stats.arcCompatibilityChecks++;
        const cuts = [];
        for (const [key] of removedEdges) {
            const base = baseRouteEdgeMap.get(key);
            if (!base) return { valid: false, reason: "non-route-removed-edge" };
            cuts.push(base.index);
        }
        cuts.sort((a, b) => a - b);
        if (!cuts.length) return { valid: false, reason: "empty-cut-set" };

        // Removing k cycle edges creates exactly k unchanged route arcs.  Their
        // interiors can never affect reconnection validity, so represent an arc
        // only by its two open ports; do not walk all n polygon points per batch
        // candidate.  This is the same contracted-topology argument used by
        // Geometric Repair.
        const componentByPort = new Map();
        const requiredAddedDegree = new Map();
        const components = [];
        for (let componentId = 0; componentId < cuts.length; componentId++) {
            const startIndex = (cuts[componentId] + 1) % order.length;
            const endIndex = cuts[(componentId + 1) % cuts.length];
            const startPoint = order[startIndex];
            const endPoint = order[endIndex];
            for (const pointId of [startPoint, endPoint]) {
                const existing = componentByPort.get(pointId);
                if (existing !== undefined && existing !== componentId) {
                    return { valid: false, reason: "overlapping-arc-ports" };
                }
                componentByPort.set(pointId, componentId);
                requiredAddedDegree.set(pointId, (requiredAddedDegree.get(pointId) || 0) + 1);
            }
            components.push({ id: componentId, startPoint, endPoint });
        }

        const actualAddedDegree = new Map();
        const componentAdjacency = Array.from({ length: components.length }, () => []);
        const componentDegree = new Array(components.length).fill(0);
        for (const [a, b] of addedEdges.values()) {
            if (!requiredAddedDegree.has(a) || !requiredAddedDegree.has(b)) {
                return { valid: false, reason: "added-edge-does-not-use-open-port" };
            }
            actualAddedDegree.set(a, (actualAddedDegree.get(a) || 0) + 1);
            actualAddedDegree.set(b, (actualAddedDegree.get(b) || 0) + 1);
            const left = componentByPort.get(a);
            const right = componentByPort.get(b);
            componentAdjacency[left].push(right);
            componentAdjacency[right].push(left);
            componentDegree[left]++;
            componentDegree[right]++;
        }
        for (const [pointId, required] of requiredAddedDegree) {
            if ((actualAddedDegree.get(pointId) || 0) !== required) {
                return { valid: false, reason: "arc-port-degree" };
            }
        }
        if (componentDegree.some(degree => degree !== 2)) {
            return { valid: false, reason: "contracted-arc-degree" };
        }

        const visited = new Set([0]);
        const pending = [0];
        while (pending.length) {
            const current = pending.pop();
            stats.arcWalkSteps++;
            for (const next of componentAdjacency[current]) {
                if (!visited.has(next)) {
                    visited.add(next);
                    pending.push(next);
                }
            }
        }
        if (visited.size !== components.length) {
            stats.subtourRejects++;
            return { valid: false, reason: "premature-subtour" };
        }
        return { valid: true, cuts, componentCount: components.length };
    }

    function checkBatchCompatibility(world, order, batch, candidate, stats) {
        stats.candidatesExamined++;
        if (batch.ownerRegionIds.has(candidate.ownerRegionId)) {
            return { compatible: false, reason: "owner-region-selected" };
        }
        const candidateRemovedKeys = candidate.removedEdgeKeys
            || candidate.removedEdges.map(([a, b]) => edgeKey(a, b));
        const candidateAddedKeys = candidate.addedEdgeKeys
            || candidate.addedEdges.map(([a, b]) => edgeKey(a, b));
        for (const key of candidateRemovedKeys) {
            if (batch.removedEdges.has(key) || batch.addedEdges.has(key)) {
                return { compatible: false, reason: "removed-edge-conflict" };
            }
        }
        for (const key of candidateAddedKeys) {
            if (batch.addedEdges.has(key) || batch.removedEdges.has(key)) {
                return { compatible: false, reason: "added-edge-conflict" };
            }
        }
        for (const key of candidateAddedKeys) {
            if (batch.baseRouteEdgeMap.has(key)
                && !batch.removedEdges.has(key)
                && !candidateRemovedKeys.includes(key)) {
                stats.existingRouteEdgeRejects++;
                return { compatible: false, reason: "existing-route-edge" };
            }
        }
        if (addedEdgesIntersect(world, candidate, batch)) {
            return { compatible: false, reason: "added-edge-intersection" };
        }

        const provisionalRemoved = new Map(batch.removedEdges);
        const provisionalAdded = new Map(batch.addedEdges);
        candidate.removedEdges.forEach(edge => provisionalRemoved.set(edgeKey(...edge), edge));
        candidate.addedEdges.forEach(edge => provisionalAdded.set(edgeKey(...edge), edge));
        const degree = new Map();
        for (const [a, b] of provisionalRemoved.values()) {
            degree.set(a, (degree.get(a) ?? 2) - 1);
            degree.set(b, (degree.get(b) ?? 2) - 1);
        }
        for (const [a, b] of provisionalAdded.values()) {
            degree.set(a, (degree.get(a) ?? 2) + 1);
            degree.set(b, (degree.get(b) ?? 2) + 1);
        }
        if ([...degree.values()].some(value => value !== 2)) {
            return { compatible: false, reason: "final-degree" };
        }
        const arcState = validateCompactArcCycle(
            order,
            provisionalRemoved,
            provisionalAdded,
            batch.baseRouteEdgeMap,
            stats
        );
        if (!arcState.valid) return { compatible: false, reason: arcState.reason };
        return { compatible: true, arcState };
    }

    function addCandidateToBatch(batch, candidate, arcState) {
        batch.candidates.push(candidate);
        batch.ownerRegionIds.add(candidate.ownerRegionId);
        for (const edge of candidate.removedEdges) {
            const key = edgeKey(...edge);
            batch.removedEdges.set(key, edge);
            batch.removedEdgeOwners.set(key, candidate.ownerRegionId);
        }
        for (const edge of candidate.addedEdges) {
            const key = edgeKey(...edge);
            batch.addedEdges.set(key, edge);
            batch.addedEdgeOwners.set(key, candidate.ownerRegionId);
        }
        batch.delta += candidate.immediateDelta;
        batch.candidateDeltaSum += candidate.immediateDelta;
        batch.arcState = arcState;
        batch.candidateEdgeOwners = {
            removed: batch.removedEdgeOwners,
            added: batch.addedEdgeOwners
        };
    }

    function rebuildBatch(order, candidates, world, stats) {
        const rebuilt = createBatchAccumulator(order);
        for (const candidate of candidates) {
            const result = checkBatchCompatibility(world, order, rebuilt, candidate, stats);
            if (!result.compatible) throw new Error(`Previously accepted batch candidate became incompatible: ${result.reason}`);
            addCandidateToBatch(rebuilt, candidate, result.arcState);
        }
        return rebuilt;
    }

    function noteCompatibilityReject(stats, result) {
        stats.batchConflictRejects++;
        stats.batchRejectReasons[result.reason] = (stats.batchRejectReasons[result.reason] || 0) + 1;
        return result;
    }

    function selectCandidateFromIterator(state, world, order, batch, stats, regionSelection) {
        let best = null;
        let bestArcState = null;
        while (true) {
            const step = state.iterator.next();
            if (step.done) {
                state.exhausted = true;
                break;
            }
            const candidate = step.value;
            const result = checkBatchCompatibility(world, order, batch, candidate, stats);
            if (!result.compatible) {
                state.rejectedCandidateCount++;
                noteCompatibilityReject(stats, result);
                continue;
            }
            if (regionSelection === "first") return { candidate, arcState: result.arcState };
            if (!best || candidate.immediateDelta < best.immediateDelta) {
                best = candidate;
                bestArcState = result.arcState;
            }
        }
        return best ? { candidate: best, arcState: bestArcState } : null;
    }

    function compareCandidates(left, right) {
        return left.immediateDelta - right.immediateDelta
            || left.discoveryOrderKey.localeCompare(
                right.discoveryOrderKey, "en", { numeric: true });
    }

    function collectBoundedRegionCandidates(state, limit, stats) {
        const retained = [];
        while (true) {
            const step = state.iterator.next();
            if (step.done) {
                state.exhausted = true;
                break;
            }
            const candidate = step.value;
            if (retained.length < limit) {
                retained.push(candidate);
                retained.sort(compareCandidates);
            } else if (compareCandidates(candidate, retained[retained.length - 1]) < 0) {
                retained[retained.length - 1] = candidate;
                retained.sort(compareCandidates);
            }
        }
        stats.beamCandidatesRetained += retained.length;
        return retained;
    }

    function cloneBatchAccumulator(batch) {
        const clone = {
            candidates: batch.candidates.slice(),
            ownerRegionIds: new Set(batch.ownerRegionIds),
            removedEdgeOwners: new Map(batch.removedEdgeOwners),
            addedEdgeOwners: new Map(batch.addedEdgeOwners),
            removedEdges: new Map(batch.removedEdges),
            addedEdges: new Map(batch.addedEdges),
            delta: batch.delta,
            candidateDeltaSum: batch.candidateDeltaSum,
            baseRouteEdgeMap: batch.baseRouteEdgeMap,
            arcState: batch.arcState,
            candidateEdgeOwners: null
        };
        if (clone.candidates.length) {
            clone.candidateEdgeOwners = {
                removed: clone.removedEdgeOwners,
                added: clone.addedEdgeOwners
            };
        }
        return clone;
    }

    function batchStateKey(batch) {
        return batch.candidates.map(candidate => candidate.discoveryOrderKey).join("|");
    }

    function compareBatchStates(left, right) {
        return left.delta - right.delta
            || right.candidates.length - left.candidates.length
            || batchStateKey(left).localeCompare(batchStateKey(right), "en", { numeric: true });
    }

    /**
     * Keep only beamWidth compatible partial batches after each owner region.
     * Each region contributes at most regionCandidateLimit candidates, making the
     * combinatorial selector explicitly bounded and deterministic.  A skip branch
     * is always retained as a possible expansion, so an early local move cannot
     * force every later region out of the batch.
     */
    function selectBatchWithBeam(world, order, regionPools, stats, beamWidth) {
        let beam = [createBatchAccumulator(order)];
        for (const pool of regionPools) {
            const expanded = beam.slice();
            for (const partial of beam) {
                for (const candidate of pool.candidates) {
                    stats.beamStateExpansions++;
                    const compatibility = checkBatchCompatibility(
                        world, order, partial, candidate, stats);
                    if (!compatibility.compatible) {
                        noteCompatibilityReject(stats, compatibility);
                        continue;
                    }
                    const next = cloneBatchAccumulator(partial);
                    addCandidateToBatch(next, candidate, compatibility.arcState);
                    expanded.push(next);
                }
            }
            expanded.sort(compareBatchStates);
            const unique = [];
            const seen = new Set();
            for (const candidateBatch of expanded) {
                const key = batchStateKey(candidateBatch);
                if (seen.has(key)) {
                    stats.beamDuplicateStateRejects++;
                    continue;
                }
                seen.add(key);
                unique.push(candidateBatch);
                if (unique.length === beamWidth) break;
            }
            stats.beamStatePrunes += Math.max(0, expanded.length - unique.length);
            beam = unique;
        }
        beam.sort(compareBatchStates);
        return beam[0] || createBatchAccumulator(order);
    }

    /**
     * Drop the candidate a rejected transaction was blamed on from its region pool.
     * Every retry must retire at least one pooled candidate, otherwise the retry
     * loop could rebuild the same batch forever; when the blamed candidate cannot
     * be identified the whole pool is retired instead.
     */
    function retireBeamCandidate(regionPools, batch, rejectedOwner, stats) {
        const pool = regionPools.find(entry => entry.regionId === rejectedOwner);
        const blamed = pool && batch.candidates.find(
            candidate => candidate.ownerRegionId === rejectedOwner);
        if (blamed && pool.candidates.includes(blamed)) {
            pool.candidates = pool.candidates.filter(candidate => candidate !== blamed);
            stats.beamCandidatesRetired++;
            return;
        }
        const fallback = (pool && pool.candidates.length ? pool : null)
            || regionPools.find(entry => entry.candidates.length);
        if (!fallback) return;
        stats.beamCandidatesRetired += fallback.candidates.length;
        fallback.candidates = [];
    }

    function ownerForTransactionError(batch, error) {
        if (Array.isArray(error?.bridgeEdge)) {
            const owner = batch.addedEdgeOwners.get(edgeKey(...error.bridgeEdge));
            if (owner) return owner;
        }
        const involvedOwners = new Set();
        for (const edge of [error?.bridgeEdge, error?.blockingEdge]) {
            if (!Array.isArray(edge)) continue;
            const key = edgeKey(...edge);
            const owner = batch.addedEdgeOwners.get(key) || batch.removedEdgeOwners.get(key);
            if (owner) involvedOwners.add(owner);
        }
        if (involvedOwners.size > 1) {
            for (let index = batch.candidates.length - 1; index >= 0; index--) {
                if (involvedOwners.has(batch.candidates[index].ownerRegionId)) {
                    return batch.candidates[index].ownerRegionId;
                }
            }
        }
        return batch.candidates[batch.candidates.length - 1]?.ownerRegionId || null;
    }

    function makeBatchReport(round, batch, stats, timings, details) {
        const committed = details.committed === true;
        const delta = committed ? details.patch.immediateDelta : 0;
        const tsplibDelta = committed ? details.patch.tsplibImmediateDelta : 0;
        const finalLength = round.initialLength + delta;
        const finalTsplibLength = round.initialTsplibLength + tsplibDelta;
        return {
            status: committed ? "committed" : "no-improvement",
            committed,
            distanceMetric: "EUCLIDEAN_RAW",
            initialLength: round.initialLength,
            finalLength,
            improvement: round.initialLength - finalLength,
            tsplibDistanceMetric: "TSPLIB_EUC_2D",
            initialTsplibLength: round.initialTsplibLength,
            finalTsplibLength,
            tsplibImprovement: round.initialTsplibLength - finalTsplibLength,
            tsplibImmediateDelta: tsplibDelta,
            immediateDelta: delta,
            batchDelta: delta,
            candidateDeltaSum: committed ? details.patch.candidateDeltaSum : 0,
            candidateCount: details.candidateCount,
            committedCount: committed ? batch.candidates.length : 0,
            rejectedCandidateCount: details.rejectedCandidateCount,
            transactionAttempts: stats.transactionAttempts,
            transactionRejects: stats.transactionRejects,
            worldCaptureCount: stats.worldCaptureCount,
            worldCaptureObjectCount: stats.worldCaptureObjectCount,
            regionSelection: details.regionSelection,
            batchSelection: details.batchSelection,
            reconnectionPolicy: details.reconnectionPolicy,
            beamWidth: details.beamWidth,
            regionCandidateLimit: details.regionCandidateLimit,
            visibilityReusedFromKopt: round.visibilityReusedFromKopt,
            visibilityRebuildCount: round.visibilityRebuildCount,
            visibilityInvalidatedAfterCommit: committed,
            rootTreeCount: round.context.forest.pockets.length,
            regionCount: round.context.regions.size,
            leafCount: round.context.leaves.length,
            candidates: committed ? batch.candidates.map(candidate => candidate) : [],
            removedEdges: committed ? details.patch.removedEdges.map(edge => edge.slice()) : [],
            addedEdges: committed ? details.patch.addedEdges.map(edge => edge.slice()) : [],
            lastRejectedReason: details.lastRejectedReason,
            stats,
            timings
        };
    }

    function optimizeBranchedDoubleBridgeBatch(world, options = {}) {
        if (!world?.totalNoktaList?.length) throw new TypeError("A populated world is required");
        const epsilon = Number.isFinite(options.epsilon) ? options.epsilon : DEFAULT_IMPROVEMENT_EPSILON;
        const regionSelection = options.regionSelection ?? "first";
        if (regionSelection !== "first" && regionSelection !== "best") {
            throw new RangeError('regionSelection must be "first" or "best"');
        }
        const reconnectionPolicy = reconnectionPolicyFromOptions(options);
        const batchSelection = options.batchSelection ?? "greedy";
        if (batchSelection !== "greedy" && batchSelection !== "beam") {
            throw new RangeError('batchSelection must be "greedy" or "beam"');
        }
        const beamWidth = options.beamWidth ?? 4;
        const regionCandidateLimit = options.regionCandidateLimit ?? 4;
        if (!Number.isInteger(beamWidth) || beamWidth < 1 || beamWidth > 32) {
            throw new RangeError("beamWidth must be an integer between 1 and 32");
        }
        if (!Number.isInteger(regionCandidateLimit)
            || regionCandidateLimit < 1 || regionCandidateLimit > 32) {
            throw new RangeError("regionCandidateLimit must be an integer between 1 and 32");
        }
        const timings = {
            objectOccMs: 0,
            roundContextMs: 0,
            candidateSearchMs: 0,
            batchBuildMs: 0,
            transactionMs: 0,
            worldCaptureMs: 0,
            finalVerificationMs: 0
        };
        const stats = createSearchStats();
        const round = prepareRound(world, options, stats, timings);
        const groups = groupLeavesByRegion(round.context.leaves);
        const regionStates = new Map();
        let batch = createBatchAccumulator(round.order);
        let candidateCount = 0;
        let rejectedCandidateCount = 0;
        let lastRejectedReason = null;

        const searchStart = now();
        const regionPools = [];
        for (const group of groups) {
            stats.sourceRegionsVisited++;
            const state = {
                regionId: group.regionId,
                iterator: iterateBranchedDoubleBridgeCandidates(
                    world,
                    round.context,
                    round.order,
                    group.leaves,
                    stats,
                    epsilon,
                    { reconnectionPolicy }
                ),
                exhausted: false,
                rejectedCandidateCount: 0
            };
            regionStates.set(group.regionId, state);
            if (batchSelection === "beam") {
                regionPools.push({
                    regionId: group.regionId,
                    candidates: collectBoundedRegionCandidates(
                        state, regionCandidateLimit, stats)
                });
                continue;
            }
            const selected = selectCandidateFromIterator(
                state,
                world,
                round.order,
                batch,
                stats,
                regionSelection
            );
            rejectedCandidateCount += state.rejectedCandidateCount;
            state.rejectedCandidateCount = 0;
            if (!selected) continue;
            addCandidateToBatch(batch, selected.candidate, selected.arcState);
            candidateCount++;
            stats.sourceRegionsWithCandidate++;
        }
        if (batchSelection === "beam") {
            batch = selectBatchWithBeam(world, round.order, regionPools, stats, beamWidth);
            candidateCount = batch.candidates.length;
            stats.sourceRegionsWithCandidate = batch.candidates.length;
        }
        timings.candidateSearchMs += now() - searchStart;

        if (!batch.candidates.length) {
            const report = makeBatchReport(round, batch, stats, timings, {
                committed: false,
                candidateCount,
                rejectedCandidateCount,
                regionSelection,
                batchSelection,
                reconnectionPolicy,
                beamWidth,
                regionCandidateLimit,
                lastRejectedReason,
                patch: null
            });
            world.lastDoubleBridgeBatchReport = report;
            if (options.log !== false && typeof console !== "undefined") console.table(report.timings);
            return report;
        }

        let roundSnapshot = null;
        while (batch.candidates.length) {
            const buildStart = now();
            const patch = buildBatchedBranchedRoutePatchRaw(round.order, batch, world, epsilon);
            timings.batchBuildMs += now() - buildStart;
            if (!roundSnapshot) {
                const captureStart = now();
                roundSnapshot = captureWorldState(world, { reusable: true });
                timings.worldCaptureMs += now() - captureStart;
                stats.worldCaptureCount = 1;
                stats.worldCaptureObjectCount = roundSnapshot.objectCount;
            }

            stats.transactionAttempts++;
            const transactionStart = now();
            const transaction = applyTourDiffTransaction(world, patch, {
                ...(options.transactionOptions || {}),
                materializeMissingEdges: true,
                polygonNo: options.polygonNo ?? 0,
                rollbackSnapshot: roundSnapshot
            });
            timings.transactionMs += now() - transactionStart;
            if (transaction.committed) {
                resetObjectOccState(world);
                world.pocketTreeOverlay = null;
                const report = makeBatchReport(round, batch, stats, timings, {
                    committed: true,
                    candidateCount,
                    rejectedCandidateCount,
                    regionSelection,
                    batchSelection,
                    reconnectionPolicy,
                    beamWidth,
                    regionCandidateLimit,
                    lastRejectedReason,
                    patch
                });
                world.lastDoubleBridgeBatchReport = report;
                if (options.log !== false && typeof console !== "undefined") console.table(report.timings);
                return report;
            }

            stats.transactionRejects++;
            lastRejectedReason = transaction.error?.message || "transaction rejected";
            const rejectedOwner = ownerForTransactionError(batch, transaction.error);
            rejectedCandidateCount++;
            if (batchSelection === "beam") {
                // The region iterators were drained into `regionPools` up front, so
                // there is no iterator left to resume.  Retire only the candidate the
                // transaction blamed and re-run the beam over the surviving pools; the
                // rejected region can still contribute one of its other candidates.
                retireBeamCandidate(regionPools, batch, rejectedOwner, stats);
                const beamRetryStart = now();
                batch = selectBatchWithBeam(world, round.order, regionPools, stats, beamWidth);
                timings.candidateSearchMs += now() - beamRetryStart;
                candidateCount = batch.candidates.length;
                stats.sourceRegionsWithCandidate = batch.candidates.length;
                continue;
            }
            const retained = batch.candidates.filter(candidate => candidate.ownerRegionId !== rejectedOwner);
            batch = rebuildBatch(round.order, retained, world, stats);

            const state = regionStates.get(rejectedOwner);
            if (state && !state.exhausted) {
                const replacementSearchStart = now();
                const replacement = selectCandidateFromIterator(
                    state,
                    world,
                    round.order,
                    batch,
                    stats,
                    regionSelection
                );
                timings.candidateSearchMs += now() - replacementSearchStart;
                rejectedCandidateCount += state.rejectedCandidateCount;
                state.rejectedCandidateCount = 0;
                if (replacement) {
                    addCandidateToBatch(batch, replacement.candidate, replacement.arcState);
                    candidateCount++;
                }
            }
        }

        const report = makeBatchReport(round, batch, stats, timings, {
            committed: false,
            candidateCount,
            rejectedCandidateCount,
            regionSelection,
            batchSelection,
            reconnectionPolicy,
            beamWidth,
            regionCandidateLimit,
            lastRejectedReason,
            patch: null
        });
        world.lastDoubleBridgeBatchReport = report;
        if (options.log !== false && typeof console !== "undefined") console.table(report.timings);
        return report;
    }

    function optimizeKoptAndBatchedBranchedDoubleBridge(world, options = {}) {
        if (!world?.totalNoktaList?.length) throw new TypeError("A populated world is required");
        const startPoint = options.startPoint || world.totalNoktaList[options.startNodeId ?? 4];
        if (!startPoint) throw new RangeError("A current route start point is required");
        const startOrder = tourOrderFromBags(startPoint, world);
        const initialLength = tourLengthRaw(startOrder, world.totalNoktaList);
        const initialTsplibLength = tourLength(startOrder, world.totalNoktaList);
        let runningLength = initialLength;
        let runningTsplibLength = initialTsplibLength;
        const rounds = [];
        const startedAt = now();

        while (true) {
            const koptReport = koptStart(options.koptOptions || {});
            if (!koptReport || !Number.isFinite(koptReport.finalLength)) {
                throw new Error("K-opt did not complete with a final length");
            }
            runningLength = koptReport.finalLength;
            runningTsplibLength = koptReport.finalTsplibLength;
            const bridgeReport = optimizeBranchedDoubleBridgeBatch(world, {
                ...(options.bridgeOptions || {}),
                visibilityPrepared: true,
                initialLength: runningLength,
                initialTsplibLength: runningTsplibLength,
                startPoint
            });
            rounds.push({ kopt: koptReport, bridge: bridgeReport });
            if (!bridgeReport.committed) break;
            runningLength += bridgeReport.immediateDelta;
            runningTsplibLength += bridgeReport.tsplibImmediateDelta;
        }

        const verificationStart = now();
        const finalOrder = tourOrderFromBags(startPoint, world);
        const verifiedFinalLength = tourLengthRaw(finalOrder, world.totalNoktaList);
        const verifiedFinalTsplibLength = tourLength(finalOrder, world.totalNoktaList);
        const finalVerificationMs = now() - verificationStart;
        if (Math.abs(verifiedFinalLength - runningLength) > 1e-6) {
            throw new Error("Accumulated optimizer delta does not match final tour length");
        }
        if (verifiedFinalTsplibLength !== runningTsplibLength) {
            throw new Error("Accumulated TSPLIB delta does not match final tour length");
        }
        const report = {
            status: "stalled",
            distanceMetric: "EUCLIDEAN_RAW",
            initialLength,
            finalLength: verifiedFinalLength,
            verifiedFinalLength,
            improvement: initialLength - verifiedFinalLength,
            tsplibDistanceMetric: "TSPLIB_EUC_2D",
            initialTsplibLength,
            finalTsplibLength: verifiedFinalTsplibLength,
            verifiedFinalTsplibLength,
            tsplibImprovement: initialTsplibLength - verifiedFinalTsplibLength,
            roundCount: rounds.length,
            koptRounds: rounds.length,
            bridgeRounds: rounds.length,
            totalCommittedBridges: rounds.reduce((sum, round) => sum + round.bridge.committedCount, 0),
            totalBatchCommits: rounds.filter(round => round.bridge.committed).length,
            totalObjectOccRebuilds: rounds.reduce(
                (sum, round) => sum + round.kopt.visibilityRebuildCount + round.bridge.visibilityRebuildCount,
                0
            ),
            totalVisibilityReusedRounds: rounds.filter(round => round.bridge.visibilityReusedFromKopt).length,
            totalWorldCaptures: rounds.reduce((sum, round) => sum + round.bridge.worldCaptureCount, 0),
            finalVerificationMs,
            totalMs: now() - startedAt,
            rounds
        };
        world.lastKoptAndBatchedDoubleBridgeReport = report;
        return report;
    }

    return {
        optimizeBranchedDoubleBridge,
        optimizeBranchedDoubleBridgeBatch,
        optimizeKoptAndBatchedBranchedDoubleBridge,
        enumerateSimpleFourCutReconnections,
        generalizedCutSetDeltaLowerBound
    };
});
