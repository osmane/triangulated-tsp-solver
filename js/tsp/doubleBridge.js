(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    Object.assign(root, api);
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const DEFAULT_IMPROVEMENT_EPSILON = 1e-9;

    function assertArray(value, name) {
        if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
    }

    function assertCuts(length, i, j, k, l) {
        if (![i, j, k, l].every(Number.isInteger)) {
            throw new TypeError("Double bridge cuts must be integer indices");
        }
        if (!(0 <= i && i < j && j < k && k < l && l < length)) {
            throw new RangeError(`Expected 0 <= i < j < k < l < ${length}`);
        }
    }

    function pointFor(orderEntry, points) {
        if (orderEntry && typeof orderEntry === "object"
            && (orderEntry.kendiYeri || (Number.isFinite(orderEntry.x) && Number.isFinite(orderEntry.y)))) {
            return orderEntry;
        }
        const point = points?.[orderEntry];
        if (!point) throw new RangeError(`No point found for route entry ${orderEntry}`);
        return point;
    }

    function displayPositionFor(orderEntry, points) {
        const point = pointFor(orderEntry, points);
        const position = point.kendiYeri || point;
        if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
            throw new TypeError("Every route point must have finite x/y coordinates");
        }
        return position;
    }

    function metricPositionFor(orderEntry, points) {
        const point = pointFor(orderEntry, points);
        const storedMetric = point.metricPosition;
        const position = storedMetric
            && Number.isFinite(storedMetric.x) && Number.isFinite(storedMetric.y)
            ? storedMetric
            : (point.kendiYeri || point);
        if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
            throw new TypeError("Every route point must have finite metric x/y coordinates");
        }
        return position;
    }

    function tsplibEuc2dDistance(a, b) {
        return Math.floor(Math.hypot(a.x - b.x, a.y - b.y) + 0.5);
    }

    function rawEuclideanDistance(a, b) {
        return Math.hypot(a.x - b.x, a.y - b.y);
    }

    function routeEdgeCost(a, b, points) {
        return tsplibEuc2dDistance(
            metricPositionFor(a, points),
            metricPositionFor(b, points)
        );
    }

    function routeEdgeLengthRaw(a, b, points) {
        return rawEuclideanDistance(
            metricPositionFor(a, points),
            metricPositionFor(b, points)
        );
    }

    function routeEdgeCostCached(world, a, b) {
        const points = world.totalNoktaList;
        const aId = typeof a === "number" ? a : a.noktaNo;
        const bId = typeof b === "number" ? b : b.noktaNo;
        const ray = typeof getPointRay === "function"
            ? getPointRay(world, aId, bId)
            : world.pointRayIndex?.get(aId < bId ? `${aId}:${bId}` : `${bId}:${aId}`);
        if (Number.isFinite(ray?.metricLength)) return ray.metricLength;
        const key = aId < bId ? `${aId}:${bId}` : `${bId}:${aId}`;
        const cache = world.routeMetricCache || (world.routeMetricCache = new Map());
        if (cache.has(key)) return cache.get(key);
        const value = routeEdgeCost(points[aId], points[bId]);
        cache.set(key, value);
        return value;
    }

    function routeEdgeLengthRawCached(world, a, b) {
        const points = world.totalNoktaList;
        const aId = typeof a === "number" ? a : a.noktaNo;
        const bId = typeof b === "number" ? b : b.noktaNo;
        const ray = typeof getPointRay === "function"
            ? getPointRay(world, aId, bId)
            : world.pointRayIndex?.get(aId < bId ? `${aId}:${bId}` : `${bId}:${aId}`);
        if (Number.isFinite(ray?.rawMetricLength)) return ray.rawMetricLength;
        const key = aId < bId ? `${aId}:${bId}` : `${bId}:${aId}`;
        const cache = world.routeRawMetricCache || (world.routeRawMetricCache = new Map());
        if (cache.has(key)) return cache.get(key);
        const value = routeEdgeLengthRaw(points[aId], points[bId]);
        cache.set(key, value);
        return value;
    }

    function tourOrderFromBags(start, world) {
        if (!world || !Array.isArray(world.totalNoktaList)) {
            throw new TypeError("world.totalNoktaList is required");
        }
        const points = world.totalNoktaList;
        const startId = typeof start === "number" ? start : start?.noktaNo;
        if (!Number.isInteger(startId) || !points[startId]) {
            throw new RangeError("start must identify a point in world.totalNoktaList");
        }

        const order = [];
        const visited = new Set();
        let currentId = startId;
        let previousId = null;

        do {
            if (visited.has(currentId)) {
                throw new Error("bag1/bag2 does not describe one simple closed cycle");
            }
            const current = points[currentId];
            if (!current || current.noktaSilindi) {
                throw new Error(`Route contains a missing or deleted point: ${currentId}`);
            }
            visited.add(currentId);
            order.push(currentId);

            const neighbors = [current.bag1, current.bag2].filter(Number.isInteger);
            if (neighbors.length !== 2 || neighbors[0] === neighbors[1]) {
                throw new Error(`Point ${currentId} does not have two distinct route neighbors`);
            }
            const nextId = previousId === null
                ? current.bag2
                : (current.bag1 === previousId ? current.bag2 : current.bag1);
            if (previousId !== null && current.bag1 !== previousId && current.bag2 !== previousId) {
                throw new Error(`Route adjacency is not reciprocal at point ${currentId}`);
            }
            previousId = currentId;
            currentId = nextId;
        } while (currentId !== startId);

        const last = points[order[order.length - 1]];
        if (last.bag1 !== startId && last.bag2 !== startId) {
            throw new Error("Route does not close back to its start");
        }
        return order;
    }

    function tourLength(order, points) {
        assertArray(order, "order");
        if (order.length < 2) return 0;
        let length = 0;
        for (let index = 0; index < order.length; index++) {
            length += routeEdgeCost(order[index], order[(index + 1) % order.length], points);
        }
        return length;
    }

    function tourLengthRaw(order, points) {
        assertArray(order, "order");
        if (order.length < 2) return 0;
        let length = 0;
        for (let index = 0; index < order.length; index++) {
            length += routeEdgeLengthRaw(order[index], order[(index + 1) % order.length], points);
        }
        return length;
    }

    function delta4OptWithCost(order, i, j, k, l, cost) {
        assertArray(order, "order");
        assertCuts(order.length, i, j, k, l);
        const at = index => order[index % order.length];
        const removed = cost(at(i), at(i + 1))
            + cost(at(j), at(j + 1))
            + cost(at(k), at(k + 1))
            + cost(at(l), at(l + 1));
        const added = cost(at(i), at(k + 1))
            + cost(at(l), at(j + 1))
            + cost(at(k), at(i + 1))
            + cost(at(j), at(l + 1));
        return added - removed;
    }

    function delta4Opt(order, i, j, k, l, points) {
        return delta4OptWithCost(order, i, j, k, l, (a, b) => routeEdgeCost(a, b, points));
    }

    function delta4OptRaw(order, i, j, k, l, points) {
        return delta4OptWithCost(order, i, j, k, l, (a, b) => routeEdgeLengthRaw(a, b, points));
    }

    function fixedDoubleBridgeEdges(order, cutIndices) {
        assertArray(order, "order");
        assertArray(cutIndices, "cutIndices");
        if (cutIndices.length !== 4 || new Set(cutIndices).size !== 4) {
            throw new Error("A fixed double bridge requires four distinct route cuts");
        }
        const cuts = cutIndices.slice().sort((a, b) => a - b);
        assertCuts(order.length, ...cuts);
        const [i, j, k, l] = cuts;
        const at = index => order[index % order.length];
        const result = {
            cuts,
            removedEdges: [
                edge(at(i), at(i + 1)), edge(at(j), at(j + 1)),
                edge(at(k), at(k + 1)), edge(at(l), at(l + 1))
            ],
            addedEdges: [
                edge(at(i), at(k + 1)), edge(at(l), at(j + 1)),
                edge(at(k), at(i + 1)), edge(at(j), at(l + 1))
            ]
        };
        const key = ([a, b]) => a < b ? `${a}:${b}` : `${b}:${a}`;
        const removedKeys = new Set(result.removedEdges.map(key));
        const addedKeys = result.addedEdges.map(key);
        if (new Set(addedKeys).size !== 4 || addedKeys.some(edgeKey => removedKeys.has(edgeKey))) {
            throw new Error("A fixed double bridge requires four new, distinct added edges");
        }
        return result;
    }

    function fourEdgeDeltaCached(world, removedEdges, addedEdges) {
        if (!world) throw new TypeError("world is required");
        if (!Array.isArray(removedEdges) || removedEdges.length !== 4
            || !Array.isArray(addedEdges) || addedEdges.length !== 4) {
            throw new TypeError("Exactly four removed and four added edges are required");
        }
        const total = edges => edges.reduce((sum, [a, b]) => sum + routeEdgeCostCached(world, a, b), 0);
        return total(addedEdges) - total(removedEdges);
    }

    function fourEdgeDeltaRawCached(world, removedEdges, addedEdges) {
        if (!world) throw new TypeError("world is required");
        if (!Array.isArray(removedEdges) || removedEdges.length !== 4
            || !Array.isArray(addedEdges) || addedEdges.length !== 4) {
            throw new TypeError("Exactly four removed and four added edges are required");
        }
        const total = edges => edges.reduce((sum, [a, b]) => sum + routeEdgeLengthRawCached(world, a, b), 0);
        return total(addedEdges) - total(removedEdges);
    }

    function buildVirtualTwoCycle(order, sourceCutIndex, counterCutIndex) {
        assertArray(order, "order");
        const n = order.length;
        if (!Number.isInteger(sourceCutIndex) || !Number.isInteger(counterCutIndex)
            || sourceCutIndex < 0 || sourceCutIndex >= n
            || counterCutIndex < 0 || counterCutIndex >= n
            || sourceCutIndex === counterCutIndex) {
            throw new RangeError("Two distinct current route cuts are required for the virtual split");
        }
        const sourceA = order[sourceCutIndex];
        const sourceB = order[(sourceCutIndex + 1) % n];
        const counterE = order[counterCutIndex];
        const counterF = order[(counterCutIndex + 1) % n];
        const counterOffset = (counterCutIndex - sourceCutIndex + n) % n;
        if (counterOffset <= 2 || counterOffset >= n - 2) {
            throw new RangeError("The first bridge cuts must leave a simple route path on both virtual cycles");
        }
        const cyclePointCounts = Object.freeze([counterOffset, n - counterOffset]);
        const cycleRouteEdgeCounts = Object.freeze([
            cyclePointCounts[0] - 1,
            cyclePointCounts[1] - 1
        ]);
        const shorterCycleId = cyclePointCounts[0] <= cyclePointCounts[1] ? 0 : 1;
        return Object.freeze({
            sourceCutIndex,
            counterCutIndex,
            cyclePointCounts,
            cycleRouteEdgeCounts,
            shorterCycleId,
            removedEdges: Object.freeze([
                Object.freeze(edge(sourceA, sourceB)),
                Object.freeze(edge(counterE, counterF))
            ]),
            addedEdges: Object.freeze([
                Object.freeze(edge(counterE, sourceB)),
                Object.freeze(edge(sourceA, counterF))
            ]),
            cycleOfRouteEdge(edgeIndex) {
                if (!Number.isInteger(edgeIndex) || edgeIndex < 0 || edgeIndex >= n) return -1;
                const offset = (edgeIndex - sourceCutIndex + n) % n;
                if (offset === 0 || offset === counterOffset) return -1;
                return offset < counterOffset ? 0 : 1;
            }
        });
    }

    function doubleBridgePermutation(order, i, j, k, l) {
        assertArray(order, "order");
        assertCuts(order.length, i, j, k, l);
        return order.slice(0, i + 1)
            .concat(order.slice(k + 1, l + 1))
            .concat(order.slice(j + 1, k + 1))
            .concat(order.slice(i + 1, j + 1))
            .concat(order.slice(l + 1));
    }

    function identityOf(entry, points) {
        const point = pointFor(entry, points);
        return point.sourcePointId ?? point.noktaNo ?? entry;
    }

    function assertHamiltonianOrder(before, after, points) {
        assertArray(before, "before");
        assertArray(after, "after");
        if (before.length !== after.length) throw new Error("Route point count changed");
        const counts = new Map();
        for (const entry of before) {
            const id = identityOf(entry, points);
            counts.set(id, (counts.get(id) || 0) + 1);
        }
        for (const entry of after) {
            const id = identityOf(entry, points);
            const remaining = counts.get(id) || 0;
            if (remaining === 0) throw new Error(`Route contains a new or duplicate point: ${id}`);
            counts.set(id, remaining - 1);
        }
        if ([...counts.values()].some(Boolean)) throw new Error("Route dropped a mandatory point");
        return true;
    }

    function snapshotCoordinates(order, points) {
        assertArray(order, "order");
        return new Map(order.map(entry => {
            const id = identityOf(entry, points);
            const display = displayPositionFor(entry, points);
            const metric = metricPositionFor(entry, points);
            return [id, Object.freeze({
                x: display.x,
                y: display.y,
                metricX: metric.x,
                metricY: metric.y
            })];
        }));
    }

    function assertCoordinatesUnchanged(order, points, snapshot) {
        if (!(snapshot instanceof Map)) throw new TypeError("snapshot must be a Map");
        for (const entry of order) {
            const id = identityOf(entry, points);
            const before = snapshot.get(id);
            const afterDisplay = displayPositionFor(entry, points);
            const afterMetric = metricPositionFor(entry, points);
            if (!before
                || before.x !== afterDisplay.x || before.y !== afterDisplay.y
                || before.metricX !== afterMetric.x || before.metricY !== afterMetric.y) {
                throw new Error(`Route optimization changed coordinates for point ${id}`);
            }
        }
        return true;
    }

    function edge(a, b) {
        return [a, b];
    }

    function canonicalEdgeKey(a, b) {
        return a < b ? `${a}:${b}` : `${b}:${a}`;
    }

    function immutableEdgeList(edges, name) {
        assertArray(edges, name);
        return Object.freeze(edges.map(([a, b]) => Object.freeze(edge(a, b))));
    }

    function edgeListFromBatch(batch, property) {
        const value = batch?.[property];
        if (value instanceof Map) return [...value.values()];
        if (Array.isArray(value)) return value;
        throw new TypeError(`batch.${property} must be a Map or an array`);
    }

    function buildAdjacencyFromEdgeDiff(baseOrder, removedEdges, addedEdges) {
        const adjacency = new Map(baseOrder.map(id => [id, new Set()]));
        for (let index = 0; index < baseOrder.length; index++) {
            const a = baseOrder[index];
            const b = baseOrder[(index + 1) % baseOrder.length];
            adjacency.get(a).add(b);
            adjacency.get(b).add(a);
        }
        for (const [a, b] of removedEdges) {
            if (!adjacency.get(a)?.has(b) || !adjacency.get(b)?.has(a)) {
                throw new Error(`Batch removes a non-route edge: ${a}-${b}`);
            }
            adjacency.get(a).delete(b);
            adjacency.get(b).delete(a);
        }
        for (const [a, b] of addedEdges) {
            if (a === b || !adjacency.has(a) || !adjacency.has(b)) {
                throw new Error(`Batch adds an invalid route edge: ${a}-${b}`);
            }
            if (adjacency.get(a).has(b) || adjacency.get(b).has(a)) {
                throw new Error(`Batch adds an existing route edge: ${a}-${b}`);
            }
            adjacency.get(a).add(b);
            adjacency.get(b).add(a);
        }
        for (const [id, neighbors] of adjacency) {
            if (neighbors.size !== 2) throw new Error(`Batch final degree is not 2 at point ${id}`);
        }
        return adjacency;
    }

    function walkAdjacencyCycle(adjacency, startId, firstNext, expectedLength) {
        const order = [];
        const visited = new Set();
        let previous = null;
        let current = startId;
        let forcedNext = firstNext;
        while (true) {
            if (visited.has(current)) {
                if (current === startId && order.length === expectedLength) break;
                throw new Error("Batch adjacency closes a premature subtour");
            }
            visited.add(current);
            order.push(current);
            const neighbors = [...adjacency.get(current)];
            const next = previous === null
                ? forcedNext
                : (neighbors[0] === previous ? neighbors[1] : neighbors[0]);
            if (!Number.isInteger(next)) throw new Error(`Batch adjacency is broken at point ${current}`);
            previous = current;
            current = next;
            forcedNext = null;
        }
        if (visited.size !== expectedLength) throw new Error("Batch adjacency does not contain every route point");
        return order;
    }

    function signedAreaForOrder(order, points) {
        let twiceArea = 0;
        for (let index = 0; index < order.length; index++) {
            const a = displayPositionFor(order[index], points);
            const b = displayPositionFor(order[(index + 1) % order.length], points);
            twiceArea += a.x * b.y - b.x * a.y;
        }
        return twiceArea / 2;
    }

    function buildBatchedBranchedRoutePatchWithCost(
        baseOrder,
        batch,
        world,
        epsilon,
        distanceMetric,
        edgeCost,
        secondaryEdgeCost
    ) {
        assertArray(baseOrder, "baseOrder");
        if (!world?.totalNoktaList) throw new TypeError("world.totalNoktaList is required");
        const candidates = Array.isArray(batch?.candidates) ? batch.candidates : [];
        if (!candidates.length) throw new Error("A batched route patch requires at least one candidate");

        const removedEdges = edgeListFromBatch(batch, "removedEdges");
        const addedEdges = edgeListFromBatch(batch, "addedEdges");
        const removedKeys = new Set(removedEdges.map(([a, b]) => canonicalEdgeKey(a, b)));
        const addedKeys = new Set(addedEdges.map(([a, b]) => canonicalEdgeKey(a, b)));
        if (removedKeys.size !== removedEdges.length || addedKeys.size !== addedEdges.length) {
            throw new Error("Batch edge diff contains duplicate edges");
        }
        if ([...addedKeys].some(key => removedKeys.has(key))) {
            throw new Error("Batch edge diff adds and removes the same edge");
        }

        const adjacency = buildAdjacencyFromEdgeDiff(baseOrder, removedEdges, addedEdges);
        const startId = baseOrder[0];
        const startNeighbors = [...adjacency.get(startId)];
        const alternatives = startNeighbors.map(next => walkAdjacencyCycle(adjacency, startId, next, baseOrder.length));
        const beforeSign = Math.sign(signedAreaForOrder(baseOrder, world.totalNoktaList));
        const after = alternatives.find(order => Math.sign(signedAreaForOrder(order, world.totalNoktaList)) === beforeSign);
        if (!after) throw new Error("Batch route orientation changed");
        assertHamiltonianOrder(baseOrder, after, world.totalNoktaList);

        const totalCost = (edges, cost) => edges.reduce(
            (sum, [a, b]) => sum + cost(world, a, b),
            0
        );
        const batchDelta = totalCost(addedEdges, edgeCost) - totalCost(removedEdges, edgeCost);
        const candidateDeltaSum = candidates.reduce((sum, candidate) => sum + candidate.immediateDelta, 0);
        const deltaTolerance = Math.max(epsilon, 1e-9);
        if (Math.abs(candidateDeltaSum - batchDelta) > deltaTolerance) {
            throw new Error("Candidate delta sum does not match the unique-edge batch delta");
        }
        if (!(batchDelta < -epsilon)) throw new Error("Batched route patch does not improve immediately");
        const secondaryDelta = totalCost(addedEdges, secondaryEdgeCost)
            - totalCost(removedEdges, secondaryEdgeCost);
        const secondaryMetric = distanceMetric === "EUCLIDEAN_RAW"
            ? { tsplibImmediateDelta: secondaryDelta }
            : { rawImmediateDelta: secondaryDelta };

        return Object.freeze({
            removedEdges: immutableEdgeList(removedEdges, "removedEdges"),
            addedEdges: immutableEdgeList(addedEdges, "addedEdges"),
            immediateDelta: batchDelta,
            batchDelta,
            candidateDeltaSum,
            distanceMetric,
            ...secondaryMetric,
            improvesImmediately: true,
            before: Object.freeze(baseOrder.slice()),
            after: Object.freeze(after),
            candidates: Object.freeze(candidates.slice()),
            candidateEdgeOwners: batch.candidateEdgeOwners || null
        });
    }

    function buildBatchedBranchedRoutePatch(baseOrder, batch, world, epsilon = DEFAULT_IMPROVEMENT_EPSILON) {
        return buildBatchedBranchedRoutePatchWithCost(
            baseOrder,
            batch,
            world,
            epsilon,
            "TSPLIB_EUC_2D",
            routeEdgeCostCached,
            routeEdgeLengthRawCached
        );
    }

    function buildBatchedBranchedRoutePatchRaw(baseOrder, batch, world, epsilon = DEFAULT_IMPROVEMENT_EPSILON) {
        return buildBatchedBranchedRoutePatchWithCost(
            baseOrder,
            batch,
            world,
            epsilon,
            "EUCLIDEAN_RAW",
            routeEdgeLengthRawCached,
            routeEdgeCostCached
        );
    }

    function buildRoutePatchWithDelta(
        order,
        i,
        j,
        k,
        l,
        points,
        epsilon,
        distanceMetric,
        deltaFunction,
        secondaryDeltaFunction
    ) {
        assertCuts(order.length, i, j, k, l);
        const n = order.length;
        const at = index => order[(index + n) % n];
        const after = doubleBridgePermutation(order, i, j, k, l);
        assertHamiltonianOrder(order, after, points);
        const immediateDelta = deltaFunction(order, i, j, k, l, points);
        const secondaryDelta = secondaryDeltaFunction(order, i, j, k, l, points);
        const secondaryMetric = distanceMetric === "EUCLIDEAN_RAW"
            ? { tsplibImmediateDelta: secondaryDelta }
            : { rawImmediateDelta: secondaryDelta };
        return Object.freeze({
            cuts: Object.freeze([i, j, k, l]),
            removedEdges: Object.freeze([
                edge(at(i), at(i + 1)), edge(at(j), at(j + 1)),
                edge(at(k), at(k + 1)), edge(at(l), at(l + 1))
            ]),
            addedEdges: Object.freeze([
                edge(at(i), at(k + 1)), edge(at(l), at(j + 1)),
                edge(at(k), at(i + 1)), edge(at(j), at(l + 1))
            ]),
            affectedRouteIntervals: Object.freeze([[i + 1, j], [j + 1, k], [k + 1, l]]),
            immediateDelta,
            distanceMetric,
            ...secondaryMetric,
            improvesImmediately: immediateDelta < -epsilon,
            before: Object.freeze(order.slice()),
            after: Object.freeze(after)
        });
    }

    function buildRoutePatch(order, i, j, k, l, points, epsilon = DEFAULT_IMPROVEMENT_EPSILON) {
        return buildRoutePatchWithDelta(
            order, i, j, k, l, points, epsilon,
            "TSPLIB_EUC_2D", delta4Opt, delta4OptRaw
        );
    }

    function buildRoutePatchRaw(order, i, j, k, l, points, epsilon = DEFAULT_IMPROVEMENT_EPSILON) {
        return buildRoutePatchWithDelta(
            order, i, j, k, l, points, epsilon,
            "EUCLIDEAN_RAW", delta4OptRaw, delta4Opt
        );
    }

    function buildBranchedRoutePatchWithBuilder(
        order,
        firstBridgeCuts,
        secondBridgeCuts,
        points,
        epsilon,
        routePatchBuilder
    ) {
        assertArray(firstBridgeCuts, "firstBridgeCuts");
        assertArray(secondBridgeCuts, "secondBridgeCuts");
        if (firstBridgeCuts.length !== 2 || secondBridgeCuts.length !== 2) {
            throw new Error("A branched double bridge requires two first-bridge and two second-bridge cuts");
        }
        const allCuts = [...firstBridgeCuts, ...secondBridgeCuts];
        if (new Set(allCuts).size !== 4) throw new Error("Branched double bridge cuts must be distinct");
        const split = buildVirtualTwoCycle(order, firstBridgeCuts[0], firstBridgeCuts[1]);
        const secondCycles = secondBridgeCuts.map(cut => split.cycleOfRouteEdge(cut));
        if (secondCycles[0] < 0 || secondCycles[1] < 0 || secondCycles[0] === secondCycles[1]) {
            throw new Error("Second bridge cuts must come from different virtual cycles");
        }
        const sorted = allCuts.slice().sort((a, b) => a - b);
        fixedDoubleBridgeEdges(order, sorted);
        const patch = routePatchBuilder(order, ...sorted, points, epsilon);
        const patchKeys = new Set(patch.addedEdges.map(([a, b]) => a < b ? `${a}:${b}` : `${b}:${a}`));
        for (const [a, b] of split.addedEdges) {
            const key = a < b ? `${a}:${b}` : `${b}:${a}`;
            if (!patchKeys.has(key)) throw new Error("Second cuts do not preserve the fixed first-bridge split topology");
        }
        return Object.freeze({
            ...patch,
            firstBridgeCuts: Object.freeze(firstBridgeCuts.slice()),
            secondBridgeCuts: Object.freeze(secondBridgeCuts.slice()),
            virtualSplitAddedEdges: split.addedEdges
        });
    }

    function buildBranchedRoutePatch(order, firstBridgeCuts, secondBridgeCuts, points, epsilon = DEFAULT_IMPROVEMENT_EPSILON) {
        return buildBranchedRoutePatchWithBuilder(
            order, firstBridgeCuts, secondBridgeCuts, points, epsilon, buildRoutePatch
        );
    }

    function buildBranchedRoutePatchRaw(order, firstBridgeCuts, secondBridgeCuts, points, epsilon = DEFAULT_IMPROVEMENT_EPSILON) {
        return buildBranchedRoutePatchWithBuilder(
            order, firstBridgeCuts, secondBridgeCuts, points, epsilon, buildRoutePatchRaw
        );
    }

    // İki Hamilton çevrimi arasındaki farkı k-kenar patch olarak çıkarır (4-kenar sınırı yok).
    // Kenarlar yönsüz çift olarak karşılaştırılır; rotasyon/yön farkları diff üretmez.
    function buildDiffPatchWithLength(before, after, points, epsilon, distanceMetric, lengthFunction, secondaryLengthFunction) {
        assertArray(before, "before");
        assertArray(after, "after");
        assertHamiltonianOrder(before, after, points);
        const key = (a, b) => a < b ? `${a}:${b}` : `${b}:${a}`;
        const edgesOf = order => {
            const map = new Map();
            for (let index = 0; index < order.length; index++) {
                const a = order[index];
                const b = order[(index + 1) % order.length];
                map.set(key(a, b), edge(a, b));
            }
            return map;
        };
        const beforeEdges = edgesOf(before);
        const afterEdges = edgesOf(after);
        const removedEdges = [...beforeEdges].filter(([k]) => !afterEdges.has(k)).map(([, pair]) => pair);
        const addedEdges = [...afterEdges].filter(([k]) => !beforeEdges.has(k)).map(([, pair]) => pair);
        const immediateDelta = lengthFunction(after, points) - lengthFunction(before, points);
        const secondaryDelta = secondaryLengthFunction(after, points) - secondaryLengthFunction(before, points);
        const secondaryMetric = distanceMetric === "EUCLIDEAN_RAW"
            ? { tsplibImmediateDelta: secondaryDelta }
            : { rawImmediateDelta: secondaryDelta };
        return Object.freeze({
            removedEdges: Object.freeze(removedEdges),
            addedEdges: Object.freeze(addedEdges),
            immediateDelta,
            distanceMetric,
            ...secondaryMetric,
            improvesImmediately: immediateDelta < -epsilon,
            before: Object.freeze(before.slice()),
            after: Object.freeze(after.slice())
        });
    }

    function buildDiffPatch(before, after, points, epsilon = DEFAULT_IMPROVEMENT_EPSILON) {
        return buildDiffPatchWithLength(
            before, after, points, epsilon, "TSPLIB_EUC_2D", tourLength, tourLengthRaw
        );
    }

    function buildDiffPatchRaw(before, after, points, epsilon = DEFAULT_IMPROVEMENT_EPSILON) {
        return buildDiffPatchWithLength(
            before, after, points, epsilon, "EUCLIDEAN_RAW", tourLengthRaw, tourLength
        );
    }

    return {
        DEFAULT_IMPROVEMENT_EPSILON,
        tsplibEuc2dDistance,
        rawEuclideanDistance,
        routeEdgeCost,
        routeEdgeCostCached,
        routeEdgeLengthRaw,
        routeEdgeLengthRawCached,
        tourOrderFromBags,
        tourLength,
        tourLengthRaw,
        delta4Opt,
        delta4OptRaw,
        fixedDoubleBridgeEdges,
        fourEdgeDeltaCached,
        fourEdgeDeltaRawCached,
        buildVirtualTwoCycle,
        doubleBridgePermutation,
        assertHamiltonianOrder,
        snapshotCoordinates,
        assertCoordinatesUnchanged,
        buildRoutePatch,
        buildRoutePatchRaw,
        buildBranchedRoutePatch,
        buildBranchedRoutePatchRaw,
        buildBatchedBranchedRoutePatch,
        buildBatchedBranchedRoutePatchRaw,
        buildDiffPatch,
        buildDiffPatchRaw
    };
});
