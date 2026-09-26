(function (root, factory) {
    const api = factory(root);
    if (typeof module === "object" && module.exports) module.exports = api;
    Object.assign(root, api);
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
    "use strict";

    const ITERATIVE_RANDOM_VISIBILITY_REPAIR_EPSILON = 1e-9;
    // Development calibration on the locked n10/n20 KBDB cases: n10 can prove a
    // full stall well below these ceilings; n20 keeps atomic gains and reports a
    // red limit stop instead of manufacturing a stall proof at the 30 s ceiling.
    const ITERATIVE_RANDOM_VISIBILITY_REPAIR_POLICY = Object.freeze({
        objectiveMode: "EUCLIDEAN_RAW",
        candidateBatchSize: 4,
        halfDepth: 3,
        maxExchangeDepth: 6,
        maxAcceptedExchanges: 64,
        maxCandidateProbes: 2000000,
        maxElapsedMs: 130000,
        yieldEveryCandidateProbes: 2048,
        seedSalt: 0x9e3779b9
    });

    const LIMIT_INCOMPLETE_MESSAGE = "Full stall not proven; the ongoing search was stopped by a limit.";
    const ERROR_INCOMPLETE_MESSAGE = "Full stall not proven; the search was stopped by a systemic error.";
    const LIMIT_REASONS = new Set([
        "MAX_EXCHANGES_REACHED",
        "MAX_PROBES_REACHED",
        "MAX_TIME_REACHED"
    ]);

    function edgeKey(a, b) {
        if (!Number.isInteger(a) || !Number.isInteger(b) || a === b) {
            throw new TypeError(`Invalid visibility repair edge ${a}-${b}`);
        }
        return a < b ? `${a}:${b}` : `${b}:${a}`;
    }

    function edgePair(key) {
        const pair = String(key).split(":").map(Number);
        if (pair.length !== 2 || !pair.every(Number.isSafeInteger) || pair[0] === pair[1]) {
            throw new TypeError(`Invalid visibility repair edge key: ${key}`);
        }
        return pair;
    }

    function compareEdgeKeys(left, right) {
        const [leftA, leftB] = edgePair(left);
        const [rightA, rightB] = edgePair(right);
        return leftA - rightA || leftB - rightB;
    }

    function endpointKey(left, right) {
        return left < right ? `${left}:${right}` : `${right}:${left}`;
    }

    function pointPosition(points, id, metric) {
        const point = points[id];
        if (!point) throw new RangeError(`Missing visibility repair point ${id}`);
        return metric ? (point.metricPosition || point.kendiYeri) : point.kendiYeri;
    }

    function rawLength(points, left, right) {
        const a = pointPosition(points, left, true);
        const b = pointPosition(points, right, true);
        return Math.hypot(a.x - b.x, a.y - b.y);
    }

    function fnv1a(text, seed = 0x811c9dc5) {
        let hash = seed >>> 0;
        for (let index = 0; index < text.length; index++) {
            hash ^= text.charCodeAt(index);
            hash = Math.imul(hash, 0x01000193) >>> 0;
        }
        return hash >>> 0;
    }

    function canonicalCycleSignature(order, points) {
        const identities = order.map(id => points[id]?.sourcePointId ?? id);
        const rotations = [];
        for (const direction of [identities, identities.slice().reverse()]) {
            for (let offset = 0; offset < direction.length; offset++) {
                rotations.push(direction.slice(offset).concat(direction.slice(0, offset)).join(","));
            }
        }
        rotations.sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
        return rotations[0] || "";
    }

    function deriveIterativeRandomVisibilityRepairSeed(order, points) {
        return fnv1a(
            `iterative-random-visibility-repair|${canonicalCycleSignature(order, points)}`,
            ITERATIVE_RANDOM_VISIBILITY_REPAIR_POLICY.seedSalt
        );
    }

    function mulberry32(seed) {
        let state = seed >>> 0;
        return function next() {
            state = (state + 0x6d2b79f5) >>> 0;
            let value = state;
            value = Math.imul(value ^ (value >>> 15), value | 1);
            value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
            return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
        };
    }

    function shuffleDeterministically(values, seed) {
        const result = values.slice();
        const random = mulberry32(seed);
        for (let index = result.length - 1; index > 0; index--) {
            const other = Math.floor(random() * (index + 1));
            [result[index], result[other]] = [result[other], result[index]];
        }
        return result;
    }

    function getCanonicalPointRay(world, left, right) {
        return world?.pointRayIndex?.get(edgeKey(left, right)) || null;
    }

    function rayIsIndexed(world, ray) {
        return !!ray && world?.rays instanceof Map && world.rays.get(ray.key) === ray;
    }

    function objectOccVisible(world, left, right) {
        const a = world.totalNoktaList[left];
        const b = world.totalNoktaList[right];
        if (!a || !b) return false;
        const ray = getCanonicalPointRay(world, left, right);
        return a.visibleList.get(right) === true
            && b.visibleList.get(left) === true
            && rayIsIndexed(world, ray);
    }

    function assertVisibilityIndexConsistency(world) {
        if (!(world?.rays instanceof Map) || !(world.pointRayIndex instanceof Map)) {
            throw new Error("ObjectOcc ray indexes are unavailable");
        }
        const rayKeys = new Set(world.rays.keys());
        for (const [key, ray] of world.rays) {
            if (!ray || ray.key !== key) throw new Error(`World ray key is inconsistent at ${String(key)}`);
            if (ray.p1No >= 0 && !world.totalNoktaList[ray.p1No]?.relatedRays?.has(key)) {
                throw new Error(`Ray ${String(key)} is missing from source point ${ray.p1No}`);
            }
            if (ray.p2No >= 0) {
                const pointKey = edgeKey(ray.p1No, ray.p2No);
                if (!world.totalNoktaList[ray.p2No]?.relatedRays?.has(key)
                    || world.pointRayIndex.get(pointKey) !== ray) {
                    throw new Error(`Point ray ${pointKey} is missing a reverse index`);
                }
            }
            for (const triangleId of ray.triangles || []) {
                if (!world.totalUcgenList[triangleId]?.rayKeys?.has(key)) {
                    throw new Error(`Ray ${String(key)} is missing from triangle ${triangleId}`);
                }
            }
        }
        for (const [key, ray] of world.pointRayIndex) {
            if (!ray || key !== edgeKey(ray.p1No, ray.p2No) || world.rays.get(ray.key) !== ray) {
                throw new Error(`Point-ray index is inconsistent at ${key}`);
            }
        }
        const assertReferences = (owner, values, label) => {
            if (!(values instanceof Set)) throw new Error(`${label} ray index is unavailable`);
            for (const key of values) {
                if (!rayKeys.has(key)) throw new Error(`${label} has dangling ray ${String(key)}`);
            }
        };
        for (const point of world.totalNoktaList || []) {
            assertReferences(point, point.relatedRays, `Point ${point.noktaNo}`);
        }
        (world.totalUcgenList || []).forEach((triangle, triangleId) => {
            assertReferences(triangle, triangle.rayKeys, `Triangle ${triangleId}`);
            for (const key of triangle.rayKeys) {
                if (!world.rays.get(key)?.triangles?.has(triangleId)) {
                    throw new Error(`Triangle ${triangleId} has a one-way ray reference`);
                }
            }
            (triangle.kenarList || []).forEach((edge, edgeId) => {
                assertReferences(edge, edge.relatedRays, `Mesh edge ${triangleId}:${edgeId}`);
            });
        });
        return true;
    }

    function buildRouteNeighbors(order) {
        const neighbors = new Map(order.map(id => [id, new Set()]));
        for (let index = 0; index < order.length; index++) {
            const left = order[index];
            const right = order[(index + 1) % order.length];
            neighbors.get(left).add(right);
            neighbors.get(right).add(left);
        }
        return neighbors;
    }

    function buildVisibleCandidateView(world, order, runSeed) {
        assertVisibilityIndexConsistency(world);
        const routeIds = new Set(order);
        const routeNeighbors = buildRouteNeighbors(order);
        const tourHash = fnv1a(canonicalCycleSignature(order, world.totalNoktaList), runSeed);
        const byPoint = new Map();
        const edgeSet = new Set();
        for (const pointId of order.slice().sort((left, right) => left - right)) {
            const point = world.totalNoktaList[pointId];
            const candidates = [];
            for (const [targetId, direct] of point.visibleList) {
                if (direct !== true || targetId === pointId || !routeIds.has(targetId)
                    || routeNeighbors.get(pointId).has(targetId)
                    || !objectOccVisible(world, pointId, targetId)) continue;
                const key = edgeKey(pointId, targetId);
                candidates.push(Object.freeze({
                    edgeKey: key,
                    sourceId: pointId,
                    targetId,
                    raw: rawLength(world.totalNoktaList, pointId, targetId)
                }));
                edgeSet.add(key);
            }
            candidates.sort((left, right) => left.targetId - right.targetId
                || compareEdgeKeys(left.edgeKey, right.edgeKey));
            const pointSeed = fnv1a(`${tourHash}|${pointId}`, runSeed ^ ITERATIVE_RANDOM_VISIBILITY_REPAIR_POLICY.seedSalt);
            byPoint.set(pointId, Object.freeze(shuffleDeterministically(candidates, pointSeed)));
        }
        return {
            byPoint,
            edgeSet,
            routeNeighbors,
            openedBatches: new Set(),
            candidateDirectedCount: [...byPoint.values()].reduce((sum, entries) => sum + entries.length, 0)
        };
    }

    function* iterateVisibleCandidateBatches(view, pointId, counters = null) {
        const entries = view.byPoint.get(pointId) || [];
        const width = ITERATIVE_RANDOM_VISIBILITY_REPAIR_POLICY.candidateBatchSize;
        for (let start = 0, batchIndex = 0; start < entries.length; start += width, batchIndex++) {
            const openKey = `${pointId}:${batchIndex}`;
            if (!view.openedBatches.has(openKey)) {
                view.openedBatches.add(openKey);
                if (counters) counters.candidateBatchOpenCount++;
            }
            yield entries.slice(start, start + width);
        }
    }

    function createSearchRuntime(world, order, runSeed) {
        const points = world.totalNoktaList;
        const baseEdges = new Map();
        const baseNeighbors = new Map(order.map(id => [id, []]));
        const edgeCosts = new Map();
        let initialLength = 0;
        for (let index = 0; index < order.length; index++) {
            const left = order[index];
            const right = order[(index + 1) % order.length];
            const key = edgeKey(left, right);
            const cost = rawLength(points, left, right);
            baseEdges.set(key, [left, right]);
            baseNeighbors.get(left).push({ otherId: right, edgeKey: key });
            baseNeighbors.get(right).push({ otherId: left, edgeKey: key });
            edgeCosts.set(key, cost);
            initialLength += cost;
        }
        for (const entries of baseNeighbors.values()) {
            entries.sort((left, right) => compareEdgeKeys(left.edgeKey, right.edgeKey)
                || left.otherId - right.otherId);
        }
        const candidateView = buildVisibleCandidateView(world, order, runSeed);
        for (const entries of candidateView.byPoint.values()) {
            for (const candidate of entries) edgeCosts.set(candidate.edgeKey, candidate.raw);
        }
        return { world, order, points, baseEdges, baseNeighbors, edgeCosts, initialLength, candidateView };
    }

    function buildAdjacency(runtime, removedEdgeKeys, addedEdgeKeys) {
        const removed = new Set(removedEdgeKeys);
        const adjacency = new Map(runtime.order.map(id => [id, []]));
        for (const [key, [left, right]] of runtime.baseEdges) {
            if (removed.has(key)) continue;
            adjacency.get(left).push(right);
            adjacency.get(right).push(left);
        }
        for (const key of addedEdgeKeys) {
            const [left, right] = edgePair(key);
            if (!adjacency.has(left) || !adjacency.has(right)) return null;
            adjacency.get(left).push(right);
            adjacency.get(right).push(left);
        }
        return adjacency;
    }

    function connectedVertexCount(adjacency, start) {
        const seen = new Set();
        const stack = [start];
        while (stack.length) {
            const current = stack.pop();
            if (seen.has(current)) continue;
            seen.add(current);
            for (const next of adjacency.get(current) || []) stack.push(next);
        }
        return seen.size;
    }

    function edgeSetDelta(runtime, removedEdgeKeys, addedEdgeKeys) {
        let delta = 0;
        for (const key of removedEdgeKeys) delta -= runtime.edgeCosts.get(key);
        for (const key of addedEdgeKeys) delta += runtime.edgeCosts.get(key);
        return delta;
    }

    function pendingState(runtime, removedInput, addedInput, activeEndpoint, fixedEndpoint, lineage) {
        const removedEdgeKeys = removedInput.slice().sort(compareEdgeKeys);
        const addedEdgeKeys = addedInput.slice().sort(compareEdgeKeys);
        if (new Set(removedEdgeKeys).size !== removedEdgeKeys.length
            || new Set(addedEdgeKeys).size !== addedEdgeKeys.length
            || removedEdgeKeys.some(key => !runtime.baseEdges.has(key) || addedEdgeKeys.includes(key))
            || addedEdgeKeys.some(key => runtime.baseEdges.has(key) || !runtime.candidateView.edgeSet.has(key))
            || removedEdgeKeys.length !== addedEdgeKeys.length + 1) return null;
        const adjacency = buildAdjacency(runtime, removedEdgeKeys, addedEdgeKeys);
        if (!adjacency) return null;
        const openEndpoints = [...adjacency]
            .filter(([, neighbors]) => neighbors.length === 1)
            .map(([id]) => id)
            .sort((left, right) => left - right);
        if ([...adjacency.values()].some(neighbors => neighbors.length < 1 || neighbors.length > 2)
            || openEndpoints.length !== 2
            || !openEndpoints.includes(activeEndpoint)
            || !openEndpoints.includes(fixedEndpoint)
            || connectedVertexCount(adjacency, openEndpoints[0]) !== runtime.order.length) return null;
        return Object.freeze({
            key: `R:${removedEdgeKeys.join(",")}|A:${addedEdgeKeys.join(",")}`,
            orientationKey: `${activeEndpoint}>${fixedEndpoint}`,
            depth: removedEdgeKeys.length,
            removedEdgeKeys,
            addedEdgeKeys,
            openEndpoints,
            activeEndpoint,
            fixedEndpoint,
            deltaRaw: edgeSetDelta(runtime, removedEdgeKeys, addedEdgeKeys),
            lineage
        });
    }

    function materializeCycleOrder(runtime, adjacency) {
        if ([...adjacency.values()].some(neighbors => neighbors.length !== 2)) return null;
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
        const directedBase = new Set(runtime.order.map((id, index) =>
            `${id}>${runtime.order[(index + 1) % runtime.order.length]}`));
        const directionScore = order => order.reduce((sum, id, index) => sum
            + (directedBase.has(`${id}>${order[(index + 1) % order.length]}`) ? 1 : 0), 0);
        const candidates = adjacency.get(start).slice().sort((left, right) => left - right)
            .map(walk).filter(Boolean);
        candidates.sort((left, right) => directionScore(right) - directionScore(left)
            || left.join(",").localeCompare(right.join(","), "en", { numeric: true }));
        return candidates[0] || null;
    }

    function completeCandidate(runtime, removedInput, addedInput, lineage) {
        const removedEdgeKeys = removedInput.slice().sort(compareEdgeKeys);
        const addedEdgeKeys = addedInput.slice().sort(compareEdgeKeys);
        if (removedEdgeKeys.length < 2
            || removedEdgeKeys.length !== addedEdgeKeys.length
            || removedEdgeKeys.length > ITERATIVE_RANDOM_VISIBILITY_REPAIR_POLICY.maxExchangeDepth
            || new Set(removedEdgeKeys).size !== removedEdgeKeys.length
            || new Set(addedEdgeKeys).size !== addedEdgeKeys.length
            || removedEdgeKeys.some(key => !runtime.baseEdges.has(key) || addedEdgeKeys.includes(key))
            || addedEdgeKeys.some(key => runtime.baseEdges.has(key) || !runtime.candidateView.edgeSet.has(key))) return null;
        const adjacency = buildAdjacency(runtime, removedEdgeKeys, addedEdgeKeys);
        if (!adjacency || [...adjacency.values()].some(neighbors => neighbors.length !== 2)
            || connectedVertexCount(adjacency, runtime.order[0]) !== runtime.order.length) return null;
        const order = materializeCycleOrder(runtime, adjacency);
        if (!order) return null;
        const deltaRaw = edgeSetDelta(runtime, removedEdgeKeys, addedEdgeKeys);
        return Object.freeze({
            key: `R:${removedEdgeKeys.join(",")}|A:${addedEdgeKeys.join(",")}`,
            removedEdgeKeys,
            addedEdgeKeys,
            deltaRaw,
            order,
            lineage
        });
    }

    function orientation(a, b, c, epsilon = ITERATIVE_RANDOM_VISIBILITY_REPAIR_EPSILON) {
        const value = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
        return Math.abs(value) <= epsilon ? 0 : Math.sign(value);
    }

    function onSegment(a, b, point, epsilon = ITERATIVE_RANDOM_VISIBILITY_REPAIR_EPSILON) {
        return point.x >= Math.min(a.x, b.x) - epsilon && point.x <= Math.max(a.x, b.x) + epsilon
            && point.y >= Math.min(a.y, b.y) - epsilon && point.y <= Math.max(a.y, b.y) + epsilon;
    }

    function segmentsIntersect(a, b, c, d, epsilon = ITERATIVE_RANDOM_VISIBILITY_REPAIR_EPSILON) {
        const o1 = orientation(a, b, c, epsilon);
        const o2 = orientation(a, b, d, epsilon);
        const o3 = orientation(c, d, a, epsilon);
        const o4 = orientation(c, d, b, epsilon);
        if (o1 !== o2 && o3 !== o4) return true;
        return (o1 === 0 && onSegment(a, b, c, epsilon))
            || (o2 === 0 && onSegment(a, b, d, epsilon))
            || (o3 === 0 && onSegment(c, d, a, epsilon))
            || (o4 === 0 && onSegment(c, d, b, epsilon));
    }

    function patchIsSimple(runtime, candidate, metric) {
        const removed = new Set(candidate.removedEdgeKeys);
        const added = candidate.addedEdgeKeys.map(edgePair);
        for (const [left, right] of added) {
            const a = pointPosition(runtime.points, left, metric);
            const b = pointPosition(runtime.points, right, metric);
            for (const [key, [routeLeft, routeRight]] of runtime.baseEdges) {
                if (removed.has(key) || left === routeLeft || left === routeRight
                    || right === routeLeft || right === routeRight) continue;
                if (segmentsIntersect(
                    a, b,
                    pointPosition(runtime.points, routeLeft, metric),
                    pointPosition(runtime.points, routeRight, metric))) return false;
            }
        }
        for (let first = 0; first < added.length; first++) {
            for (let second = first + 1; second < added.length; second++) {
                const [aId, bId] = added[first];
                const [cId, dId] = added[second];
                if (aId === cId || aId === dId || bId === cId || bId === dId) continue;
                if (segmentsIntersect(
                    pointPosition(runtime.points, aId, metric),
                    pointPosition(runtime.points, bId, metric),
                    pointPosition(runtime.points, cId, metric),
                    pointPosition(runtime.points, dId, metric))) return false;
            }
        }
        return true;
    }

    function sameCoordinate(a, b, epsilon = ITERATIVE_RANDOM_VISIBILITY_REPAIR_EPSILON) {
        return Math.abs(a.x - b.x) <= epsilon && Math.abs(a.y - b.y) <= epsilon;
    }

    function segmentsCrossInInterior(a, b, c, d, epsilon = ITERATIVE_RANDOM_VISIBILITY_REPAIR_EPSILON) {
        if ([a, b].some(left => [c, d].some(right => sameCoordinate(left, right, epsilon)))) return false;
        const rx = b.x - a.x;
        const ry = b.y - a.y;
        const sx = d.x - c.x;
        const sy = d.y - c.y;
        const denominator = rx * sy - ry * sx;
        const qx = c.x - a.x;
        const qy = c.y - a.y;
        if (Math.abs(denominator) > epsilon) {
            const t = (qx * sy - qy * sx) / denominator;
            const u = (qx * ry - qy * rx) / denominator;
            return t > epsilon && t < 1 - epsilon && u > epsilon && u < 1 - epsilon;
        }
        if (Math.abs(qx * ry - qy * rx) > epsilon) return false;
        const useX = Math.abs(rx) >= Math.abs(ry);
        const a0 = useX ? a.x : a.y;
        const a1 = useX ? b.x : b.y;
        const c0 = useX ? c.x : c.y;
        const c1 = useX ? d.x : d.y;
        const aMin = Math.min(a0, a1);
        const aMax = Math.max(a0, a1);
        const cMin = Math.min(c0, c1);
        const cMax = Math.max(c0, c1);
        return Math.min(aMax, cMax) - Math.max(aMin, cMin) > epsilon;
    }

    function invalidateCrossedVisibilityRays(world, addedBoundaryEdges, options = {}) {
        assertVisibilityIndexConsistency(world);
        const epsilon = options.epsilon ?? ITERATIVE_RANDOM_VISIBILITY_REPAIR_EPSILON;
        const boundaries = addedBoundaryEdges.map(([left, right]) => ({
            left,
            right,
            start: pointPosition(world.totalNoktaList, left, false),
            finish: pointPosition(world.totalNoktaList, right, false)
        }));
        const invalidated = [];
        for (const [key, ray] of world.rays) {
            const crosses = boundaries.some(boundary => {
                if (ray.p1No >= 0 && ray.p2No >= 0
                    && edgeKey(ray.p1No, ray.p2No) === edgeKey(boundary.left, boundary.right)) return false;
                return segmentsCrossInInterior(ray.p1Loc, ray.p2Loc, boundary.start, boundary.finish, epsilon);
            });
            if (crosses) invalidated.push({ key, ray });
        }

        for (const { key, ray } of invalidated) {
            world.rays.delete(key);
            for (const [pointKey, indexedRay] of world.pointRayIndex) {
                if (indexedRay === ray || (ray.p1No >= 0 && ray.p2No >= 0
                    && pointKey === edgeKey(ray.p1No, ray.p2No))) world.pointRayIndex.delete(pointKey);
            }
            for (const point of world.totalNoktaList) point.relatedRays.delete(key);
            for (const triangle of world.totalUcgenList) {
                triangle.rayKeys.delete(key);
                for (const edge of triangle.kenarList) edge.relatedRays.delete(key);
            }
            if (ray.p1No >= 0 && ray.p2No >= 0) {
                world.totalNoktaList[ray.p1No]?.visibleList.delete(ray.p2No);
                world.totalNoktaList[ray.p2No]?.visibleList.delete(ray.p1No);
                const pointKey = edgeKey(ray.p1No, ray.p2No);
                world.routeMetricCache?.delete(pointKey);
                world.routeRawMetricCache?.delete(pointKey);
            }
        }
        assertVisibilityIndexConsistency(world);
        return Object.freeze({
            invalidatedRayCount: invalidated.length,
            invalidatedRayKeys: Object.freeze(invalidated.map(entry => String(entry.key)))
        });
    }

    function resolveLimits(options) {
        const read = (name, defaultValue, integer) => {
            const value = options[name] ?? defaultValue;
            if (!Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) {
                throw new RangeError(`${name} must be a non-negative ${integer ? "safe integer" : "number"}`);
            }
            return value;
        };
        return Object.freeze({
            maxAcceptedExchanges: read("maxAcceptedExchanges", ITERATIVE_RANDOM_VISIBILITY_REPAIR_POLICY.maxAcceptedExchanges, true),
            maxCandidateProbes: read("maxCandidateProbes", ITERATIVE_RANDOM_VISIBILITY_REPAIR_POLICY.maxCandidateProbes, true),
            maxElapsedMs: read("maxElapsedMs", ITERATIVE_RANDOM_VISIBILITY_REPAIR_POLICY.maxElapsedMs, false)
        });
    }

    function compareStates(left, right) {
        return left.key.localeCompare(right.key, "en", { numeric: true })
            || left.activeEndpoint - right.activeEndpoint
            || left.fixedEndpoint - right.fixedEndpoint;
    }

    function makeCounters() {
        return {
            rootDirectionCount: 0,
            candidateBatchOpenCount: 0,
            candidateProbeCount: 0,
            extensionProbeCount: 0,
            bridgePairProbeCount: 0,
            endpointBucketProbeCount: 0,
            uniqueHalfStateCount: 0,
            duplicateHalfStateCount: 0,
            topologyRejectCount: 0,
            completeCandidateCount: 0,
            duplicateFinalistCount: 0,
            nonImprovingCandidateCount: 0,
            visibilityRejectCount: 0,
            geometryRejectCount: 0,
            transactionAttemptCount: 0,
            transactionRejectCount: 0,
            acceptedExchangeCount: 0,
            objectOccRebuildCount: 0,
            stallObjectOccRebuildCount: 0,
            fullSweepCount: 0,
            searchRestartCount: 0,
            invalidatedRayCount: 0
        };
    }

    function dependency(options, optionName, globalName) {
        return options[optionName] || options.dependencies?.[globalName] || root[globalName];
    }

    function defaultYieldControl() {
        if (typeof root.setTimeout === "function") {
            return new Promise(resolve => root.setTimeout(resolve, 0));
        }
        return Promise.resolve();
    }

    function finalReport(state, reason, error = null) {
        const now = state.now();
        let finalLength = state.initialLength;
        try {
            if (state.initialLength !== null && state.order?.length) {
                finalLength = state.tourLengthRaw(state.order, state.world.totalNoktaList);
            }
        } catch (_) {
            finalLength = state.lastKnownLength;
        }
        const fullStallProven = reason === "FULL_STALL";
        return Object.freeze({
            committed: state.counters.acceptedExchangeCount > 0,
            status: fullStallProven ? "FULL_STALL" : "STOPPED",
            reason,
            fullStallProven,
            incompleteMessage: fullStallProven ? null
                : (LIMIT_REASONS.has(reason) ? LIMIT_INCOMPLETE_MESSAGE : ERROR_INCOMPLETE_MESSAGE),
            error: error ? (error.message || String(error)) : null,
            initialLength: state.initialLength,
            finalLength,
            totalRawGain: Number.isFinite(state.initialLength) && Number.isFinite(finalLength)
                ? state.initialLength - finalLength : null,
            acceptedExchangeCount: state.counters.acceptedExchangeCount,
            objectOccRebuildCount: state.counters.objectOccRebuildCount,
            stallObjectOccRebuildCount: state.counters.stallObjectOccRebuildCount,
            fullSweepCount: state.counters.fullSweepCount,
            candidateProbeCount: state.counters.candidateProbeCount,
            invalidatedRayCount: state.counters.invalidatedRayCount,
            runSeed: state.runSeed,
            elapsedMs: now - state.startedAt,
            limits: state.limits,
            budget: Object.freeze({
                acceptedExchanges: Object.freeze({ used: state.counters.acceptedExchangeCount, limit: state.limits.maxAcceptedExchanges }),
                candidateProbes: Object.freeze({ used: state.counters.candidateProbeCount, limit: state.limits.maxCandidateProbes }),
                elapsedMs: Object.freeze({ used: now - state.startedAt, limit: state.limits.maxElapsedMs })
            }),
            counters: Object.freeze({ ...state.counters }),
            moves: Object.freeze(state.moves.slice()),
            policy: ITERATIVE_RANDOM_VISIBILITY_REPAIR_POLICY
        });
    }

    function timeLimitReason(state) {
        return state.now() - state.startedAt >= state.limits.maxElapsedMs ? "MAX_TIME_REACHED" : null;
    }

    async function takeProbe(state, counterName) {
        const timeReason = timeLimitReason(state);
        if (timeReason) return timeReason;
        if (state.counters.candidateProbeCount >= state.limits.maxCandidateProbes) {
            return "MAX_PROBES_REACHED";
        }
        state.counters.candidateProbeCount++;
        state.counters[counterName]++;
        if (state.counters.candidateProbeCount % state.yieldEveryCandidateProbes === 0) {
            await state.yieldControl();
            return timeLimitReason(state);
        }
        return null;
    }

    function sourceEdgeKey(points, key) {
        const [left, right] = edgePair(key);
        const sourceLeft = points[left]?.sourcePointId ?? left;
        const sourceRight = points[right]?.sourcePointId ?? right;
        return sourceLeft < sourceRight
            ? `${sourceLeft}:${sourceRight}`
            : `${sourceRight}:${sourceLeft}`;
    }

    async function searchCurrentVisibility(state) {
        const runtime = createSearchRuntime(state.world, state.order, state.runSeed);
        const endpointBuckets = new Map();
        const seenStates = new Set();
        const seenFinalists = new Set();
        let generationOrdinal = 0;

        const tryCandidate = candidate => {
            if (!candidate) {
                state.counters.topologyRejectCount++;
                return { kind: "continue" };
            }
            state.counters.completeCandidateCount++;
            if (!(candidate.deltaRaw < -ITERATIVE_RANDOM_VISIBILITY_REPAIR_EPSILON)) {
                state.counters.nonImprovingCandidateCount++;
                return { kind: "continue" };
            }
            if (seenFinalists.has(candidate.key)) {
                state.counters.duplicateFinalistCount++;
                return { kind: "continue" };
            }
            seenFinalists.add(candidate.key);
            if (candidate.addedEdgeKeys.some(key => {
                const [left, right] = edgePair(key);
                return !objectOccVisible(state.world, left, right);
            })) {
                state.counters.visibilityRejectCount++;
                return { kind: "continue" };
            }
            if (!patchIsSimple(runtime, candidate, false) || !patchIsSimple(runtime, candidate, true)) {
                state.counters.geometryRejectCount++;
                return { kind: "continue" };
            }

            let patch;
            try {
                patch = state.buildDiffPatchRaw(runtime.order, candidate.order, runtime.points);
            } catch (error) {
                return { kind: "system", reason: "TRANSACTION_INVARIANT_FAILED", error };
            }
            if (!patch.improvesImmediately
                || patch.addedEdges.length !== candidate.addedEdgeKeys.length
                || patch.removedEdges.length !== candidate.removedEdgeKeys.length) {
                return {
                    kind: "system",
                    reason: "TRANSACTION_INVARIANT_FAILED",
                    error: new Error("Candidate topology and route diff disagree")
                };
            }
            state.counters.transactionAttemptCount++;
            let transaction;
            try {
                transaction = state.applyTransaction(state.world, patch, {
                    ...state.transactionOptions,
                    materializeMissingEdges: true,
                    polygonNo: state.polygonNo,
                    deltaTolerance: 1e-6,
                    collectVisibilityPatch: true,
                    boundedVisibilityRollback: true,
                    materializationOptions: { requireCachedRay: true }
                });
            } catch (error) {
                return { kind: "system", reason: "TRANSACTION_INVARIANT_FAILED", error };
            }
            if (!transaction?.committed) {
                state.counters.transactionRejectCount++;
                try {
                    assertVisibilityIndexConsistency(state.world);
                } catch (error) {
                    return { kind: "system", reason: "VISIBILITY_INVALIDATION_FAILED", error };
                }
                return { kind: "continue" };
            }
            return { kind: "commit", candidate, patch, transaction };
        };

        const visitState = async current => {
            const limitReason = timeLimitReason(state);
            if (limitReason) return { kind: "limit", reason: limitReason };
            const identity = `${current.key}|${current.orientationKey}`;
            if (seenStates.has(identity)) {
                state.counters.duplicateHalfStateCount++;
                return { kind: "continue" };
            }
            seenStates.add(identity);
            current = Object.freeze({ ...current, generationOrdinal: generationOrdinal++ });
            state.counters.uniqueHalfStateCount++;

            for (const batch of iterateVisibleCandidateBatches(runtime.candidateView, current.activeEndpoint, state.counters)) {
                for (const candidate of batch) {
                    if (candidate.targetId !== current.fixedEndpoint) continue;
                    const stopped = await takeProbe(state, "bridgePairProbeCount");
                    if (stopped) return { kind: "limit", reason: stopped };
                    const result = tryCandidate(completeCandidate(
                        runtime,
                        current.removedEdgeKeys,
                        current.addedEdgeKeys.concat(candidate.edgeKey),
                        { kind: "single-fragment-chain", stateKey: current.key, closingEdgeKey: candidate.edgeKey }
                    ));
                    if (result.kind !== "continue") return result;
                }
            }

            for (const activeBatch of iterateVisibleCandidateBatches(
                runtime.candidateView, current.activeEndpoint, state.counters)) {
                for (const activeCandidate of activeBatch) {
                    for (const fixedBatch of iterateVisibleCandidateBatches(
                        runtime.candidateView, current.fixedEndpoint, state.counters)) {
                        for (const fixedCandidate of fixedBatch) {
                            const pairStopped = await takeProbe(state, "bridgePairProbeCount");
                            if (pairStopped) return { kind: "limit", reason: pairStopped };
                            if (activeCandidate.targetId === fixedCandidate.targetId
                                || activeCandidate.edgeKey === fixedCandidate.edgeKey) continue;
                            const bucket = endpointBuckets.get(endpointKey(
                                activeCandidate.targetId, fixedCandidate.targetId)) || [];
                            for (const other of bucket) {
                                const bucketStopped = await takeProbe(state, "endpointBucketProbeCount");
                                if (bucketStopped) return { kind: "limit", reason: bucketStopped };
                                if (current.depth + other.depth > ITERATIVE_RANDOM_VISIBILITY_REPAIR_POLICY.maxExchangeDepth) continue;
                                const bridgeEdgeKeys = [activeCandidate.edgeKey, fixedCandidate.edgeKey];
                                const result = tryCandidate(completeCandidate(
                                    runtime,
                                    current.removedEdgeKeys.concat(other.removedEdgeKeys),
                                    current.addedEdgeKeys.concat(other.addedEdgeKeys, bridgeEdgeKeys),
                                    {
                                        kind: "paired-fragment-chain",
                                        halfStateKeys: [current.key, other.key],
                                        bridgeEdgeKeys: bridgeEdgeKeys.slice().sort(compareEdgeKeys),
                                        endpointBucketKey: endpointKey(
                                            activeCandidate.targetId, fixedCandidate.targetId)
                                    }
                                ));
                                if (result.kind !== "continue") return result;
                            }
                        }
                    }
                }
            }

            const bucketKey = endpointKey(current.openEndpoints[0], current.openEndpoints[1]);
            const bucket = endpointBuckets.get(bucketKey) || [];
            bucket.push(current);
            bucket.sort(compareStates);
            endpointBuckets.set(bucketKey, bucket);

            if (current.depth >= ITERATIVE_RANDOM_VISIBILITY_REPAIR_POLICY.halfDepth) {
                return { kind: "continue" };
            }
            for (const batch of iterateVisibleCandidateBatches(runtime.candidateView, current.activeEndpoint, state.counters)) {
                for (const candidate of batch) {
                    if (candidate.targetId === current.fixedEndpoint
                        || current.addedEdgeKeys.includes(candidate.edgeKey)) continue;
                    for (const removal of runtime.baseNeighbors.get(candidate.targetId) || []) {
                        const stopped = await takeProbe(state, "extensionProbeCount");
                        if (stopped) return { kind: "limit", reason: stopped };
                        if (current.removedEdgeKeys.includes(removal.edgeKey)) continue;
                        const child = pendingState(
                            runtime,
                            current.removedEdgeKeys.concat(removal.edgeKey),
                            current.addedEdgeKeys.concat(candidate.edgeKey),
                            removal.otherId,
                            current.fixedEndpoint,
                            {
                                kind: "extension",
                                parentStateKey: current.key,
                                candidateEdgeKey: candidate.edgeKey,
                                removedEdgeKey: removal.edgeKey
                            }
                        );
                        if (!child) {
                            state.counters.topologyRejectCount++;
                            continue;
                        }
                        const result = await visitState(child);
                        if (result.kind !== "continue") return result;
                    }
                }
            }
            return { kind: "continue" };
        };

        const indexById = new Map(runtime.order.map((id, index) => [id, index]));
        for (const activeEndpoint of runtime.order.slice().sort((left, right) => left - right)) {
            const index = indexById.get(activeEndpoint);
            const previous = runtime.order[(index - 1 + runtime.order.length) % runtime.order.length];
            const next = runtime.order[(index + 1) % runtime.order.length];
            for (const [direction, fixedEndpoint] of [["PREVIOUS_FIXED", previous], ["NEXT_FIXED", next]]) {
                state.counters.rootDirectionCount++;
                const rootEdgeKey = edgeKey(activeEndpoint, fixedEndpoint);
                const rootState = pendingState(
                    runtime, [rootEdgeKey], [], activeEndpoint, fixedEndpoint,
                    { kind: "root-cut", direction, rootEdgeKey }
                );
                if (!rootState) {
                    return {
                        kind: "system",
                        reason: "TRANSACTION_INVARIANT_FAILED",
                        error: new Error(`Invalid directed root ${activeEndpoint}>${fixedEndpoint}`)
                    };
                }
                const result = await visitState(rootState);
                if (result.kind !== "continue") return result;
            }
        }
        const finalLimitReason = timeLimitReason(state);
        return finalLimitReason
            ? { kind: "limit", reason: finalLimitReason }
            : { kind: "exhausted", runtime };
    }

    async function optimizeIterativeRandomVisibilityRepair(world, options = {}) {
        const points = world?.totalNoktaList;
        if (!Array.isArray(points) || points.length < 4) {
            throw new TypeError("A populated world is required");
        }
        const objectOccFn = dependency(options, "objectOccFn", "objectOcc");
        const tourOrder = dependency(options, "tourOrderFn", "tourOrderFromBags");
        const tourLengthFn = dependency(options, "tourLengthRawFn", "tourLengthRaw");
        const buildPatch = dependency(options, "buildDiffPatchRawFn", "buildDiffPatchRaw");
        const applyTransaction = dependency(options, "applyTransactionFn", "applyTourDiffTransaction");
        for (const [name, value] of [
            ["objectOcc", objectOccFn],
            ["tourOrderFromBags", tourOrder],
            ["tourLengthRaw", tourLengthFn],
            ["buildDiffPatchRaw", buildPatch],
            ["applyTourDiffTransaction", applyTransaction]
        ]) {
            if (typeof value !== "function") throw new Error(`${name} is required`);
        }
        const limits = resolveLimits(options);
        const now = options.nowFn || (() => typeof root.performance !== "undefined"
            ? root.performance.now() : Date.now());
        const counters = makeCounters();
        const state = {
            world,
            limits,
            now,
            startedAt: now(),
            counters,
            runSeed: null,
            order: null,
            initialLength: null,
            lastKnownLength: null,
            derivedPointCount: null,
            moves: [],
            objectOccFn,
            tourOrder,
            tourLengthRaw: tourLengthFn,
            buildDiffPatchRaw: buildPatch,
            applyTransaction,
            yieldControl: options.yieldControl || defaultYieldControl,
            yieldEveryCandidateProbes: options.yieldEveryCandidateProbes
                ?? ITERATIVE_RANDOM_VISIBILITY_REPAIR_POLICY.yieldEveryCandidateProbes,
            transactionOptions: options.transactionOptions || {},
            polygonNo: options.polygonNo ?? 0
        };
        if (!Number.isSafeInteger(state.yieldEveryCandidateProbes)
            || state.yieldEveryCandidateProbes < 1) {
            throw new RangeError("yieldEveryCandidateProbes must be a positive safe integer");
        }

        counters.objectOccRebuildCount++;
        try {
            objectOccFn(world);
            assertVisibilityIndexConsistency(world);
        } catch (error) {
            return finalReport(state, "OBJECT_OCC_FAILED", error);
        }

        const startPoint = options.startPoint || points[options.startNodeId ?? 4];
        if (!startPoint) throw new RangeError("A current route start point is required");
        try {
            state.order = tourOrder(startPoint, world);
            state.initialLength = tourLengthFn(state.order, points);
            state.lastKnownLength = state.initialLength;
            state.derivedPointCount = points.filter(point => point?.turemis).length;
            if (options.runSeed !== undefined
                && (!Number.isSafeInteger(options.runSeed) || options.runSeed < 0 || options.runSeed > 0xffffffff)) {
                throw new RangeError("runSeed must be an unsigned 32-bit integer");
            }
            state.runSeed = options.runSeed === undefined
                ? deriveIterativeRandomVisibilityRepairSeed(state.order, points)
                : options.runSeed >>> 0;
        } catch (error) {
            return finalReport(state, "TRANSACTION_INVARIANT_FAILED", error);
        }

        if (timeLimitReason(state)) return finalReport(state, "MAX_TIME_REACHED");
        if (counters.acceptedExchangeCount >= limits.maxAcceptedExchanges) {
            return finalReport(state, "MAX_EXCHANGES_REACHED");
        }

        let rebuiltAfterLastCommit = false;
        while (true) {
            let search;
            try {
                search = await searchCurrentVisibility(state);
            } catch (error) {
                return finalReport(state, "TRANSACTION_INVARIANT_FAILED", error);
            }
            if (search.kind === "limit" || search.kind === "system") {
                return finalReport(state, search.reason, search.error);
            }
            if (search.kind === "commit") {
                const beforeLength = state.lastKnownLength;
                let afterOrder;
                let afterLength;
                try {
                    afterOrder = tourOrder(startPoint, world);
                    afterLength = tourLengthFn(afterOrder, points);
                    if (!(afterLength < beforeLength - ITERATIVE_RANDOM_VISIBILITY_REPAIR_EPSILON)) {
                        throw new Error("Committed exchange is not a strict raw improvement");
                    }
                    if (points.filter(point => point?.turemis).length !== state.derivedPointCount) {
                        throw new Error("Iterative visibility repair changed the derived point count");
                    }
                } catch (error) {
                    state.order = afterOrder || state.order;
                    state.lastKnownLength = Number.isFinite(afterLength) ? afterLength : state.lastKnownLength;
                    return finalReport(state, "TRANSACTION_INVARIANT_FAILED", error);
                }
                state.order = afterOrder;
                state.lastKnownLength = afterLength;
                counters.acceptedExchangeCount++;
                counters.searchRestartCount++;
                state.moves.push(Object.freeze({
                    exchangeIndex: counters.acceptedExchangeCount,
                    exchangeDepth: search.patch.addedEdges.length,
                    deltaRaw: search.patch.immediateDelta,
                    beforeLength,
                    afterLength,
                    removedEdgeKeys: Object.freeze(search.candidate.removedEdgeKeys.map(key => sourceEdgeKey(points, key))),
                    addedEdgeKeys: Object.freeze(search.candidate.addedEdgeKeys.map(key => sourceEdgeKey(points, key))),
                    lineage: search.candidate.lineage
                }));
                try {
                    const invalidation = invalidateCrossedVisibilityRays(world, search.patch.addedEdges);
                    counters.invalidatedRayCount += invalidation.invalidatedRayCount;
                } catch (error) {
                    return finalReport(state, "VISIBILITY_INVALIDATION_FAILED", error);
                }
                rebuiltAfterLastCommit = false;
                if (counters.acceptedExchangeCount >= limits.maxAcceptedExchanges) {
                    return finalReport(state, "MAX_EXCHANGES_REACHED");
                }
                await state.yieldControl();
                if (timeLimitReason(state)) return finalReport(state, "MAX_TIME_REACHED");
                continue;
            }

            counters.fullSweepCount++;
            if (rebuiltAfterLastCommit) return finalReport(state, "FULL_STALL");
            await state.yieldControl();
            if (timeLimitReason(state)) return finalReport(state, "MAX_TIME_REACHED");
            counters.objectOccRebuildCount++;
            counters.stallObjectOccRebuildCount++;
            try {
                objectOccFn(world);
                assertVisibilityIndexConsistency(world);
            } catch (error) {
                return finalReport(state, "OBJECT_OCC_FAILED", error);
            }
            rebuiltAfterLastCommit = true;
            if (timeLimitReason(state)) return finalReport(state, "MAX_TIME_REACHED");
        }
    }

    return {
        ITERATIVE_RANDOM_VISIBILITY_REPAIR_EPSILON,
        ITERATIVE_RANDOM_VISIBILITY_REPAIR_POLICY,
        ITERATIVE_RANDOM_VISIBILITY_REPAIR_INCOMPLETE_MESSAGE: LIMIT_INCOMPLETE_MESSAGE,
        deriveIterativeRandomVisibilityRepairSeed,
        buildIterativeRandomVisibilityCandidateView: buildVisibleCandidateView,
        iterateVisibleCandidateBatches,
        assertIterativeRandomVisibilityIndexes: assertVisibilityIndexConsistency,
        invalidateCrossedVisibilityRays,
        optimizeIterativeRandomVisibilityRepair
    };
});
