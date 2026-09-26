(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    Object.assign(root, api);
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    function meshEdgeKey(a, b) {
        return a < b ? `${a}:${b}` : `${b}:${a}`;
    }

    function buildMeshEdgeIndex(world) {
        const index = new Map();
        world.totalUcgenList.forEach((triangle, triangleId) => {
            if (triangle.disabled) return;
            triangle.kenarList.forEach((edge, edgeId) => {
                const key = meshEdgeKey(edge.uc1NoktaNo, edge.uc2NoktaNo);
                const records = index.get(key) || [];
                records.push({ triangleId, edgeId, edge });
                index.set(key, records);
            });
        });
        return index;
    }

    function orientation(a, b, c, epsilon = 1e-9) {
        const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
        return Math.abs(cross) <= epsilon ? 0 : Math.sign(cross);
    }

    function onSegment(a, b, p, epsilon = 1e-9) {
        return p.x >= Math.min(a.x, b.x) - epsilon && p.x <= Math.max(a.x, b.x) + epsilon
            && p.y >= Math.min(a.y, b.y) - epsilon && p.y <= Math.max(a.y, b.y) + epsilon;
    }

    // Koordinat-tabanlı kesişim testi. Bilinçli olarak k_optHelper.js'teki ID-tabanlı global
    // `segmentsIntersect(viewerA, seenA, viewerB, seenB, world)` ile FARKLI isimdedir; aynı isimle
    // export edilirse yükleme sırasına göre k-opt sessizce bozulur (ID'ler üzerinde .x -> NaN).
    function segmentsIntersectCoords(a, b, c, d, epsilon = 1e-9) {
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

    function pointPosition(entry, points) {
        const point = typeof entry === "number" ? points[entry] : entry;
        if (!point) throw new RangeError(`Missing route point ${entry}`);
        return point.kendiYeri || point;
    }

    function assertSimpleOrder(order, points, epsilon = 1e-9) {
        for (let left = 0; left < order.length; left++) {
            const leftNext = (left + 1) % order.length;
            const a = pointPosition(order[left], points);
            const b = pointPosition(order[leftNext], points);
            for (let right = left + 1; right < order.length; right++) {
                const rightNext = (right + 1) % order.length;
                if (right === leftNext || rightNext === left) continue;
                const c = pointPosition(order[right], points);
                const d = pointPosition(order[rightNext], points);
                if (segmentsIntersectCoords(a, b, c, d, epsilon)) {
                    throw new Error(`Route self-intersection between edges ${left} and ${right}`);
                }
            }
        }
        return true;
    }

    function signedArea(order, points) {
        let twiceArea = 0;
        for (let index = 0; index < order.length; index++) {
            const a = pointPosition(order[index], points);
            const b = pointPosition(order[(index + 1) % order.length], points);
            twiceArea += a.x * b.y - b.x * a.y;
        }
        return twiceArea / 2;
    }

    function assertPatchSimple(patch, points, epsilon = 1e-9) {
        const removed = new Set(patch.removedEdges.map(([a, b]) => meshEdgeKey(a, b)));
        for (const [aId, bId] of patch.addedEdges) {
            const a = pointPosition(aId, points);
            const b = pointPosition(bId, points);
            for (let index = 0; index < patch.before.length; index++) {
                const cId = patch.before[index];
                const dId = patch.before[(index + 1) % patch.before.length];
                if (removed.has(meshEdgeKey(cId, dId)) || aId === cId || aId === dId || bId === cId || bId === dId) continue;
                if (segmentsIntersectCoords(a, b, pointPosition(cId, points), pointPosition(dId, points), epsilon)) {
                    throw new Error(`Added bridge ${aId}-${bId} intersects route edge ${cId}-${dId}`);
                }
            }
        }
        for (let left = 0; left < patch.addedEdges.length; left++) {
            const [aId, bId] = patch.addedEdges[left];
            for (let right = left + 1; right < patch.addedEdges.length; right++) {
                const [cId, dId] = patch.addedEdges[right];
                if (aId === cId || aId === dId || bId === cId || bId === dId) continue;
                if (segmentsIntersectCoords(
                    pointPosition(aId, points), pointPosition(bId, points),
                    pointPosition(cId, points), pointPosition(dId, points), epsilon
                )) throw new Error("Added bridge edges intersect each other");
            }
        }
        return true;
    }

    function assertMeshPairSymmetry(world, records) {
        if (records.length !== 2) throw new Error("A route edge must have two mesh-side records");
        const [left, right] = records;
        if (left.edge.komsuNo !== right.triangleId || right.edge.komsuNo !== left.triangleId
            || left.edge.komsudaKacinciKenarNo !== right.edgeId
            || right.edge.komsudaKacinciKenarNo !== left.edgeId) {
            throw new Error("Mesh neighbor records are not reciprocal");
        }
        if (left.edge.disKenar !== right.edge.disKenar
            || left.edge.polyKenar !== right.edge.polyKenar
            || left.edge.kenarPolyNo !== right.edge.kenarPolyNo) {
            throw new Error("Mesh boundary flags are not symmetric");
        }
        return true;
    }

    function linkMeshPair(records) {
        if (records.length !== 2) throw new Error("A materialized bridge must have exactly two mesh-side records");
        const [left, right] = records;
        left.edge.komsuNo = right.triangleId;
        left.edge.komsudaKacinciKenarNo = right.edgeId;
        right.edge.komsuNo = left.triangleId;
        right.edge.komsudaKacinciKenarNo = left.edgeId;
        return records;
    }

    function snapshotTransaction(world, records) {
        return {
            bags: world.totalNoktaList.map(point => [point.bag1, point.bag2]),
            flags: records.map(record => ({
                edge: record.edge,
                disKenar: record.edge.disKenar,
                polyKenar: record.edge.polyKenar,
                kenarPolyNo: record.edge.kenarPolyNo
            }))
        };
    }

    function rollbackTransaction(world, snapshot) {
        snapshot.bags.forEach(([bag1, bag2], index) => {
            world.totalNoktaList[index].bag1 = bag1;
            world.totalNoktaList[index].bag2 = bag2;
        });
        snapshot.flags.forEach(state => {
            state.edge.disKenar = state.disKenar;
            state.edge.polyKenar = state.polyKenar;
            state.edge.kenarPolyNo = state.kenarPolyNo;
        });
    }

    function setMeshBoundary(records, isBoundary, polygonNo, visibilitySession = null) {
        if (visibilitySession && typeof recordVisibilityBoundaryChange === "function") {
            recordVisibilityBoundaryChange(visibilitySession, records, isBoundary, polygonNo);
        }
        for (const record of records) {
            record.edge.disKenar = isBoundary;
            record.edge.polyKenar = false;
            record.edge.kenarPolyNo = isBoundary ? polygonNo : -1;
        }
    }

    function applyBags(order, world) {
        for (let index = 0; index < order.length; index++) {
            const point = world.totalNoktaList[order[index]];
            point.bag1 = order[(index - 1 + order.length) % order.length];
            point.bag2 = order[(index + 1) % order.length];
        }
    }

    function captureWorldState(world, options = {}) {
        const reusable = options.reusable === true;
        const excludeVisibility = options.excludeVisibility === true;
        const pointSet = excludeVisibility ? new WeakSet(world.totalNoktaList) : null;
        const triangleSet = excludeVisibility ? new WeakSet(world.totalUcgenList) : null;
        const edgeSet = excludeVisibility
            ? new WeakSet(world.totalUcgenList.flatMap(triangle => triangle.kenarList))
            : null;
        const seen = new WeakSet();
        const records = [];

        const skipTraversal = (target, key) => {
            if (!excludeVisibility) return false;
            if (target === world) {
                return ["rays", "pointRayIndex", "routeMetricCache", "routeRawMetricCache",
                    "projectionTasks", "edgeTasks", "lookAtTasks"].includes(key);
            }
            if (pointSet.has(target)) {
                return ["visibleList", "invisibleList", "relatedRays", "lookAtTasks"].includes(key);
            }
            if (triangleSet.has(target)) return key === "rayKeys";
            if (edgeSet.has(target)) return key === "relatedRays";
            return false;
        };

        const visit = value => {
            if (!value || (typeof value !== "object" && typeof value !== "function") || seen.has(value)) return;
            if (typeof value === "function") return;
            seen.add(value);

            // Donmuş bir nesnenin kendi anahtarları da değerleri de değişemez; geri
            // yükleme onun için garantili no-op'tur, kaydı tutmanın tek etkisi
            // restore()'un yazılamaz bir özelliğe atama yapıp fırlatmasıdır. Teorik
            // değil: KBDB raporunu world'e bırakıyor (lastKoptAndBatchedDoubleBridgeReport)
            // ve rapor freezeCandidate'in dondurduğu adayları taşıyor, dolayısıyla
            // KBDB'den sonraki HER snapshot bu grafiği geziyor. Gezinme sürer, çünkü
            // donmuş bir nesne hâlâ değişebilir nesnelere referans tutabilir.
            // Map/Set muaftır: Object.freeze onların .set/.add/.clear'ını engellemez,
            // yani hâlâ değişirler ve kayıtları gerekir.
            const frozen = Object.isFrozen(value);

            if (Array.isArray(value)) {
                const items = value.slice();
                if (!frozen) records.push({ type: "array", target: value, items });
                items.forEach(visit);
                return;
            }
            if (value instanceof Map) {
                const entries = [...value.entries()];
                records.push({ type: "map", target: value, entries });
                entries.forEach(([key, item]) => { visit(key); visit(item); });
                return;
            }
            if (value instanceof Set) {
                const items = [...value.values()];
                records.push({ type: "set", target: value, items });
                items.forEach(visit);
                return;
            }

            const keys = Reflect.ownKeys(value);
            const values = new Map(keys.map(key => [key, value[key]]));
            if (!frozen) records.push({ type: "object", target: value, keys: new Set(keys), values });
            values.forEach((item, key) => {
                if (!skipTraversal(value, key)) visit(item);
            });
        };

        visit(world);
        const privateState = {
            aramailkNoktasi: world.aramailkNoktasi,
            earKesisimKenarGidenUcgen: world.earKesisimKenarGidenUcgen,
            earKesisimKenarGelenUcgen: world.earKesisimKenarGelenUcgen,
            gidenMuseumSonUcgen: world.gidenMuseumSonUcgen
        };
        let restored = false;
        return {
            objectCount: records.length,
            reusable,
            restore() {
                if (restored && !reusable) return;
                for (const record of records) {
                    if (record.type === "object") {
                        for (const key of Reflect.ownKeys(record.target)) {
                            if (!record.keys.has(key)) delete record.target[key];
                        }
                        record.values.forEach((value, key) => { record.target[key] = value; });
                    } else if (record.type === "array") {
                        record.target.length = 0;
                        record.target.push(...record.items);
                    } else if (record.type === "map") {
                        record.target.clear();
                        record.entries.forEach(([key, value]) => record.target.set(key, value));
                    } else if (record.type === "set") {
                        record.target.clear();
                        record.items.forEach(value => record.target.add(value));
                    }
                }
                world.aramailkNoktasi = privateState.aramailkNoktasi;
                world.earKesisimKenarGidenUcgen = privateState.earKesisimKenarGidenUcgen;
                world.earKesisimKenarGelenUcgen = privateState.earKesisimKenarGelenUcgen;
                world.gidenMuseumSonUcgen = privateState.gidenMuseumSonUcgen;
                if (excludeVisibility) {
                    if (typeof resetObjectOccState !== "function") {
                        throw new Error("ObjectOcc reset is required for a bounded rollback snapshot");
                    }
                    resetObjectOccState(world, { replaceCollections: true });
                }
                restored = true;
            }
        };
    }

    function validateRoutePatch(world, patch, options = {}) {
        if (!patch) throw new Error("RoutePatch is required");
        if (!patch.improvesImmediately && !options.allowNonImproving) {
            throw new Error("RoutePatch does not improve immediately");
        }
        if (Number.isFinite(options.maxImmediateDelta)
            && patch.immediateDelta > options.maxImmediateDelta) {
            throw new Error(`RoutePatch exceeds immediate worsening limit: ${patch.immediateDelta}`);
        }
        const points = world.totalNoktaList;
        const lengthFunction = patch.distanceMetric === "EUCLIDEAN_RAW" ? tourLengthRaw : tourLength;
        if (typeof assertHamiltonianOrder !== "function" || typeof lengthFunction !== "function") {
            throw new Error("doubleBridge route helpers are required");
        }
        assertHamiltonianOrder(patch.before, patch.after, points);
        // Production validity comes from the overlay + triangle-walk corridor below.  Keep
        // the coordinate sweep only as an explicitly requested diagnostic assertion.
        if (options.assertSimple === true) assertPatchSimple(patch, points, options.epsilon);
        const beforeArea = signedArea(patch.before, points);
        const afterArea = signedArea(patch.after, points);
        if (Math.sign(beforeArea) !== Math.sign(afterArea)) throw new Error("Route orientation changed");
        const fullDelta = lengthFunction(patch.after, points) - lengthFunction(patch.before, points);
        if (Math.abs(fullDelta - patch.immediateDelta) > (options.deltaTolerance || 1e-6)) {
            throw new Error("RoutePatch O(1) delta does not match full tour delta");
        }
        for (const id of patch.before) {
            const point = points[id];
            if (!point || point.turemis || point.sourcePointId === null || point.sourcePointId === undefined) {
                throw new Error(`Invalid mandatory route point ${id}`);
            }
        }

        const meshIndex = buildMeshEdgeIndex(world);
        const resolve = ([a, b], allowMissing = false) => {
            const records = meshIndex.get(meshEdgeKey(a, b));
            if (!records) {
                if (allowMissing) return null;
                throw new Error(`Bridge edge ${a}-${b} is not materialized in the mesh`);
            }
            assertMeshPairSymmetry(world, records);
            return records;
        };
        const removed = patch.removedEdges.map(resolve);
        const added = patch.addedEdges.map(edge => resolve(edge, options.materializeMissingEdges === true));
        const presentRecords = [...removed, ...added.filter(Boolean)].flat();
        return {
            removed,
            added,
            missingAddedEdges: patch.addedEdges.filter((_, index) => !added[index]),
            affectedTriangles: [...new Set(presentRecords.map(record => record.triangleId))],
            affectedRays: [...new Set(presentRecords.flatMap(record => [...(record.edge.relatedRays || [])]))],
            fullDelta
        };
    }

    function materializeMeshEdge(world, aId, bId, visibilitySession = null, options = {}) {
        if (visibilitySession && typeof recordVisibilityMaterialization === "function") {
            recordVisibilityMaterialization(visibilitySession, "before", aId, bId);
        }
        try {
        const existing = buildMeshEdgeIndex(world).get(meshEdgeKey(aId, bId));
        if (existing) return existing;
        if (typeof pointToPointQuery2 !== "function" || typeof connectPoints !== "function") {
            throw new Error("Mesh triangle-walk helpers are unavailable");
        }
        const cachedRay = typeof getPointRay === "function"
            ? getPointRay(world, aId, bId)
            : world.pointRayIndex?.get(meshEdgeKey(aId, bId));
        // A cached ObjectOcc ray also carries the successful source interval.  Starting the
        // triangle-walk there avoids retrying unrelated angular intervals; if the ray is in
        // the opposite direction we simply walk from that endpoint.
        const walkFromId = cachedRay?.p1No === bId ? bId : aId;
        const walkToId = walkFromId === aId ? bId : aId;
        const source = world.totalNoktaList[walkFromId];
        const target = world.totalNoktaList[walkToId];
        if (!source || !target) throw new Error(`Missing bridge endpoint ${aId}-${bId}`);

        let blockingEdge = null;
        const noteBlocker = answer => {
            const blocker = answer?.ilKesilenDiskenar;
            if (blocker
                && blocker.uc1NoktaNo !== aId && blocker.uc2NoktaNo !== aId
                && blocker.uc1NoktaNo !== bId && blocker.uc2NoktaNo !== bId) {
                blockingEdge = [blocker.uc1NoktaNo, blocker.uc2NoktaNo];
            }
        };
        if (options.requireCachedRay === true && !cachedRay) {
            throw new Error(`A cached ObjectOcc ray is required for bridge edge ${aId}-${bId}`);
        }
        const preferredIntervalId = cachedRay?.p1No === walkFromId ? cachedRay.intervalId : -1;
        const intervals = options.requireCachedRay === true
            ? [{ interval: source.aralikList[preferredIntervalId], index: preferredIntervalId }]
            : source.aralikList
                .map((interval, index) => ({ interval, index }))
                .sort((left, right) =>
                    (left.index === preferredIntervalId ? -1 : 0)
                    - (right.index === preferredIntervalId ? -1 : 0));
        for (const { interval } of intervals) {
            if (!interval || interval.disabled) continue;
            let answer = pointToPointQuery2(
                source,
                target.kendiYeri,
                true,
                interval,
                0,
                world.totalNoktaList,
                world.totalUcgenList,
                world
            );
            if (answer.durum <= 0) {
                noteBlocker(answer);
                continue;
            }
            // pointToPointQuery2 already walked the triangle corridor and tells us which
            // active boundary would be crossed.  Do not call connectPoints in that case:
            // doing so would retriangulate through a protected edge and only reveal the
            // crossing later as a disappeared bridge.
            noteBlocker(answer);
            if (blockingEdge) continue;
            answer = connectPoints(target, source, interval, answer, -1, world);
            if (!answer?.connected) {
                noteBlocker(answer);
                continue;
            }
            const records = buildMeshEdgeIndex(world).get(meshEdgeKey(aId, bId));
            if (records) return linkMeshPair(records);
        }
        // Walk'un kestiği sınır kenarı (ilKesilenDiskenar) hataya iliştirilir: çağıran taraf
        // kesişen tur kenarı çiftini tam tarama yapmadan doğrudan mesh'ten öğrenir.
        const error = new Error(`Triangle-walk could not materialize bridge edge ${aId}-${bId}`);
        error.bridgeEdge = [aId, bId];
        error.objectOccRayUsed = !!cachedRay;
        if (blockingEdge) error.blockingEdge = blockingEdge;
        throw error;
        } finally {
            if (visibilitySession && typeof recordVisibilityMaterialization === "function") {
                recordVisibilityMaterialization(visibilitySession, "after", aId, bId);
            }
        }
    }

    function applyRoutePatchTransaction(world, patch, options = {}) {
        let validation;
        let snapshot;
        let visibilitySession = null;
        const timings = { overlayValidationMs: 0, commitMs: 0, rollbackMs: 0 };
        const clock = () => typeof performance !== "undefined" ? performance.now() : Date.now();
        try {
            const validationStart = clock();
            validation = validateRoutePatch(world, patch, options);
            timings.overlayValidationMs = clock() - validationStart;
            if (options.collectVisibilityPatch === true) {
                if (typeof beginVisibilityPatch !== "function") throw new Error("visibilityPatch helpers are required");
                visibilitySession = beginVisibilityPatch(world, { source: "route-patch", patch });
            }
            const records = [...validation.removed, ...validation.added.filter(Boolean)].flat();
            snapshot = options.materializeMissingEdges
                ? captureWorldState(world)
                : snapshotTransaction(world, records);
            const commitStart = clock();
            for (const recordsForEdge of validation.removed) setMeshBoundary(recordsForEdge, false, -1, visibilitySession);
            if (options.materializeMissingEdges) {
                validation.missingAddedEdges.forEach(([a, b]) => materializeMeshEdge(
                    world, a, b, visibilitySession, options.materializationOptions));
                const refreshedIndex = buildMeshEdgeIndex(world);
                validation.removed = patch.removedEdges.map(([a, b]) => {
                    const refreshed = refreshedIndex.get(meshEdgeKey(a, b));
                    if (!refreshed) return null;
                    linkMeshPair(refreshed);
                    setMeshBoundary(refreshed, false, -1, visibilitySession);
                    return refreshed;
                }).filter(Boolean);
                validation.added = patch.addedEdges.map(([a, b]) => {
                    const refreshed = refreshedIndex.get(meshEdgeKey(a, b));
                    if (!refreshed) throw new Error(`Materialized bridge edge disappeared: ${a}-${b}`);
                    linkMeshPair(refreshed);
                    assertMeshPairSymmetry(world, refreshed);
                    return refreshed;
                });
            }
            for (const recordsForEdge of validation.added) setMeshBoundary(recordsForEdge, true, options.polygonNo ?? 0, visibilitySession);
            applyBags(patch.after, world);
            if (visibilitySession && typeof recordVisibilityBagChanges === "function") {
                recordVisibilityBagChanges(visibilitySession, patch.before, patch.after);
            }
            if (options.beforeCommit) options.beforeCommit({ world, patch, validation });
            for (const recordsForEdge of [...validation.removed, ...validation.added]) {
                assertMeshPairSymmetry(world, recordsForEdge);
            }
            const committedOrder = typeof tourOrderFromBags === "function"
                ? tourOrderFromBags(patch.after[0], world)
                : patch.after;
            assertHamiltonianOrder(patch.before, committedOrder, world.totalNoktaList);
            timings.commitMs = clock() - commitStart;
            const visibilityPatch = visibilitySession ? commitVisibilityPatch(visibilitySession) : undefined;
            return {
                committed: true,
                timings,
                patch: Object.freeze({
                    ...patch,
                    affectedTriangles: Object.freeze(validation.affectedTriangles),
                    affectedRays: Object.freeze(validation.affectedRays),
                    inversePatch: snapshot
                }),
                order: committedOrder,
                ...(visibilityPatch ? { visibilityPatch } : {})
            };
        } catch (error) {
            if (snapshot) {
                const rollbackStart = clock();
                if (typeof snapshot.restore === "function") snapshot.restore();
                else rollbackTransaction(world, snapshot);
                timings.rollbackMs = clock() - rollbackStart;
            }
            if (visibilitySession?.active && typeof abortVisibilityPatch === "function") abortVisibilityPatch(visibilitySession);
            if (options.throwOnFailure) throw error;
            return {
                committed: false,
                error,
                patch,
                timings,
                rollbackSnapshotObjectCount: snapshot?.objectCount ?? null
            };
        }
    }

    // Aşama 2 (route-ils-plani.md): k-kenar diff patch commit'i. buildDiffPatch çıktısını mesh'e
    // atomik işler; 4-kenar RoutePatch varsayımı yoktur. Otoriter geometrik doğrulama triangle-walk
    // materializasyonudur (kesişen kenar walk'ta başarısız olur ve rollback tetikler).
    function validateTourDiff(world, patch, options = {}) {
        if (!patch || !Array.isArray(patch.removedEdges) || !Array.isArray(patch.addedEdges)) {
            throw new Error("Tour diff patch is required");
        }
        if (!patch.improvesImmediately && !options.allowNonImproving) {
            throw new Error("Tour diff does not improve");
        }
        if (Number.isFinite(options.maxImmediateDelta)
            && patch.immediateDelta > options.maxImmediateDelta) {
            throw new Error(`Tour diff exceeds immediate worsening limit: ${patch.immediateDelta}`);
        }
        const points = world.totalNoktaList;
        if (typeof assertHamiltonianOrder !== "function") {
            throw new Error("doubleBridge route helpers are required");
        }
        assertHamiltonianOrder(patch.before, patch.after, points);
        const lengthFunction = patch.distanceMetric === "EUCLIDEAN_RAW" ? tourLengthRaw : tourLength;
        if (typeof lengthFunction !== "function") throw new Error("doubleBridge route length helper is required");
        const fullDelta = lengthFunction(patch.after, points) - lengthFunction(patch.before, points);
        if (Math.abs(fullDelta - patch.immediateDelta) > (options.deltaTolerance || 1e-6)) {
            throw new Error("Tour diff delta does not match full tour delta");
        }
        for (const id of patch.before) {
            const point = points[id];
            if (!point || point.turemis || point.sourcePointId === null || point.sourcePointId === undefined) {
                throw new Error(`Invalid mandatory route point ${id}`);
            }
        }
        // Karesel koordinat taraması üretim yolunda çalışmaz.  Removed-edge overlay kurulduktan
        // sonra her added edge triangle-walk ile materialize edilir; yeni kenarlar anında boundary
        // işaretlendiğinden sonraki walk kesişimi doğrudan blockingEdge olarak bildirir.
        if (options.assertSimple === true) {
            assertSimpleOrder(patch.after, points, options.epsilon);
        }
        const meshIndex = buildMeshEdgeIndex(world);
        const removed = patch.removedEdges.map(([a, b]) => {
            const records = meshIndex.get(meshEdgeKey(a, b));
            if (!records) throw new Error(`Removed tour edge ${a}-${b} is not in the mesh`);
            assertMeshPairSymmetry(world, records);
            return records;
        });
        const added = patch.addedEdges.map(([a, b]) => {
            const records = meshIndex.get(meshEdgeKey(a, b)) || null;
            if (!records && !options.materializeMissingEdges) {
                throw new Error(`Bridge edge ${a}-${b} is not materialized in the mesh`);
            }
            if (records) assertMeshPairSymmetry(world, records);
            return records;
        });
        return { removed, added };
    }

    function applyTourDiffTransaction(world, patch, options = {}) {
        const clock = () => typeof performance !== "undefined" ? performance.now() : Date.now();
        const timings = { validationMs: 0, commitMs: 0, rollbackMs: 0 };
        let snapshot;
        let visibilitySession = null;
        try {
            const validationStart = clock();
            const validation = validateTourDiff(world, patch, options);
            timings.validationMs = clock() - validationStart;
            if (options.collectVisibilityPatch === true) {
                if (typeof beginVisibilityPatch !== "function") throw new Error("visibilityPatch helpers are required");
                visibilitySession = beginVisibilityPatch(world, { source: "tour-diff", patch });
            }

            const needsMaterialization = validation.added.some(records => !records);
            snapshot = options.rollbackSnapshot || (needsMaterialization
                ? captureWorldState(world, { excludeVisibility: options.boundedVisibilityRollback === true })
                : snapshotTransaction(world, [...validation.removed, ...validation.added].flat()));

            const commitStart = clock();
            for (const records of validation.removed) setMeshBoundary(records, false, -1, visibilitySession);
            // Mesh'te zaten bulunan yeni kenarlar planardır; önce boundary yaparak eksik
            // kenarların triangle-walk'una gerçek yeni turun koridorunu gösteririz.
            validation.added.forEach(records => {
                if (records) setMeshBoundary(records, true, options.polygonNo ?? 0, visibilitySession);
            });
            if (needsMaterialization) {
                for (let index = 0; index < patch.addedEdges.length; index++) {
                    if (validation.added[index]) continue;
                    const [a, b] = patch.addedEdges[index];
                    const records = materializeMeshEdge(
                        world, a, b, visibilitySession, options.materializationOptions);
                    setMeshBoundary(records, true, options.polygonNo ?? 0, visibilitySession);
                }
            }
            // Retriangulation eski kenarları silmiş/yeniden yaratmış olabilir; indeks tazelenir.
            const refreshed = buildMeshEdgeIndex(world);
            for (const [a, b] of patch.removedEdges) {
                const records = refreshed.get(meshEdgeKey(a, b));
                if (records) {
                    linkMeshPair(records);
                    setMeshBoundary(records, false, -1, visibilitySession);
                }
            }
            const addedRecords = patch.addedEdges.map(([a, b]) => {
                const records = refreshed.get(meshEdgeKey(a, b));
                if (!records) throw new Error(`Bridge edge disappeared after materialization: ${a}-${b}`);
                linkMeshPair(records);
                setMeshBoundary(records, true, options.polygonNo ?? 0, visibilitySession);
                return records;
            });
            applyBags(patch.after, world);
            if (visibilitySession && typeof recordVisibilityBagChanges === "function") {
                recordVisibilityBagChanges(visibilitySession, patch.before, patch.after);
            }
            if (options.beforeCommit) options.beforeCommit({ world, patch });
            for (const records of addedRecords) assertMeshPairSymmetry(world, records);
            const committedOrder = typeof tourOrderFromBags === "function"
                ? tourOrderFromBags(patch.after[0], world)
                : patch.after;
            assertHamiltonianOrder(patch.before, committedOrder, world.totalNoktaList);
            timings.commitMs = clock() - commitStart;
            const visibilityPatch = visibilitySession ? commitVisibilityPatch(visibilitySession) : undefined;
            return { committed: true, timings, patch, order: committedOrder,
                rollbackSnapshotObjectCount: snapshot.objectCount ?? null,
                ...(visibilityPatch ? { visibilityPatch } : {}) };
        } catch (error) {
            if (snapshot) {
                const rollbackStart = clock();
                if (typeof snapshot.restore === "function") snapshot.restore();
                else rollbackTransaction(world, snapshot);
                timings.rollbackMs = clock() - rollbackStart;
            }
            if (visibilitySession?.active && typeof abortVisibilityPatch === "function") abortVisibilityPatch(visibilitySession);
            if (options.throwOnFailure) throw error;
            return {
                committed: false,
                error,
                patch,
                timings,
                rollbackSnapshotObjectCount: snapshot?.objectCount ?? null
            };
        }
    }

    return {
        meshEdgeKey,
        buildMeshEdgeIndex,
        segmentsIntersectCoords,
        assertSimpleOrder,
        assertPatchSimple,
        signedArea,
        assertMeshPairSymmetry,
        linkMeshPair,
        validateRoutePatch,
        validateTourDiff,
        materializeMeshEdge,
        applyRoutePatchTransaction,
        applyTourDiffTransaction,
        rollbackTransaction,
        captureWorldState
    };
});
