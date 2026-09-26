(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    Object.assign(root, api);
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    function visibilityEdgeKey(a, b) {
        return a < b ? `${a}:${b}` : `${b}:${a}`;
    }

    function edgePair(key) {
        return key.split(":").map(Number);
    }

    function captureBoundaryState(world) {
        const state = new Map();
        world.totalUcgenList.forEach(triangle => {
            if (triangle.disabled) return;
            triangle.kenarList.forEach(edge => {
                const key = visibilityEdgeKey(edge.uc1NoktaNo, edge.uc2NoktaNo);
                const current = state.get(key) || { isBoundary: false, polygonNos: new Set(), recordCount: 0 };
                current.recordCount++;
                if (edge.disKenar) current.isBoundary = true;
                if (Number.isInteger(edge.kenarPolyNo) && edge.kenarPolyNo >= 0) current.polygonNos.add(edge.kenarPolyNo);
                state.set(key, current);
            });
        });
        return state;
    }

    function triangleFingerprint(triangle) {
        if (!triangle) return null;
        return JSON.stringify({
            disabled: triangle.disabled === true,
            edges: triangle.kenarList.map(edge => ({
                endpoints: edge.uc1NoktaNo < edge.uc2NoktaNo
                    ? [edge.uc1NoktaNo, edge.uc2NoktaNo]
                    : [edge.uc2NoktaNo, edge.uc1NoktaNo],
                komsuNo: edge.komsuNo,
                komsudaKacinciKenarNo: edge.komsudaKacinciKenarNo,
                karsiNoktaNo: edge.karsiNoktaNo
            }))
        });
    }

    function captureTopologyState(world) {
        return new Map(world.totalUcgenList.map((triangle, triangleId) =>
            [triangleId, triangleFingerprint(triangle)]));
    }

    function deepFreeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.freeze(value);
        for (const child of Object.values(value)) deepFreeze(child);
        return value;
    }

    function beginVisibilityPatch(world, options = {}) {
        if (!world) throw new TypeError("world is required");
        return {
            active: true,
            world,
            source: options.source || "transaction",
            patch: options.patch || null,
            beforeBoundary: captureBoundaryState(world),
            beforeTopology: captureTopologyState(world),
            boundaryEvents: [],
            materializationEvents: [],
            touchedPointIds: new Set()
        };
    }

    function assertActive(session) {
        if (!session?.active) throw new Error("Visibility patch session is not active");
    }

    function recordVisibilityBoundaryChange(session, records, isBoundary, polygonNo) {
        if (!session) return;
        assertActive(session);
        const byKey = new Map();
        for (const record of records || []) {
            const edge = record.edge || record;
            const key = visibilityEdgeKey(edge.uc1NoktaNo, edge.uc2NoktaNo);
            if (!byKey.has(key)) byKey.set(key, edge);
        }
        for (const [key, edge] of byKey) {
            const [a, b] = edgePair(key);
            session.boundaryEvents.push({ key, endpoints: [a, b], from: edge.disKenar === true,
                to: isBoundary === true, polygonNo: isBoundary ? polygonNo : -1 });
            session.touchedPointIds.add(a);
            session.touchedPointIds.add(b);
        }
    }

    function recordVisibilityMaterialization(session, phase, a, b) {
        if (!session) return;
        assertActive(session);
        session.materializationEvents.push({
            phase,
            edge: a < b ? [a, b] : [b, a],
            triangleCount: session.world.totalUcgenList.length
        });
        session.touchedPointIds.add(a);
        session.touchedPointIds.add(b);
    }

    function recordVisibilityBagChanges(session, before, after) {
        if (!session) return;
        assertActive(session);
        const beforeNeighbors = new Map();
        for (let index = 0; index < before.length; index++) {
            const id = before[index];
            beforeNeighbors.set(id, [before[(index - 1 + before.length) % before.length], before[(index + 1) % before.length]].sort((a, b) => a - b));
        }
        for (let index = 0; index < after.length; index++) {
            const id = after[index];
            const neighbors = [after[(index - 1 + after.length) % after.length], after[(index + 1) % after.length]].sort((a, b) => a - b);
            if (JSON.stringify(beforeNeighbors.get(id)) !== JSON.stringify(neighbors)) session.touchedPointIds.add(id);
        }
    }

    function boundaryDiff(before, after) {
        const keys = new Set([...before.keys(), ...after.keys()]);
        const removedEdges = [];
        const addedEdges = [];
        for (const key of keys) {
            const wasBoundary = before.get(key)?.isBoundary === true;
            const isBoundary = after.get(key)?.isBoundary === true;
            if (wasBoundary && !isBoundary) removedEdges.push(edgePair(key));
            if (!wasBoundary && isBoundary) addedEdges.push(edgePair(key));
        }
        removedEdges.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
        addedEdges.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
        return { removedEdges, addedEdges };
    }

    function recordedBoundaryDiff(events) {
        const coalesced = new Map();
        for (const event of events) {
            const current = coalesced.get(event.key);
            if (!current) coalesced.set(event.key, { from: event.from, to: event.to });
            else current.to = event.to;
        }
        const removedEdges = [];
        const addedEdges = [];
        for (const [key, event] of coalesced) {
            if (event.from && !event.to) removedEdges.push(edgePair(key));
            if (!event.from && event.to) addedEdges.push(edgePair(key));
        }
        removedEdges.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
        addedEdges.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
        return { removedEdges, addedEdges };
    }

    function topologyDiff(before, after) {
        const ids = new Set([...before.keys(), ...after.keys()]);
        const retiredTriangles = [];
        const createdTriangles = [];
        for (const triangleId of ids) {
            const oldFingerprint = before.get(triangleId);
            const newFingerprint = after.get(triangleId);
            if (oldFingerprint !== undefined && oldFingerprint !== newFingerprint) {
                retiredTriangles.push({ triangleId, fingerprint: oldFingerprint });
            }
            if (newFingerprint !== undefined && oldFingerprint !== newFingerprint) {
                createdTriangles.push({ triangleId, fingerprint: newFingerprint });
            }
        }
        return { retiredTriangles, createdTriangles };
    }

    function sameEdges(left, right) {
        return JSON.stringify(left) === JSON.stringify(right);
    }

    function edgeDifferenceCount(left, right) {
        const leftKeys = new Set(left.map(([a, b]) => visibilityEdgeKey(a, b)));
        const rightKeys = new Set(right.map(([a, b]) => visibilityEdgeKey(a, b)));
        return [...leftKeys].filter(key => !rightKeys.has(key)).length
            + [...rightKeys].filter(key => !leftKeys.has(key)).length;
    }

    function commitVisibilityPatch(session) {
        assertActive(session);
        const afterBoundary = captureBoundaryState(session.world);
        const afterTopology = captureTopologyState(session.world);
        const oracle = boundaryDiff(session.beforeBoundary, afterBoundary);
        const recorded = recordedBoundaryDiff(session.boundaryEvents);
        const topology = topologyDiff(session.beforeTopology, afterTopology);
        const directBoundaryEventMatch = sameEdges(recorded.removedEdges, oracle.removedEdges)
            && sameEdges(recorded.addedEdges, oracle.addedEdges);
        session.active = false;
        const summary = {
            status: "committed",
            source: session.source,
            // P0 is shadow infrastructure: the before/after oracle is authoritative and fills
            // materialization changes that currently bypass setMeshBoundary. P3 must close the
            // direct-event gap before it can consume events without this full snapshot.
            removedEdges: oracle.removedEdges,
            addedEdges: oracle.addedEdges,
            recordedRemovedEdges: recorded.removedEdges,
            recordedAddedEdges: recorded.addedEdges,
            oracleRemovedEdges: oracle.removedEdges,
            oracleAddedEdges: oracle.addedEdges,
            directBoundaryEventMatch,
            boundaryOracleMatch: true,
            reconciledBoundaryEventCount: directBoundaryEventMatch ? 0
                : edgeDifferenceCount(oracle.removedEdges, recorded.removedEdges)
                    + edgeDifferenceCount(oracle.addedEdges, recorded.addedEdges),
            retiredTriangles: topology.retiredTriangles,
            createdTriangles: topology.createdTriangles,
            touchedPointIds: [...session.touchedPointIds].sort((a, b) => a - b),
            rawBoundaryEventCount: session.boundaryEvents.length,
            materializationEvents: session.materializationEvents.map(event => ({ ...event }))
        };
        return deepFreeze(summary);
    }

    function abortVisibilityPatch(session) {
        if (!session?.active) return deepFreeze({ status: "aborted", discardedEventCount: 0 });
        const discardedEventCount = session.boundaryEvents.length + session.materializationEvents.length;
        session.active = false;
        session.boundaryEvents.length = 0;
        session.materializationEvents.length = 0;
        session.touchedPointIds.clear();
        return deepFreeze({ status: "aborted", discardedEventCount });
    }

    return {
        visibilityEdgeKey,
        captureBoundaryState,
        captureTopologyState,
        beginVisibilityPatch,
        recordVisibilityBoundaryChange,
        recordVisibilityMaterialization,
        recordVisibilityBagChanges,
        commitVisibilityPatch,
        abortVisibilityPatch
    };
});
