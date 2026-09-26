(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    Object.assign(root, api);
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const PAIRED_REPAIR_RAW_EPSILON = 1e-9;
    const PAIRED_REPAIR_DELTA_TOLERANCE = 1e-6;

    const PAIRED_REPAIR_POLICY = Object.freeze({
        objectiveMode: "TSPLIB_EUC_2D",
        rawSecondary: true,
        candidateCap: 12,
        halfDepth: 4,
        beamWidth: 128,
        maxExchangeDepth: 8,
        repairDepth: 2,
        joinProbeLimit: 2000000,
        repairProbeLimit: 2000000
    });

    function edgeKeyOf(a, b) {
        if (a === b) throw new RangeError("A route edge cannot connect a point to itself");
        return a < b ? `${a}:${b}` : `${b}:${a}`;
    }

    function edgePair(key) {
        const parts = String(key).split(":").map(Number);
        if (parts.length !== 2 || !parts.every(Number.isSafeInteger) || parts[0] === parts[1]) {
            throw new TypeError(`Invalid edge key: ${key}`);
        }
        return parts;
    }

    function compareEdgeKeys(left, right) {
        const [leftA, leftB] = edgePair(left);
        const [rightA, rightB] = edgePair(right);
        return leftA - rightA || leftB - rightB;
    }

    function compareNumberArrays(left, right) {
        const count = Math.min(left.length, right.length);
        for (let index = 0; index < count; index++) {
            if (left[index] !== right[index]) return left[index] - right[index];
        }
        return left.length - right.length;
    }

    function compareLengths(left, right) {
        if (left.tsplib !== right.tsplib) return left.tsplib - right.tsplib;
        if (Math.abs(left.raw - right.raw) <= PAIRED_REPAIR_RAW_EPSILON) return 0;
        return left.raw - right.raw;
    }

    function compareKeyStrings(left, right) {
        return left.localeCompare(right, "en", { numeric: true });
    }

    function endpointKey(left, right) {
        return left < right ? `${left}:${right}` : `${right}:${left}`;
    }

    function stateKeyOf(removedEdgeKeys, addedEdgeKeys) {
        return `R:${removedEdgeKeys.join(",")}|A:${addedEdgeKeys.join(",")}`;
    }

    /**
     * ObjectOcc görünürlük ışınlarından aday kenar grafiğini kurar. Her nokta,
     * kendisine bağlanabilecek görünür kenarlardan en kısa candidateCap tanesini
     * seçer; grafik bu seçimlerin birleşimidir. Mevcut tur kenarları aday değildir.
     */
    function buildVisibilityCandidateGraph(world, order, options = {}) {
        const cap = options.candidateCap ?? PAIRED_REPAIR_POLICY.candidateCap;
        const points = world.totalNoktaList;
        const routeSet = new Set(order);
        const routeEdgeKeys = new Set(order.map((id, index) =>
            edgeKeyOf(id, order[(index + 1) % order.length])));

        const eligible = new Map();
        for (const ray of world.pointRayIndex.values()) {
            const a = ray.p1No;
            const b = ray.p2No;
            if (!routeSet.has(a) || !routeSet.has(b) || a === b) continue;
            const key = edgeKeyOf(a, b);
            if (routeEdgeKeys.has(key) || eligible.has(key)) continue;
            // A2 yalnız en az bir uçtan görünür kaydı olan kenarları aday sayar.
            if (!points[a].visibleList.has(b) && !points[b].visibleList.has(a)) continue;
            const left = points[a].metricPosition;
            const right = points[b].metricPosition;
            const raw = Math.hypot(left.x - right.x, left.y - right.y);
            eligible.set(key, {
                edgeKey: key,
                sourceA: Math.min(a, b),
                sourceB: Math.max(a, b),
                raw,
                tsplib: Math.floor(raw + 0.5)
            });
        }

        const proposalsByEndpoint = new Map(order.map(id => [id, []]));
        for (const edge of [...eligible.values()].sort((left, right) => compareEdgeKeys(left.edgeKey, right.edgeKey))) {
            proposalsByEndpoint.get(edge.sourceA).push({ sourceId: edge.sourceA, otherSourceId: edge.sourceB, ...edge });
            proposalsByEndpoint.get(edge.sourceB).push({ sourceId: edge.sourceB, otherSourceId: edge.sourceA, ...edge });
        }

        const compareCandidates = (left, right) => left.tsplib - right.tsplib
            || left.raw - right.raw
            || left.otherSourceId - right.otherSourceId
            || compareEdgeKeys(left.edgeKey, right.edgeKey);
        const neighborsById = new Map();
        const selectedKeys = new Set();
        let candidateCapPruneCount = 0;
        for (const [sourceId, proposals] of proposalsByEndpoint) {
            proposals.sort(compareCandidates);
            candidateCapPruneCount += Math.max(0, proposals.length - cap);
            const selected = proposals.slice(0, cap);
            neighborsById.set(sourceId, selected);
            for (const proposal of selected) selectedKeys.add(proposal.edgeKey);
        }
        const candidateEdges = [...selectedKeys].map(key => eligible.get(key))
            .sort((left, right) => left.tsplib - right.tsplib
                || left.raw - right.raw
                || compareEdgeKeys(left.edgeKey, right.edgeKey));
        return {
            neighborsById,
            candidateEdges,
            candidateEdgeSet: selectedKeys,
            eligibleEdgeCount: eligible.size,
            candidateCapPruneCount
        };
    }

    function createRuntime(world, order, options) {
        const points = world.totalNoktaList;
        const edgeCosts = new Map();
        const costFor = key => {
            const existing = edgeCosts.get(key);
            if (existing) return existing;
            const [left, right] = edgePair(key);
            const a = points[left].metricPosition;
            const b = points[right].metricPosition;
            const raw = Math.hypot(a.x - b.x, a.y - b.y);
            const cost = { raw, tsplib: Math.floor(raw + 0.5) };
            edgeCosts.set(key, cost);
            return cost;
        };

        const baseEdges = new Map();
        const baseEdgeIndex = new Map();
        const baseNeighbors = new Map(order.map(id => [id, []]));
        const initialLengths = { tsplib: 0, raw: 0 };
        for (let index = 0; index < order.length; index++) {
            const left = order[index];
            const right = order[(index + 1) % order.length];
            const key = edgeKeyOf(left, right);
            baseEdges.set(key, [Math.min(left, right), Math.max(left, right)]);
            baseEdgeIndex.set(key, index);
            baseNeighbors.get(left).push(right);
            baseNeighbors.get(right).push(left);
            const cost = costFor(key);
            initialLengths.tsplib += cost.tsplib;
            initialLengths.raw += cost.raw;
        }
        for (const neighbors of baseNeighbors.values()) neighbors.sort((left, right) => left - right);

        const graph = buildVisibilityCandidateGraph(world, order, options);
        for (const edge of graph.candidateEdges) edgeCosts.set(edge.edgeKey, { raw: edge.raw, tsplib: edge.tsplib });

        return {
            order,
            points,
            baseEdges,
            baseEdgeIndex,
            baseNeighbors,
            edgeCosts,
            initialLengths,
            neighborsById: graph.neighborsById,
            candidateEdges: graph.candidateEdges,
            candidateEdgeSet: graph.candidateEdgeSet,
            eligibleEdgeCount: graph.eligibleEdgeCount,
            candidateCapPruneCount: graph.candidateCapPruneCount,
            rootEdgeKeys: [...baseEdges.keys()].sort(compareEdgeKeys)
        };
    }

    function edgeSetDelta(runtime, removedEdgeKeys, addedEdgeKeys) {
        const delta = { tsplib: 0, raw: 0 };
        for (const key of removedEdgeKeys) {
            const cost = runtime.edgeCosts.get(key);
            if (!cost) throw new Error(`Missing removed-edge metric: ${key}`);
            delta.tsplib -= cost.tsplib;
            delta.raw -= cost.raw;
        }
        for (const key of addedEdgeKeys) {
            const cost = runtime.edgeCosts.get(key);
            if (!cost) throw new Error(`Missing added-edge metric: ${key}`);
            delta.tsplib += cost.tsplib;
            delta.raw += cost.raw;
        }
        return delta;
    }

    /**
     * Kenar farkını turun kesilmiş yaylarından okuyarak inceler. Yay bazlı olduğu
     * için tüm noktaları dolaşmadan bileşen sayısını ve açık uçları verir; yarı
     * zincir genişletmesinde her adımda çağrıldığı için ucuz olması gerekiyor.
     */
    function analyzeCompactTopology(runtime, removedEdgeKeys, addedEdgeKeys) {
        const removed = new Set(removedEdgeKeys);
        const added = new Set(addedEdgeKeys);
        if (removed.size !== removedEdgeKeys.length || added.size !== addedEdgeKeys.length) {
            return { valid: false, reason: "DUPLICATE_EDGE" };
        }
        for (const key of removed) {
            if (!runtime.baseEdges.has(key)) return { valid: false, reason: "NON_ROUTE_REMOVAL" };
            if (added.has(key)) return { valid: false, reason: "EDGE_CONFLICT" };
        }
        for (const key of added) {
            if (!runtime.candidateEdgeSet.has(key)) return { valid: false, reason: "OUTSIDE_CANDIDATE_GRAPH" };
            if (runtime.baseEdges.has(key) && !removed.has(key)) {
                return { valid: false, reason: "EDGE_ALREADY_PRESENT" };
            }
        }
        const balanced = removed.size === added.size;
        const pending = removed.size === added.size + 1;
        if (!balanced && !pending) return { valid: false, reason: "UNBALANCED_DIFF" };

        const degrees = new Map();
        for (const key of removed) {
            for (const id of edgePair(key)) degrees.set(id, (degrees.get(id) ?? 2) - 1);
        }
        for (const key of added) {
            for (const id of edgePair(key)) degrees.set(id, (degrees.get(id) ?? 2) + 1);
        }
        if ([...degrees.values()].some(degree => degree < 1 || degree > 2)) {
            return { valid: false, reason: "ENDPOINT_DEGREE" };
        }
        const openEndpoints = [...degrees].filter(([, degree]) => degree === 1)
            .map(([id]) => id).sort((left, right) => left - right);
        if (pending && openEndpoints.length !== 2) return { valid: false, reason: "OPEN_ENDPOINT_COUNT" };
        if (balanced && openEndpoints.length !== 0) return { valid: false, reason: "OPEN_ENDPOINT_COUNT" };

        const cutIndices = removedEdgeKeys.map(key => runtime.baseEdgeIndex.get(key))
            .sort((left, right) => left - right);
        const arcs = cutIndices.map((cutIndex, arcIndex) => {
            const nextCut = cutIndices[(arcIndex + 1) % cutIndices.length];
            const startIndex = (cutIndex + 1) % runtime.order.length;
            return {
                index: arcIndex,
                startId: runtime.order[startIndex],
                endId: runtime.order[nextCut],
                length: ((nextCut - startIndex + runtime.order.length) % runtime.order.length) + 1
            };
        });
        const endpointToArc = new Map();
        for (const arc of arcs) {
            for (const endpoint of [arc.startId, arc.endId]) {
                const existing = endpointToArc.get(endpoint);
                if (existing !== undefined && existing !== arc.index) {
                    return { valid: false, reason: "AMBIGUOUS_ARC_ENDPOINT" };
                }
                endpointToArc.set(endpoint, arc.index);
            }
        }
        const parent = arcs.map((_, index) => index);
        const find = input => {
            while (parent[input] !== input) {
                parent[input] = parent[parent[input]];
                input = parent[input];
            }
            return input;
        };
        for (const key of added) {
            const [leftId, rightId] = edgePair(key);
            const leftArc = endpointToArc.get(leftId);
            const rightArc = endpointToArc.get(rightId);
            if (leftArc === undefined || rightArc === undefined) {
                return { valid: false, reason: "ADDED_EDGE_NOT_ON_OPEN_ARC" };
            }
            const leftRoot = find(leftArc);
            const rightRoot = find(rightArc);
            if (leftRoot !== rightRoot) parent[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
        }
        const sizes = new Map();
        for (const arc of arcs) {
            const arcRoot = find(arc.index);
            sizes.set(arcRoot, (sizes.get(arcRoot) || 0) + arc.length);
        }
        return {
            valid: true,
            balanced,
            pending,
            openEndpoints,
            componentCount: sizes.size,
            componentSizes: [...sizes.values()].sort((left, right) => left - right),
            degrees
        };
    }

    /**
     * Kenar farkının tam komşuluk analizi: onarım aşaması hangi noktanın hangi
     * bileşende olduğunu ve komşularını bilmek zorunda olduğu için burada bütün
     * tur dolaşılıyor.
     */
    function analyzeDiff(runtime, removedEdgeKeys, addedEdgeKeys) {
        const removed = new Set(removedEdgeKeys);
        const added = new Set(addedEdgeKeys);
        if (removed.size !== removedEdgeKeys.length || added.size !== addedEdgeKeys.length) {
            return { valid: false, reason: "DUPLICATE_EDGE" };
        }
        for (const key of removed) {
            if (!runtime.baseEdges.has(key)) return { valid: false, reason: "NON_ROUTE_REMOVAL" };
            if (added.has(key)) return { valid: false, reason: "EDGE_CONFLICT" };
        }
        for (const key of added) {
            if (!runtime.candidateEdgeSet.has(key)) return { valid: false, reason: "OUTSIDE_CANDIDATE_GRAPH" };
            if (runtime.baseEdges.has(key) && !removed.has(key)) {
                return { valid: false, reason: "EDGE_ALREADY_PRESENT" };
            }
        }
        const balanced = removed.size === added.size;
        const pending = removed.size === added.size + 1;
        if (!balanced && !pending) return { valid: false, reason: "UNBALANCED_DIFF" };

        const adjacency = new Map(runtime.order.map(id => [id, []]));
        for (const [key, pair] of runtime.baseEdges) {
            if (removed.has(key)) continue;
            adjacency.get(pair[0]).push(pair[1]);
            adjacency.get(pair[1]).push(pair[0]);
        }
        for (const key of added) {
            const [left, right] = edgePair(key);
            adjacency.get(left).push(right);
            adjacency.get(right).push(left);
        }
        const openEndpoints = [];
        for (const [id, neighbors] of adjacency) {
            neighbors.sort((left, right) => left - right);
            if (neighbors.length === 1) openEndpoints.push(id);
            else if (neighbors.length !== 2) {
                return { valid: false, reason: "ENDPOINT_DEGREE", sourcePointId: id, degree: neighbors.length };
            }
        }
        openEndpoints.sort((left, right) => left - right);
        if (pending && openEndpoints.length !== 2) return { valid: false, reason: "OPEN_ENDPOINT_COUNT" };
        if (balanced && openEndpoints.length !== 0) return { valid: false, reason: "OPEN_ENDPOINT_COUNT" };

        const components = [];
        const unseen = new Set(runtime.order);
        while (unseen.size) {
            let start = Infinity;
            for (const id of unseen) if (id < start) start = id;
            const stack = [start];
            const ids = [];
            unseen.delete(start);
            while (stack.length) {
                const current = stack.pop();
                ids.push(current);
                for (const next of adjacency.get(current)) {
                    if (!unseen.delete(next)) continue;
                    stack.push(next);
                }
            }
            ids.sort((left, right) => left - right);
            components.push(ids);
        }
        components.sort((left, right) => left[0] - right[0]);
        const componentById = new Map();
        components.forEach((ids, componentIndex) => ids.forEach(id => componentById.set(id, componentIndex)));
        return {
            valid: true,
            balanced,
            pending,
            openEndpoints,
            componentCount: components.length,
            componentSizes: components.map(ids => ids.length).sort((left, right) => left - right),
            components,
            componentById,
            adjacency
        };
    }

    function compactState(runtime, removedInput, addedInput) {
        const removedEdgeKeys = removedInput.slice().sort(compareEdgeKeys);
        const addedEdgeKeys = addedInput.slice().sort(compareEdgeKeys);
        const topology = analyzeCompactTopology(runtime, removedEdgeKeys, addedEdgeKeys);
        if (!topology.valid) return topology;
        const delta = edgeSetDelta(runtime, removedEdgeKeys, addedEdgeKeys);
        return {
            valid: true,
            key: stateKeyOf(removedEdgeKeys, addedEdgeKeys),
            depth: removedEdgeKeys.length,
            removedEdgeKeys,
            addedEdgeKeys,
            openEndpoints: topology.openEndpoints,
            deltaTsplib: delta.tsplib,
            deltaRaw: delta.raw
        };
    }

    function currentEdgePresent(runtime, state, key) {
        if (state.addedEdgeKeys.includes(key)) return true;
        return runtime.baseEdges.has(key) && !state.removedEdgeKeys.includes(key);
    }

    function setsOverlap(left, right) {
        return left.some(value => right.includes(value));
    }

    function makeCounters(runtime) {
        const expansionLimit = runtime.order.length * PAIRED_REPAIR_POLICY.halfDepth * PAIRED_REPAIR_POLICY.beamWidth;
        return {
            halfStateExpansionCount: 0,
            halfStateExpansionLimit: expansionLimit,
            candidateVisitCount: 0,
            candidateVisitLimit: expansionLimit * PAIRED_REPAIR_POLICY.candidateCap,
            uniqueHalfStateCount: 0,
            indexedHalfStateCount: 0,
            duplicateHalfStateCount: 0,
            duplicateOrientationCount: 0,
            invalidHalfStateCount: 0,
            beamTruncationCount: 0,
            joinProbeCount: 0,
            joinConflictCount: 0,
            joinDepthRejectCount: 0,
            joinedSingleCycleCount: 0,
            repairRequiredCount: 0,
            repairProbeCount: 0,
            repairComplementMissCount: 0,
            repairConflictCount: 0,
            repairCycleRejectCount: 0,
            repairFinalistCount: 0,
            objectiveRejectCount: 0,
            finalistUpdateCount: 0,
            candidateCapPruneCount: runtime.candidateCapPruneCount,
            eligibleEdgeCount: runtime.eligibleEdgeCount,
            candidateEdgeCount: runtime.candidateEdges.length
        };
    }

    function registerHalfState(state, compact, activeEndpoint, fixedEndpoint) {
        if (!compact.valid || compact.openEndpoints.length !== 2) {
            state.counters.invalidHalfStateCount++;
            return null;
        }
        if (!state.halfStateTable.has(compact.key)) {
            state.halfStateTable.set(compact.key, compact);
            state.orientationKeys.set(compact.key, []);
            state.counters.uniqueHalfStateCount++;
        } else {
            state.counters.duplicateHalfStateCount++;
        }
        const orientation = `${activeEndpoint}>${fixedEndpoint}`;
        const orientations = state.orientationKeys.get(compact.key);
        if (orientations.includes(orientation)) {
            state.counters.duplicateOrientationCount++;
            return null;
        }
        orientations.push(orientation);
        return { stateKey: compact.key, activeEndpoint, fixedEndpoint };
    }

    function indexHalfState(state, key) {
        if (state.indexedStateKeys.includes(key)) return;
        const compact = state.halfStateTable.get(key);
        const bucketKey = endpointKey(compact.openEndpoints[0], compact.openEndpoints[1]);
        const bucket = state.endpointIndex.get(bucketKey) || [];
        bucket.push(key);
        bucket.sort(compareKeyStrings);
        state.endpointIndex.set(bucketKey, bucket);
        state.indexedStateKeys.push(key);
        state.counters.indexedHalfStateCount++;
    }

    function compareFrontierEntries(left, right, table) {
        const a = table.get(left.stateKey);
        const b = table.get(right.stateKey);
        return a.deltaTsplib - b.deltaTsplib
            || (Math.abs(a.deltaRaw - b.deltaRaw) <= PAIRED_REPAIR_RAW_EPSILON ? 0 : a.deltaRaw - b.deltaRaw)
            || compareKeyStrings(a.key, b.key)
            || left.activeEndpoint - right.activeEndpoint
            || left.fixedEndpoint - right.fixedEndpoint;
    }

    /**
     * Bir yarı zinciri bir kenar daha ekleyip bir kenar çıkararak derinleştirir.
     * Zincirin sabit ucu yerinde kalır, aktif ucu aday grafiği üzerinden yürür.
     */
    function expandHalfState(runtime, state, entry) {
        const compact = state.halfStateTable.get(entry.stateKey);
        state.counters.halfStateExpansionCount++;
        const parentTopology = analyzeCompactTopology(runtime, compact.removedEdgeKeys, compact.addedEdgeKeys);
        if (!parentTopology.valid) return;

        for (const candidate of runtime.neighborsById.get(entry.activeEndpoint) || []) {
            state.counters.candidateVisitCount++;
            if (state.counters.candidateVisitCount > state.counters.candidateVisitLimit) {
                state.scopeBound = "CANDIDATE_VISIT_LIMIT";
                return;
            }
            const target = candidate.otherSourceId;
            if (target === entry.fixedEndpoint
                || compact.removedEdgeKeys.includes(candidate.edgeKey)
                || currentEdgePresent(runtime, compact, candidate.edgeKey)) {
                continue;
            }
            if ((parentTopology.degrees.get(target) ?? 2) !== 2) continue;
            const removable = runtime.baseNeighbors.get(target)
                .map(other => edgeKeyOf(target, other))
                .filter(key => runtime.baseEdges.has(key) && currentEdgePresent(runtime, compact, key))
                .sort(compareEdgeKeys);
            for (const removedKey of removable) {
                const child = compactState(
                    runtime,
                    compact.removedEdgeKeys.concat(removedKey),
                    compact.addedEdgeKeys.concat(candidate.edgeKey));
                if (!child.valid || child.depth > PAIRED_REPAIR_POLICY.halfDepth) {
                    state.counters.invalidHalfStateCount++;
                    continue;
                }
                const childTopology = analyzeCompactTopology(runtime, child.removedEdgeKeys, child.addedEdgeKeys);
                if (!childTopology.valid || !childTopology.pending || childTopology.componentCount !== 1
                    || !child.openEndpoints.includes(entry.fixedEndpoint)) {
                    state.counters.invalidHalfStateCount++;
                    continue;
                }
                const activeEndpoint = child.openEndpoints.find(id => id !== entry.fixedEndpoint);
                const childEntry = registerHalfState(state, child, activeEndpoint, entry.fixedEndpoint);
                if (childEntry) state.nextFrontier.push(childEntry);
            }
        }
    }

    function enumerateHalfStates(runtime, state, shouldStop) {
        for (const rootKey of runtime.rootEdgeKeys) {
            const [left, right] = edgePair(rootKey);
            const compact = compactState(runtime, [rootKey], []);
            if (!compact.valid) throw new Error(`Invalid paired-repair root ${rootKey}: ${compact.reason}`);
            let frontier = [
                registerHalfState(state, compact, left, right),
                registerHalfState(state, compact, right, left)
            ].filter(Boolean);
            indexHalfState(state, compact.key);

            for (let depth = 1; depth < PAIRED_REPAIR_POLICY.halfDepth && frontier.length; depth++) {
                state.nextFrontier = [];
                for (const entry of frontier) {
                    if (state.scopeBound) return;
                    if (shouldStop?.()) {
                        state.scopeBound = "STOP_REQUESTED";
                        return;
                    }
                    if (state.counters.halfStateExpansionCount >= state.counters.halfStateExpansionLimit) {
                        state.scopeBound = "HALF_STATE_EXPANSION_LIMIT";
                        return;
                    }
                    expandHalfState(runtime, state, entry);
                }
                state.nextFrontier.sort((a, b) => compareFrontierEntries(a, b, state.halfStateTable));
                if (state.nextFrontier.length > PAIRED_REPAIR_POLICY.beamWidth) {
                    state.counters.beamTruncationCount++;
                    state.nextFrontier.length = PAIRED_REPAIR_POLICY.beamWidth;
                }
                frontier = state.nextFrontier;
                for (const entry of frontier) indexHalfState(state, entry.stateKey);
            }
        }
    }

    function analyzeJoinedTopology(runtime, removedEdgeKeys, addedEdgeKeys) {
        const cutIndices = removedEdgeKeys.map(key => runtime.baseEdgeIndex.get(key))
            .sort((left, right) => left - right);
        const arcStarts = [];
        const arcEnds = [];
        const arcLengths = [];
        for (let index = 0; index < cutIndices.length; index++) {
            const cutIndex = cutIndices[index];
            const nextCut = cutIndices[(index + 1) % cutIndices.length];
            const startIndex = (cutIndex + 1) % runtime.order.length;
            arcStarts.push(runtime.order[startIndex]);
            arcEnds.push(runtime.order[nextCut]);
            arcLengths.push(((nextCut - startIndex + runtime.order.length) % runtime.order.length) + 1);
        }
        const arcForEndpoint = id => {
            for (let index = 0; index < arcStarts.length; index++) {
                if (arcStarts[index] === id || arcEnds[index] === id) return index;
            }
            return -1;
        };
        const parent = cutIndices.map((_, index) => index);
        const find = input => {
            while (parent[input] !== input) {
                parent[input] = parent[parent[input]];
                input = parent[input];
            }
            return input;
        };
        for (const key of addedEdgeKeys) {
            const [leftId, rightId] = edgePair(key);
            let leftArc = arcForEndpoint(leftId);
            let rightArc = arcForEndpoint(rightId);
            if (leftArc < 0 || rightArc < 0) return { valid: false };
            leftArc = find(leftArc);
            rightArc = find(rightArc);
            if (leftArc !== rightArc) parent[Math.max(leftArc, rightArc)] = Math.min(leftArc, rightArc);
        }
        const sizes = new Map();
        for (let index = 0; index < arcLengths.length; index++) {
            const arcRoot = find(index);
            sizes.set(arcRoot, (sizes.get(arcRoot) || 0) + arcLengths[index]);
        }
        return {
            valid: true,
            componentCount: sizes.size,
            componentSizes: [...sizes.values()].sort((left, right) => left - right)
        };
    }

    function buildJoinedState(runtime, state, left, right, bridgeEdgeKeys) {
        if (left.depth + right.depth > PAIRED_REPAIR_POLICY.maxExchangeDepth) {
            state.counters.joinDepthRejectCount++;
            return null;
        }
        if (setsOverlap(left.removedEdgeKeys, right.removedEdgeKeys)
            || setsOverlap(left.addedEdgeKeys, right.addedEdgeKeys)
            || setsOverlap(left.removedEdgeKeys, right.addedEdgeKeys)
            || setsOverlap(right.removedEdgeKeys, left.addedEdgeKeys)) {
            state.counters.joinConflictCount++;
            return null;
        }
        const removedEdgeKeys = left.removedEdgeKeys.concat(right.removedEdgeKeys).sort(compareEdgeKeys);
        const addedEdgeKeys = left.addedEdgeKeys.concat(right.addedEdgeKeys, bridgeEdgeKeys).sort(compareEdgeKeys);
        if (new Set(bridgeEdgeKeys).size !== 2
            || new Set(removedEdgeKeys).size !== removedEdgeKeys.length
            || new Set(addedEdgeKeys).size !== addedEdgeKeys.length
            || setsOverlap(removedEdgeKeys, addedEdgeKeys)) {
            state.counters.joinConflictCount++;
            return null;
        }
        const topology = analyzeJoinedTopology(runtime, removedEdgeKeys, addedEdgeKeys);
        if (!topology.valid) {
            state.counters.joinConflictCount++;
            return null;
        }
        return {
            key: stateKeyOf(removedEdgeKeys, addedEdgeKeys),
            removedEdgeKeys,
            addedEdgeKeys,
            componentCount: topology.componentCount,
            componentSizes: topology.componentSizes,
            lineage: {
                leftHalfStateKey: left.key,
                rightHalfStateKey: right.key,
                bridgeEdgeKeys: bridgeEdgeKeys.slice().sort(compareEdgeKeys)
            }
        };
    }

    /**
     * İki bileşene ayrılmış diff'i tek tura kapatmak için iki kenarlık onarım
     * dener: bileşenleri bağlayan bir aday kenar ve onun tümleyeni eklenirken
     * uçlarındaki iki mevcut kenar çıkarılır.
     */
    function normalizeRepairPatch(runtime, joined, firstRemoved, secondRemoved, firstAdded, secondAdded) {
        const removed = new Set(joined.removedEdgeKeys);
        const added = new Set(joined.addedEdgeKeys);
        const removeCurrent = key => {
            if (added.delete(key)) return true;
            if (runtime.baseEdges.has(key) && !removed.has(key)) {
                removed.add(key);
                return true;
            }
            return false;
        };
        const addCurrent = key => {
            if (removed.delete(key)) return true;
            if (runtime.baseEdges.has(key) || added.has(key)) return false;
            added.add(key);
            return true;
        };
        if (!removeCurrent(firstRemoved) || !removeCurrent(secondRemoved)
            || !addCurrent(firstAdded) || !addCurrent(secondAdded)) return null;
        const removedEdgeKeys = [...removed].sort(compareEdgeKeys);
        const addedEdgeKeys = [...added].sort(compareEdgeKeys);
        const limit = PAIRED_REPAIR_POLICY.maxExchangeDepth + PAIRED_REPAIR_POLICY.repairDepth;
        if (removedEdgeKeys.length > limit || addedEdgeKeys.length > limit
            || removedEdgeKeys.length !== addedEdgeKeys.length) return null;
        return { removedEdgeKeys, addedEdgeKeys };
    }

    function processRepairProbe(runtime, state, joined, topology, candidate, choiceIndex) {
        state.counters.repairProbeCount++;
        const leftNeighbors = topology.adjacency.get(candidate.sourceA);
        const rightNeighbors = topology.adjacency.get(candidate.sourceB);
        const leftOther = leftNeighbors[Math.floor(choiceIndex / 2)];
        const rightOther = rightNeighbors[choiceIndex % 2];
        if (leftOther === candidate.sourceB || rightOther === candidate.sourceA || leftOther === rightOther) {
            state.counters.repairConflictCount++;
            return;
        }
        const firstRemoved = edgeKeyOf(candidate.sourceA, leftOther);
        const secondRemoved = edgeKeyOf(candidate.sourceB, rightOther);
        const complement = edgeKeyOf(leftOther, rightOther);
        if (!runtime.candidateEdgeSet.has(complement)) {
            state.counters.repairComplementMissCount++;
            return;
        }
        const patch = normalizeRepairPatch(
            runtime, joined, firstRemoved, secondRemoved, candidate.edgeKey, complement);
        if (!patch) {
            state.counters.repairConflictCount++;
            return;
        }
        const topologyAfter = analyzeDiff(runtime, patch.removedEdgeKeys, patch.addedEdgeKeys);
        if (!topologyAfter.valid || topologyAfter.componentCount !== 1 || !topologyAfter.balanced) {
            state.counters.repairCycleRejectCount++;
            return;
        }
        const delta = edgeSetDelta(runtime, patch.removedEdgeKeys, patch.addedEdgeKeys);
        const lengths = {
            tsplib: state.initialLengths.tsplib + delta.tsplib,
            raw: state.initialLengths.raw + delta.raw
        };
        state.counters.repairFinalistCount++;
        if (compareLengths(lengths, state.initialLengths) >= 0) {
            state.counters.objectiveRejectCount++;
            return;
        }
        const key = stateKeyOf(patch.removedEdgeKeys, patch.addedEdgeKeys);
        const finalist = {
            key,
            removedEdgeKeys: patch.removedEdgeKeys,
            addedEdgeKeys: patch.addedEdgeKeys,
            deltaTsplib: delta.tsplib,
            deltaRaw: delta.raw,
            lengths,
            lineage: {
                ...joined.lineage,
                joinedComponentSizes: joined.componentSizes,
                repairAddedEdgeKeys: [candidate.edgeKey, complement].sort(compareEdgeKeys),
                repairRemovedEdgeKeys: [firstRemoved, secondRemoved].sort(compareEdgeKeys)
            }
        };
        const comparison = state.bestFinalist ? compareLengths(finalist.lengths, state.bestFinalist.lengths) : -1;
        if (!state.bestFinalist || comparison < 0
            || (comparison === 0 && compareKeyStrings(finalist.key, state.bestFinalist.key) < 0)) {
            state.bestFinalist = finalist;
            state.counters.finalistUpdateCount++;
        }
    }

    function processJoinedRepair(runtime, state, joined) {
        const topology = analyzeDiff(runtime, joined.removedEdgeKeys, joined.addedEdgeKeys);
        if (!topology.valid || topology.componentCount !== 2) {
            state.counters.repairCycleRejectCount++;
            return;
        }
        const candidate = runtime.candidateEdges.find(edge =>
            topology.componentById.get(edge.sourceA) !== topology.componentById.get(edge.sourceB)
            && !currentEdgePresent(runtime, joined, edge.edgeKey));
        if (!candidate) {
            state.counters.repairComplementMissCount++;
            return;
        }
        for (let choiceIndex = 0; choiceIndex < 4; choiceIndex++) {
            if (state.counters.repairProbeCount >= PAIRED_REPAIR_POLICY.repairProbeLimit) {
                state.scopeBound = "REPAIR_PROBE_LIMIT";
                return;
            }
            processRepairProbe(runtime, state, joined, topology, candidate, choiceIndex);
        }
    }

    /**
     * Derinliği tam olan yarı zincirleri, iki köprü kenarının serbest uçlarına
     * göre kurulmuş endpoint tablosu üzerinden eşleştirir. Eşleşme yalnız ileri
     * yönde taranır; böylece her çift bir kez denenir.
     */
    function joinHalfStates(runtime, state, shouldStop) {
        state.joinStateKeys = state.indexedStateKeys.slice().sort((leftKey, rightKey) => {
            const left = state.halfStateTable.get(leftKey);
            const right = state.halfStateTable.get(rightKey);
            return right.depth - left.depth
                || compareKeyStrings(
                    endpointKey(left.openEndpoints[0], left.openEndpoints[1]),
                    endpointKey(right.openEndpoints[0], right.openEndpoints[1]))
                || compareKeyStrings(leftKey, rightKey);
        });
        const joinStateRank = new Map(state.joinStateKeys.map((key, index) => [key, index]));
        for (const bucket of state.endpointIndex.values()) {
            bucket.sort((left, right) => joinStateRank.get(left) - joinStateRank.get(right));
        }

        for (const leftKey of state.joinStateKeys) {
            const left = state.halfStateTable.get(leftKey);
            if (left.depth !== PAIRED_REPAIR_POLICY.halfDepth) break;
            const leftRank = joinStateRank.get(leftKey);
            const neighborsA = runtime.neighborsById.get(left.openEndpoints[0]) || [];
            const neighborsB = runtime.neighborsById.get(left.openEndpoints[1]) || [];
            for (const candidateA of neighborsA) {
                if (state.scopeBound) return;
                for (const candidateB of neighborsB) {
                    if (candidateA.otherSourceId === candidateB.otherSourceId) continue;
                    if (state.counters.joinProbeCount >= PAIRED_REPAIR_POLICY.joinProbeLimit) {
                        state.scopeBound = "JOIN_PROBE_LIMIT";
                        return;
                    }
                    if (shouldStop?.()) {
                        state.scopeBound = "STOP_REQUESTED";
                        return;
                    }
                    const bucket = state.endpointIndex.get(
                        endpointKey(candidateA.otherSourceId, candidateB.otherSourceId)) || [];
                    const bridgeEdgeKeys = [candidateA.edgeKey, candidateB.edgeKey].sort(compareEdgeKeys);
                    state.counters.joinProbeCount++;
                    for (const rightKey of bucket) {
                        if (joinStateRank.get(rightKey) <= leftRank) continue;
                        const right = state.halfStateTable.get(rightKey);
                        if (right.depth !== PAIRED_REPAIR_POLICY.halfDepth) continue;
                        const joined = buildJoinedState(runtime, state, left, right, bridgeEdgeKeys);
                        if (!joined) continue;
                        if (joined.componentCount === 1) {
                            state.counters.joinedSingleCycleCount++;
                            continue;
                        }
                        if (joined.componentCount !== 2) {
                            state.counters.joinConflictCount++;
                            continue;
                        }
                        state.counters.repairRequiredCount++;
                        processJoinedRepair(runtime, state, joined);
                        if (state.scopeBound) return;
                    }
                }
            }
        }
    }

    /**
     * Kazanan kenar farkını gerçek tur sırasına çevirir. İki yürüyüş yönünden,
     * mevcut turun yönüyle daha çok örtüşeni seçilir; böylece uygulanacak fark
     * gereksiz yere tüm turu ters çevirmez.
     */
    function materializeOrder(runtime, removedEdgeKeys, addedEdgeKeys) {
        const topology = analyzeDiff(runtime, removedEdgeKeys, addedEdgeKeys);
        if (!topology.valid || !topology.balanced || topology.componentCount !== 1) {
            throw new Error("Paired-repair finalist does not describe one degree-two cycle");
        }
        const start = runtime.order[0];
        const walk = firstNeighbor => {
            const order = [start];
            let previous = start;
            let current = firstNeighbor;
            while (current !== start && order.length <= runtime.order.length) {
                order.push(current);
                const neighbors = topology.adjacency.get(current);
                const next = neighbors[0] === previous ? neighbors[1] : neighbors[0];
                previous = current;
                current = next;
            }
            if (current !== start || order.length !== runtime.order.length
                || new Set(order).size !== order.length) {
                throw new Error("Paired-repair finalist failed Hamiltonian materialization");
            }
            return order;
        };
        const directedBase = new Set(runtime.order.map((id, index) =>
            `${id}>${runtime.order[(index + 1) % runtime.order.length]}`));
        const score = order => order.reduce((total, id, index) => total
            + (directedBase.has(`${id}>${order[(index + 1) % order.length]}`) ? 1 : 0), 0);
        const candidates = topology.adjacency.get(start).slice()
            .sort((left, right) => left - right).map(walk);
        candidates.sort((left, right) => score(right) - score(left) || compareNumberArrays(left, right));
        return candidates[0];
    }

    /**
     * Sınırlı arama: yarı zincirleri say, eşleştir, onar ve turu kısaltan tek en
     * iyi sonucu döndür. Dünyaya hiçbir şey yazmaz.
     */
    function findPairedChainRepair(world, order, options = {}) {
        const runtime = createRuntime(world, order, options);
        const state = {
            scopeBound: null,
            initialLengths: { ...runtime.initialLengths },
            bestFinalist: null,
            halfStateTable: new Map(),
            orientationKeys: new Map(),
            indexedStateKeys: [],
            endpointIndex: new Map(),
            joinStateKeys: [],
            nextFrontier: [],
            counters: makeCounters(runtime)
        };
        const deadline = Number.isFinite(options.timeLimitMs)
            ? (typeof performance === "object" ? performance.now() : Date.now()) + options.timeLimitMs
            : null;
        const shouldStop = deadline === null
            ? null
            : () => (typeof performance === "object" ? performance.now() : Date.now()) >= deadline;

        enumerateHalfStates(runtime, state, shouldStop);
        if (!state.scopeBound) joinHalfStates(runtime, state, shouldStop);

        const result = {
            runtime,
            scopeBound: state.scopeBound,
            initialLengths: state.initialLengths,
            bestLengths: { ...state.initialLengths },
            bestFinalist: state.bestFinalist,
            bestOrder: null,
            counters: state.counters,
            deltaDrift: { tsplib: 0, raw: 0 }
        };
        if (!state.bestFinalist) return result;

        const bestOrder = materializeOrder(
            runtime, state.bestFinalist.removedEdgeKeys, state.bestFinalist.addedEdgeKeys);
        const full = {
            tsplib: tourLength(bestOrder, runtime.points),
            raw: tourLengthRaw(bestOrder, runtime.points)
        };
        const drift = {
            tsplib: Math.abs(full.tsplib - state.bestFinalist.lengths.tsplib),
            raw: Math.abs(full.raw - state.bestFinalist.lengths.raw)
        };
        if (drift.tsplib !== 0 || drift.raw > PAIRED_REPAIR_DELTA_TOLERANCE) {
            throw new Error(`Paired-repair finalist delta drift: raw=${drift.raw} tsplib=${drift.tsplib}`);
        }
        result.bestOrder = bestOrder;
        result.bestLengths = full;
        result.deltaDrift = drift;
        return result;
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
     * Aday grafiği görünürlükten kurulduğu için arama öncesi ObjectOcc çalıştırır,
     * bulunan tek en iyi sonucu kesişim denetiminden geçirip tek işlem olarak uygular.
     */
    function optimizePairedChainRepair(world, options = {}) {
        const points = world.totalNoktaList;
        const startPoint = options.startPoint || points[options.startNodeId ?? 4];
        if (!startPoint) throw new RangeError("A current route start point is required");
        if (options.prepareVisibility !== false) objectOcc(world);
        const beforeOrder = tourOrderFromBags(startPoint, world);
        const search = findPairedChainRepair(world, beforeOrder, options);

        const report = {
            committed: false,
            reason: "NO_IMPROVEMENT",
            scopeBound: search.scopeBound,
            initialTsplibLength: search.initialLengths.tsplib,
            initialLength: search.initialLengths.raw,
            finalTsplibLength: search.initialLengths.tsplib,
            finalLength: search.initialLengths.raw,
            move: null,
            geometry: { checkedPairCount: 0, crossingCount: 0 },
            counters: search.counters
        };
        if (!search.bestOrder) return report;

        report.move = {
            removedEdgeKeys: search.bestFinalist.removedEdgeKeys,
            addedEdgeKeys: search.bestFinalist.addedEdgeKeys,
            exchangeDepth: search.bestFinalist.removedEdgeKeys.length,
            deltaTsplib: search.bestFinalist.deltaTsplib,
            deltaRaw: search.bestFinalist.deltaRaw,
            lineage: search.bestFinalist.lineage
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
        PAIRED_REPAIR_POLICY,
        PAIRED_REPAIR_RAW_EPSILON,
        analyzePairedRepairDiff: analyzeDiff,
        buildVisibilityCandidateGraph,
        findPairedChainRepair,
        materializePairedChainOrder: materializeOrder,
        optimizePairedChainRepair
    };
});
