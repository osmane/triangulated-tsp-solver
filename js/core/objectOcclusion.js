"use strict";

const OBJECT_OCC_DIAGNOSTICS = Symbol("objectOccDiagnostics");

function objectOccNow() {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function startObjectOccDiagnostics(world, options = {}) {
    if (!world) throw new TypeError("world is required");
    if (world[OBJECT_OCC_DIAGNOSTICS]) throw new Error("ObjectOcc diagnostics are already active");
    const session = { options: { ...options }, calls: [], activeCall: null };
    Object.defineProperty(world, OBJECT_OCC_DIAGNOSTICS, {
        value: session,
        configurable: true,
        writable: true
    });
    return session;
}

function stopObjectOccDiagnostics(world) {
    const session = world?.[OBJECT_OCC_DIAGNOSTICS];
    if (!session) return { calls: [], totals: { callCount: 0 } };
    if (session.activeCall) throw new Error("Cannot stop ObjectOcc diagnostics during a rebuild");
    delete world[OBJECT_OCC_DIAGNOSTICS];
    const numericFields = [
        "totalMs", "resetMs", "walkMs", "projectionMs", "indexMs", "memoryDelta",
        "observerCount", "affectedObserverCount", "affectedRayCount", "affectedTriangleCount",
        "lookAtAttemptCount", "triangleStepCount", "intersectionPredicateCount",
        "projectionTaskCount", "edgeTaskCount", "processedEdgeSkipCount"
    ];
    const totals = { callCount: session.calls.length };
    for (const field of numericFields) {
        const values = session.calls.map(call => call[field]).filter(Number.isFinite);
        totals[field] = values.length ? values.reduce((sum, value) => sum + value, 0) : null;
    }
    return { calls: session.calls, totals };
}

/**
 * (ax,ay)–(bx,by) ışınını leksikografik sıraya koyup
 * 124-bit BigInt anahtara paketler.
 *
 *  - Koordinatlar: 3 haneli ondalık (1 mm, 1 px, …) duyarlılık
 *  - Ekran/enlem sınırları:  x ≤ 1 500 000,  y ≤ 800 000
 *
 *  Anahtar düzeni (MSB → LSB):
 *      ax | ay | bx | by      ← her biri 31 bit
 */
function getCanonicalRayKey(p1, p2, projShift = 0) {
    const SCALE = 10000;               // 3 ondalık → tamsayı
    const BITS_PER_COORD = 31n;                // 0-2 147 483 647
    const SHIFT = BITS_PER_COORD;
    const MAX_COORD = (1n << SHIFT) - 1n; // 0x7FFF FFFFn

    // ► 1) Ölçekle & tamsayılaştır
    let ax = Math.round(p1.x * SCALE);
    let ay = Math.round(p1.y * SCALE);
    let bx = Math.round(p2.x * SCALE);
    let by = Math.round(p2.y * SCALE);

    // ► 2) Leksikografik küçük-büyük sıralama
    if (ax > bx || (ax === bx && ay > by)) {
        [ax, ay, bx, by] = [bx, by, ax, ay];
    }

    // ► 3) Aralık kontrolü (hataları erkenden yakalamak için)
    for (const c of [ax, ay, bx, by]) {
        if (c < 0 || c > Number(MAX_COORD))
            throw new RangeError(`Koordinat aralık dışı: ${c / SCALE}`);
    }

    // ► 4) Bit kaydırarak paketle (BigInt)
    let key = BigInt(ax);
    key = (key << SHIFT) + BigInt(ay);
    key = (key << SHIFT) + BigInt(bx);
    key = (key << SHIFT) + BigInt(by);

    // ► 5) (İsteğe bağlı) projeksiyon kaydırması
    return key + BigInt(projShift * SCALE);
}

function getPointRayKey(a, b) {
    return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function getPointRay(world, a, b) {
    return world?.pointRayIndex?.get(getPointRayKey(a, b)) || null;
}

function cross2d(a, b, c) {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function triangleVertices(world, triangle) {
    const pointIds = [];
    for (const edge of triangle?.kenarList || []) {
        if (!pointIds.includes(edge.uc1NoktaNo)) pointIds.push(edge.uc1NoktaNo);
        if (!pointIds.includes(edge.uc2NoktaNo)) pointIds.push(edge.uc2NoktaNo);
    }
    if (pointIds.length !== 3) return null;
    const vertices = pointIds.map(pointId => world.totalNoktaList[pointId]?.kendiYeri);
    return vertices.every(Boolean) ? vertices : null;
}

function pointStrictlyInsideTriangle(point, vertices, epsilon = 1e-8) {
    const signs = [
        cross2d(vertices[0], vertices[1], point),
        cross2d(vertices[1], vertices[2], point),
        cross2d(vertices[2], vertices[0], point)
    ];
    if (signs.some(value => Math.abs(value) <= epsilon)) return false;
    return signs.every(value => value > 0) || signs.every(value => value < 0);
}

function pointInsideTriangleInclusive(point, vertices, epsilon = 1e-8) {
    if (!vertices) return false;
    const signs = [
        cross2d(vertices[0], vertices[1], point),
        cross2d(vertices[1], vertices[2], point),
        cross2d(vertices[2], vertices[0], point)
    ];
    const hasPositive = signs.some(value => value > epsilon);
    const hasNegative = signs.some(value => value < -epsilon);
    return !(hasPositive && hasNegative);
}

function segmentPassesThroughTriangleInterior(start, finish, vertices, epsilon = 1e-9) {
    if (!start || !finish || !vertices) return false;
    const rx = finish.x - start.x;
    const ry = finish.y - start.y;
    const breakpoints = [0, 1];
    for (let index = 0; index < 3; index++) {
        const edgeStart = vertices[index];
        const edgeFinish = vertices[(index + 1) % 3];
        const sx = edgeFinish.x - edgeStart.x;
        const sy = edgeFinish.y - edgeStart.y;
        const denominator = rx * sy - ry * sx;
        if (Math.abs(denominator) <= epsilon) continue;
        const qx = edgeStart.x - start.x;
        const qy = edgeStart.y - start.y;
        const t = (qx * sy - qy * sx) / denominator;
        const u = (qx * ry - qy * rx) / denominator;
        if (t >= -epsilon && t <= 1 + epsilon && u >= -epsilon && u <= 1 + epsilon) {
            breakpoints.push(Math.max(0, Math.min(1, t)));
        }
    }
    breakpoints.sort((a, b) => a - b);
    const unique = breakpoints.filter((value, index) => index === 0 || Math.abs(value - breakpoints[index - 1]) > epsilon);
    for (let index = 0; index + 1 < unique.length; index++) {
        const left = unique[index];
        const right = unique[index + 1];
        if (right - left <= epsilon) continue;
        const t = (left + right) / 2;
        if (pointStrictlyInsideTriangle({ x: start.x + rx * t, y: start.y + ry * t }, vertices)) return true;
    }
    return false;
}

function classifyRayAgainstOutside(world, ray, outside, meshEdgeClasses = null) {
    if (!ray || typeof outside?.has !== "function") return "unknown";
    if (ray.p1No >= 0 && ray.p2No >= 0 && meshEdgeClasses) {
        const directClass = meshEdgeClasses.get(getPointRayKey(ray.p1No, ray.p2No));
        if (directClass) return directClass;
    }

    const states = new Set();
    const addState = triangleId => {
        const triangle = world.totalUcgenList[triangleId];
        if (!triangle || triangle.disabled) return;
        states.add(outside.has(triangleId) ? "exterior" : "interior");
    };
    for (const triangleId of ray.triangles || []) {
        const triangle = world.totalUcgenList[triangleId];
        if (triangle && !triangle.disabled && segmentPassesThroughTriangleInterior(
            ray.p1Loc,
            ray.p2Loc,
            triangleVertices(world, triangle)
        )) addState(triangleId);
    }
    if (states.size === 1) return states.values().next().value;
    if (states.size > 1) return "mixed";

    // Mesh kenarı boyunca yürüyen daha uzun ray'lerde strict triangle-interior
    // kesiti olmayabilir. Midpoint'i ray üçgenleri ve onların komşularında bulup
    // iki tarafın current outside sınıfını okuruz; global point-in-polygon yoktur.
    const midpoint = {
        x: (ray.p1Loc.x + ray.p2Loc.x) / 2,
        y: (ray.p1Loc.y + ray.p2Loc.y) / 2
    };
    const candidates = new Set(ray.triangles || []);
    for (const triangleId of [...candidates]) {
        const triangle = world.totalUcgenList[triangleId];
        for (const edge of triangle?.kenarList || []) {
            if (edge.komsuNo >= 0) candidates.add(edge.komsuNo);
        }
    }
    for (const triangleId of candidates) {
        const triangle = world.totalUcgenList[triangleId];
        if (triangle && !triangle.disabled
            && pointInsideTriangleInclusive(midpoint, triangleVertices(world, triangle))) {
            addState(triangleId);
        }
    }
    if (states.size === 1) return states.values().next().value;
    return states.size > 1 ? "boundary" : "unknown";
}

/**
 * izdüşüm yapılabilmesi için target'dan önceki ve sonraki noktaların ya sağda ya solda olması gerekir
 * biri sağda biri solda ise izdüşüm yapılamaz
 * If `target` is a real point (has noktaNo), decide whether to add a projection
 * task relative to `current`.
 *
 * @param {Object} target   – Candidate point that owns noktaNo
 * @param {Object} current  – Currently selected point
 * @param {Object[]} points – world.totalNoktaList
 */
function readyForProjection(target, current, points) {
    // Yalnızca noktaNo'su OLAN noktalar değerlendirilir. Random üretilen poligonlarda kapanış sırasında projeksiyon olmaması için baglar eklendi
    if (!('noktaNo' in target) || (target.bag1 === null || target.bag2 === null)) return;

    const prev = points[target.bag1];
    const next = points[target.bag2];

    // target‑current vektörüyle prev ve next arasında yönlü çarpımlar
    const cross1 = crossProductLength(
        target.kendiYeri.x, target.kendiYeri.y,
        current.kendiYeri.x, current.kendiYeri.y,
        prev.kendiYeri.x, prev.kendiYeri.y,
    );

    const cross2 = crossProductLength(
        target.kendiYeri.x, target.kendiYeri.y,
        current.kendiYeri.x, current.kendiYeri.y,
        next.kendiYeri.x, next.kendiYeri.y,
    );

    const sameSign = (cross1 > 0 && cross2 > 0) || (cross1 < 0 && cross2 < 0);

    const onSameSide = sameSign || (isZero(cross1) || isZero(cross2));

    return onSameSide;
}

//---------------------------------------------------------------------
// Ana Fonksiyonlar
//---------------------------------------------------------------------

/**
 * lookAt: İki nokta arasındaki görünürlüğü kontrol eder.
 * Eğer görünürse, ray global rays listesine eklenir,
 * ve üçgenlerle ilişkilendirme yapılır. İzdüşüm veya kesişim görevleri tetiklenir.
 */

// Çizgi ekleme fonksiyonu, ek indeksleri de güncelliyor.

function lookAt(currentPoint, targetPoint, world, pointQuery = pointToPointQuery3) {
    if (currentPoint.invisibleList.has(targetPoint.noktaNo)) {
        return false;
    } else if (currentPoint.visibleList.get(targetPoint.noktaNo) === true) {
        return true;
    } else if (currentPoint.visibleList.has(targetPoint.noktaNo)
        && currentPoint.visibleList.get(targetPoint.noktaNo) === false) {
        if (targetPoint.noktaNo > 3) {
            if (readyForProjection(targetPoint, currentPoint, world.totalNoktaList)) {
                world.projectionTasks.enqueue(targetPoint, targetPoint.noktaNo);
            }
        }
        return true;
    }

    let answer = new PointToAnswer();
    let intervalId = 0;
    for (let i = 0; i < currentPoint.aralikList.length; i++) {
        if (!currentPoint.aralikList[i].disabled) {
            answer = pointQuery(
                currentPoint,
                targetPoint.kendiYeri,
                currentPoint.aralikList[i],
                world
            );

            if (answer.durum > 0) {
                intervalId = i;
                break;
            }
        }
    }

    if (
        ((answer.durum == 0) && (answer?.ilKesilenDiskenar == null)) ||
        (
            (answer.durum > 0) &&
            (
                (answer?.ilKesilenDiskenar == null) ||
                (
                    !!answer.ilKesilenDiskenar &&
                    ((answer.ilKesilenDiskenar.uc1NoktaNo == targetPoint.noktaNo) ||
                        (answer.ilKesilenDiskenar.uc2NoktaNo == targetPoint.noktaNo))
                )
            )
        )
    ) {

        addRay(currentPoint, targetPoint, answer.triangles, world, null, null, intervalId, pointQuery.rayStorage);
        if (targetPoint.noktaNo > 3) {
            if (readyForProjection(targetPoint, currentPoint, world.totalNoktaList)) {
                // Eğer bakılan noktanın her iki bağlantısı da ray'e göre aynı taraftaysa bu nokta ötesinde görülebilir bir dış kenar olan bir yapıda olabilir,
                // bu kenarın bir kısmı görünür alana dahil edilebilir durumdadır
                // Bu nedenle bakan nokta ile bakılan nokta yönünde bir izdüşüm zinciri başlatılarak bir dış kenara gelene kadar devam edilir            
                world.projectionTasks.enqueue(targetPoint, targetPoint.noktaNo);
            }
        }
        return true;
    } else {

        // Eğer bakılan nokta yönünde bir poligon kenarı görüşü engellediyse bu kenarın her iki ucuna bir lookAtNext yapılması gerekir
        const tip1 = world.totalNoktaList[answer.ilKesilenDiskenar.uc1NoktaNo].kendiYeri;
        const tip2 = world.totalNoktaList[answer.ilKesilenDiskenar.uc2NoktaNo].kendiYeri;
        const edgeKey = getCanonicalRayKey(tip1, tip2);
        world.edgeTasks.enqueue([answer.ilKesilenDiskenar.uc1NoktaNo, answer.ilKesilenDiskenar.uc2NoktaNo], edgeKey);
        return false;
    }
}

function addRay(currentPoint, targetPoint, triangles, world, projectFrom, edge, intervalId, rayStorage = null) {
    const key = getCanonicalRayKey(currentPoint.kendiYeri, targetPoint?.kendiYeri ?? targetPoint, targetPoint.kendiYeri == undefined ? .123 : 0);

    if (!world.rays.has(key)) {
        const traversedTriangles = rayStorage ? rayStorage.capture(triangles) : new Set(triangles);
        const ray = new Ray({
            p1Loc: currentPoint.kendiYeri,
            p2Loc: targetPoint?.kendiYeri ?? targetPoint, // eğer hedef bir projeksiyon koordinatıysa
            p1No: currentPoint.noktaNo,
            p2No: targetPoint?.noktaNo ?? -1, // projeksiyon Nokta sınıfı değil koordinatsa
            triangles: traversedTriangles,
            projectFrom: projectFrom,   // hangi nokta üzerinden projeksiyon yapıldığı
            key: key,
            length: mesafeHesapla(currentPoint.kendiYeri, targetPoint?.kendiYeri ?? targetPoint),
            projEdgeTip1: edge != null ? edge.uc1NoktaNo : null,
            projEdgeTip2: edge != null ? edge.uc2NoktaNo : null,
            intervalId: intervalId,
        });
        // Nokta-nokta ray'lerde hem optimizer'ın ham Öklid uzunluğu hem de ikincil
        // TSPLIB benchmark maliyeti bir kez hesaplanıp önbelleklenir.
        if (ray.p2No >= 0 && typeof routeEdgeCost === "function") {
            ray.metricLength = routeEdgeCost(currentPoint, targetPoint);
            ray.rawMetricLength = routeEdgeLengthRaw(currentPoint, targetPoint);
            if (!world.routeMetricCache) world.routeMetricCache = new Map();
            world.routeMetricCache.set(getPointRayKey(ray.p1No, ray.p2No), ray.metricLength);
            if (!world.routeRawMetricCache) world.routeRawMetricCache = new Map();
            world.routeRawMetricCache.set(getPointRayKey(ray.p1No, ray.p2No), ray.rawMetricLength);
        }

        world.rays.set(key, ray);
        if (ray.p2No >= 0) {
            if (!world.pointRayIndex) world.pointRayIndex = new Map();
            world.pointRayIndex.set(getPointRayKey(ray.p1No, ray.p2No), ray);
        }

        currentPoint.relatedRays.add(key);
        targetPoint?.relatedRays?.add(key);

        if (edge) {
            edge.relatedRays.add(key);
            if (edge.komsuNo > -1) {
                const neighborTri = world.totalUcgenList[edge.komsuNo];
                const neighborEdge = neighborTri.kenarList[edge.komsudaKacinciKenarNo];
                neighborEdge.relatedRays.add(key);
            }
        }

        //Görünür durumlar için iki nokta arasındaki ışına üzerinde geçtiği üçgenlerin ucgenNo'ları ekleniyor
        if (rayStorage) rayStorage.register(ray, triangles);
        else for (const triangle of ray.triangles) world.totalUcgenList[triangle].rayKeys.add(key);
    }
}

/**
 * lookAtNext: Belirtilen doğrultuda bir sonraki noktayı inceler.
 */
function lookAtNext(currentPoint, world, edge) {
    /* ---------- Yardımcılar --------------------------------------- */
    const getPoint = id => world.totalNoktaList[id];
    const markDirect = (src, id) => src.visibleList.set(id, true);
    const markIndirect = (src, id) => {
        const prev = src.visibleList.get(id);
        // Daha önce 'true' (direct) işareti varsa dokunma
        if (prev !== true) {
            src.visibleList.set(id, false);
        }
    };

    // bakılan nokta sıraya eklenebilir mi, daha önce doğrudan görülür olarak eklenmiş mi
    const shouldQueue = (src, id) =>
        !src.invisibleList.has(id) &&
        (!src.visibleList.has(id) || src.visibleList.get(id) === false);

    /* ---------- 1 | Başlangıç ------------------------------------- */
    // linked list ile bağlantıları izleme yerine üçgen şelalesi yöntemi kullanılabilir
    // daha hızlı olabilir, çoklu poligon içeren haritalarda da kullanılır.
    currentPoint.invisibleList.add(currentPoint.noktaNo);

    let next1Id, next2Id;
    if (!edge) {
        // Normalde bakan noktanın iki tarafındaki bağlantıları her zaman görünür durumdadır
        // Ancak lookAt içinde yapılan ray işlemleri ve projection işlemleri için ek kod yazmamak amacıyla kuyruğa ekleniyor.
        // ray işlemler k-opt değişiklikleri sırasında gereken eventleri üretecek
        next1Id = currentPoint.bag1;
        next2Id = currentPoint.bag2;
    } else {
        next1Id = edge.uc1NoktaNo;
        next2Id = edge.uc2NoktaNo;
    }

    // O(1) kuyruk
    const queue = new UniqueQueue();
    [next1Id, next2Id].forEach(id => {
        if (id !== -1 && shouldQueue(currentPoint, id)) {
            queue.enqueue(getPoint(id), id);
        }
    });

    const visitedIds = new Set([currentPoint.noktaNo]);

    /* ---------- 2 | Kuyruk‑tabanlı tarama -------------------------- */
    while (!queue.isEmpty()) {
        const lookingPoint = queue.dequeue();
        if (!lookingPoint || visitedIds.has(lookingPoint.noktaNo)) continue;
        visitedIds.add(lookingPoint.noktaNo);

        if (!lookAt(currentPoint, lookingPoint, world)) continue;

        markDirect(currentPoint, lookingPoint.noktaNo);
        // Burada nokta daha önceden direct olarak görülmüşse bu durumun tersine çevrilmemesi gerekiyor
        markIndirect(lookingPoint, currentPoint.noktaNo);

        [lookingPoint.bag1, lookingPoint.bag2]
            .filter(id => shouldQueue(currentPoint, id))
            .forEach(id => queue.enqueue(getPoint(id), id));
    }
}

/**
 * lookAtNextSector: Seçili noktanın aktif aralıklarının giden uçlarındaki noktaların aralıklarının giden uçlarına görünürlük 
 * kontrolü yapar, görünür noktalar için işlemi tekrarlar. 
 * iki veya daha fazla poligonun görünürlük kontrolü için çözüm sağlar.
 * Kanonik tam rebuild bu sector yürüyüşünü kullanır; performansı ölçek testlerinde ayrıca raporlanır.
 */
function lookAtNextSector(currentPoint, world, edge, pointQuery = pointToPointQuery3) {
    /* ---------- Yardımcılar --------------------------------------- */
    const getPoint = id => world.totalNoktaList[id];
    const markDirect = (src, id) => src.visibleList.set(id, true);
    const markIndirect = (src, id) => {
        const prev = src.visibleList.get(id);
        // Daha önce 'true' (direct) işareti varsa dokunma
        if (prev !== true) {
            src.visibleList.set(id, false);
        }
    };

    // bakılan nokta sıraya eklenebilir mi, daha önce doğrudan görülür olarak eklenmiş mi
    const shouldQueue = (src, id) =>
        !src.invisibleList.has(id) &&
        (!src.visibleList.has(id) || src.visibleList.get(id) === false);

    /* ---------- 1 | Başlangıç ------------------------------------- */

    currentPoint.invisibleList.add(currentPoint.noktaNo);

    let initialNeighborIds = [];
    if (!edge) {
        initialNeighborIds = getValidNeighborIds(currentPoint);
    } else {
        initialNeighborIds = edge;
    }

    const queue = new UniqueQueue();
    initialNeighborIds.forEach(id => {
        if (shouldQueue(currentPoint, id)) {
            const point = getPoint(id);
            if (point) queue.enqueue(point, id);
        }
    });

    const visitedIds = new Set([currentPoint.noktaNo]);

    /* ---------- 2 | Kuyruk‑tabanlı tarama -------------------------- */
    while (!queue.isEmpty()) {
        const lookingPoint = queue.dequeue();
        if (!lookingPoint || visitedIds.has(lookingPoint.noktaNo)) continue;
        visitedIds.add(lookingPoint.noktaNo);

        if (!lookAt(currentPoint, lookingPoint, world, pointQuery)) continue;

        markDirect(currentPoint, lookingPoint.noktaNo);
        // Burada nokta daha önceden direct olarak görülmüşse bu durumun tersine çevrilmemesi gerekiyor (Bakılan nokta için)
        markIndirect(lookingPoint, currentPoint.noktaNo);

        const lookingNeighborIds = getValidNeighborIds(lookingPoint);
        for (const neighborId of lookingNeighborIds) {
            if (shouldQueue(currentPoint, neighborId)) {
                queue.enqueue(getPoint(neighborId), neighborId);
            }
        }
    }
}

function getValidNeighborIds(point) {
    const neighborIds = [];
    if (!point || !Array.isArray(point.aralikList)) {
        return neighborIds; // Geçersiz nokta veya aralikList yoksa boş dön
    }
    for (let i = 0; i < point.aralikList.length; i++) {
        const aralik = point.aralikList[i];
        if (!aralik.disabled) {
            const neighborId = aralik.gidenUcNo;
            if (neighborId !== -1) {
                neighborIds.push(neighborId);
            }
        }
    }
    return neighborIds;
}

/**
 * performProjectionTasks: Bekleyen izdüşüm görevini uygular,
 * ilerleme yönündeki noktayı kontrol eder ve diğer ucu kuyruğa ekler.
 */
function performProjectionTasks(currentPoint, world, rayStorage = null) {
    const { totalUcgenList, totalNoktaList } = world;
    const { kendiYeri } = currentPoint;
    const eps = epsilon;

    while (!world.projectionTasks.isEmpty()) {
        // currentPoint targetPoint üzerinden projeksiyon yapıyor, köşeden öteye bakıyor.
        const targetPoint = world.projectionTasks.dequeue();
        const { aralikList } = targetPoint;
        const key = getCanonicalRayKey(currentPoint.kendiYeri, targetPoint.kendiYeri);

        // bir projectionTask oluşmuşsa bir ray de vardır, eğer key/ray yok hatası alınırsa geliştirmede bir yanlışlık vardır
        // buraya tolere edici koşullar eklemek giderilmesi daha zor sorunlara yol açar, bu nedenle güvenlik eklemedim 
        const pilotRay = world.rays.get(key);

        let rayTriangles = new Set(pilotRay.triangles); // buradaki son üçgen altta aranan aralık üçgeni olamaz, ancak son üçgeni bulmak daha maliyetli

        // Bu targetPoint üzerinde bir kenar bulduğumuzda çıkacağız
        let foundValidEdge = false;

        let edge;
        let intervalId;
        for (intervalId = 0; intervalId < aralikList.length; intervalId++) {
            const interval = aralikList[intervalId];
            if (interval.disabled) continue;

            const ucgen = totalUcgenList[interval.ucgenNo];
            edge = ucgen.kenarList[interval.ucgeniciKarsiKenarNo];


            if (_isValidProjection(edge, targetPoint, kendiYeri, totalNoktaList, eps)) {

                rayTriangles.add(interval.ucgenNo);

                // Eğer kenar dış kenar ya da komşu yoksa genişlet
                edge = _findNeighboringValidEdge(edge, targetPoint, kendiYeri, totalUcgenList, totalNoktaList, eps, rayTriangles);
                foundValidEdge = !!edge;
            }


            if (foundValidEdge) {
                break;
            }
        }

        addRay(currentPoint, edge.projectionLoc, rayTriangles, world, targetPoint.noktaNo, edge, intervalId, rayStorage);

        const tip1 = world.totalNoktaList[edge.uc1NoktaNo].kendiYeri;
        const tip2 = world.totalNoktaList[edge.uc2NoktaNo].kendiYeri;
        const edgeKey = getCanonicalRayKey(tip1, tip2);
        // Eğer bakılan nokta yönünde bir poligon kenarı görüşü engellediyse bu kenarın her iki ucuna bir lookAtNext yapılması gerekir
        world.edgeTasks.enqueue([edge.uc1NoktaNo, edge.uc2NoktaNo], edgeKey);
    }
}

function _isValidProjection(edge, targetPoint, ownPos, noktaList, eps) {
    const answer = collKesisimHesapla(edge, targetPoint, ownPos, 0, noktaList);
    if (answer.durum !== 0) return false;

    const virtualLen = answer.uc1toKN + answer.uc2toKN;
    const p1 = noktaList[edge.uc1NoktaNo].kendiYeri;
    const p2 = noktaList[edge.uc2NoktaNo].kendiYeri;
    const actualLen = mesafeHesapla(p1, p2);
    edge.projectionLoc = answer.kesisimNok;
    return Math.abs(virtualLen - actualLen) < eps;
    /*const tmpEps = 0.001;

    const edgeX1Diff = answer.kesisimNok.x - noktaList[edge.uc1NoktaNo].kendiYeri.x;
    const edgeY1Diff = answer.kesisimNok.y - noktaList[edge.uc1NoktaNo].kendiYeri.y;
    if (Math.abs(edgeX1Diff) < tmpEps && Math.abs(edgeY1Diff) < tmpEps) {
        return false;
    }

    const edgeX2Diff = answer.kesisimNok.x - noktaList[edge.uc2NoktaNo].kendiYeri.x;
    const edgeY2Diff = answer.kesisimNok.y - noktaList[edge.uc2NoktaNo].kendiYeri.y;
    if (Math.abs(edgeX2Diff) < tmpEps && Math.abs(edgeY2Diff) < tmpEps) {
        return false;
    }

    const targetXDiff = answer.kesisimNok.x - targetPoint.kendiYeri.x;
    const targetYDiff = answer.kesisimNok.y - targetPoint.kendiYeri.y;
    if (Math.abs(targetXDiff) < tmpEps && Math.abs(targetYDiff) < tmpEps) {
        return false;
    }

    const ownPosXDiff = answer.kesisimNok.x - ownPos.x;
    const ownPosYDiff = answer.kesisimNok.y - ownPos.y;
    if (Math.abs(ownPosXDiff) < tmpEps && Math.abs(ownPosYDiff) < tmpEps) {
        return false;
    }


    const rectCorners = createRectangleFromLine(world.totalNoktaList[edge.uc1NoktaNo].kendiYeri, world.totalNoktaList[edge.uc2NoktaNo].kendiYeri, 0.0001);

    if (isPointInRectangle(answer.kesisimNok, rectCorners.a, rectCorners.b, rectCorners.d) && answer.durum == 0) {
        edge.projectionLoc = answer.kesisimNok;
        return true;
    } else {
        return false;
    }*/
}

/**
 * Başlangıç kenarından başlayarak, komşu üçgenlerin kenarları arasında
 * geçerli projeksiyon sunan ilk kenarı bulur.
 */
function _findNeighboringValidEdge(startEdge, target, ownPos, tris, points, eps, rayTris) {
    let edge = startEdge;

    // Kenar dış kenar değilse ve bir komşu varsa devam et
    while (!edge.disKenar && edge.komsuNo > -1) {
        const nbrTri = tris[edge.komsuNo];
        if (!nbrTri) break;

        const currentIdx = edge.komsudaKacinciKenarNo;
        const neighborEdge = nbrTri.kenarList[currentIdx];
        if (neighborEdge.disKenar && !edge.disKenar) {
            break;
        }
        // Komşu üçgenin diğer iki kenarını al
        const candidates = nbrTri.kenarList.filter((_, idx) => idx !== currentIdx);

        // Geçerli projeksiyon sunan ilk kenarı bul
        const valid = candidates.find(cand =>
            // burada her zaman iki kenara da bakmaya gerek yok, yz kodu havalı göstermek için hızı düşürmüş, her kodu çiçeğe benzetmeye çalışanlardan bulaşmış
            _isValidProjection(cand, target, ownPos, points, eps)
        );

        if (!valid) break;        // Hiçbir aday uymadı: döngüyü kır
        rayTris.add(edge.komsuNo); // Geçerli üçgeni kaydet
        edge = valid;              // Bulduğumuz kenarı yeni başlangıç yap        
    }

    return edge;
}

// Eğer bakılan nokta yönünde bir poligon kenarı görüşü engellediyse bu kenarın her iki ucuna bir lookAtNext yapılması gerekir
function performEdgeTasks(currentPoint, world, processedEdgeKeys, visitEdge = lookAtNextSector) {
    while (!world.edgeTasks.isEmpty()) {
        const edge = world.edgeTasks.dequeue();
        // Rebuild sırasında mesh sabittir: aynı kenarı aynı bakan nokta için ikinci kez
        // taramak yeni görünürlük üretemez. UniqueQueue yalnız kuyruktaki kopyayı
        // engellediğinden, birbirini karşılıklı kuyruklayan kenarlar sonsuz döngü
        // oluşturabiliyordu (500sn.xml, vertex 44: 3 kenarlık ping-pong).
        // Bu nedenle her kenar vertex başına en fazla bir kez işlenir.
        const edgeKey = edge[0] < edge[1] ? edge[0] + ":" + edge[1] : edge[1] + ":" + edge[0];
        if (processedEdgeKeys.has(edgeKey)) continue;
        processedEdgeKeys.add(edgeKey);
        visitEdge(currentPoint, world, edge);
    }
}

function pointToPointQuery3(bakanNokta, hedefNokta, lookAralik, world) {
    const answer = new PointToAnswer();
    answer.polyNo = -7;
    answer.durum = 0;
    answer.sonKesilenDoluPoly = -1;
    answer.onKesilenDoluPoly = -1;
    answer.oncekiDoluKenar = null;
    answer.kesilenKenarSay = 0;
    answer.ihlal = false;

    if (!lookAralik.disabled) {
        let currentUcgen = world.totalUcgenList[lookAralik.ucgenNo];
        let neighborUcgen = currentUcgen;
        let volumKenar = currentUcgen.kenarList[lookAralik.ucgeniciKarsiKenarNo];
        const kesnok = collKesisimHesapla(volumKenar, bakanNokta, hedefNokta, 0, world.totalNoktaList);

        if (kesnok.durum === 0) {
            answer.ihlal = true;
        }

        if (kesnok.durum > 0) {
            answer.ucgenNo = lookAralik.ucgenNo;
            answer.durum = 1;
            answer.polyNo = neighborUcgen.ucgenPolyNo;
            answer.kesNok = kesnok.kesisimNok;
            answer.triangles.add(lookAralik.ucgenNo);
            if (answer.polyNo > -1) {
                answer.kesilenKenarSay++;
                answer.sonKesilenDoluPoly = answer.polyNo;
            }

            if (kesnok.durum === 2) {
                do {
                    if (volumKenar.komsuNo >= 0) {
                        neighborUcgen = world.totalUcgenList[volumKenar.komsuNo];
                        const neighborActiveKenar = neighborUcgen.kenarList[volumKenar.komsudaKacinciKenarNo];

                        answer.durum = 2;
                        answer.ucgenNo = volumKenar.komsuNo;
                        answer.polyNo = neighborUcgen.ucgenPolyNo;

                        if (!answer.oncekiDoluKenar) {
                            if (volumKenar.kenarPolyNo > -1) answer.oncekiDoluKenar = volumKenar;
                            else if (neighborActiveKenar.kenarPolyNo > -1) answer.oncekiDoluKenar = neighborActiveKenar;
                        }

                        if (!answer.ilKesilenDiskenar) {
                            if (volumKenar.disKenar) answer.ilKesilenDiskenar = volumKenar;
                            else if (neighborActiveKenar.disKenar) answer.ilKesilenDiskenar = neighborActiveKenar;
                        }

                        if (answer.polyNo > -1) {
                            answer.kesilenKenarSay++;
                            if (answer.kesilenKenarSay > 1) answer.onKesilenDoluPoly = answer.sonKesilenDoluPoly;
                            answer.sonKesilenDoluPoly = answer.polyNo;
                        }

                        /*if (showCember) {
                            neighborUcgen.boya = true;
                        }*/
                        answer.triangles.add(answer.ucgenNo);

                        // Bakan nokta karşı noktada ise döngüden çık                        
                        if (pointsEqual(bakanNokta.kendiYeri, world.totalNoktaList[neighborUcgen.kenarList[volumKenar.komsudaKacinciKenarNo].karsiNoktaNo].kendiYeri)) {
                            break;
                        }

                        // Komşu kenarlar üzerinden kesişim sorgusu
                        const kenarNo1 = (volumKenar.komsudaKacinciKenarNo + 1) % 3;
                        const kenarNo2 = (volumKenar.komsudaKacinciKenarNo + 2) % 3;
                        const kesilenKenar1 = neighborUcgen.kenarList[kenarNo1];
                        const kesilenKenar2 = neighborUcgen.kenarList[kenarNo2];

                        const kesCev1 = collKesisimHesapla(kesilenKenar1, bakanNokta, hedefNokta, 0, world.totalNoktaList);
                        if (kesCev1.durum === 2) {
                            volumKenar = kesilenKenar1;
                            answer.kesNok = kesCev1.kesisimNok;
                        } else {
                            const kesCev2 = collKesisimHesapla(kesilenKenar2, bakanNokta, hedefNokta, 0, world.totalNoktaList);
                            if (kesCev2.durum === 2) {
                                volumKenar = kesilenKenar2;
                                answer.kesNok = kesCev2.kesisimNok;
                            } else {
                                if (kesCev1.durum === 0 && kesCev2.durum === 0) {
                                    answer.durum = 0;
                                }
                                break;
                            }
                            if (kesCev1.durum === 0 && kesCev2.durum === 0) {
                                answer.ihlal = true;
                                break;
                            }
                        }

                        if (volumKenar.komsuNo > -1) {
                            neighborUcgen = world.totalUcgenList[volumKenar.komsuNo];
                            const neighborActiveKenar2 = neighborUcgen.kenarList[volumKenar.komsudaKacinciKenarNo];
                            if (!answer.oncekiDoluKenar) {
                                if (volumKenar.kenarPolyNo > -1) answer.oncekiDoluKenar = volumKenar;
                                else if (neighborActiveKenar2.kenarPolyNo > -1) answer.oncekiDoluKenar = neighborActiveKenar2;
                            }
                            if (!answer.ilKesilenDiskenar) {
                                if (volumKenar.disKenar) answer.ilKesilenDiskenar = volumKenar;
                                else if (neighborActiveKenar2.disKenar) answer.ilKesilenDiskenar = neighborActiveKenar2;
                            }
                        }
                    } else {
                        if (volumKenar.komsuNo < -9) {
                            answer.ilKesilenDiskenar = volumKenar;
                            answer.oncekiDoluKenar = volumKenar;
                            answer.sonKesilenDoluPoly = volumKenar.komsuNo;
                        }
                        break;
                    }
                } while (true);


            }
        } else {
            answer.ihlal = true;
            answer.ucgenNo = -1;
        }
    } else {
        answer.ihlal = true;
        answer.polyNo = -1;
        answer.durum = 0;
        answer.sonKesilenDoluPoly = -1;
        answer.oncekiDoluKenar = null;
    }

    return answer;
}

function resetObjectOccState(world, options = {}) {
    const replaceCollections = options.replaceCollections === true;
    world.objectOccPrepared = false;
    world.rays = new Map();
    world.pointRayIndex = new Map();
    world.routeMetricCache = new Map();
    world.routeRawMetricCache = new Map();
    world.projectionTasks = new UniqueQueue();
    world.edgeTasks = new UniqueQueue();
    world.lookAtTasks = new UniqueQueue();

    world.totalNoktaList.forEach(vertice => {
        if (replaceCollections) {
            vertice.visibleList = new Map();
            vertice.invisibleList = new Set();
            vertice.relatedRays = new Set();
        } else {
            vertice.visibleList.clear();
            vertice.invisibleList.clear();
            vertice.relatedRays.clear();
        }
        vertice.lookAtTasks = new UniqueQueue();
    });
    world.totalUcgenList.forEach(triangle => {
        triangle.rayKeys = replaceCollections ? new Set() : triangle.rayKeys;
        if (!replaceCollections) triangle.rayKeys.clear();
        triangle.kenarList.forEach(edge => {
            if (replaceCollections) edge.relatedRays = new Set();
            else edge.relatedRays.clear();
        });
    });
}

function runObjectOccFull(targetWorld) {
    resetObjectOccState(targetWorld);
    targetWorld.totalNoktaList.forEach(vertice => {
        if (vertice.noktaNo > 3) {
            const processedEdgeKeys = new Set();
            lookAtNextSector(vertice, targetWorld, null);

            while (!targetWorld.projectionTasks.isEmpty() || !targetWorld.edgeTasks.isEmpty()) {
                if (!targetWorld.projectionTasks.isEmpty()) {
                    performProjectionTasks(vertice, targetWorld);
                }
                if (!targetWorld.edgeTasks.isEmpty()) {
                    performEdgeTasks(vertice, targetWorld, processedEdgeKeys);
                }
            }
        }
    });
    return targetWorld;
}

function installObjectOccDiagnosticFunctions(call) {
    const originals = {
        addRay,
        collKesisimHesapla,
        lookAt,
        pointToPointQuery3,
        findNeighboringValidEdge: _findNeighboringValidEdge
    };
    addRay = function measuredAddRay(...args) {
        const start = objectOccNow();
        try {
            return originals.addRay(...args);
        } finally {
            call.indexMs += objectOccNow() - start;
        }
    };
    collKesisimHesapla = function measuredIntersection(...args) {
        call.intersectionPredicateCount++;
        return originals.collKesisimHesapla(...args);
    };
    lookAt = function measuredLookAt(...args) {
        call.lookAtAttemptCount++;
        return originals.lookAt(...args);
    };
    pointToPointQuery3 = function measuredPointQuery(...args) {
        const answer = originals.pointToPointQuery3(...args);
        call.triangleStepCount += answer.triangles.size;
        return answer;
    };
    _findNeighboringValidEdge = function measuredNeighborWalk(...args) {
        const rayTriangles = args[6];
        const before = rayTriangles.size;
        const answer = originals.findNeighboringValidEdge(...args);
        call.triangleStepCount += rayTriangles.size - before;
        return answer;
    };
    return () => {
        addRay = originals.addRay;
        collKesisimHesapla = originals.collKesisimHesapla;
        lookAt = originals.lookAt;
        pointToPointQuery3 = originals.pointToPointQuery3;
        _findNeighboringValidEdge = originals.findNeighboringValidEdge;
    };
}

function installObjectOccDiagnosticQueues(targetWorld, call) {
    const queues = [
        [targetWorld.projectionTasks, "projectionTaskCount"],
        [targetWorld.edgeTasks, "edgeTaskCount"]
    ];
    const restorers = queues.map(([queue, counter]) => {
        const hadOwn = Object.prototype.hasOwnProperty.call(queue, "dequeue");
        const ownValue = queue.dequeue;
        const original = queue.dequeue;
        queue.dequeue = function measuredDequeue() {
            const item = original.call(this);
            if (item !== undefined) call[counter]++;
            return item;
        };
        return () => {
            if (hadOwn) queue.dequeue = ownValue;
            else delete queue.dequeue;
        };
    });
    return () => restorers.reverse().forEach(restore => restore());
}

function runObjectOccDiagnosed(targetWorld, session) {
    const memorySampler = typeof session.options?.memorySampler === "function"
        ? session.options.memorySampler
        : null;
    const call = {
        mode: "full",
        totalMs: 0,
        resetMs: 0,
        walkMs: 0,
        projectionMs: 0,
        indexMs: 0,
        observerCount: 0,
        affectedObserverCount: 0,
        affectedRayCount: 0,
        affectedTriangleCount: 0,
        lookAtAttemptCount: 0,
        triangleStepCount: 0,
        intersectionPredicateCount: 0,
        projectionTaskCount: 0,
        edgeTaskCount: 0,
        processedEdgeSkipCount: 0,
        fallbackReason: null,
        exactDigestMatch: null,
        memoryDelta: null,
        error: null
    };
    const totalStart = objectOccNow();
    const memoryBefore = memorySampler ? memorySampler() : null;
    let restoreFunctions = () => {};
    let restoreQueues = () => {};
    session.activeCall = call;
    try {
        restoreFunctions = installObjectOccDiagnosticFunctions(call);
        const resetStart = objectOccNow();
        resetObjectOccState(targetWorld);
        call.resetMs = objectOccNow() - resetStart;
        restoreQueues = installObjectOccDiagnosticQueues(targetWorld, call);
        targetWorld.totalNoktaList.forEach(vertice => {
            if (vertice.noktaNo > 3) {
                call.observerCount++;
                const processedEdgeKeys = new Set();
                const walkStart = objectOccNow();
                lookAtNextSector(vertice, targetWorld, null);
                call.walkMs += objectOccNow() - walkStart;

                while (!targetWorld.projectionTasks.isEmpty() || !targetWorld.edgeTasks.isEmpty()) {
                    if (!targetWorld.projectionTasks.isEmpty()) {
                        const projectionStart = objectOccNow();
                        performProjectionTasks(vertice, targetWorld);
                        call.projectionMs += objectOccNow() - projectionStart;
                    }
                    if (!targetWorld.edgeTasks.isEmpty()) {
                        const edgeStart = objectOccNow();
                        const edgeCountBefore = call.edgeTaskCount;
                        const processedBefore = processedEdgeKeys.size;
                        performEdgeTasks(vertice, targetWorld, processedEdgeKeys);
                        call.walkMs += objectOccNow() - edgeStart;
                        call.processedEdgeSkipCount += (call.edgeTaskCount - edgeCountBefore)
                            - (processedEdgeKeys.size - processedBefore);
                    }
                }
            }
        });
        return targetWorld;
    } catch (error) {
        call.error = error?.message || String(error);
        throw error;
    } finally {
        restoreQueues();
        restoreFunctions();
        call.totalMs = objectOccNow() - totalStart;
        call.affectedObserverCount = call.observerCount;
        call.affectedRayCount = targetWorld.rays.size;
        call.affectedTriangleCount = targetWorld.totalUcgenList
            .reduce((sum, triangle) => sum + (triangle.rayKeys.size > 0 ? 1 : 0), 0);
        if (memorySampler) call.memoryDelta = memorySampler() - memoryBefore;
        session.calls.push(Object.freeze({ ...call }));
        session.activeCall = null;
    }
}

function objectOcc(targetWorld = world) {
    const session = targetWorld[OBJECT_OCC_DIAGNOSTICS];
    try {
        const mode = targetWorld.objectOccMode ?? "legacy";
        if (mode !== "legacy" && mode !== "shared") throw new Error("Unknown ObjectOcc mode: " + mode);
        if (mode === "shared") {
            if (typeof runSharedObjectOcc !== "function") throw new Error("objectOccShared.js is required for shared mode");
            if (session) runSharedObjectOccDiagnosed(targetWorld, session);
            else runSharedObjectOcc(targetWorld);
            return targetWorld;
        }
        const result = session ? runObjectOccDiagnosed(targetWorld, session) : runObjectOccFull(targetWorld);
        targetWorld.objectOccPrepared = true;
        return result;
    } catch (error) {
        targetWorld.objectOccPrepared = false;
        throw error;
    }
}

// Backward-compatible name for callers outside triangulator.html.
function objectOcclusion(targetWorld = world) {
    return objectOcc(targetWorld);
}

if (typeof module === "object" && module.exports) {
    module.exports = {
        objectOcc,
        objectOcclusion,
        performEdgeTasks,
        resetObjectOccState,
        startObjectOccDiagnostics,
        stopObjectOccDiagnostics,
        getPointRayKey,
        getPointRay,
        segmentPassesThroughTriangleInterior,
        classifyRayAgainstOutside
    };
}
