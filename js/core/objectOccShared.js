"use strict";

const sharedSetLoaders = new WeakMap();
class SharedVisibilitySet extends Set {
    constructor(loader) { super(); sharedSetLoaders.set(this, loader); }
    load() {
        const loader = sharedSetLoaders.get(this);
        if (!loader) return;
        sharedSetLoaders.delete(this);
        for (const item of loader()) Set.prototype.add.call(this, item);
    }
    get size() { this.load(); return super.size; }
    has(value) { this.load(); return super.has(value); }
    add(value) { this.load(); return super.add(value); }
    delete(value) { this.load(); return super.delete(value); }
    clear() { sharedSetLoaders.delete(this); super.clear(); }
    values() { this.load(); return super.values(); }
    keys() { return this.values(); }
    entries() { this.load(); return super.entries(); }
    forEach(callback, thisArg) { this.load(); return super.forEach(callback, thisArg); }
    [Symbol.iterator]() { return this.values(); }
}
class SharedTrianglePath {
    constructor(node, tail = []) { this.node = node; this.tail = tail; }
}

// Idea A: one portal graph and a persistent cone forest. Targets share their
// prefixes; forward and reverse indexes are finalized once in ray insertion
// order before existing consumers run. This does not claim an O(n log n + k) worst-case bound: cone expansion,
// legacy frame/projection compatibility and consumer materialization are
// accounted for separately. The legacy mode remains the default.
function buildSharedVisibility(world) {
    const points = world.totalNoktaList;
    const triangles = world.totalUcgenList;
    const visible = points.map(() => new Map());
    const invisible = points.map((_, id) => new Set(id > 3 ? [id] : []));
    const stats = { portals: 0, seeds: 0, coneSteps: 0, vertexChecks: 0, output: 0 };
    const hits = points.map(() => new Map());
    const walls = points.map(() => []);
    const sectors = new Map();
    function makeNode(triangle, parent, interval, entry = null) {
        return { triangle, parent, interval, entry };
    }
    const TAU = 2 * Math.PI;
    const TOL = 1e-12;
    const portals = triangles.map(tri => tri.disabled ? null : tri.kenarList.map(edge => {
        stats.portals++;
        const neighbor = edge.komsuNo >= 0 ? triangles[edge.komsuNo] : null;
        const other = neighbor?.kenarList[edge.komsudaKacinciKenarNo];
        return { edge, a: edge.uc1NoktaNo, b: edge.uc2NoktaNo, c: edge.karsiNoktaNo,
            next: !edge.disKenar && !other?.disKenar && neighbor && !neighbor.disabled ? edge.komsuNo : -1,
            entry: edge.komsudaKacinciKenarNo };
    }));
    const mark = (origin, target, node) => {
        if (origin === target) return;
        visible[origin].set(target, true);
        if (!hits[origin].has(target)) hits[origin].set(target, node);
        if (visible[target].get(origin) !== true) visible[target].set(origin, false);
    };
    const angle = (origin, target) => Math.atan2(
        points[target].kendiYeri.y - points[origin].kendiYeri.y,
        points[target].kendiYeri.x - points[origin].kendiYeri.x);
    function edgeArc(origin, portal) {
        let low = angle(origin, portal.a), high = angle(origin, portal.b);
        if (high < low) [low, high] = [high, low];
        if (high - low > Math.PI) [low, high] = [high, low + TAU];
        return [low, high];
    }
    const queue = [];
    for (let origin = 4; origin < points.length; origin++) {
        for (const interval of points[origin].aralikList) {
            if (interval.disabled) continue;
            const portal = portals[interval.ucgenNo]?.[interval.ucgeniciKarsiKenarNo];
            if (!portal) throw new Error(`invalid active interval at ${origin}`);
            const node = makeNode(interval.ucgenNo, null, interval);
            mark(origin, portal.a, node);
            mark(origin, portal.b, node);
            const [low, high] = edgeArc(origin, portal);
            sectors.set(interval, { low, high, spans: [] });
            if (high - low <= TOL) continue;
            if (portal.next < 0) { walls[origin].push({ low, high, portal, node }); continue; }
            queue.push([origin, portal.next, portal.entry, low, high, node]);
            stats.seeds++;
        }
    }
    // Breadth-first processing shares the portal representation across every
    // observer. A cone covers every target within its angular interval.
    for (let head = 0; head < queue.length; head++) {
        const [origin, triangleId, entry, low, high, parent] = queue[head];
        const node = makeNode(triangleId, parent, parent.interval, entry);
        queue[head] = null;
        stats.coneSteps++;
        if (stats.coneSteps > 10000000) throw new Error("prototype cone budget exceeded");
        const edges = portals[triangleId];
        const opposite = edges[entry].c;
        let direction = angle(origin, opposite);
        while (direction < low - TOL) direction += TAU;
        stats.vertexChecks++;
        if (opposite !== origin && direction <= high + TOL) mark(origin, opposite, node);
        for (let edgeId = 0; edgeId < 3; edgeId++) {
            if (edgeId === entry) continue;
            const portal = edges[edgeId];
            if (portal.a === origin || portal.b === origin) continue;
            const [edgeLow, edgeHigh] = edgeArc(origin, portal);
            for (let shift = -1; shift <= 1; shift++) {
                const clippedLow = Math.max(low, edgeLow + shift * TAU);
                const clippedHigh = Math.min(high, edgeHigh + shift * TAU);
                if (clippedHigh - clippedLow <= TOL) continue;
                if (portal.next < 0) walls[origin].push({ low: clippedLow, high: clippedHigh, portal, node });
                else queue.push([origin, portal.next, portal.entry, clippedLow, clippedHigh, node]);
            }
        }
    }
    const result = { totalNoktaList: visible.map((visibleList, id) => ({ visibleList, invisibleList: invisible[id] })) };
    stats.output = visible.reduce((sum, list) => sum + list.size, 0);
    for (const spans of walls) spans.sort((a, b) => a.low - b.low);
    for (const spans of walls) for (const span of spans) sectors.get(span.node.interval).spans.push(span);
    return { world: result, stats, hits, walls, sectors };
}

function runSharedObjectOcc(world) {
    const start = objectOccNow();
    resetObjectOccState(world);
    const resetMs = objectOccNow() - start;
    const buildStart = objectOccNow();
    const shared = buildSharedVisibility(world);
    const stats = shared.stats;
    stats.resetMs = resetMs;
    stats.buildMs = objectOccNow() - buildStart;
    Object.assign(stats, { sharedQueries: 0, frameQueries: 0, unresolvedQueries: 0, pathEntries: 0,
        endpointQueries: 0, endpointTriangleSteps: 0,
        lazyRaySets: 0, loadedRaySets: 0, loadedTriangleSets: 0, reverseNodeVisits: 0,
        reverseIndexEntries: 0, indexMs: 0 });
    const ids = new Map(world.totalNoktaList.map((point, id) => [point.kendiYeri, id]));
    const storage = {
        capture(triangles) {
            if (!(triangles instanceof SharedTrianglePath)) return new Set(triangles);
            stats.lazyRaySets++;
            return new SharedVisibilitySet(function* () {
                stats.loadedRaySets++;
                const prefix = [];
                for (let node = triangles.node; node; node = node.parent) {
                    stats.pathEntries++;
                    prefix.push(node.triangle);
                }
                yield* prefix.reverse();
                stats.pathEntries += triangles.tail.length;
                yield* triangles.tail;
            });
        },
        // Reverse indeks finish() icinde butun ray turleri icin tek ekleme
        // sirasiyla kurulur. Burada kismi kayit yapmak projection ray'lerini
        // shared point ray'lerinin onune alip legacy dolasim sirasini bozardi.
        register() {},
        finish() {
            // K-opt triangle.rayKeys'i hemen tuketiyor. Indeksi ucgen basina alt
            // agac tarayip siralamak, maliyeti ObjectOcc disina tasiyor ve yogun
            // rastgele poligonlarda ayni dugumleri defalarca geziyordu. Ray'leri
            // kanonik ekleme sirasinda bir kez acmak hem legacy Set sirasini
            // dogrudan korur hem de toplam isi gercek ray-yol girdileriyle sinirlar.
            const indexStart = objectOccNow();
            for (const [key, ray] of world.rays) {
                for (const triangleId of ray.triangles) {
                    world.totalUcgenList[triangleId].rayKeys.add(key);
                    stats.reverseIndexEntries++;
                }
            }
            stats.indexMs = objectOccNow() - indexStart;
        }
    };
    const query = (point, target, interval, targetWorld) => {
        const targetId = ids.get(target);
        if (targetId === undefined || targetId < 4) {
            stats.frameQueries++;
            return pointToPointQuery3(point, target, interval, targetWorld);
        }
        const origin = point.noktaNo;
        const hit = shared.hits[origin].get(targetId);
        const answer = new PointToAnswer();
        stats.sharedQueries++;
        if (hit) {
            if (hit.interval !== interval) return answer;
            // Preserve the legacy endpoint fan, including its floating-point
            // endpoint crossing decisions. Only the final portal is replayed;
            // the long origin-to-target prefix stays shared.
            const tailInterval = hit.parent ? {
                disabled: false,
                ucgenNo: hit.parent.triangle,
                ucgeniciKarsiKenarNo: targetWorld.totalUcgenList[hit.triangle].kenarList[hit.entry].komsudaKacinciKenarNo
            } : interval;
            const tail = pointToPointQuery3(point, target, tailInterval, targetWorld);
            stats.endpointQueries++;
            stats.endpointTriangleSteps += tail.triangles.size;
            tail.triangles = new SharedTrianglePath(hit.parent, [...tail.triangles]);
            return tail;
        }
        const angle = Math.atan2(target.y - point.kendiYeri.y, target.x - point.kendiYeri.x);
        const sector = shared.sectors.get(interval);
        let sectorDirection = angle;
        while (sectorDirection < sector.low - 1e-12) sectorDirection += 2 * Math.PI;
        if (sectorDirection > sector.high + 1e-12) return answer;
        const spans = sector.spans;
        let low = 0, high = spans.length;
        while (low < high) {
            const mid = (low + high) >>> 1;
            if (spans[mid].low <= sectorDirection + 1e-12) low = mid + 1;
            else high = mid;
        }
        // Interior spans do not overlap; the preceding span may share a vertex.
        for (const index of [low - 1, low - 2]) {
            const span = spans[index];
            if (!span || sectorDirection > span.high + 1e-12) continue;
            answer.durum = 2;
            answer.ilKesilenDiskenar = span.portal.edge;
            return answer;
        }
        // Compatibility path is counted, never represented as shared work.
        stats.unresolvedQueries++;
        return pointToPointQuery3(point, target, interval, targetWorld);
    };
    query.rayStorage = storage;
    try {
        for (const point of world.totalNoktaList) {
            if (point.noktaNo <= 3) continue;
            const processed = new Set();
            lookAtNextSector(point, world, null, query);
            while (!world.projectionTasks.isEmpty() || !world.edgeTasks.isEmpty()) {
                performProjectionTasks(point, world, storage);
                performEdgeTasks(point, world, processed,
                    (observer, targetWorld, edge) => lookAtNextSector(observer, targetWorld, edge, query));
            }
        }
        storage.finish();
        world.objectOccPrepared = true;
        stats.totalMs = objectOccNow() - start;
        return stats;
    } catch (error) {
        world.objectOccPrepared = false;
        throw error;
    }
}

function runSharedObjectOccDiagnosed(world, session) {
    const call = { mode: "shared", totalMs: 0, resetMs: 0, walkMs: null, projectionMs: null,
        indexMs: 0, observerCount: world.totalNoktaList.filter(p => p.noktaNo > 3).length,
        lookAtAttemptCount: 0, triangleStepCount: 0, intersectionPredicateCount: 0,
        projectionTaskCount: null, edgeTaskCount: null, processedEdgeSkipCount: null,
        affectedObserverCount: 0, affectedRayCount: 0, affectedTriangleCount: null,
        memoryDelta: null, error: null };
    const start = objectOccNow();
    session.activeCall = call;
    const restore = installObjectOccDiagnosticFunctions(call);
    try {
        const stats = runSharedObjectOcc(world);
        call.shared = { ...stats };
        call.resetMs = stats.resetMs;
        call.indexMs = stats.indexMs;
        call.affectedObserverCount = call.observerCount;
        call.affectedRayCount = world.rays.size;
        // Do not enumerate deferred reverse indexes merely to count them.
        return stats;
    } catch (error) {
        call.error = error.message;
        throw error;
    } finally {
        restore();
        call.totalMs = objectOccNow() - start;
        session.calls.push(Object.freeze(call));
        session.activeCall = null;
    }
}

if (typeof module === "object" && module.exports) module.exports = { buildSharedVisibility, runSharedObjectOcc, SharedVisibilitySet };
