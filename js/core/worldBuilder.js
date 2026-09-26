"use strict";

/**
 * triangulator.html'deki nokta işleme boru hattının sayfadan bağımsız hali.
 * Hem Raw Route yüklemesi hem de convex layers yeniden kurulumu, XML'e
 * dokunmadan aynı nokta-dizisi → World yolundan geçer.
 */

const WORLD_BUILDER_MIN_DISTANCE = 2;
const WORLD_BUILDER_SPECIAL_POINT_INDEX = 4; // Index 4'teki nokta (5. nokta)
const WORLD_BUILDER_SPECIAL_TRIGGER_LENGTH = 5; // totalNoktaList 5 olunca tetiklenir

/**
 * Yeni bir noktayı işler, world nesnesini günceller ve ilk nokta değiştirme durumunu yönetir.
 * @returns {boolean} ilkNoktaDegisti'nin güncel durumu.
 */
function processPointAndUpdateState(loc, metricPosition, isXmlPoint, polyNo, sourcePointId, world, currentIlkNoktaDegisti, workMeter) {
    const targetNokta = new Nokta(world);
    targetNokta.kendiYeri = loc;
    targetNokta.metricPosition = { ...metricPosition };
    targetNokta.sourcePointId = sourcePointId;

    let updatedIlkNoktaDegisti = currentIlkNoktaDegisti;

    if (world.totalNoktaList.length === WORLD_BUILDER_SPECIAL_TRIGGER_LENGTH && !currentIlkNoktaDegisti) {
        if (world.totalNoktaList[WORLD_BUILDER_SPECIAL_POINT_INDEX]) {
            world.totalNoktaList[WORLD_BUILDER_SPECIAL_POINT_INDEX].kendiYeri = loc;
            world.totalNoktaList[WORLD_BUILDER_SPECIAL_POINT_INDEX].metricPosition = { ...metricPosition };
            world.totalNoktaList[WORLD_BUILDER_SPECIAL_POINT_INDEX].sourcePointId = sourcePointId;
            updatedIlkNoktaDegisti = true;
        } else {
            console.error(`Hata: ${WORLD_BUILDER_SPECIAL_POINT_INDEX} index'li nokta bulunamadı!`);
        }
    } else {
        // Nokta, polygonList indeksleriyle birebir eşleşen polyNo'nun poligonuna eklenir.
        const previousRoute = world.polygonList[polyNo]?.polyNoktaList || [];
        if (workMeter) workMeter.routeIndexVisits = (workMeter.routeIndexVisits || 0) + previousRoute.length;
        const routeBefore = new Set(previousRoute);
        Ucgenle(loc, isXmlPoint, targetNokta, polyNo, world);
        const routeIndex = world.polygonList[polyNo]?.polyNoktaList.find(index => {
            if (workMeter) workMeter.routeIndexVisits++;
            return !routeBefore.has(index);
        });
        if (Number.isInteger(routeIndex) && world.totalNoktaList[routeIndex]) {
            world.totalNoktaList[routeIndex].sourcePointId = sourcePointId;
            world.totalNoktaList[routeIndex].metricPosition = { ...metricPosition };
        } else {
            throw new Error(`Input point ${sourcePointId} was not added to polygon ${polyNo}`);
        }
    }
    return updatedIlkNoktaDegisti;
}

/**
 * Belirtilen poligonu kapatmayı dener (lookAt kontrolü yaparak).
 * @returns {boolean} Kapatma işleminin başarılı olup olmadığı.
 */
function tryClosePolygon(polyNoToClose, world, workMeter) {
    if (polyNoToClose < 0 || polyNoToClose >= world.polygonList.length ||
        !world.polygonList[polyNoToClose] || world.polygonList[polyNoToClose].polyNoktaList.length < 3) {
        console.warn(`Cannot close polygon ${polyNoToClose}: Polygon index invalid or fewer than 3 points; leaving it open.`);
        return false;
    }

    const polyPointsIndices = world.polygonList[polyNoToClose].polyNoktaList;
    const firstPointIndex = polyPointsIndices[0];
    const lastPointIndex = polyPointsIndices[polyPointsIndices.length - 1];

    if (firstPointIndex < 0 || firstPointIndex >= world.totalNoktaList.length ||
        lastPointIndex < 0 || lastPointIndex >= world.totalNoktaList.length) {
        console.error(`Cannot close polygon ${polyNoToClose}: Point indices [${firstPointIndex}, ${lastPointIndex}] are invalid for totalNoktaList.`);
        return false;
    }

    const firstPoint = world.totalNoktaList[firstPointIndex];
    const lastPoint = world.totalNoktaList[lastPointIndex];
    const firstPointLoc = firstPoint.kendiYeri;

    if (workMeter) workMeter.closingVisibilityChecks = (workMeter.closingVisibilityChecks || 0) + 1;
    const canClose = lookAt(lastPoint, firstPoint, world);

    if (canClose) {
        console.log(`lookAt check PASSED for closing polygon ${polyNoToClose}. Closing...`);
        const targetNokta = new Nokta(world);
        targetNokta.kendiYeri = firstPointLoc;

        // Kapatma işlemi, kapatılmakta olan polyNoToClose poligonuna kenar ekler.
        Ucgenle(firstPointLoc, false, targetNokta, polyNoToClose, world);
        return true;
    } else {
        console.warn(`lookAt check FAILED for closing polygon ${polyNoToClose}. Cannot close with segment from ${JSON.stringify(lastPoint.kendiYeri)} to ${JSON.stringify(firstPointLoc)}.`);
        return false;
    }
}

/**
 * Toplanmış nokta dizisinden ({loc, metricPosition, isXmlPoint, polyNo, sourcePointId})
 * yeni bir World kurar. polyNo değerleri 0'dan başlayıp ardışık olmalıdır; polyNo
 * değiştiğinde önceki poligon kapatılır, son poligon döngü sonunda kapatılır.
 * Koordinatlar geldiği gibi kullanılır; jitter burada UYGULANMAZ.
 */
function buildWorldFromCollectedPoints(pointsToProcess, workMeter) {
    const builtWorld = new World();
    let ilkNoktaDegisti = false;
    let previousPolyNo = null;
    let lastPolyNo = -1;
    let processedPointCount = 0;

    for (const pointData of pointsToProcess) {
        if (workMeter) workMeter.inputPointVisits = (workMeter.inputPointVisits || 0) + 1;
        const loc = pointData.loc;
        const currentPolyNo = pointData.polyNo;

        if (isTooClose(loc, builtWorld.totalNoktaList, WORLD_BUILDER_MIN_DISTANCE, workMeter)) {
            console.warn(`Skipping point during processing due to proximity: ${JSON.stringify(loc)} from polyNo ${currentPolyNo}`);
            continue;
        }

        if (previousPolyNo !== null && currentPolyNo !== previousPolyNo) {
            console.log(`(Processing) Polygon changed from ${previousPolyNo} to ${currentPolyNo}. Attempting to close polygon ${previousPolyNo}.`);
            tryClosePolygon(previousPolyNo, builtWorld, workMeter);
        }

        ilkNoktaDegisti = processPointAndUpdateState(
            loc, pointData.metricPosition, pointData.isXmlPoint,
            currentPolyNo, pointData.sourcePointId, builtWorld, ilkNoktaDegisti, workMeter
        );
        processedPointCount++;
        previousPolyNo = currentPolyNo;
        lastPolyNo = currentPolyNo;
    }

    if (processedPointCount > 0 && lastPolyNo !== -1) {
        tryClosePolygon(lastPolyNo, builtWorld, workMeter);
    }

    // Kapatma sırasındaki lookAt çağrıları ray üretmiş olabilir; temiz başlangıç.
    builtWorld.rays = new Map();
    builtWorld.pointRayIndex = new Map();
    builtWorld.routeMetricCache = new Map();
    builtWorld.routeRawMetricCache = new Map();
    builtWorld.projectionTasks = new UniqueQueue();
    builtWorld.edgeTasks = new UniqueQueue();

    return builtWorld;
}

/**
 * Mevcut world'deki gerçek poligon noktalarını toplar. Çerçeve noktaları (0-3),
 * kesişimden türemiş noktalar ve silinmiş noktalar dışarıda bırakılır.
 */
function collectRoutePoints(sourceWorld, workMeter) {
    const points = [];
    for (let index = 4; index < sourceWorld.totalNoktaList.length; index++) {
        if (workMeter) workMeter.collectPointVisits = (workMeter.collectPointVisits || 0) + 1;
        const nokta = sourceWorld.totalNoktaList[index];
        if (!nokta || nokta.turemis || nokta.noktaSilindi) continue;
        points.push({
            x: nokta.kendiYeri.x,
            y: nokta.kendiYeri.y,
            metricPosition: { ...(nokta.metricPosition || nokta.kendiYeri) },
            sourcePointId: nokta.sourcePointId,
            noktaIndex: index
        });
    }
    return points;
}

/**
 * Çizili rotayı bag1/bag2 komşuluğundan yürüyüp collectRoutePoints indekslerine
 * çevirir; exact çözücüye üst sınır tohumu olarak verilir. polyNoktaList sırası
 * K-opt/köprü sonrası bayatlayabildiği için bag komşuluğu esas alınır.
 *
 * Rota tek kapalı çevrim değilse ya da türemiş/silinmiş bir noktadan geçiyorsa
 * null döner: o durumda çizili tur ile çözücünün nokta kümesi aynı değildir,
 * karşılaştırılabilir bir tohum yoktur ve çözücü eskisi gibi yalnızca kendi
 * heuristiğinden başlar.
 */
function routeTourSeed(sourceWorld, points, workMeter) {
    if (points.length < 3) return null;
    const pointIndexByNokta = new Map(points.map((point, at) => {
        if (workMeter) workMeter.seedMapPointVisits = (workMeter.seedMapPointVisits || 0) + 1;
        return [point.noktaIndex, at];
    }));
    const noktaList = sourceWorld.totalNoktaList;
    const startNoktaIndex = points[0].noktaIndex;
    const tour = [];
    const visited = new Set();
    let previousIndex = null;
    let currentIndex = startNoktaIndex;

    for (let guard = 0; guard <= noktaList.length; guard++) {
        if (workMeter) workMeter.seedRouteSteps = (workMeter.seedRouteSteps || 0) + 1;
        const current = noktaList[currentIndex];
        if (!current || !Number.isInteger(current.bag1) || !Number.isInteger(current.bag2)) return null;
        const at = pointIndexByNokta.get(currentIndex);
        if (at === undefined || visited.has(currentIndex)) return null;
        visited.add(currentIndex);
        tour.push(at);
        const nextIndex = previousIndex === null || current.bag1 === previousIndex
            ? current.bag2
            : current.bag1;
        previousIndex = currentIndex;
        currentIndex = nextIndex;
        if (currentIndex === startNoktaIndex) {
            return tour.length === points.length ? tour : null;
        }
    }
    return null;
}

/**
 * DPZ sonucunun world kayıtları. UI aktarımı ve ölçümlü Worker provası aynı
 * kayıtları bu fonksiyonla üretir; world kurmasının işi böylece eşleşir.
 */
function dbwcWorldRecords(ordered, workMeter) {
    return ordered.map(point => {
        if (workMeter) workMeter.worldRecordVisits = (workMeter.worldRecordVisits || 0) + 1;
        return {
            loc: { x: point.displayX, y: point.displayY },
            metricPosition: { x: point.x, y: point.y },
            isXmlPoint: true,
            polyNo: 0,
            sourcePointId: point.sourcePointId,
            isJoinable: true
        };
    });
}

/**
 * Kurulan world'ün noktaları, rota bağları ve üçgen kenarları üzerinden iki
 * bağımsız 32 bitlik özet. Tanısaldır: UI'nin kurduğu world ile ölçümlü Worker
 * provasının aynı yapıyı ürettiğini denetler.
 */
function worldTransferDigest(sourceWorld) {
    let first = 0x811c9dc5, second = 0x9e3779b9;
    const buffer = new Float64Array(1), words = new Uint32Array(buffer.buffer);
    const mixWord = word => {
        first = Math.imul(first ^ word, 0x01000193) >>> 0;
        second = Math.imul((second ^ word) + 0x7f4a7c15, 0x85ebca6b) >>> 0;
    };
    const mixNumber = value => {
        buffer[0] = typeof value === "number" ? value : NaN;
        mixWord(words[0]);
        mixWord(words[1]);
    };
    const mixText = value => {
        const text = String(value);
        mixWord(text.length);
        for (let at = 0; at < text.length; at++) mixWord(text.charCodeAt(at));
    };
    mixNumber(sourceWorld.totalNoktaList.length);
    for (const nokta of sourceWorld.totalNoktaList) {
        if (!nokta) {
            mixWord(0);
            continue;
        }
        mixNumber(nokta.kendiYeri.x);
        mixNumber(nokta.kendiYeri.y);
        mixNumber(nokta.metricPosition ? nokta.metricPosition.x : NaN);
        mixNumber(nokta.metricPosition ? nokta.metricPosition.y : NaN);
        mixNumber(nokta.bag1);
        mixNumber(nokta.bag2);
        mixWord((nokta.turemis ? 1 : 0) | (nokta.noktaSilindi ? 2 : 0));
        mixText(nokta.sourcePointId);
    }
    mixNumber(sourceWorld.totalUcgenList.length);
    for (const ucgen of sourceWorld.totalUcgenList) {
        mixWord(ucgen.disabled ? 1 : 0);
        for (const kenar of ucgen.kenarList) {
            mixNumber(kenar.uc1NoktaNo);
            mixNumber(kenar.uc2NoktaNo);
            mixNumber(kenar.komsuNo);
        }
    }
    for (const polygon of sourceWorld.polygonList) mixNumber(polygon.polyNoktaList.length);
    return `${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
}

/** Kapalı çevrimin verilen maliyet fonksiyonuna göre uzunluğu. */
function cycleCost(cycle, points, costFn) {
    let total = 0;
    for (let at = 0; at < cycle.length; at++) {
        total += costFn(points[cycle[at]], points[cycle[(at + 1) % cycle.length]]);
    }
    return total;
}

/**
 * Mevcut world'ün noktalarından convex layers hesaplar ve her katmanı ayrı bir
 * kapalı poligon olarak içeren yeni bir World kurar. Katman i → PolyNo i.
 * Hull kuramayan 1-2 artık nokta, en içteki katmanın en ucuz kenarına
 * yedirilir. 3 noktadan az veri varsa null döner. Dönen world.convexLayers,
 * katman sırasına göre nokta verilerini ({x, y, metricPosition, sourcePointId}) tutar.
 */
function rebuildWorldAsConvexLayers(sourceWorld) {
    const points = collectRoutePoints(sourceWorld);
    if (points.length < 3) return null;

    const layers = absorbRemainderIntoLastLayer(computeConvexLayers(points), points);
    const pointsToProcess = [];
    layers.forEach((layer, layerNo) => {
        const ordered = layer.length >= 3 ? rotateLayerForSafeClosure(layer, points) : layer;
        for (const pointIndex of ordered) {
            const point = points[pointIndex];
            pointsToProcess.push({
                loc: { x: point.x, y: point.y }, // koordinatlar zaten jitter'lı
                isXmlPoint: true,
                polyNo: layerNo,
                sourcePointId: point.sourcePointId,
                metricPosition: point.metricPosition
            });
        }
    });

    const builtWorld = buildWorldFromCollectedPoints(pointsToProcess);
    builtWorld.convexLayers = layers.map(layer => layer.map(pointIndex => points[pointIndex]));
    return { world: builtWorld, layers: builtWorld.convexLayers };
}

/**
 * Çizili poligonları (dıştan içe = polygonList sırası) nokta verisi + çevrim
 * indeksleri olarak toplar. Çerçeve/türemiş/silinmiş noktalar atlanır.
 */
function collectLayerCycles(sourceWorld) {
    const points = [];
    const cycles = [];
    for (const polygon of sourceWorld.polygonList) {
        if (!polygon?.polyNoktaList?.length) continue;
        const cycle = [];
        for (const noktaIndex of polygon.polyNoktaList) {
            const nokta = sourceWorld.totalNoktaList[noktaIndex];
            if (!nokta || nokta.turemis || nokta.noktaSilindi) continue;
            cycle.push(points.length);
            points.push({
                x: nokta.kendiYeri.x,
                y: nokta.kendiYeri.y,
                metricPosition: { ...(nokta.metricPosition || nokta.kendiYeri) },
                sourcePointId: nokta.sourcePointId
            });
        }
        if (cycle.length > 0) cycles.push(cycle);
    }
    return { points, cycles };
}

// Köprü kararları optimizer ile aynı metrikle verilir: metricPosition üzerinden
// ham Öklid. Tuval pikseli anizotropik ölçeklenebildiği için kullanılmaz.
function routeMetricRawCost(a, b) {
    const pa = a.metricPosition || a;
    const pb = b.metricPosition || b;
    return Math.hypot(pa.x - pb.x, pa.y - pb.y);
}

function routeMetricTsplibCost(a, b) {
    const pa = a.metricPosition || a;
    const pb = b.metricPosition || b;
    return Math.floor(Math.hypot(pa.x - pb.x, pa.y - pb.y) + 0.5);
}

/**
 * Çizili poligon katmanlarını dıştan içe tek köprülerle tek tura birleştirir ve
 * sonucu PolyNo 0 olan tek kapalı poligon olarak yeni bir World'e çizer.
 * 2'den az dolu poligon varsa null döner. Rapor için birleşim listesi
 * (sourcePointId etiketli) ve tur uzunlukları (raw + TSPLIB) döndürülür.
 */
function mergeWorldLayers(sourceWorld) {
    const { points, cycles } = collectLayerCycles(sourceWorld);
    if (cycles.length < 2) return null;

    const merged = mergeLayerCycles(cycles, points, routeMetricRawCost);
    const orderedCycle = merged.cycle.length >= 3
        ? rotateLayerForSafeClosure(merged.cycle, points)
        : merged.cycle;

    const pointsToProcess = orderedCycle.map(pointIndex => {
        const point = points[pointIndex];
        return {
            loc: { x: point.x, y: point.y }, // koordinatlar zaten jitter'lı
            isXmlPoint: true,
            polyNo: 0,
            sourcePointId: point.sourcePointId,
            metricPosition: point.metricPosition
        };
    });

    const builtWorld = buildWorldFromCollectedPoints(pointsToProcess);

    const label = pointIndex => points[pointIndex].sourcePointId ?? pointIndex;
    const merges = merged.merges.map(merge => merge.type === "bridge"
        ? {
            ...merge,
            removedOuterIds: merge.removedOuter.map(label),
            removedInnerIds: merge.removedInner.map(label),
            addedIds: merge.added.map(edge => edge.map(label))
        }
        : { ...merge, pointId: label(merge.pointIndex) });

    let tourLength = 0;
    let tourTsplibLength = 0;
    for (let at = 0; at < orderedCycle.length; at++) {
        const a = points[orderedCycle[at]];
        const b = points[orderedCycle[(at + 1) % orderedCycle.length]];
        tourLength += routeMetricRawCost(a, b);
        tourTsplibLength += routeMetricTsplibCost(a, b);
    }

    return {
        world: builtWorld,
        merges,
        totalDelta: merged.merges.reduce((sum, merge) => sum + merge.delta, 0),
        tourLength,
        tourTsplibLength
    };
}

/**
 * Çizili noktalar için kanıtlı optimum (exact) turu bulur ve sonucu PolyNo 0
 * olan tek kapalı poligon olarak yeni bir World'e çizer. Karar metriği rotanın
 * geri kalanıyla aynıdır: metricPosition üzerinden ham Öklid; TSPLIB EUC_2D
 * yalnızca raporlanır. 3 noktadan az veri varsa null döner.
 *
 * Euclid optimum turu kendini kesmez, dolayısıyla yeniden çizimde kesişimden
 * türemiş nokta oluşmaz; kapanış yine snap-güvenli noktadan başlatılır.
 */
function rebuildWorldAsExactTour(sourceWorld, options = {}) {
    const points = collectRoutePoints(sourceWorld);
    if (points.length < 3) return null;

    // Çizili tur çözücüye üst sınır tohumu olarak verilir. Incumbent arama
    // boyunca yalnızca kısalabildiği için, bütçe dolup optimum kanıtlanamasa
    // bile dönen tur çizili turdan uzun olamaz.
    const seedTour = routeTourSeed(sourceWorld, points);
    const sourceTourLength = seedTour === null
        ? null
        : cycleCost(seedTour, points, routeMetricRawCost);

    const solution = options.precomputedSolution || solveExactTsp(points, {
        ...options,
        costFn: routeMetricRawCost,
        initialTour: seedTour
    });
    if (!Array.isArray(solution.tour) || solution.tour.length !== points.length
        || new Set(solution.tour).size !== points.length
        || solution.tour.some(index => !Number.isInteger(index) || index < 0 || index >= points.length)) {
        throw new Error("Exact TSP returned an invalid tour permutation");
    }
    const verifiedLength = cycleCost(solution.tour, points, routeMetricRawCost);
    if (!Number.isFinite(solution.length) || Math.abs(verifiedLength - solution.length) > 1e-7) {
        throw new Error("Exact TSP returned an inconsistent tour length");
    }
    const orderedCycle = solution.tour.length >= 3
        ? rotateLayerForSafeClosure(solution.tour, points)
        : solution.tour;

    const pointsToProcess = orderedCycle.map(pointIndex => {
        const point = points[pointIndex];
        return {
            loc: { x: point.x, y: point.y }, // koordinatlar zaten jitter'lı
            isXmlPoint: true,
            polyNo: 0,
            sourcePointId: point.sourcePointId,
            metricPosition: point.metricPosition
        };
    });

    const tourLength = cycleCost(orderedCycle, points, routeMetricRawCost);
    const tourTsplibLength = cycleCost(orderedCycle, points, routeMetricTsplibCost);

    // improved=false ise çağıran tuvale basmamalıdır: tur çizili turdan kısa
    // değildir. sourceTourLength null ise (rota tek kapalı çevrim değil ya da
    // türemiş nokta içeriyor) karşılaştırılacak uzunluk yoktur; exact tur zaten
    // o yapıyı sadeleştirdiği için çizim eskisi gibi uygulanır.
    const improved = sourceTourLength === null || tourLength < sourceTourLength - 1e-9;

    // A tied or budget-limited result needs no mesh rebuild. The candidate is
    // kept separate until its point set and single closed route are checked.
    const candidateWorld = improved ? buildWorldFromCollectedPoints(pointsToProcess) : sourceWorld;
    if (improved) {
        const rebuiltPoints = collectRoutePoints(candidateWorld);
        const rebuiltTour = routeTourSeed(candidateWorld, rebuiltPoints);
        const pointKey = point => JSON.stringify([point.sourcePointId, point.x, point.y,
            point.metricPosition.x, point.metricPosition.y]);
        const originalKeys = points.map(pointKey).sort();
        const rebuiltKeys = rebuiltPoints.map(pointKey).sort();
        if (rebuiltPoints.length !== points.length || !rebuiltTour
            || originalKeys.some((key, at) => key !== rebuiltKeys[at])) {
            throw new Error(`Exact TSP world transfer lost points or tour connectivity (${rebuiltPoints.length}/${points.length})`);
        }
        const rebuiltLength = cycleCost(rebuiltTour, rebuiltPoints, routeMetricRawCost);
        if (Math.abs(rebuiltLength - tourLength) > 1e-7) {
            throw new Error(`Exact TSP world transfer changed metric length (${rebuiltLength} vs ${tourLength})`);
        }
    }
    return {
        world: candidateWorld,
        solution,
        pointCount: points.length,
        tourLength,
        tourTsplibLength,
        sourceTourLength,
        improved,
        tourPointIds: orderedCycle.map(pointIndex => points[pointIndex].sourcePointId ?? pointIndex)
    };
}

if (typeof module === "object" && module.exports) {
    module.exports = {
        buildWorldFromCollectedPoints,
        collectLayerCycles,
        collectRoutePoints,
        cycleCost,
        dbwcWorldRecords,
        mergeWorldLayers,
        processPointAndUpdateState,
        rebuildWorldAsConvexLayers,
        rebuildWorldAsExactTour,
        routeTourSeed,
        tryClosePolygon,
        worldTransferDigest
    };
}
