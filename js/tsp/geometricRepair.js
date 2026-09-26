(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    Object.assign(root, api);
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const GEOMETRIC_REPAIR_EPSILON = 1e-9;
    const GEOMETRIC_REPAIR_POLICY = Object.freeze({
        objectiveMode: "EUCLIDEAN_RAW",
        projectionDirections: 4,
        projectionWindow: 2,
        candidateDegreeLimit: 16,
        halfDepth: 3,
        maxExchangeDepth: 6,
        endpointBucketWidth: 128,
        joinProbeFactor: 131072,
        validationFactor: 64,
        totalWorkFactor: 8192
    });

    /**
     * `String.prototype.localeCompare` with options rebuilds a collator on every
     * call. One cached `Intl.Collator("en", { numeric: true })` is the same
     * comparison by specification and keeps every tie-break order unchanged.
     */
    const compareNumericText = typeof Intl === "object" && typeof Intl.Collator === "function"
        ? new Intl.Collator("en", { numeric: true }).compare
        : (left, right) => left.localeCompare(right, "en", { numeric: true });

    function edgeKey(a, b) {
        if (a === b) throw new RangeError("A repair edge cannot be a self-loop");
        return a < b ? `${a}:${b}` : `${b}:${a}`;
    }

    function edgePair(key) {
        const pair = String(key).split(":").map(Number);
        if (pair.length !== 2 || !pair.every(Number.isSafeInteger) || pair[0] === pair[1]) {
            throw new TypeError(`Invalid repair edge key: ${key}`);
        }
        return pair;
    }

    function compareEdgeKeys(left, right) {
        const [leftA, leftB] = edgePair(left);
        const [rightA, rightB] = edgePair(right);
        return leftA - rightA || leftB - rightB;
    }

    /** Hoisted so the bounded search does not allocate one closure per sort call. */
    const compareNumbers = (left, right) => left - right;

    /**
     * One packing serves both the internal edge id and the join loop's endpoint
     * bucket index: an unordered point pair maps to `min * pointCount + max`.
     * Sorting by that id reproduces the compareEdgeKeys lexicographic order without
     * re-parsing strings, and the bucket lookup needs no string at all. The packing
     * is injective only over this world's point ids - never source ids - which is
     * what validatePackedEdgeDomain establishes once per run for both uses.
     */
    function packedEdgeId(pointCount, left, right) {
        return left < right ? left * pointCount + right : right * pointCount + left;
    }

    function packedEdgePair(pointCount, id) {
        const left = Math.floor(id / pointCount);
        return [left, id - left * pointCount];
    }

    function validatePackedEdgeDomain(points, order) {
        const pointCount = points.length;
        if (!Number.isSafeInteger(pointCount * pointCount)) {
            throw new RangeError("Geometric Repair packed edge ids would lose precision");
        }
        for (const id of order) {
            if (!Number.isSafeInteger(id) || id < 0 || id >= pointCount) {
                throw new RangeError("Geometric Repair route contains an unpackable point id");
            }
        }
        return pointCount;
    }

    /**
     * The join loop addresses its buckets with packedEdgeId rather than this key,
     * so no string is built per bridge pair; the textual form is what the optional
     * trace reports.
     */
    function endpointKey(left, right) {
        return left < right ? `${left}:${right}` : `${right}:${left}`;
    }

    function pointPosition(points, id, metric) {
        const point = points[id];
        if (!point) throw new RangeError(`Missing repair point ${id}`);
        return metric ? (point.metricPosition || point.kendiYeri) : point.kendiYeri;
    }

    function rawLength(points, left, right) {
        const a = pointPosition(points, left, true);
        const b = pointPosition(points, right, true);
        return Math.hypot(a.x - b.x, a.y - b.y);
    }

    function sourceEdgeKey(points, key) {
        const [left, right] = edgePair(key);
        const sourceLeft = points[left]?.sourcePointId ?? left;
        const sourceRight = points[right]?.sourcePointId ?? right;
        return sourceLeft < sourceRight
            ? `${sourceLeft}:${sourceRight}`
            : `${sourceRight}:${sourceLeft}`;
    }

    function objectOccVisible(world, left, right) {
        const a = world.totalNoktaList[left];
        const b = world.totalNoktaList[right];
        if (!a || !b) return false;
        const mutuallyVisible = a.visibleList.get(right) === true && b.visibleList.get(left) === true;
        const ray = typeof getPointRay === "function"
            ? getPointRay(world, left, right)
            : world.pointRayIndex?.get(edgeKey(left, right));
        return mutuallyVisible && !!ray;
    }

    /**
     * Four fixed projection axes represent eight directions. Connecting only the
     * two predecessors and successors on each sorted axis gives maximum degree 16.
     * The graph is built in O(n log n) and never scans all point pairs or all rays.
     */
    function buildProjectionCandidateGraph(world, order, options = {}) {
        const directions = options.projectionDirections ?? GEOMETRIC_REPAIR_POLICY.projectionDirections;
        const window = options.projectionWindow ?? GEOMETRIC_REPAIR_POLICY.projectionWindow;
        if (directions !== GEOMETRIC_REPAIR_POLICY.projectionDirections
            || window !== GEOMETRIC_REPAIR_POLICY.projectionWindow) {
            throw new Error("Geometric Repair projection policy is frozen");
        }
        const points = world.totalNoktaList;
        const routeEdges = new Set(order.map((id, index) => edgeKey(id, order[(index + 1) % order.length])));
        const proposalKeys = new Set();
        let projectionProposalCount = 0;
        for (let direction = 0; direction < directions; direction++) {
            const angle = Math.PI * direction / directions;
            const dx = Math.cos(angle);
            const dy = Math.sin(angle);
            const sorted = order.slice().sort((left, right) => {
                const a = pointPosition(points, left, true);
                const b = pointPosition(points, right, true);
                const projectionDelta = (a.x * dx + a.y * dy) - (b.x * dx + b.y * dy);
                return projectionDelta || left - right;
            });
            for (let index = 0; index < sorted.length; index++) {
                for (let offset = 1; offset <= window; offset++) {
                    for (const candidateIndex of [index - offset, index + offset]) {
                        if (candidateIndex < 0 || candidateIndex >= sorted.length) continue;
                        projectionProposalCount++;
                        proposalKeys.add(edgeKey(sorted[index], sorted[candidateIndex]));
                    }
                }
            }
        }

        const edges = [];
        let routeEdgeRejectCount = 0;
        let visibilityRejectCount = 0;
        for (const key of [...proposalKeys].sort(compareEdgeKeys)) {
            if (routeEdges.has(key)) {
                routeEdgeRejectCount++;
                continue;
            }
            const [left, right] = edgePair(key);
            if (!objectOccVisible(world, left, right)) {
                visibilityRejectCount++;
                continue;
            }
            edges.push(Object.freeze({
                edgeKey: key,
                sourceA: left,
                sourceB: right,
                raw: rawLength(points, left, right)
            }));
        }
        edges.sort((left, right) => left.raw - right.raw || compareEdgeKeys(left.edgeKey, right.edgeKey));

        const neighborsById = new Map(order.map(id => [id, []]));
        for (const edge of edges) {
            neighborsById.get(edge.sourceA).push({
                edgeKey: edge.edgeKey,
                otherSourceId: edge.sourceB,
                raw: edge.raw
            });
            neighborsById.get(edge.sourceB).push({
                edgeKey: edge.edgeKey,
                otherSourceId: edge.sourceA,
                raw: edge.raw
            });
        }
        let maximumDegree = 0;
        for (const neighbors of neighborsById.values()) {
            neighbors.sort((left, right) => left.raw - right.raw
                || left.otherSourceId - right.otherSourceId
                || compareEdgeKeys(left.edgeKey, right.edgeKey));
            maximumDegree = Math.max(maximumDegree, neighbors.length);
        }
        if (maximumDegree > GEOMETRIC_REPAIR_POLICY.candidateDegreeLimit) {
            throw new Error("Projection candidate graph exceeded its proven degree bound");
        }
        return {
            edges,
            edgeSet: new Set(edges.map(edge => edge.edgeKey)),
            neighborsById,
            stats: {
                projectionProposalCount,
                uniqueProjectionEdgeCount: proposalKeys.size,
                routeEdgeRejectCount,
                visibilityRejectCount,
                candidateEdgeCount: edges.length,
                maximumDegree
            }
        };
    }

    function createRuntime(world, order, options) {
        const points = world.totalNoktaList;
        const pointCount = validatePackedEdgeDomain(points, order);
        const baseEdgesById = new Map();
        const baseEdgeIndexById = new Map();
        const baseNeighbors = new Map(order.map(id => [id, []]));
        const edgeCostsById = new Map();
        const edgeKeysById = Object.create(null);
        let initialLength = 0;
        for (let index = 0; index < order.length; index++) {
            const left = order[index];
            const right = order[(index + 1) % order.length];
            const key = edgeKey(left, right);
            const id = packedEdgeId(pointCount, left, right);
            const cost = rawLength(points, left, right);
            baseEdgesById.set(id, [left, right]);
            baseEdgeIndexById.set(id, index);
            baseNeighbors.get(left).push(right);
            baseNeighbors.get(right).push(left);
            edgeCostsById.set(id, cost);
            edgeKeysById[id] = key;
            initialLength += cost;
        }
        for (const neighbors of baseNeighbors.values()) neighbors.sort(compareNumbers);
        const graph = buildProjectionCandidateGraph(world, order, options);
        const candidateEdgeIdSet = new Set();
        for (const edge of graph.edges) {
            const id = packedEdgeId(pointCount, edge.sourceA, edge.sourceB);
            edgeCostsById.set(id, edge.raw);
            edgeKeysById[id] = edge.edgeKey;
            candidateEdgeIdSet.add(id);
        }
        // The candidate graph already ordered every adjacency list. Mapping those
        // lists carries the probe order over verbatim, so no second sort has to be
        // argued equivalent to the one buildProjectionCandidateGraph performed.
        const numericNeighborsById = new Map();
        for (const [id, neighbors] of graph.neighborsById) {
            numericNeighborsById.set(id, neighbors.map(neighbor => ({
                edgeId: packedEdgeId(pointCount, id, neighbor.otherSourceId),
                edgeKey: neighbor.edgeKey,
                otherSourceId: neighbor.otherSourceId,
                raw: neighbor.raw
            })));
        }

        let maxEdgeCost = 0;
        for (const cost of edgeCostsById.values()) {
            if (!Number.isFinite(cost) || cost < 0) {
                throw new RangeError("Geometric Repair requires finite non-negative edge costs");
            }
            if (cost > maxEdgeCost) maxEdgeCost = cost;
        }
        const deltaTermCount = 2 * GEOMETRIC_REPAIR_POLICY.maxExchangeDepth;
        const unitRoundoff = Number.EPSILON / 2;
        const gamma = (deltaTermCount - 1) * unitRoundoff
            / (1 - (deltaTermCount - 1) * unitRoundoff);
        const deltaRoundoff = 2 * gamma * deltaTermCount * maxEdgeCost;
        if (!(deltaRoundoff < GEOMETRIC_REPAIR_EPSILON)) {
            throw new Error("Geometric Repair incremental delta roundoff exceeds the improvement epsilon");
        }
        return {
            world,
            order,
            points,
            pointCount,
            captureTrace: options.captureTrace === true,
            baseNeighbors,
            baseEdgesById,
            baseEdgeIndexById,
            edgeCostsById,
            edgeKeysById,
            initialLength,
            candidateEdges: graph.edges,
            candidateEdgeSet: graph.edgeSet,
            neighborsById: graph.neighborsById,
            candidateEdgeIdSet,
            numericNeighborsById,
            graphStats: graph.stats
        };
    }

    function edgeSetDelta(runtime, removedEdgeIds, addedEdgeIds) {
        let delta = 0;
        for (const id of removedEdgeIds) delta -= runtime.edgeCostsById.get(id);
        for (const id of addedEdgeIds) delta += runtime.edgeCostsById.get(id);
        return delta;
    }

    /** Analyze at most five cuts as contracted route fragments; no full route walk. */
    function analyzeCompactTopology(runtime, removedInput, addedInput) {
        const removed = new Set(removedInput);
        const added = new Set(addedInput);
        if (removed.size !== removedInput.length || added.size !== addedInput.length) {
            return { valid: false, reason: "DUPLICATE_EDGE" };
        }
        for (const id of removed) {
            if (!runtime.baseEdgesById.has(id) || added.has(id)) {
                return { valid: false, reason: "INVALID_REMOVAL" };
            }
        }
        for (const id of added) {
            if (!runtime.candidateEdgeIdSet.has(id) || runtime.baseEdgesById.has(id)) {
                return { valid: false, reason: "OUTSIDE_CANDIDATE_GRAPH" };
            }
        }
        const balanced = removed.size === added.size;
        const pending = removed.size === added.size + 1;
        if (!balanced && !pending) return { valid: false, reason: "UNBALANCED_DIFF" };

        // This is the innermost arithmetic of the whole search. packedEdgePair is
        // the same two operations, but it returns them in a fresh array; unpacking
        // in place keeps the degree pass allocation-free, and the scans below stay
        // off the intermediate arrays that spread, filter and map would build.
        const pointCount = runtime.pointCount;
        const degrees = new Map();
        for (const edgeId of removed) {
            const left = Math.floor(edgeId / pointCount);
            const right = edgeId - left * pointCount;
            degrees.set(left, (degrees.get(left) ?? 2) - 1);
            degrees.set(right, (degrees.get(right) ?? 2) - 1);
        }
        for (const edgeId of added) {
            const left = Math.floor(edgeId / pointCount);
            const right = edgeId - left * pointCount;
            degrees.set(left, (degrees.get(left) ?? 2) + 1);
            degrees.set(right, (degrees.get(right) ?? 2) + 1);
        }
        const openEndpoints = [];
        for (const [id, degree] of degrees) {
            if (degree < 1 || degree > 2) return { valid: false, reason: "ENDPOINT_DEGREE" };
            if (degree === 1) openEndpoints.push(id);
        }
        openEndpoints.sort(compareNumbers);
        if ((pending && openEndpoints.length !== 2) || (balanced && openEndpoints.length !== 0)) {
            return { valid: false, reason: "OPEN_ENDPOINT_COUNT" };
        }

        const cutIndices = [...removed].map(id => runtime.baseEdgeIndexById.get(id))
            .sort(compareNumbers);
        const arcs = cutIndices.map((cutIndex, arcIndex) => {
            const nextCut = cutIndices[(arcIndex + 1) % cutIndices.length];
            const startIndex = (cutIndex + 1) % runtime.order.length;
            return {
                index: arcIndex,
                startId: runtime.order[startIndex],
                endId: runtime.order[nextCut]
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
        for (const id of added) {
            const [left, right] = packedEdgePair(runtime.pointCount, id);
            const leftArc = endpointToArc.get(left);
            const rightArc = endpointToArc.get(right);
            if (leftArc === undefined || rightArc === undefined) {
                return { valid: false, reason: "ADDED_EDGE_NOT_ON_OPEN_ARC" };
            }
            const leftRoot = find(leftArc);
            const rightRoot = find(rightArc);
            if (leftRoot !== rightRoot) parent[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
        }
        return {
            valid: true,
            balanced,
            pending,
            openEndpoints,
            componentCount: new Set(arcs.map(arc => find(arc.index))).size,
            degrees
        };
    }

    function edgeKeyFromId(runtime, id) {
        const cached = runtime.edgeKeysById[id];
        if (cached !== undefined) return cached;
        const [left, right] = packedEdgePair(runtime.pointCount, id);
        return edgeKey(left, right);
    }

    function edgeKeysFromIds(runtime, ids) {
        return ids.map(id => edgeKeyFromId(runtime, id));
    }

    function stateKey(runtime, removedEdgeIds, addedEdgeIds) {
        return `R:${edgeKeysFromIds(runtime, removedEdgeIds).join(",")}`
            + `|A:${edgeKeysFromIds(runtime, addedEdgeIds).join(",")}`;
    }

    /**
     * The half of a compact state that only a survivor needs. It is split out
     * because analyzeCompactTopology already answers every question the expansion
     * loop rejects on, while the key, the touched-id merge and the delta re-sum
     * below are pure cost for a state that is about to be discarded.
     */
    function finishCompactState(runtime, removedEdgeIds, addedEdgeIds, topology) {
        const touchedEdgeIds = removedEdgeIds.concat(addedEdgeIds).sort(compareNumbers);
        return {
            valid: true,
            key: stateKey(runtime, removedEdgeIds, addedEdgeIds),
            depth: removedEdgeIds.length,
            removedEdgeIds,
            addedEdgeIds,
            touchedEdgeIds,
            openEndpoints: topology.openEndpoints,
            deltaRaw: edgeSetDelta(runtime, removedEdgeIds, addedEdgeIds),
            // The expansion loop needs this same analysis for the parent and the
            // child; it is read-only and may be shared by sibling orientations.
            topology
        };
    }

    function compactState(runtime, removedInput, addedInput) {
        const removedEdgeIds = removedInput.slice().sort(compareNumbers);
        const addedEdgeIds = addedInput.slice().sort(compareNumbers);
        const topology = analyzeCompactTopology(runtime, removedEdgeIds, addedEdgeIds);
        if (!topology.valid) return topology;
        return finishCompactState(runtime, removedEdgeIds, addedEdgeIds, topology);
    }

    function currentEdgePresent(runtime, state, id) {
        return state.addedEdgeIds.includes(id)
            || (runtime.baseEdgesById.has(id) && !state.removedEdgeIds.includes(id));
    }

    function compareStates(left, right) {
        return left.deltaRaw - right.deltaRaw
            || left.depth - right.depth
            || compareNumericText(left.key, right.key)
            || left.activeEndpoint - right.activeEndpoint
            || left.fixedEndpoint - right.fixedEndpoint;
    }

    function makeSearchCounters(runtime) {
        const n = runtime.order.length;
        const branch = GEOMETRIC_REPAIR_POLICY.candidateDegreeLimit * 2;
        let statesPerRoot = 0;
        for (let depth = 0; depth < GEOMETRIC_REPAIR_POLICY.halfDepth; depth++) {
            statesPerRoot += branch ** depth;
        }
        const halfStateExpansionLimit = 2 * n * statesPerRoot;
        const joinProbeLimit = Math.ceil(GEOMETRIC_REPAIR_POLICY.joinProbeFactor * n ** 0.7);
        const validationLimit = Math.ceil(GEOMETRIC_REPAIR_POLICY.validationFactor * n ** 0.7);
        const totalWorkLimit = Math.ceil(GEOMETRIC_REPAIR_POLICY.totalWorkFactor * n ** 1.7);
        const preprocessingWorkCount = runtime.graphStats.projectionProposalCount
            + runtime.graphStats.uniqueProjectionEdgeCount
            + runtime.graphStats.candidateEdgeCount
            + 2 * n;
        return {
            ...runtime.graphStats,
            totalWorkCount: preprocessingWorkCount,
            totalWorkLimit,
            halfStateExpansionCount: 0,
            halfStateExpansionLimit,
            candidateVisitCount: 0,
            candidateVisitLimit: halfStateExpansionLimit * GEOMETRIC_REPAIR_POLICY.candidateDegreeLimit,
            uniqueHalfStateCount: 0,
            duplicateHalfStateCount: 0,
            invalidHalfStateCount: 0,
            endpointBucketPruneCount: 0,
            joinProbeCount: 0,
            joinProbeLimit,
            joinConflictCount: 0,
            topologyRejectCount: 0,
            deltaPrunedCandidateCount: 0,
            completeCandidateCount: 0,
            improvingCandidateCount: 0,
            duplicateFinalistCount: 0,
            validationCount: 0,
            validationLimit,
            visibilityQueryCount: 0,
            intersectionTestCount: 0,
            geometryRejectCount: 0,
            transactionAttemptCount: 0,
            transactionWorkReserve: 0,
            transactionSnapshotObjectCount: 0,
            randomKickCount: 0
        };
    }

    function consumeWork(counters, amount = 1) {
        if (counters.totalWorkCount + amount > counters.totalWorkLimit) return false;
        counters.totalWorkCount += amount;
        return true;
    }

    function enumerateHalfStates(runtime, counters) {
        const states = [];
        const orientations = new Set();
        // Different parents reach the same removed/added pair by adding the two
        // ids in a different order, and everything analyzeCompactTopology and
        // finishCompactState derive depends on that pair alone. Caching the
        // finished state keyed on it skips the repeat analysis; the one part of
        // the rejection that reads the parent stays outside the cache below.
        const compactByEdgeIds = new Map();
        const register = (compact, activeEndpoint, fixedEndpoint, traceSteps) => {
            if (!compact.valid || compact.openEndpoints.length !== 2
                || !compact.openEndpoints.includes(activeEndpoint)
                || !compact.openEndpoints.includes(fixedEndpoint)) {
                counters.invalidHalfStateCount++;
                return null;
            }
            const orientationKey = `${compact.key}|${activeEndpoint}>${fixedEndpoint}`;
            if (orientations.has(orientationKey)) {
                counters.duplicateHalfStateCount++;
                return null;
            }
            orientations.add(orientationKey);
            // keyRank is defined before the state enters the join phase so rank
            // assignment does not transition the hot state object shape.
            const entry = { ...compact, activeEndpoint, fixedEndpoint, keyRank: 0 };
            if (runtime.captureTrace) entry.traceSteps = traceSteps;
            states.push(entry);
            counters.uniqueHalfStateCount++;
            return entry;
        };

        let frontier = [];
        for (const [id, [left, right]] of [...runtime.baseEdgesById].sort(([a], [b]) => a - b)) {
            const compact = compactState(runtime, [id], []);
            frontier.push(
                register(compact, left, right, runtime.captureTrace ? [{
                    kind: "root-cut",
                    removedEdgeKey: edgeKeyFromId(runtime, id),
                    activeEndpoint: left,
                    fixedEndpoint: right,
                    openEndpoints: compact.openEndpoints.slice()
                }] : undefined),
                register(compact, right, left, runtime.captureTrace ? [{
                    kind: "root-cut",
                    removedEdgeKey: edgeKeyFromId(runtime, id),
                    activeEndpoint: right,
                    fixedEndpoint: left,
                    openEndpoints: compact.openEndpoints.slice()
                }] : undefined)
            );
        }
        frontier = frontier.filter(Boolean);

        for (let depth = 1; depth < GEOMETRIC_REPAIR_POLICY.halfDepth && frontier.length; depth++) {
            const nextFrontier = [];
            for (const parent of frontier) {
                counters.halfStateExpansionCount++;
                if (counters.halfStateExpansionCount > counters.halfStateExpansionLimit) {
                    return { states, budgetExhausted: "HALF_STATE_EXPANSION_LIMIT" };
                }
                if (!consumeWork(counters)) return { states, budgetExhausted: "TOTAL_WORK_LIMIT" };
                const parentTopology = parent.topology;
                for (const candidate of runtime.numericNeighborsById.get(parent.activeEndpoint) || []) {
                    counters.candidateVisitCount++;
                    if (counters.candidateVisitCount > counters.candidateVisitLimit) {
                        return { states, budgetExhausted: "CANDIDATE_VISIT_LIMIT" };
                    }
                    if (!consumeWork(counters)) return { states, budgetExhausted: "TOTAL_WORK_LIMIT" };
                    const target = candidate.otherSourceId;
                    if (target === parent.fixedEndpoint
                        || parent.removedEdgeIds.includes(candidate.edgeId)
                        || currentEdgePresent(runtime, parent, candidate.edgeId)
                        || (parentTopology.degrees.get(target) ?? 2) !== 2) continue;
                    for (const other of runtime.baseNeighbors.get(target)) {
                        const removedId = packedEdgeId(runtime.pointCount, target, other);
                        if (!currentEdgePresent(runtime, parent, removedId)) continue;
                        const childRemoved = parent.removedEdgeIds
                            .concat(removedId).sort(compareNumbers);
                        const childAdded = parent.addedEdgeIds
                            .concat(candidate.edgeId).sort(compareNumbers);
                        const childEdgeIds = `${childRemoved}|${childAdded}`;
                        let child = compactByEdgeIds.get(childEdgeIds);
                        if (child === undefined) {
                            // Both former rejections incremented the same counter and
                            // skipped the same child, so merging them ahead of
                            // finishCompactState leaves invalidHalfStateCount identical
                            // while keeping discarded children off the expensive path.
                            const childTopology = analyzeCompactTopology(
                                runtime, childRemoved, childAdded);
                            child = !childTopology.valid
                                || childRemoved.length > GEOMETRIC_REPAIR_POLICY.halfDepth
                                || !childTopology.pending
                                || childTopology.componentCount !== 1
                                ? null
                                : finishCompactState(
                                    runtime, childRemoved, childAdded, childTopology);
                            compactByEdgeIds.set(childEdgeIds, child);
                        }
                        // Only this last test reads the parent, so it stays per
                        // expansion and the counter keeps its exact former value.
                        if (child === null
                            || !child.openEndpoints.includes(parent.fixedEndpoint)) {
                            counters.invalidHalfStateCount++;
                            continue;
                        }
                        const activeEndpoint = child.openEndpoints.find(id => id !== parent.fixedEndpoint);
                        const traceSteps = runtime.captureTrace ? parent.traceSteps.concat({
                            kind: "extension",
                            candidateEdgeKey: candidate.edgeKey,
                            removedEdgeKey: edgeKeyFromId(runtime, removedId),
                            previousActiveEndpoint: parent.activeEndpoint,
                            targetEndpoint: target,
                            newActiveEndpoint: activeEndpoint,
                            fixedEndpoint: parent.fixedEndpoint,
                            openEndpoints: child.openEndpoints.slice()
                        }) : undefined;
                        const entry = register(child, activeEndpoint, parent.fixedEndpoint, traceSteps);
                        if (entry) nextFrontier.push(entry);
                    }
                }
            }
            frontier = nextFrontier.sort(compareStates);
        }
        // Join and validation never read topology. Nulling the field preserves the
        // state shape while allowing the per-state Map/arrays to be reclaimed.
        for (const state of states) state.topology = null;
        return { states, budgetExhausted: null };
    }

    /**
     * A half state touches at most halfDepth removed plus halfDepth - 1 added ids,
     * so the joined scan compares at most 5 x 5 ids and beats building a Set.
     */
    function arraysOverlap(left, right) {
        for (let leftIndex = 0; leftIndex < left.length; leftIndex++) {
            const value = left[leftIndex];
            for (let rightIndex = 0; rightIndex < right.length; rightIndex++) {
                if (right[rightIndex] === value) return true;
            }
        }
        return false;
    }

    function collectFinalist(runtime, counters, finalists, seen, removedInput, addedInput, lineage) {
        const removedEdgeIds = removedInput.slice().sort(compareNumbers);
        const addedEdgeIds = addedInput.slice().sort(compareNumbers);
        if (removedEdgeIds.length !== addedEdgeIds.length
            || removedEdgeIds.length > GEOMETRIC_REPAIR_POLICY.maxExchangeDepth) return;
        const compact = analyzeCompactTopology(runtime, removedEdgeIds, addedEdgeIds);
        if (!compact.valid || !compact.balanced || compact.componentCount !== 1) {
            counters.topologyRejectCount++;
            return;
        }
        counters.completeCandidateCount++;
        const deltaRaw = edgeSetDelta(runtime, removedEdgeIds, addedEdgeIds);
        if (!(deltaRaw < -GEOMETRIC_REPAIR_EPSILON)) return;
        counters.improvingCandidateCount++;
        const key = stateKey(runtime, removedEdgeIds, addedEdgeIds);
        if (seen.has(key)) {
            counters.duplicateFinalistCount++;
            return;
        }
        seen.add(key);
        finalists.push({ key, removedEdgeIds, addedEdgeIds, deltaRaw, lineage });
    }

    /** A bridge may not reuse an edge either half already removed or added. */
    function bridgeConflicts(left, right, bridgeEdgeId) {
        return left.touchedEdgeIds.includes(bridgeEdgeId)
            || right.touchedEdgeIds.includes(bridgeEdgeId);
    }

    /**
     * Joined half-chains never share an edge, so the exchange delta is the sum of
     * the half deltas and the closing edges. Scoring a join before its topology is
     * analyzed skips the work for candidates collectFinalist would drop anyway.
     * The bound is zero rather than the strict epsilon so the last-bit difference
     * between this incremental sum and the full edgeSetDelta re-sum can never
     * discard an improving exchange.
     */
    function joinDeltaCanImprove(counters, estimate) {
        if (estimate < 0) return true;
        counters.deltaPrunedCandidateCount++;
        return false;
    }

    function joinHalfStates(runtime, states, counters) {
        const finalists = [];
        const seenFinalists = new Set();
        const buckets = new Map();
        // The same base every candidate id was packed with; deriving it again from
        // points.length would silently miss candidateEdgeIdSet if the two drifted.
        const pointCount = runtime.pointCount;
        const orderedStates = states.slice().sort(compareStates);
        // Every join probe compares two state keys. Collating the unique keys once
        // and reusing the resulting ranks keeps that order identical while taking
        // the locale comparison off the hot path.
        const rankByKey = new Map();
        const sortedKeys = [...new Set(orderedStates.map(state => state.key))]
            .sort(compareNumericText);
        for (let index = 1; index < sortedKeys.length; index++) {
            if (compareNumericText(sortedKeys[index - 1], sortedKeys[index]) === 0) {
                throw new Error("Geometric Repair state keys are not collation-distinct");
            }
        }
        for (const key of sortedKeys) {
            rankByKey.set(key, rankByKey.size);
        }
        for (const state of orderedStates) state.keyRank = rankByKey.get(state.key);
        for (const state of orderedStates) {
            if (!consumeWork(counters)) {
                return { finalists, budgetExhausted: "TOTAL_WORK_LIMIT" };
            }
            // The bucket index and the closing edge id are the same packed pair.
            const closureId = packedEdgeId(
                pointCount, state.openEndpoints[0], state.openEndpoints[1]);
            const bucket = buckets.get(closureId) || [];
            // States arrive in compareStates order, so every bucket is a sorted
            // subsequence and only needs its tail dropped at the width bound.
            bucket.push(state);
            if (bucket.length > GEOMETRIC_REPAIR_POLICY.endpointBucketWidth) {
                bucket.length = GEOMETRIC_REPAIR_POLICY.endpointBucketWidth;
                counters.endpointBucketPruneCount++;
            }
            buckets.set(closureId, bucket);

            if (runtime.candidateEdgeIdSet.has(closureId)
                && !currentEdgePresent(runtime, state, closureId)
                && joinDeltaCanImprove(counters, state.deltaRaw + runtime.edgeCostsById.get(closureId))) {
                const closureKey = edgeKeyFromId(runtime, closureId);
                const lineage = { kind: "single-chain", halfKeys: [state.key], closingEdges: [closureKey] };
                if (runtime.captureTrace) {
                    lineage.halfTraces = [{
                        stateKey: state.key,
                        depth: state.depth,
                        openEndpoints: state.openEndpoints.slice(),
                        steps: state.traceSteps
                    }];
                }
                collectFinalist(
                    runtime, counters, finalists, seenFinalists,
                    state.removedEdgeIds, state.addedEdgeIds.concat(closureId),
                    lineage
                );
            }
        }

        // Every bucket entry is one of the states, so the smallest state delta is a
        // lower bound on right.deltaRaw for any bucket the walk could reach, and the
        // candidate graph's cheapest edge is one on both bridge terms. Substituting
        // those three floors into the join estimate gives a lower bound that can be
        // evaluated before a bucket is even addressed: when it is already
        // non-negative, no right in any reachable bucket can improve.
        const minStateDelta = orderedStates.length ? orderedStates[0].deltaRaw : 0;
        const minCandidateRaw = runtime.candidateEdges.length ? runtime.candidateEdges[0].raw : 0;
        for (const left of orderedStates) {
            // orderedStates is sorted by ascending deltaRaw, so this floor only
            // rises from here on and no later left can improve either.
            if (left.deltaRaw + minStateDelta + 2 * minCandidateRaw >= 0) break;
            const neighborsA = runtime.numericNeighborsById.get(left.openEndpoints[0]) || [];
            const neighborsB = runtime.numericNeighborsById.get(left.openEndpoints[1]) || [];
            if (neighborsA.length === 0 || neighborsB.length === 0) continue;
            // Both adjacency lists are ordered by ascending raw, so each of these
            // floors is non-decreasing along its loop and the first non-negative
            // one ends that loop instead of skipping a single entry.
            const leftFloor = left.deltaRaw + minStateDelta;
            const minRawB = neighborsB[0].raw;
            for (const candidateA of neighborsA) {
                if (leftFloor + candidateA.raw + minRawB >= 0) break;
                const pairFloor = leftFloor + candidateA.raw;
                for (const candidateB of neighborsB) {
                    if (pairFloor + candidateB.raw >= 0) break;
                    if (candidateA.otherSourceId === candidateB.otherSourceId
                        || candidateA.edgeId === candidateB.edgeId) continue;
                    const bucket = buckets.get(packedEdgeId(
                        pointCount, candidateA.otherSourceId, candidateB.otherSourceId));
                    if (bucket === undefined) continue;
                    for (const right of bucket) {
                        counters.joinProbeCount++;
                        if (counters.joinProbeCount > counters.joinProbeLimit) {
                            return { finalists, budgetExhausted: "JOIN_PROBE_LIMIT" };
                        }
                        if (!consumeWork(counters)) {
                            return { finalists, budgetExhausted: "TOTAL_WORK_LIMIT" };
                        }
                        // Buckets are filled in compareStates order and its first
                        // term is ascending deltaRaw, so every bucket is a run sorted
                        // by deltaRaw. For a fixed (left, candidateA, candidateB) only
                        // right.deltaRaw varies in this estimate, so the estimate is
                        // non-decreasing along the bucket: once it stops being negative
                        // no later entry in the bucket can improve either. Every probe
                        // this break drops is one joinDeltaCanImprove would have
                        // rejected on its own, so the finalist set is unchanged.
                        //
                        // The estimate is tested ahead of the conflict predicates for
                        // the same reason. All of these must pass for a join to reach
                        // collectFinalist, so their order cannot change which probes
                        // survive; testing four adds and a compare before the nested
                        // touched-edge scans both reaches the break at the first
                        // non-negative entry rather than the first one that happens to
                        // clear every conflict, and puts the cheapest predicate first.
                        if (!joinDeltaCanImprove(counters, left.deltaRaw + right.deltaRaw
                            + candidateA.raw + candidateB.raw)) break;
                        if (left.keyRank >= right.keyRank
                            || left.depth + right.depth > GEOMETRIC_REPAIR_POLICY.maxExchangeDepth
                            || arraysOverlap(left.touchedEdgeIds, right.touchedEdgeIds)) {
                            counters.joinConflictCount++;
                            continue;
                        }
                        // The two bridge edges are already distinct at the loop head.
                        if (bridgeConflicts(left, right, candidateA.edgeId)
                            || bridgeConflicts(left, right, candidateB.edgeId)) {
                            counters.joinConflictCount++;
                            continue;
                        }
                        const bridgeEdgeIds = [candidateA.edgeId, candidateB.edgeId];
                        const bridgeEdges = [candidateA.edgeKey, candidateB.edgeKey];
                        const lineage = {
                            kind: "paired-fragment-chain",
                            halfKeys: [left.key, right.key].sort(),
                            closingEdges: bridgeEdges.slice().sort(compareEdgeKeys)
                        };
                        if (runtime.captureTrace) {
                            lineage.bucketKey = endpointKey(
                                candidateA.otherSourceId, candidateB.otherSourceId);
                            lineage.bridgeAssignments = [
                                {
                                    edgeKey: candidateA.edgeKey,
                                    leftOpenEndpoint: left.openEndpoints[0],
                                    bucketEndpoint: candidateA.otherSourceId
                                },
                                {
                                    edgeKey: candidateB.edgeKey,
                                    leftOpenEndpoint: left.openEndpoints[1],
                                    bucketEndpoint: candidateB.otherSourceId
                                }
                            ];
                            lineage.halfTraces = [left, right].map(state => ({
                                stateKey: state.key,
                                depth: state.depth,
                                activeEndpoint: state.activeEndpoint,
                                fixedEndpoint: state.fixedEndpoint,
                                openEndpoints: state.openEndpoints.slice(),
                                steps: state.traceSteps
                            }));
                        }
                        collectFinalist(
                            runtime, counters, finalists, seenFinalists,
                            left.removedEdgeIds.concat(right.removedEdgeIds),
                            left.addedEdgeIds.concat(right.addedEdgeIds, bridgeEdgeIds),
                            lineage
                        );
                    }
                }
            }
        }
        return { finalists, budgetExhausted: null };
    }

    function finalAdjacency(runtime, removedEdgeIds, addedEdgeIds) {
        const removed = new Set(removedEdgeIds);
        const adjacency = new Map(runtime.order.map(id => [id, []]));
        for (const [id, [left, right]] of runtime.baseEdgesById) {
            if (removed.has(id)) continue;
            adjacency.get(left).push(right);
            adjacency.get(right).push(left);
        }
        for (const id of addedEdgeIds) {
            const [left, right] = packedEdgePair(runtime.pointCount, id);
            adjacency.get(left).push(right);
            adjacency.get(right).push(left);
        }
        if ([...adjacency.values()].some(neighbors => neighbors.length !== 2)) return null;
        return adjacency;
    }

    function materializeOrder(runtime, removedEdgeIds, addedEdgeIds) {
        const adjacency = finalAdjacency(runtime, removedEdgeIds, addedEdgeIds);
        if (!adjacency) throw new Error("Repair finalist does not have degree two");
        const start = runtime.order[0];
        const walk = firstNeighbor => {
            const result = [start];
            let previous = start;
            let current = firstNeighbor;
            while (current !== start && result.length <= runtime.order.length) {
                result.push(current);
                const neighbors = adjacency.get(current);
                const next = neighbors[0] === previous ? neighbors[1] : neighbors[0];
                previous = current;
                current = next;
            }
            return current === start && result.length === runtime.order.length
                && new Set(result).size === result.length ? result : null;
        };
        const candidates = adjacency.get(start).slice().sort((a, b) => a - b).map(walk).filter(Boolean);
        if (!candidates.length) throw new Error("Repair finalist is not one Hamilton cycle");
        const directedBase = new Set(runtime.order.map((id, index) =>
            `${id}>${runtime.order[(index + 1) % runtime.order.length]}`));
        const directionScore = order => order.reduce((sum, id, index) => sum
            + (directedBase.has(`${id}>${order[(index + 1) % order.length]}`) ? 1 : 0), 0);
        candidates.sort((left, right) => directionScore(right) - directionScore(left)
            || compareNumericText(left.join(","), right.join(",")));
        return candidates[0];
    }

    function segmentsIntersectForRepair(a, b, c, d, epsilon = GEOMETRIC_REPAIR_EPSILON) {
        const orient = (p, q, r) => {
            const value = (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
            return Math.abs(value) <= epsilon ? 0 : Math.sign(value);
        };
        const onSegment = (p, q, r) => Math.min(p.x, q.x) - epsilon <= r.x
            && r.x <= Math.max(p.x, q.x) + epsilon
            && Math.min(p.y, q.y) - epsilon <= r.y
            && r.y <= Math.max(p.y, q.y) + epsilon;
        const o1 = orient(a, b, c);
        const o2 = orient(a, b, d);
        const o3 = orient(c, d, a);
        const o4 = orient(c, d, b);
        return (o1 !== o2 && o3 !== o4)
            || (o1 === 0 && onSegment(a, b, c))
            || (o2 === 0 && onSegment(a, b, d))
            || (o3 === 0 && onSegment(c, d, a))
            || (o4 === 0 && onSegment(c, d, b));
    }

    /** Current ObjectOcc visibility is conservative under removal; retained edges form the overlay. */
    function validateFinalist(runtime, finalist, counters) {
        counters.validationCount++;
        const removed = new Set(finalist.removedEdgeIds);
        const added = finalist.addedEdgeIds.map(id => packedEdgePair(runtime.pointCount, id));
        for (const [left, right] of added) {
            counters.visibilityQueryCount++;
            if (!consumeWork(counters)) return { valid: false, budgetExhausted: "TOTAL_WORK_LIMIT" };
            if (!runtime.candidateEdgeIdSet.has(packedEdgeId(runtime.pointCount, left, right))
                || !objectOccVisible(runtime.world, left, right)) {
                return { valid: false, reason: "OVERLAY_VISIBILITY_MISSING" };
            }
        }
        for (const metric of [false, true]) {
            for (const [left, right] of added) {
                const a = pointPosition(runtime.points, left, metric);
                const b = pointPosition(runtime.points, right, metric);
                for (const [id, [routeLeft, routeRight]] of runtime.baseEdgesById) {
                    if (removed.has(id)
                        || left === routeLeft || left === routeRight
                        || right === routeLeft || right === routeRight) continue;
                    counters.intersectionTestCount++;
                    if (!consumeWork(counters)) {
                        return { valid: false, budgetExhausted: "TOTAL_WORK_LIMIT" };
                    }
                    if (segmentsIntersectForRepair(
                        a, b,
                        pointPosition(runtime.points, routeLeft, metric),
                        pointPosition(runtime.points, routeRight, metric))) {
                        return { valid: false, reason: "FINAL_SIMPLE_REJECTED" };
                    }
                }
            }
            for (let first = 0; first < added.length; first++) {
                for (let second = first + 1; second < added.length; second++) {
                    const [aId, bId] = added[first];
                    const [cId, dId] = added[second];
                    if (aId === cId || aId === dId || bId === cId || bId === dId) continue;
                    counters.intersectionTestCount++;
                    if (!consumeWork(counters)) {
                        return { valid: false, budgetExhausted: "TOTAL_WORK_LIMIT" };
                    }
                    if (segmentsIntersectForRepair(
                        pointPosition(runtime.points, aId, metric),
                        pointPosition(runtime.points, bId, metric),
                        pointPosition(runtime.points, cId, metric),
                        pointPosition(runtime.points, dId, metric))) {
                        return { valid: false, reason: "FINAL_SIMPLE_REJECTED" };
                    }
                }
            }
        }
        if (!consumeWork(counters, 3 * runtime.order.length)) {
            return { valid: false, budgetExhausted: "TOTAL_WORK_LIMIT" };
        }
        const order = materializeOrder(runtime, finalist.removedEdgeIds, finalist.addedEdgeIds);
        const fullLength = tourLengthRaw(order, runtime.points);
        if (Math.abs(fullLength - (runtime.initialLength + finalist.deltaRaw)) > 1e-6) {
            throw new Error("Geometric Repair finalist delta drift");
        }
        return { valid: true, order, fullLength };
    }

    function finishSearchResult(result, phaseTimings, totalStartedAt) {
        if (phaseTimings) {
            phaseTimings.totalMs = performance.now() - totalStartedAt;
            result.phaseTimings = phaseTimings;
        }
        return result;
    }

    function findGeometricRepair(world, order, options = {}) {
        if (!world?.totalNoktaList?.length || !Array.isArray(order) || order.length < 4) {
            throw new TypeError("A populated world and current route are required");
        }
        const phaseTimings = options.capturePhaseTimings === true ? {
            graphMs: 0,
            enumerateMs: 0,
            joinMs: 0,
            validateMs: 0,
            totalMs: 0
        } : null;
        const totalStartedAt = phaseTimings ? performance.now() : 0;
        let phaseStartedAt = totalStartedAt;
        const runtime = createRuntime(world, order, options);
        if (phaseTimings) {
            phaseTimings.graphMs = performance.now() - phaseStartedAt;
            phaseStartedAt = performance.now();
        }
        const counters = makeSearchCounters(runtime);
        if (counters.totalWorkCount > counters.totalWorkLimit) {
            return finishSearchResult(
                { runtime, counters, reason: "BUDGET_EXHAUSTED", budgetStage: "PREPROCESSING_LIMIT" },
                phaseTimings, totalStartedAt);
        }
        const enumeration = enumerateHalfStates(runtime, counters);
        if (phaseTimings) {
            phaseTimings.enumerateMs = performance.now() - phaseStartedAt;
            phaseStartedAt = performance.now();
        }
        if (enumeration.budgetExhausted) {
            return finishSearchResult(
                { runtime, counters, reason: "BUDGET_EXHAUSTED", budgetStage: enumeration.budgetExhausted },
                phaseTimings, totalStartedAt);
        }
        const joined = joinHalfStates(runtime, enumeration.states, counters);
        if (phaseTimings) {
            phaseTimings.joinMs = performance.now() - phaseStartedAt;
            phaseStartedAt = performance.now();
        }
        if (joined.budgetExhausted) {
            return finishSearchResult(
                { runtime, counters, reason: "BUDGET_EXHAUSTED", budgetStage: joined.budgetExhausted },
                phaseTimings, totalStartedAt);
        }
        joined.finalists.sort((left, right) => left.deltaRaw - right.deltaRaw
            || compareNumericText(left.key, right.key));
        let best = null;
        let lastRejectReason = null;
        for (const finalist of joined.finalists) {
            if (counters.validationCount >= counters.validationLimit) {
                if (phaseTimings) phaseTimings.validateMs = performance.now() - phaseStartedAt;
                return finishSearchResult(
                    { runtime, counters, reason: "BUDGET_EXHAUSTED", budgetStage: "VALIDATION_LIMIT" },
                    phaseTimings, totalStartedAt);
            }
            const validation = validateFinalist(runtime, finalist, counters);
            if (validation.budgetExhausted) {
                if (phaseTimings) phaseTimings.validateMs = performance.now() - phaseStartedAt;
                return finishSearchResult({
                        runtime,
                        counters,
                        reason: "BUDGET_EXHAUSTED",
                        budgetStage: validation.budgetExhausted
                    }, phaseTimings, totalStartedAt);
            }
            if (!validation.valid) {
                counters.geometryRejectCount++;
                lastRejectReason = validation.reason;
                continue;
            }
            best = {
                key: finalist.key,
                removedEdgeKeys: edgeKeysFromIds(runtime, finalist.removedEdgeIds),
                addedEdgeKeys: edgeKeysFromIds(runtime, finalist.addedEdgeIds),
                deltaRaw: finalist.deltaRaw,
                lineage: finalist.lineage,
                order: validation.order,
                finalLength: validation.fullLength
            };
            break;
        }
        if (phaseTimings) phaseTimings.validateMs = performance.now() - phaseStartedAt;
        return finishSearchResult({
            runtime,
            counters,
            reason: best ? "IMPROVEMENT_FOUND" : "NO_IMPROVEMENT",
            budgetStage: null,
            lastRejectReason,
            best
        }, phaseTimings, totalStartedAt);
    }

    function optimizeGeometricRepair(world, options = {}) {
        const points = world?.totalNoktaList;
        const startPoint = options.startPoint || points?.[options.startNodeId ?? 4];
        if (!startPoint) throw new RangeError("A current route start point is required");
        if (world.objectOccPrepared !== true) {
            return Object.freeze({
                committed: false,
                reason: "VISIBILITY_NOT_PREPARED",
                complexity: { worstCase: "O(n^1.7)", budgetExhausted: false }
            });
        }
        const beforeOrder = tourOrderFromBags(startPoint, world);
        const derivedPointCountBefore = points.filter(point => point?.turemis).length;
        const search = findGeometricRepair(world, beforeOrder, options);
        const report = {
            committed: false,
            reason: search.reason,
            initialLength: search.runtime.initialLength,
            finalLength: search.runtime.initialLength,
            move: null,
            counters: search.counters,
            complexity: {
                worstCase: "O(n^1.7)",
                candidateGraph: "O(n log n)",
                chainSearch: "O(n) with frozen degree/depth/bucket bounds",
                geometryValidation: "O(n^1.7)",
                budgetExhausted: search.reason === "BUDGET_EXHAUSTED",
                budgetStage: search.budgetStage
            },
            visibility: {
                source: "ObjectOcc",
                overlay: "current-visible candidates checked against retained boundary after removals",
                invalidatedAfterCommit: false
            },
            validity: {
                derivedPointCountBefore,
                derivedPointCountAfter: derivedPointCountBefore
            }
        };
        if (!search.best || search.reason !== "IMPROVEMENT_FOUND") {
            if (search.lastRejectReason) report.lastRejectReason = search.lastRejectReason;
            return Object.freeze(report);
        }

        const patch = buildDiffPatchRaw(beforeOrder, search.best.order, points);
        report.move = {
            exchangeDepth: patch.addedEdges.length,
            internalRemovedEdgeKeys: search.best.removedEdgeKeys,
            internalAddedEdgeKeys: search.best.addedEdgeKeys,
            removedEdgeKeys: search.best.removedEdgeKeys.map(key => sourceEdgeKey(points, key)),
            addedEdgeKeys: search.best.addedEdgeKeys.map(key => sourceEdgeKey(points, key)),
            deltaRaw: patch.immediateDelta,
            lineage: search.best.lineage
        };
        const transactionWorkReserve = 256 * beforeOrder.length;
        if (!consumeWork(search.counters, transactionWorkReserve)) {
            report.reason = "BUDGET_EXHAUSTED";
            report.complexity.budgetExhausted = true;
            report.complexity.budgetStage = "TRANSACTION_RESERVE";
            report.move = null;
            return Object.freeze(report);
        }
        search.counters.transactionWorkReserve = transactionWorkReserve;
        search.counters.transactionAttemptCount++;
        const transaction = applyTourDiffTransaction(world, patch, {
            ...(options.transactionOptions || {}),
            materializeMissingEdges: true,
            polygonNo: options.polygonNo ?? 0,
            deltaTolerance: 1e-6,
            collectVisibilityPatch: true,
            boundedVisibilityRollback: true,
            materializationOptions: { requireCachedRay: true }
        });
        search.counters.transactionSnapshotObjectCount = transaction.rollbackSnapshotObjectCount || 0;
        if (!transaction.committed) {
            report.reason = "TRANSACTION_REJECTED";
            report.error = transaction.error?.message || String(transaction.error);
            return Object.freeze(report);
        }

        const afterOrder = tourOrderFromBags(startPoint, world);
        const derivedPointCountAfter = points.filter(point => point?.turemis).length;
        if (derivedPointCountAfter !== derivedPointCountBefore) {
            throw new Error("Geometric Repair changed the derived point count");
        }
        report.committed = true;
        report.reason = "COMMITTED";
        report.finalLength = tourLengthRaw(afterOrder, points);
        report.validity.derivedPointCountAfter = derivedPointCountAfter;
        report.visibility.invalidatedAfterCommit = true;
        report.visibilityPatch = transaction.visibilityPatch;
        resetObjectOccState(world);
        world.pocketTreeOverlay = null;
        return Object.freeze(report);
    }

    return {
        GEOMETRIC_REPAIR_EPSILON,
        GEOMETRIC_REPAIR_POLICY,
        buildGeometricRepairCandidateGraph: buildProjectionCandidateGraph,
        findGeometricRepair,
        optimizeGeometricRepair
    };
});
