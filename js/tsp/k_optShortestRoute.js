let iterationCount = 0;
/*const sleep = ms => new Promise(res => setTimeout(res, ms));
const raf = () => new Promise(res => requestAnimationFrame(res));

async */
function koptStart(options = {}) {
  const requestedStart = options.startNode ?? world.totalNoktaList[options.startNodeId];
  let startNode = requestedStart || world.totalNoktaList[7] || world.totalNoktaList[4];
  let prev = world.totalNoktaList[options.previousNodeId ?? startNode.bag1];
  const polygon = world.polygonList[0].polyNoktaList;
  const initialLength = triPolygonPerimeter(startNode, null);
  const initialTsplibLength = triPolygonPerimeterTsplib(startNode, null);
  let bestWay = initialLength;
  let nexSegmentStart = startNode;
  let ignoredPrev = prev;
  let improvedOverall = true;
  let iterationCount = 0;
  // UI çağrısında sınır verilmez: algoritma ilk kısalmayan tam taramaya kadar sürer.
  // Lokal/dahili çağrılar isterse açık bir üst sınır verebilir.
  const maxIterations = options.maxIterations === undefined || options.maxIterations === null
    ? Infinity
    : Math.max(1, Math.trunc(options.maxIterations));
  const minLimit = 0;
  //const limitStart = polygon.length;
  // 12 ölçülmüş bir optimum DEĞİL; kanıt yetersizliğiyle korunuyor. Bir kez 4'e
  // çekildi (ebe8dea) ve geri alındı: 4'ün dayanağı yalnız n≈100'deydi, n=50 ve
  // n=200'de aşağı-değil-lik testi düşüyor. Ölçülen: k₀ düşürmek her boyutta
  // %20–70 iş tasarrufu sağlıyor (sağlam, t=−8…−28) ama kalite farkı hiçbir
  // boyutta anlamlı çıkmadı (en düşük pHolm 0.420) — yani "12 israf" gösterildi,
  // "doğru değer şu" gösterilemedi. Karar için hücre başına ~25 fixture gerekiyor,
  // koşulmadı.
  // Ayrıca: segmentLimit=2 bir fixture'da 1800s'de sonlanmadı (aynı girdide k=3
  // 15s) — düşük değerler serbestçe denenmemeli.
  const limitStart = Math.max(1, Math.min(options.segmentLimit ?? 12, polygon.length - 1));
  // Bir iyileşme uygulandıktan sonra segment uzunluğu k'ya ne olacağı:
  //   "increment" : eski davranış, k++ (polygon.length/2-1 ile sınırlı)
  //   "hold"      : k'ya dokunma, azalan merdiven sweep içinde bozulmaz
  //   "reset"     : her iyileşmede en uzun segmentten (limitStart) yeniden başla
  const kStrategy = options.kStrategy ?? "increment";
  if (!["increment", "hold", "reset"].includes(kStrategy)) {
    throw new Error("Bilinmeyen kStrategy: " + kStrategy);
  }
  let k = 1;
  let improved = true;
  const candidatePipeline = options.candidatePipeline ?? "legacy";
  if (!["legacy", "staged"].includes(candidatePipeline)) {
    throw new Error("Bilinmeyen candidatePipeline: " + candidatePipeline);
  }
  const candidateIdentity = options.candidateIdentity
    ?? (candidatePipeline === "legacy" ? "legacy-sum" : "edge-pair");
  if (!["legacy-sum", "edge-pair"].includes(candidateIdentity)) {
    throw new Error("Bilinmeyen candidateIdentity: " + candidateIdentity);
  }
  if (candidatePipeline === "staged" && candidateIdentity !== "edge-pair") {
    throw new Error("staged candidatePipeline requires collision-free edge-pair identities");
  }
  const candidateScore = options.candidateScore ?? "length";
  if (!["length", "delta"].includes(candidateScore)) {
    throw new Error("Bilinmeyen candidateScore: " + candidateScore);
  }
  const directRayLookup = options.directRayLookup ?? "point-index";
  if (!["canonical", "point-index"].includes(directRayLookup)) {
    throw new Error("Bilinmeyen directRayLookup: " + directRayLookup);
  }
  // Bu sınır algoritmik bir karmaşıklık iddiası değildir. Bir iş birimi bir segment
  // değerlendirmesidir; kullanıcı/benchmark aynı çağrının en fazla kaç segment
  // tarayacağını deterministik olarak sınırlayabilir.
  const maxSegmentEvaluations = options.maxSegmentEvaluations === undefined
    || options.maxSegmentEvaluations === null
    ? Infinity
    : Math.max(0, Math.trunc(options.maxSegmentEvaluations));
  let segmentEvalCount = 0;
  let segmentBudgetExhausted = false;
  let visibilityRebuildCount = 0;
  // Görünürlük yenileme kadansı (Phase 9 §6.1). 1 = bugünkü davranış: iyileşen
  // her pass'ten sonra tam rebuild. N > 1 ise rebuild N iyileşen pass'te bire
  // düşer. Askıda kalan bayatlık koşu bitmeden bir kez temizlenir; çağıran
  // (doubleBridgeOptimizer) visibilityPrepared:true ile taze görünürlük bekler.
  const visibilityRefreshEveryNPasses = options.visibilityRefreshEveryNPasses === undefined
    || options.visibilityRefreshEveryNPasses === null
    ? 1
    : Math.max(1, Math.trunc(options.visibilityRefreshEveryNPasses));
  let passesSinceRefresh = 0;
  let visibilityStale = false;
  let visibilityStaleFlushCount = 0;
  let visibilityStaleRetryCount = 0;
  const nowMs = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  const koptStartTime = nowMs();
  let visibilityRebuildMs = 0;
  const refreshVisibility = () => {
    const rebuildStart = nowMs();
    objectOcc(world);
    visibilityRebuildMs += nowMs() - rebuildStart;
    visibilityRebuildCount++;
    passesSinceRefresh = 0;
    visibilityStale = false;
  };
  // Ölçüm enstrümantasyonu: varsayılan olarak kapalı. kFormula verildiğinde zorunlu
  // olarak açılır, çünkü formül pass başı özellik vektörünü girdi alıyor.
  // Maliyeti sıfır değil: pass başına bir buildBranchedBridgeRoundContext (mesh
  // üzerinde ~6 geçiş) demek, bu yüzden prod yolunda çalışmaz.
  const kFormula = typeof options.kFormula === "function" ? options.kFormula : null;
  const instrument = (options.instrument || kFormula) ? {
    segmentEvalCount: 0,
    candidateRayCount: 0,
    candidateProbeCount: 0,
    candidateMatchCount: 0,
    duplicateCandidateCount: 0,
    legacyIdentityCollisionCount: 0,
    directRayLookupCount: 0,
    canonicalRayLookupCount: 0,
    directRayFallbackCount: 0,
    corridorOverlapCount: 0,
    exactIntersectionCount: 0,
    deltaRejectCount: 0,
    candidateValidationCount: 0,
    adIntersectionCount: 0,
    addedEdgeCrossRejectCount: 0,
    moveIntegrityFailureCount: 0,
    moveSnapshotCount: 0,
    moveSnapshotObjectCount: 0,
    moveRollbackCount: 0,
    moveRollbackMs: 0,
    appliedMoveCount: 0,
    kHistogram: [],   // pass başına { k: uygulananHamleSayısı }
    kTopPerPass: [],  // pass başına hamle üreten en yüksek k
    k0PerPass: [],    // pass başına fiilen kullanılan başlangıç k'sı
    passFeatures: [],
    featureErrors: [],
    featureMs: 0
  } : null;
  // Rapor henüz tamamlanmadan oluşan bir throw'da da sayaçlar teşhis için erişilebilir.
  if (instrument) world.__koptInstrument = instrument;
  let passIndex = -1;
  if (!options.visibilityPrepared) {
    refreshVisibility();
  }
  let passStartLength = initialLength;
  let stalled = false;
  const passLengths = [];
  const passMs = [];
  const buildReport = (overrides = {}) => {
    // Kadans N > 1 iken son pass'ler yenilemesiz bitmiş olabilir. Bayatlık
    // koşudan dışarı sızmamalı: rapor kurulmadan önce bir kez kapatılır.
    if (visibilityStale) {
      refreshVisibility();
      visibilityStaleFlushCount++;
    }
    const finalLength = triPolygonPerimeter(world.totalNoktaList[4], null);
    const finalTsplibLength = triPolygonPerimeterTsplib(world.totalNoktaList[4], null);
    const totalMs = nowMs() - koptStartTime;
    console.log("Poligon başlangıç uzunluğu:", initialLength, "Çözüm uzunluğu: ", finalLength);
    return {
      initialLength,
      finalLength,
      distanceMetric: "EUCLIDEAN_RAW",
      initialTsplibLength,
      finalTsplibLength,
      tsplibImprovement: initialTsplibLength - finalTsplibLength,
      iterationCount,
      startNodeId: startNode.noktaNo,
      segmentLimit: limitStart,
      kStrategy,
      candidatePipeline,
      candidateIdentity,
      candidateScore,
      directRayLookup,
      maxSegmentEvaluations,
      segmentEvalCount,
      stopReason: overrides.stopReason || (segmentBudgetExhausted
        ? "SEGMENT_BUDGET_EXHAUSTED"
        : (stalled ? "STALLED" : "MAX_ITERATIONS")),
      visibilityRebuildCount,
      visibilityRefreshEveryNPasses,
      visibilityStaleFlushCount,
      visibilityStaleRetryCount,
      stalled: overrides.stalled ?? stalled,
      passLengths,
      passMs,
      totalMs,
      visibilityRebuildMs,
      koptSearchMs: totalMs - visibilityRebuildMs,
      ...(overrides.error ? { error: overrides.error } : {}),
      // Enstrümantasyon kapalıyken bu anahtar raporda hiç görünmez.
      ...(instrument ? { instrument } : {})
    };
  };
  do {
    passIndex++;
    let passFeature = null;
    if (instrument) {
      instrument.kHistogram.push({});
      instrument.kTopPerPass.push(0);
      passFeature = koptRecordPassFeatures(instrument, passIndex, world, nowMs);
    }
    k = limitStart;
    // Formül kolu (§6-A): k'yı o anki pocket yapısından türet. Özellik hesabı
    // başarısızsa sessizce limitStart'a düşer — koşu ölmez.
    if (kFormula && passFeature) {
      const proposed = kFormula(passFeature, passIndex);
      if (Number.isFinite(proposed)) {
        k = Math.max(2, Math.min(Math.round(proposed), Math.floor(polygon.length / 2 - 1)));
      }
    }
    if (instrument) instrument.k0PerPass.push(k);
    improved = false;
    iterationCount++; // debug
    // console.log("Iteration: ", iterationCount); // debug
    while (k > 0 && !segmentBudgetExhausted) {
      console.log("k:", k); // debug

      for (let kopt = 0; kopt < polygon.length; kopt++) {
        if (segmentEvalCount >= maxSegmentEvaluations) {
          segmentBudgetExhausted = true;
          break;
        }
        segmentEvalCount++;
        if (instrument) instrument.segmentEvalCount = segmentEvalCount;
        const segInfo = collectIdsWithEndpoints(nexSegmentStart, k, world, ignoredPrev);
        // Segment ile poligon bağlantısını sağlayan noktaları belirle (poligon tarafı)
        const adKeys = segmentEndpointsExternals(segInfo);        

        let firstLn;
        let lastLn;
          // Segmenti poligona bağlayan kenarların ham Öklid uzunluğunu ray/sparse cache'den al.
          if (segInfo.first.bag1 == adKeys[0] || segInfo.first.bag2 == adKeys[0]) {
          firstLn = routeEdgeLengthRawCached(world, segInfo.first, adKeys[0]);
          lastLn = routeEdgeLengthRawCached(world, segInfo.last, adKeys[1]);
        } else {
          firstLn = routeEdgeLengthRawCached(world, segInfo.first, adKeys[1]);
          lastLn = routeEdgeLengthRawCached(world, segInfo.last, adKeys[0]);
        }

        const oldPRLn = firstLn + lastLn;
        const excludes = new Set([0, 1, 2, 3]);
        segInfo.ids.forEach(id => excludes.add(id));

        // Segmentin uç noktalarıyla poligona bağlanılabilecek bağlantıları belirle (önceki bağlantıdan daha kısa olanlar)
        const prDualRays = getVisibleEdgesBetween(
          segInfo.first,
          segInfo.last,
          world,
          excludes,
          Infinity,
          {
            candidateIdentity,
            deferGeometry: candidatePipeline === "staged",
            directRayLookup,
            instrument
          }
        );
        if (instrument) instrument.candidateRayCount += prDualRays.size;

        const nodeA = world.totalNoktaList[adKeys[0]];
        const nodeD = world.totalNoktaList[adKeys[1]];

        const adRay = koptGetPointRay(world, nodeA.noktaNo, nodeD.noktaNo, directRayLookup, instrument);

        if (!adRay) {
          ({ nexSegmentStart, ignoredPrev } = setNextStart(nexSegmentStart, ignoredPrev));
          continue;
        }

        prDualRays.forEach((prValue, prKey) => {
          const rayP = world.rays.get(prValue.rayIds[0]);
          const rayR = world.rays.get(prValue.rayIds[1]);

          const raPTip = rayP.p1No != segInfo.first.noktaNo && rayP.p1No != segInfo.last.noktaNo ? rayP.p1No : rayP.p2No;
          const raRTip = rayR.p1No != segInfo.first.noktaNo && rayR.p1No != segInfo.last.noktaNo ? rayR.p1No : rayR.p2No;
          

          const rayPtoR = koptGetPointRay(world, raPTip, raRTip, directRayLookup, instrument);
          const rayPtoRId = rayPtoR?.key;

          if (!rayPtoR) {
            console.error("rayPtoR not found", raPTip, " to ", raRTip, "iterationCount:", iterationCount);
          }

          // Karar metriği ham Öklid uzunluğudur. TSPLIB yalnız raporlama için korunur.
          const BtoPLn = rayP.rawMetricLength ?? routeEdgeLengthRawCached(world, rayP.p1No, rayP.p2No);
          const CtoRLn = rayR.rawMetricLength ?? routeEdgeLengthRawCached(world, rayR.p1No, rayR.p2No);
          const ADLn = adRay.rawMetricLength ?? routeEdgeLengthRawCached(world, adKeys[0], adKeys[1]);
          const PRLn = rayPtoR?.rawMetricLength ?? routeEdgeLengthRawCached(world, raPTip, raRTip);
          prValue.length = BtoPLn + CtoRLn + ADLn;
          prValue.delta = prValue.length - oldPRLn - PRLn;

          const totalReal = BtoPLn + CtoRLn + ADLn;
          if (((raPTip == 20 || raPTip == 21) && (raRTip == 20 || raRTip == 21)) && // debug
            (segInfo.first.noktaNo == 37 && segInfo.last.noktaNo == 38)) {
            console.log("has ray breakpoint", totalReal);
          } // debug end
          // Segmentin poligona bağlanacak uçları poligon üzerinde birbirlerine bağlıdırlar,
          // dolayısıyla birbirlerini her zaman görmeleri gerekir, burada hata alınıyorsa,
          // birbirine bağlı iki nokta için bir görünürlük ray'i yok demektir,
          // ray beklenmedik bir şekilde silinmiş ve yeniden eklenmemiş demektir.

          // Yeni uzunluğun epsilon farkı kadar uzun olması loop'a girmeyi engelleyebilir. 
          // delta_L = AD + PB + CR - AB - CD - PR
          //const ABLn = mesafeHesapla(    
          if (
            adRay.key == rayPtoRId || // segmentin koparıldığı bağlantılarla tekrar işlem yapmaması için 
            oldPRLn + PRLn - prValue.length < epsilon
          ) {
            if (instrument && oldPRLn + PRLn - prValue.length < epsilon) instrument.deltaRejectCount++;
            prDualRays.delete(prKey);
          }
        });

        if (prDualRays.size === 0) {
          ({ nexSegmentStart, ignoredPrev } = setNextStart(nexSegmentStart, ignoredPrev));

          continue;
        }
        // Segmenti ayırmak için bağlantısı kesilen iki ucun birbirine bağlanması durumunda kesilecek üçgenleri bul
        let adTriangleIds = new Set();
        if (!collectTriangles(nodeA, nodeD, adTriangleIds)) {
          ({ nexSegmentStart, ignoredPrev } = setNextStart(nexSegmentStart, ignoredPrev));

          continue;
        }

        // AD hattının geçtiği üçgenlerden geçen raylardan bcSegmentine bağlı olanlar alınıyor
        // Tünelleme durumları için projeksiyon raylarının da yenilenmesi lazım
        const adTriRays = new Set();
        const tipProps = ["p1No", "p2No", "projEdgeTip1", "projEdgeTip2"];

        for (const triId of adTriangleIds) {
          const triangle = world.totalUcgenList[triId];
          for (const rayId of triangle.rayKeys) {
            const ray = world.rays.get(rayId);
            if (!ray) continue;

            // ray’in uç noktalarından herhangi biri segInfo.ids içinde mi?
            if (tipProps.map((prop) => ray[prop]).some((nodeNo) => segInfo.ids.has(nodeNo))) {
              adTriRays.add(rayId);
            }
          }
        }

        const scoreCandidate = candidateScore === "delta"
          ? value => value.delta
          : value => value.length;
        let shortDualRays;
        if (candidatePipeline === "staged") {
          // Delta tüm adaylar için O(1) cache okumalarıyla hazırlandı. Adayları kararlı
          // skor sırasına koyup kesin geometriyi yalnız seçime kadar doğrulamak, aynı
          // aday kümesi/skor altında validate-all ile aynı sonucu verir.
          shortDualRays = koptFindFirstValidCandidate(
            prDualRays,
            scoreCandidate,
            candidate => koptCandidateGeometryValid(
              candidate,
              segInfo,
              nodeA,
              nodeD,
              adTriRays,
              world,
              instrument
            ),
            instrument
          );
        } else {
          // Eski doğrulama sırası A/B kontrolü için korunur.
          for (const [prKey, prValue] of prDualRays) {
            if (!koptCandidateAdGeometryValid(
              prValue, segInfo, nodeA, nodeD, adTriRays, world, instrument)
              || !koptAddedEdgesDisjoint(prValue, nodeA, nodeD, world, instrument)) {
              prDualRays.delete(prKey);
            }
          }
          shortDualRays = findShortestRay(prDualRays, scoreCandidate);
        }

        // Değişen segmentlerdeki noktaları gören noktaların visibleListlerinden bu noktalar silinip,
        // bakan noktalara yeni lookAt taskları eklenecek. BC Segmentine, AD Segmentine ve PR Segmentine bağlı tüm raylar ve raykeyler karşılıklı silinecek
        if (shortDualRays) {
          let moveSnapshot = null;
          if (options.rollbackOnMoveFailure === true) {
            if (typeof captureWorldState !== "function") {
              throw new Error("rollbackOnMoveFailure requires captureWorldState");
            }
            moveSnapshot = captureWorldState(world);
            if (instrument) {
              instrument.moveSnapshotCount++;
              instrument.moveSnapshotObjectCount += moveSnapshot.objectCount;
            }
          }
          const rollbackMove = message => {
            if (!moveSnapshot) return null;
            const rollbackStart = nowMs();
            moveSnapshot.restore();
            if (instrument) {
              instrument.moveRollbackCount++;
              instrument.moveRollbackMs += nowMs() - rollbackStart;
            }
            return buildReport({ stopReason: "MOVE_ROLLED_BACK", stalled: false, error: message });
          };
          // Tur/mesh tutarlılığı bozulduysa devam etmek bag1/bag2'yi asimetrik bırakır ve
          // sınırsız tur yürüyüşleri sonsuz döngüye girer; geri al ya da açıkça dur.
          const failMoveIntegrity = message => {
            const rolledBack = rollbackMove(message);
            // Geri alma world'e bağlı sayaçları da geri yükler; sayaç ondan sonra artırılır.
            if (instrument) instrument.moveIntegrityFailureCount++;
            if (rolledBack) return rolledBack;
            throw new Error("K-opt move integrity failure: " + message);
          };
          const getTargetIdFromRay = (ray, segInfoData) => {
            return ray.p1No === segInfoData.first.noktaNo || ray.p1No === segInfoData.last.noktaNo ? ray.p2No : ray.p1No;
          };

          // Kesilen segmentin yeni bağlantı uçları için LookAt görevi eklenecek noktalar bulunuyor
          const rayP = world.rays.get(shortDualRays.rayIds[0]);
          const rayR = world.rays.get(shortDualRays.rayIds[1]);

          const targetPId = getTargetIdFromRay(rayP, segInfo);
          const targetRId = getTargetIdFromRay(rayR, segInfo);

          // Alttaki üç benzer döngü listesi optimizasyon gereği birleştirilmiyor
          [targetPId, targetRId].forEach((id) => {
            processPointAndItsViewers(id, world);
          });

          // Kesilen segmentin üzerindeki tüm noktalar için
          segInfo.ids.forEach((id) => {
            processPointAndItsViewers(id, world);
          });

          // Kesilen segmentin yerine geçecek kenarın noktaları
          [nodeA.noktaNo, nodeD.noktaNo].forEach((id) => {
            processPointAndItsViewers(id, world);
          });

          adTriRays.forEach((adIntersectRayId) => {
            const adIntersectRay = world.rays.get(adIntersectRayId);
            if (adIntersectRay) {
              // nodeA ve nodeD, k segmenti kesildiğinde poligonun yeni yama kenarını temsil ediyor
              const intersect = segmentsIntersect(nodeA.noktaNo, nodeD.noktaNo, adIntersectRay.p1No, adIntersectRay.p2Loc, world);
              if (intersect && adIntersectRay.p2No > -1) {
                cleanupMutualRelations(world.totalNoktaList[adIntersectRay.p1No], world.totalNoktaList[adIntersectRay.p2No], world);
              } else if (intersect && adIntersectRay.p2No < 0) {
                const viewer = world.totalNoktaList[adIntersectRay.p1No];
                cleanupMutualRelations(viewer, adIntersectRay.p2Loc, world);

                const seen = world.totalNoktaList[adIntersectRay.projectFrom];

                processPointAndItsViewers(adIntersectRay.projEdgeTip1, world);
                processPointAndItsViewers(adIntersectRay.projEdgeTip2, world);
              }
            }
          });

          // ObjectOcc bu koridorları ray üzerinde zaten tutuyor; aynı iki triangle-walk'u
          // yeniden çalıştırmak yerine ters indeksi birleştir.
          const prTriangleIds = new Set([
            ...(rayP.triangles || []),
            ...(rayR.triangles || []),
          ]);

          // Yenilenecek P ve R kenarlarının kestiği görünürlükler siliniyor
          prTriangleIds.forEach((id) => {
            const prTriangle = world.totalUcgenList[id];
            prTriangle.rayKeys.forEach((rayId) => {
              const ray = world.rays.get(rayId);
              if (ray) {
                const intersectP = segmentsIntersect(rayP.p1No, rayP.p2No, ray.p1No, ray.p2Loc, world);
                const intersectR = segmentsIntersect(rayR.p1No, rayR.p2No, ray.p1No, ray.p2Loc, world);
                if ((intersectP || intersectR) && ray.p2No > -1) {
                  cleanupMutualRelations(world.totalNoktaList[ray.p1No], world.totalNoktaList[ray.p2No], world);
                } else if ((intersectP || intersectR) && ray.p2No < 0) {
                  const viewer = world.totalNoktaList[ray.p1No];

                  cleanupMutualRelations(viewer, ray.p2Loc, world);

                  const seen = world.totalNoktaList[ray.projectFrom];

                  processPointAndItsViewers(ray.projEdgeTip1, world);
                  processPointAndItsViewers(ray.projEdgeTip2, world);
                }
              }
            });
          });

          // k segmentinin poligonla bağlantıları kesiliyor
          let previous;
          if (adKeys.includes(segInfo.first.bag1)) {
            previous = segInfo.first.bag1;
          } else if (adKeys.includes(segInfo.first.bag2)) {
            previous = segInfo.first.bag2;
          }

          const targetP = world.totalNoktaList[targetPId];
          const targetR = world.totalNoktaList[targetRId];
          const removedEdges = segInfo.first === segInfo.last
            ? [[segInfo.first, nodeA], [segInfo.first, nodeD]]
            : koptBagsLinked(segInfo.first, nodeA)
              ? [[segInfo.first, nodeA], [segInfo.last, nodeD]]
              : [[segInfo.first, nodeD], [segInfo.last, nodeA]];
          removedEdges.push([targetP, targetR]);

          disconnectSegment(segInfo.first, [], world, k, false, world.totalNoktaList[previous]);
          disconnectSegment(targetP, [], world, 1, true, targetR);

          // disconnectPoint kenarı mesh'te bulamazsa bag'leri sessizce bırakır.
          const unremovedEdge = removedEdges.find(([left, right]) => koptBagsLinked(left, right));
          if (unremovedEdge) {
            return failMoveIntegrity(
              `removed edge ${unremovedEdge[0].noktaNo}-${unremovedEdge[1].noktaNo} is still linked in bag1/bag2`);
          }
          // break; //debug
          let  connectionTips = [];
           connectionTips.push([world.totalNoktaList[rayP.p1No], world.totalNoktaList[rayP.p2No]]);
           connectionTips.push([world.totalNoktaList[rayR.p1No], world.totalNoktaList[rayR.p2No]]);
           connectionTips.push([nodeA, nodeD]);

          let bagWriteFailure = null;
          for (const dual of  connectionTips) {
            const activeNokta = dual[0];
            const list = activeNokta.aralikList;
            const len = list.length;
            const start = rayP.intervalId;
            const startIndex = ((start % len) + len) % len;

            for (let offset = 0; offset < len; offset++) {
              // list üzerinde dairesel gezinme
              const i = (startIndex + offset) % len;
              if (activeNokta.aralikList[i].disabled == false) {
                const targetNokta = dual[1];
                let mdAnswer = new PointToAnswer();
                mdAnswer = pointToPointQuery2(activeNokta, targetNokta.kendiYeri, true, activeNokta.aralikList[i], 0, world.totalNoktaList, world.totalUcgenList, world);

                if (mdAnswer.durum > 0) {
                  if (activeNokta.aralikList[i].gidenUcNo != targetNokta.noktaNo && activeNokta.aralikList[i].gelenUcNo != targetNokta.noktaNo) {
                    mdAnswer = connectPoints(targetNokta, activeNokta, activeNokta.aralikList[i], mdAnswer, -1, world);

                    if (mdAnswer.connected) {
                      boyamaKenari1 = world.totalUcgenList[mdAnswer.earSonUcgen].kenarList[2];
                      boyamaKenari1.polyKenar = false;
                      boyamaKenari1.disKenar = true;
                      boyamaKenari1.kenarPolyNo = 0;
                      world.totalUcgenList[boyamaKenari1.komsuNo].kenarList[boyamaKenari1.komsudaKacinciKenarNo].polyKenar = false;
                      world.totalUcgenList[boyamaKenari1.komsuNo].kenarList[boyamaKenari1.komsudaKacinciKenarNo].disKenar = true;
                      world.totalUcgenList[boyamaKenari1.komsuNo].kenarList[boyamaKenari1.komsudaKacinciKenarNo].kenarPolyNo = 0;
                    } else {
                      console.log("connection problem between: ", mdAnswer, targetNokta.noktaNo, activeNokta.noktaNo, "iteration:", iterationCount);
                      const rolledBack = rollbackMove(
                        `Connection failed between ${targetNokta.noktaNo} and ${activeNokta.noktaNo}`);
                      if (rolledBack) return rolledBack;
                      // Tarihsel çağrılar için davranışı koru; güvenli üretim çağrıları
                      // rollbackOnMoveFailure seçeneğini açmalıdır.
                      return;
                    }
                  } else {
                    if (activeNokta.aralikList[i].gidenUcNo == targetNokta.noktaNo) {
                      let boyamaKenari1 = world.totalUcgenList[activeNokta.aralikList[i].ucgenNo].kenarList[activeNokta.aralikList[i].ucgeniciGidenKenarNo];
                      boyamaKenari1.polyKenar = false;
                      boyamaKenari1.disKenar = true;
                      boyamaKenari1.kenarPolyNo = 0;
                      world.totalUcgenList[boyamaKenari1.komsuNo].kenarList[boyamaKenari1.komsudaKacinciKenarNo].polyKenar = false;
                      world.totalUcgenList[boyamaKenari1.komsuNo].kenarList[boyamaKenari1.komsudaKacinciKenarNo].disKenar = true;
                      world.totalUcgenList[boyamaKenari1.komsuNo].kenarList[boyamaKenari1.komsudaKacinciKenarNo].kenarPolyNo = 0;
                    }
                    if (activeNokta.aralikList[i].gelenUcNo == targetNokta.noktaNo) {
                      let boyamaKenari1 = world.totalUcgenList[activeNokta.aralikList[i].ucgenNo].kenarList[activeNokta.aralikList[i].ucgeniciGelenKenarNo];
                      boyamaKenari1.polyKenar = false;
                      boyamaKenari1.disKenar = true;
                      boyamaKenari1.kenarPolyNo = 0;
                      world.totalUcgenList[boyamaKenari1.komsuNo].kenarList[boyamaKenari1.komsudaKacinciKenarNo].polyKenar = false;
                      world.totalUcgenList[boyamaKenari1.komsuNo].kenarList[boyamaKenari1.komsudaKacinciKenarNo].disKenar = true;
                      world.totalUcgenList[boyamaKenari1.komsuNo].kenarList[boyamaKenari1.komsudaKacinciKenarNo].kenarPolyNo = 0;
                    }
                  }

                  if (!koptWriteBag(activeNokta, targetNokta.noktaNo) || !koptWriteBag(targetNokta, activeNokta.noktaNo)) {
                    bagWriteFailure = `bag1/bag2 already full while linking ${activeNokta.noktaNo}-${targetNokta.noktaNo}`;
                  }

                  break;
                } else if (i > activeNokta.aralikList.length - 1) { // debug                  
                  console.error("Catastrophic Circuit Cock-up", mdAnswer);
                }
              }
            }
            if (bagWriteFailure) break;
          }
          if (bagWriteFailure) return failMoveIntegrity(bagWriteFailure);
          // Engelleme aday seçiminde yapılır: eklenen kenarların birbirini kesmesini
          // koptAddedEdgesDisjoint, mevcut tur kenarlarını kesmesini objectOcc görünürlüğü önler.
          // Bu yalnız bir tetik telidir (sağlam koşularda hiç tetiklenmez): biri kaçarsa bir
          // connectPoints tur kenarını mesh'ten silmiştir ve devam etmek bag1/bag2'yi bozar.
          const brokenAddedEdge = connectionTips.find(([left, right]) =>
            !(left.bag1 === right.noktaNo || left.bag2 === right.noktaNo)
            || !(right.bag1 === left.noktaNo || right.bag2 === left.noktaNo)
            || !koptRouteEdgeInMesh(world, left.noktaNo, right.noktaNo));
          if (brokenAddedEdge) {
            return failMoveIntegrity(
              `added edge ${brokenAddedEdge[0].noktaNo}-${brokenAddedEdge[1].noktaNo} is missing from bag1/bag2 or the mesh`);
          }
          /*const nullOlankler = world.totalNoktaList.filter((item) => item.bag1 === null || item.bag2 === null); // debug
          if (nullOlankler && nullOlankler.length > 0) {
            // debug
            console.error("crash2, nullOlankler", nullOlankler, "iterationCount:", iterationCount);
            return;
          }*/

          nexSegmentStart = nodeD;

          ignoredPrev = nodeA;
          //world.aramailkNoktasi = nodeD;

          improved = true;
          // Hamle, k'yı değiştiren strateji dalından ÖNCE kaydedilmeli; sonra
          // kaydedilirse histogram bir basamak kayar.
          if (instrument) {
            instrument.appliedMoveCount++;
            const bucket = instrument.kHistogram[passIndex];
            bucket[k] = (bucket[k] || 0) + 1;
            if (k > instrument.kTopPerPass[passIndex]) instrument.kTopPerPass[passIndex] = k;
          }
          //k += (Math.abs((polygon.length / 2 - 1) - n) - Math.abs((polygon.length / 2 - 1) - (n + 1)) + 1) / 2;
          if (kStrategy === "increment") {
            if (k + 1 <= polygon.length / 2 - 1) {
              k++;
            }
          } else if (kStrategy === "reset") {
            k = limitStart;
          }
          // Hot-loop'ta senkron canvas çizimi UI'yi kilitler; çizim çağıran tarafta bir kez yapılır.
        } else {
          ({ nexSegmentStart, ignoredPrev } = setNextStart(nexSegmentStart, ignoredPrev));
        }
      }
      k--;
    }
    if (improved && options.rebuildVisibilityAfterIteration !== false) {
      passesSinceRefresh++;
      visibilityStale = true;
      // N = 1'de koşul ilk artışta sağlanır; varsayılan yol değişmez.
      if (passesSinceRefresh >= visibilityRefreshEveryNPasses) refreshVisibility();
    }
    const passEndLength = triPolygonPerimeter(world.totalNoktaList[4], null);
    passLengths.push(passEndLength);
    passMs.push(nowMs() - koptStartTime);
    stalled = !(passEndLength < passStartLength);
    // Bayat görünürlükle tıkanmak gerçek tıkanma sayılmaz: N > 1'de pass, aday
    // olmadığı için değil, göremediği için durmuş olabilir. Koşu bitmeden önce
    // askıdaki yenileme yapılır ve bir pass daha denenir; yenilenmiş görünürlükle
    // de kısalma gelmezse bir sonraki turda visibilityStale false'tur ve tıkanma
    // geçerlidir. N = 1'de visibilityStale hiç true olmaz, bu dal ölü koddur.
    if (stalled && visibilityStale) {
      refreshVisibility();
      visibilityStaleRetryCount++;
      stalled = false;
    }
    passStartLength = passEndLength;
  } while (!segmentBudgetExhausted && !stalled && iterationCount < maxIterations);
  return buildReport();
}

// --- Ölçüm yardımcıları (§2.1). Yalnızca options.instrument / options.kFormula ile çalışır. ---

function koptQuantile(sorted, q) {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// O anki rota + mesh'ten §5.3'ün aday özelliklerini çıkarır. Tek bir
// buildBranchedBridgeRoundContext çağrısı; ucuz değildir, bu yüzden pass başına bir kez.
function koptExtractPocketFeatures(world) {
  const order = tourOrderFromBags(world.totalNoktaList[4], world);
  const ctx = buildBranchedBridgeRoundContext(world, order);
  // regionId === null olan run'lar core'a ait; pocket run'ı değiller ve k ile
  // kıyaslanacak büyüklük değiller.
  const runLens = ctx.regionRuns.filter(run => run.regionId).map(run => run.edgeIndices.length);
  runLens.sort((a, b) => a - b);
  const depths = ctx.forest.pockets.map(pocket => pocket.maxDepth);
  depths.sort((a, b) => a - b);
  // Payda dış üçgen sayısı olmalı; ctx.dual.adjacency.length TÜM üçgenlerdir (çoğu null).
  const outsideCount = ctx.outside.size;
  return {
    runP90: koptQuantile(runLens, 0.9),
    runMax: runLens.length ? runLens[runLens.length - 1] : 0,
    runMean: runLens.length ? runLens.reduce((a, b) => a + b, 0) / runLens.length : 0,
    pocketCount: ctx.forest.pockets.length,
    coreFraction: outsideCount ? ctx.coreResult.core.size / outsideCount : 0,
    maxDepthP90: koptQuantile(depths, 0.9),
    maxDepthMax: depths.length ? depths[depths.length - 1] : 0,
    routeEdgeCount: order.length
  };
}

function koptRecordPassFeatures(instrument, passIdx, world, nowMs) {
  const started = nowMs();
  let feature = null;
  try {
    feature = koptExtractPocketFeatures(world);
    const previous = instrument.passFeatures.length
      ? instrument.passFeatures[instrument.passFeatures.length - 1]
      : null;
    // Delta'lar yakınsama hızını taşır; sabit değerlerden farklı bilgi (§5.3).
    feature.dCoreFraction = previous ? feature.coreFraction - previous.coreFraction : 0;
    feature.dPocketCount = previous ? feature.pocketCount - previous.pocketCount : 0;
    feature.pass = passIdx;
    instrument.passFeatures.push(feature);
  } catch (error) {
    // buildBranchedBridgeRoundContext rota/mesh tutarsızlığında atıyor
    // ("Route edge X has multiple outside-tree owners", order.length < 4).
    // Bir özellik günlüğü hatası koşuyu öldürmemeli.
    instrument.featureErrors.push({ pass: passIdx, message: String(error && error.message || error) });
  }
  instrument.featureMs += nowMs() - started;
  return feature;
}

function setNextStart(nexSegmentStart, ignoredPrev) {
  const nexSegmentStartId = nexSegmentStart.bag1 == ignoredPrev.noktaNo ? nexSegmentStart.bag2 : nexSegmentStart.bag1;
  ignoredPrev = nexSegmentStart;
  nexSegmentStart = world.totalNoktaList[nexSegmentStartId];
  return { nexSegmentStart, ignoredPrev };
}

function performLookAtTasks(world) {
  while (!world.lookAtTasks.isEmpty()) {
    const currentPoint = world.lookAtTasks.dequeue();
    while (!world.projectionTasks.isEmpty() || !currentPoint.lookAtTasks.isEmpty()) {
      if (!currentPoint.lookAtTasks.isEmpty()) {
        const seen = currentPoint.lookAtTasks.dequeue();
        lookAtNextSector(currentPoint, world, [seen]);
      }
      if (!world.projectionTasks.isEmpty()) {
        performProjectionTasks(currentPoint, world);
      }
    }
  }
}

function disconnectPoint(nokta, tip, world) {
  for (const { disabled, ucgenNo, ucgeniciGidenKenarNo, ucgeniciGelenKenarNo, gidenUcNo } of nokta.aralikList) {
    if (!disabled && gidenUcNo == tip) {
      [ucgeniciGidenKenarNo, ucgeniciGelenKenarNo].forEach((kenarNo) => {
        const kenarTest = world.totalUcgenList[ucgenNo].kenarList[kenarNo];
        const komsuUcgen = world.totalUcgenList[kenarTest.komsuNo];
        const komsuKenarTest = komsuUcgen.kenarList[kenarTest.komsudaKacinciKenarNo];
        if (
          [kenarTest.uc1NoktaNo, kenarTest.uc2NoktaNo].includes(nokta.noktaNo) &&
          [kenarTest.uc1NoktaNo, kenarTest.uc2NoktaNo].includes(tip) &&
          (kenarTest.disKenar || komsuKenarTest.disKenar)
        ) {
          [kenarTest, komsuKenarTest].forEach((kenar) => {
            kenar.relatedRays.forEach((rayId) => {
              const ray = world.rays.get(rayId);
              if (ray) {
                // ilk döngüde ray silineceğinden ikinci döngüde alttaki blokun çalışmasına gerek yok
                const viewer = world.totalNoktaList[ray.p1No];
                const seen = world.totalNoktaList[ray.projectFrom];
                viewer.visibleList.delete(ray.projectFrom);
                seen.visibleList.delete(ray.p1No);
                //viewer.lookAtTasks.enqueue(seen.noktaNo, seen.noktaNo);
                //world.lookAtTasks.enqueue(viewer, getCanonicalRayKey(viewer.kendiYeri, seen.kendiYeri));
                removeRayFromIndexes(rayId, world);

                processPointAndItsViewers(kenarTest.uc1NoktaNo, world);
                processPointAndItsViewers(kenarTest.uc2NoktaNo, world);
              }
              kenar.relatedRays.delete(rayId);
            });
            Object.assign(kenar, {
              disKenar: false,
              polyKenar: false,
              kenarPolyNo: -1,
            });

            // Bir Noktanın iki bağı birden null olamaz, eğer null kontrolü yapılmazsa ikinci turda iki bağda null olur.
            if (nokta.bag1 == tip) nokta.bag1 = null;
            if (nokta.bag2 == tip) nokta.bag2 = null;
            const tipNokta = world.totalNoktaList[tip];
            if (tipNokta.bag1 == nokta.noktaNo) tipNokta.bag1 = null;
            if (tipNokta.bag2 == nokta.noktaNo) tipNokta.bag2 = null;

            //(tipNokta.bag1 && tipNokta.bag1 == nokta.noktaNo) ? tipNokta.bag1 = null : tipNokta.bag2 = null;
          });
        }
      });
      break;
    }
  }
}

function disconnectSegment(start, seg, world, k = null, oneSide = false, previous) {
  // -------- yardımcı ------------
  const otherBagTip = (node, usedId) => (usedId === node.bag1 ? "bag2" : "bag1");
  // ------------------------------

  let prev = previous ? previous : start;
  let curr = start;
  let i = 0;

  let usedNextIdFirst = null; // ilk adımda hangi bag’i kullandık?
  if (oneSide && (start.bag1 == null || start.bag2 == null)) {
    const tipB = start.bag1 == null ? start.bag2 : start.bag1;
    disconnectPoint(start, tipB, world);
    seg[0] = curr;
    return seg;
  }

  do {
    seg[i++] = curr;

    // Prev olmayan komşu = ilerleyeceğimiz bag
    const nextId = curr.bag2 === prev.noktaNo ? curr.bag1 : curr.bag2;
    if (!nextId) {
      break;
    }

    // ---------- İLK nokta ----------
    if (i === 1) {
      // henüz ilk köşedeyiz
      usedNextIdFirst = nextId;
      const tip = otherBagTip(curr, nextId);
      disconnectPoint(curr, curr[tip], world);
    }

    prev = curr;
    curr = world.totalNoktaList[nextId];
  } while (
    curr.noktaNo !== start.noktaNo && // tam tura gelmedik
    (k == null || i <= k) // k aşılmadı
  );

  // ---------- SON nokta ----------
  // Döngüden çıkınca prev = son ziyaret edilen köşe,
  // curr     = prev'ten sonraki (start veya k sonrası).
  const tipLast = otherBagTip(prev, curr.noktaNo);
  // Aynı düğümde iki kez koparmayı önlemek için
  // (ör. k === 1) kontrol edelim:
  if (!oneSide && (prev.noktaNo !== start.noktaNo || tipLast !== otherBagTip(start, usedNextIdFirst))) {
    disconnectPoint(prev, prev[tipLast], world);
  }

  return seg;
}

function collectTriangles(nodeA, nodeD, rayTrianglesIds) {
  let answer = new PointToAnswer();
  for (let i = 0; i < nodeA.aralikList.length; i++) {
    if (!nodeA.aralikList[i].disabled) {
      answer = pointToPointQuery3(nodeA, nodeD.kendiYeri, nodeA.aralikList[i], world);

      if (answer.durum > 0) {
        break;
      }
    }
  }

  // Çizilecek kenarın içinden geçtiği üçgenler toplanıyor
  if (
    (answer.durum == 0 && answer?.ilKesilenDiskenar == null) ||
    (answer.durum > 0 &&
      (answer?.ilKesilenDiskenar == null || (!!answer.ilKesilenDiskenar && (answer.ilKesilenDiskenar.uc1NoktaNo == nodeD.noktaNo || answer.ilKesilenDiskenar.uc2NoktaNo == nodeD.noktaNo))))
  ) {
    answer.triangles.forEach((id) => {
      rayTrianglesIds.add(id);
    });
    return true;
  } else {
    return false;
  }
}

function cleanupMutualRelations(viewer, seen, world) {
  let key;
  if (Object.hasOwn(seen, "noktaNo")) {
    viewer.visibleList.delete(seen.noktaNo);
    seen.visibleList.delete(viewer.noktaNo);
    key = koptGetPointRay(world, viewer.noktaNo, seen.noktaNo, "point-index")?.key
      ?? getCanonicalRayKey(viewer.kendiYeri, seen.kendiYeri);
  } else {
    key = getCanonicalRayKey(viewer.kendiYeri, seen, 0.123); // burada ilgili kenarın bulunup üzerinden relatedRay'in silinmesi gerek
  }
  removeRayFromIndexes(key, world);
}

function removeRayFromIndexes(rayId, world) {
  const ray = world.rays.get(rayId);
  if (!ray) return false;
  world.rays.delete(rayId);
  world.totalNoktaList[ray.p1No]?.relatedRays.delete(rayId);
  if (ray.p2No >= 0) {
    world.totalNoktaList[ray.p2No]?.relatedRays.delete(rayId);
    world.pointRayIndex?.delete(
      ray.p1No < ray.p2No ? `${ray.p1No}:${ray.p2No}` : `${ray.p2No}:${ray.p1No}`
    );
  }
  for (const triangleId of ray.triangles || []) {
    const triangle = world.totalUcgenList[triangleId];
    triangle?.rayKeys.delete(rayId);
    if (ray.projEdgeTip1 === null || ray.projEdgeTip2 === null) continue;
    for (const edge of triangle.kenarList) {
      if ((edge.uc1NoktaNo === ray.projEdgeTip1 && edge.uc2NoktaNo === ray.projEdgeTip2)
        || (edge.uc1NoktaNo === ray.projEdgeTip2 && edge.uc2NoktaNo === ray.projEdgeTip1)) {
        edge.relatedRays.delete(rayId);
      }
    }
  }
  return true;
}

function processPointAndItsViewers(seenId, world) {
  const seen = world.totalNoktaList[seenId];
  seen.visibleList.forEach((associatedValue, viewerId) => {
    const viewer = world.totalNoktaList[viewerId];
    cleanupMutualRelations(viewer, seen, world);
  });

  // kesilen noktaların visibleList'i üzerinden görünürlükler yenilendiğinden projeksiyon rayleri silinmiyor,
  // bu nedenle ayrıca silmek gerekiyor, yeni bir projeksiyon taskı eklemeye gerek yok,
  // çünkü projectFrom noktası için bir lookAt görevi oluşacak ve durumu uygunsa projeksiyon yapılacak.
  seen.relatedRays.forEach((rayId) => {
    const ray = world.rays.get(rayId);
    if (ray) {
      removeRayFromIndexes(rayId, world);
    }
  });
}

/**
 * Poligonu gez ve her kenar için callback'i çalıştır.
 *
 * @param {Node}      start         – Başlangıç düğümü
 * @param {Object}    world         – world.totalNoktaList[id] ➜ Node
 * @param {Function}  callback      – (curr, next, step) şeklinde çağrılır
 * @param {number?}   k = null  – Adım sınırı (null ⇒ tam tur)
 *
 *   callback(currNode, nextNode, stepIndex)
 *     currNode : Şu anki düğüm
 *     nextNode : Bir sonraki düğüm
 *     stepIndex: 0-dan başlayan adım numarası
 */
function traversePolygon(start, world, reducer, acc, k = null, prev = start) {
  let curr = start;
  let step = 0;
  if (k === 0) return acc;

  do {
    const nextId = curr.bag1 === prev.noktaNo ? curr.bag2 : curr.bag1;
    const next = world.totalNoktaList[nextId];
    // Kapalı bir tur en fazla nokta sayısı kadar adımda başa döner. Bozuk bag1/bag2
    // (açık uç ya da başlangıcı içermeyen bir çevrim) sessiz sonsuz döngü yerine hata verir.
    if (!next || step >= world.totalNoktaList.length) {
      throw new Error(`traversePolygon: bag1/bag2 does not describe one simple closed cycle (start ${start.noktaNo}, at ${curr.noktaNo})`);
    }

    acc = reducer(acc, curr, next, step++);

    prev = curr;
    curr = next;
  } while (curr.noktaNo !== start.noktaNo && (k == null || step < k));
  return acc;
}

function collectIdsWithEndpoints(startNode, k, world, prev) {
  return traversePolygon(
    startNode,
    world,
    (a, curr, _next, step) => {
      a.ids.add(curr.noktaNo); // kimlik kümesi
      if (step === 0) a.first = curr; // ilk düğüm
      a.last = curr; // her adımda güncel; sonunda “son düğüm”
      return a;
    },
    { ids: new Set(), first: null, last: null },
    k,
    prev
  );
}

function segmentEndpointsExternals(acc) {
  const { ids, first, last } = acc;

  const endpoints = [first, last];

  let externalBagKey = [];

  if (first.noktaNo != last.noktaNo) {
    endpoints.forEach((node) => {
      // Segmentin içinde OLMAYAN bag hangi tarafta?
      externalBagKey.push(node[ids.has(node.bag1) ? "bag2" : "bag1"]);
    });
  } else {
    externalBagKey = [first.bag1, first.bag2];
  }

  return externalBagKey;
}

/**
 * n1 ve n2’nin görünürlük listeleri arasında,
 * – bitişik (bag1/bag2)       – u ≠ v
 * – her iki düğüm de en az bir ucu görebiliyor
 * – opsiyonel uzunluk / kesişim / excluded filtreleri
 * koşullarını geçen **kenar ikililerini** döndürür.
 *
 * @param {Object} n1  { noktaNo:Number, visibleList:Map<number,true> }
 * @param {Object} n2
 * @param {Object} world  world.totalNoktaList { id → { bag1, bag2, kendiYeri } }
 * @param {number[]}  [excluded=[]]
 * @param {number}    [prevlength=Infinity]
 * @returns {Map<number, [[viewer,seen],[viewer,seen]]>}
 */

function koptGetPointRay(world, pointAId, pointBId, lookupMode = "point-index", instrument = null) {
  if (lookupMode === "point-index" && typeof getPointRay === "function") {
    if (instrument) instrument.directRayLookupCount++;
    const indexed = getPointRay(world, pointAId, pointBId);
    if (indexed) return indexed;
    if (instrument) instrument.directRayFallbackCount++;
  }
  if (instrument) instrument.canonicalRayLookupCount++;
  const pointA = world.totalNoktaList[pointAId];
  const pointB = world.totalNoktaList[pointBId];
  if (!pointA || !pointB) return undefined;
  return world.rays.get(getCanonicalRayKey(pointA.kendiYeri, pointB.kendiYeri));
}

function koptCandidateIdentityKey(viewerA, seenA, viewerB, seenB) {
  // Düğüm kimlikleri tamsayıdır; ayraçlı dörtleme Number/BigInt taşması ve
  // toplam-temelli çakışmaları olmadan yönlü bağlantı rollerini korur.
  return `${viewerA}:${seenA}|${viewerB}:${seenB}`;
}

function koptCandidateRayGeometryValid(candidate, world, segmentEndpointA, segmentEndpointB, instrument = null) {
  const rayA = world.rays.get(candidate.rayIds[0]);
  const rayB = world.rays.get(candidate.rayIds[1]);
  if (!rayA || !rayB) return false;
  if (segmentEndpointA === segmentEndpointB) return true;
  const [small, large] = rayA.triangles.size <= rayB.triangles.size
    ? [rayA.triangles, rayB.triangles]
    : [rayB.triangles, rayA.triangles];
  let corridorsOverlap = false;
  for (const triangleId of small) {
    if (large.has(triangleId)) {
      corridorsOverlap = true;
      break;
    }
  }
  if (!corridorsOverlap) return true;
  if (instrument) {
    instrument.corridorOverlapCount++;
    instrument.exactIntersectionCount++;
  }
  return !segmentsIntersect(rayA.p1No, rayA.p2No, rayB.p1No, rayB.p2No, world);
}

function koptCandidateAdGeometryValid(candidate, segInfo, nodeA, nodeD, adTriRays, world, instrument = null) {
  for (const rayId of candidate.rayIds) {
    if (!adTriRays.has(rayId)) continue;
    const ray = world.rays.get(rayId);
    if (!ray) return false;
    const { first, last } = segInfo;
    const tipsMatched = (
      ray.p1No === first.noktaNo
      || ray.p2No === first.noktaNo
      || ray.p1No === last.noktaNo
      || ray.p2No === last.noktaNo
    ) && !ray.projectFrom;
    if (!tipsMatched) continue;
    if (instrument) instrument.adIntersectionCount++;
    if (segmentsIntersect(nodeA.noktaNo, nodeD.noktaNo, ray.p1No, ray.p2No, world)) return false;
  }
  return true;
}

// Ekran koordinatlarında (mesh'in kullandığı) iki tur kenarı kesişiyor mu? Uç kimliği
// paylaşan kenarlar yalnız aynı doğrultuda üst üste biniyorsa kesişir; ortak uçta
// temas bir kesişim değildir (segmentsIntersect bunu ayırt etmez).
function koptRouteEdgesCross(a, b, c, d, world) {
  const sharesA = a === c || a === d;
  const sharesB = b === c || b === d;
  const list = world.totalNoktaList;
  const orient = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  if (sharesA && sharesB) return true;
  if (sharesA || sharesB) {
    const shared = list[sharesA ? a : b].kendiYeri;
    const u = list[sharesA ? b : a].kendiYeri;
    const v = list[(sharesA ? a : b) === c ? d : c].kendiYeri;
    return orient(shared, u, v) === 0
      && (u.x - shared.x) * (v.x - shared.x) + (u.y - shared.y) * (v.y - shared.y) > 0;
  }
  const pa = list[a].kendiYeri, pb = list[b].kendiYeri, pc = list[c].kendiYeri, pd = list[d].kendiYeri;
  const within = (p, q, r) => Math.min(p.x, q.x) <= r.x && r.x <= Math.max(p.x, q.x)
    && Math.min(p.y, q.y) <= r.y && r.y <= Math.max(p.y, q.y);
  const o1 = orient(pa, pb, pc), o2 = orient(pa, pb, pd);
  const o3 = orient(pc, pd, pa), o4 = orient(pc, pd, pb);
  return (o1 !== o2 && o3 !== o4)
    || (o1 === 0 && within(pa, pb, pc)) || (o2 === 0 && within(pa, pb, pd))
    || (o3 === 0 && within(pc, pd, pa)) || (o4 === 0 && within(pc, pd, pb));
}

// Hamlenin eklediği üç kenar (AD, uç→P, uç→R) birbirini kesmemeli. Yukarıdaki iki test
// ray.triangles / triangle.rayKeys indeksine dayanır ve bu indeks bir pass içinde bayatlar:
// connectPoints yeniden üçgenlerken üçgen kimliklerini yeniden kullanır, hamleye dahil
// olmayan ışınları güncellemez. Kesişen bir hamle kabul edilirse AD'yi bağlayan
// connectPoints az önce eklenen tur kenarını mesh'ten siler; bag1/bag2 ile mesh ayrışır
// ve sonraki bir hamle turu bozar. Bu yüzden üç çift indeksten bağımsız, O(1) test edilir.
function koptAddedEdgesDisjoint(candidate, nodeA, nodeD, world, instrument = null) {
  const rayP = world.rays.get(candidate.rayIds[0]);
  const rayR = world.rays.get(candidate.rayIds[1]);
  if (!rayP || !rayR) return false;
  const edges = [[nodeA.noktaNo, nodeD.noktaNo], [rayP.p1No, rayP.p2No], [rayR.p1No, rayR.p2No]];
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      if (koptRouteEdgesCross(edges[i][0], edges[i][1], edges[j][0], edges[j][1], world)) {
        if (instrument) instrument.addedEdgeCrossRejectCount++;
        return false;
      }
    }
  }
  return true;
}

function koptCandidateGeometryValid(candidate, segInfo, nodeA, nodeD, adTriRays, world, instrument = null) {
  return koptCandidateRayGeometryValid(
    candidate, world, segInfo.first.noktaNo, segInfo.last.noktaNo, instrument)
    && koptCandidateAdGeometryValid(candidate, segInfo, nodeA, nodeD, adTriRays, world, instrument)
    && koptAddedEdgesDisjoint(candidate, nodeA, nodeD, world, instrument);
}

// a–b kenarı mesh'te devre dışı olmayan bir aralıkta tur kenarı (disKenar) olarak var mı?
function koptRouteEdgeInMesh(world, a, b) {
  for (const aralik of world.totalNoktaList[a].aralikList) {
    if (aralik.disabled) continue;
    const kenarNo = aralik.gidenUcNo === b ? aralik.ucgeniciGidenKenarNo
      : aralik.gelenUcNo === b ? aralik.ucgeniciGelenKenarNo
        : -1;
    if (kenarNo >= 0 && world.totalUcgenList[aralik.ucgenNo].kenarList[kenarNo].disKenar) return true;
  }
  return false;
}

function koptBagsLinked(nodeA, nodeB) {
  return nodeA.bag1 === nodeB.noktaNo || nodeA.bag2 === nodeB.noktaNo
    || nodeB.bag1 === nodeA.noktaNo || nodeB.bag2 === nodeA.noktaNo;
}

// Boş bag'e yazar; iki bag de doluysa yazmaz. Eskiden bag2'nin üstüne yazılıyordu ve
// kopmamış bir kenarın öbür ucu tek taraflı bağlı kalıyordu (asimetrik komşuluk).
function koptWriteBag(node, id) {
  if (node.bag1 == null) node.bag1 = id;
  else if (node.bag2 == null) node.bag2 = id;
  else return false;
  return true;
}

function koptFindFirstValidCandidate(candidates, score, isValid, instrument = null) {
  if (!candidates || candidates.size === 0) return null;
  const ordered = [...candidates.values()].sort((left, right) => {
    const scoreDelta = score(left) - score(right);
    return scoreDelta || left.ordinal - right.ordinal;
  });
  for (const candidate of ordered) {
    if (instrument) instrument.candidateValidationCount++;
    if (isValid(candidate)) return candidate;
  }
  return null;
}

function getVisibleEdgesBetween(n1, n2, world, excl, prevlength = Infinity, options = {}) {
  const vis1 = n1.visibleList;
  const vis2 = n2.visibleList;
  const id1 = n1.noktaNo;
  const id2 = n2.noktaNo;
  const instrument = options.instrument || null;
  const candidateIdentity = options.candidateIdentity ?? "legacy-sum";
  const deferGeometry = options.deferGeometry === true;
  const directRayLookup = options.directRayLookup ?? "point-index";

  const edges = new Map();
  const legacyIdentityOwners = new Map();
  let ordinal = 0;
  function tryEdge(u, v) {
    if (instrument) instrument.candidateProbeCount++;
    if (u === v) return;
    if (excl.has(u) || excl.has(v)) return;
    // İki farklı bakan noktayla görünen uçlar birbirlerine bağlı olmalı
    // Bağlanılmaya aday noktaların birbirleri arasında kenar olup olmadığı doğrulanıyor
    // Ancak gerek var mı, 
    if ((vis1.has(u) && vis2.has(v)) || (vis1.has(v) && vis2.has(u))) { 
    } else {
      return;
    }

    // -------- viewer & seen seçimi (viewerA ≠ viewerB şartlı) -----
    let viewerA,
      viewerB,
      seenA,
      seenB,
      matchFound = false;

    const n1SeesU = vis1.has(u),
      n1SeesV = vis1.has(v);
    const n2SeesU = vis2.has(u),
      n2SeesV = vis2.has(v);

    // bunları llm ekledi, u zaten n1'in listesinden geliyor
    // yukardaki koşul sayesinde zaten bağlı oldukları da doğrulanmış, gerek var mı ((vis1.has(u) && vis2.has(v)) || (vis1.has(v) && vis2.has(u)))
    if (n1SeesU && n2SeesV) {
      viewerA = id1;
      seenA = u;
      viewerB = id2;
      seenB = v;
      matchFound = true;
    }
    // 2) id1→v, id2→u ?
    else if (n1SeesV && n2SeesU) {
      viewerA = id1;
      seenA = v;
      viewerB = id2;
      seenB = u;
      matchFound = true;
    }

    if (!matchFound) return;
    if (instrument) instrument.candidateMatchCount++;

    const rayA = koptGetPointRay(world, viewerA, seenA, directRayLookup, instrument);
    const rayB = koptGetPointRay(world, viewerB, seenB, directRayLookup, instrument);
    if (!rayA || !rayB) return;
    const compA = rayA.key;
    const compB = rayB.key;
    const exactKey = koptCandidateIdentityKey(viewerA, seenA, viewerB, seenB);
    const legacyKey = compA + compB;
    const legacyOwner = legacyIdentityOwners.get(legacyKey);
    if (legacyOwner === undefined) legacyIdentityOwners.set(legacyKey, exactKey);
    else if (legacyOwner !== exactKey && instrument) instrument.legacyIdentityCollisionCount++;

    const key = candidateIdentity === "edge-pair" ? exactKey : legacyKey;
    // Çakışmasız kimlikte gerçek yinelenenler kesin geometri öncesi elenir. Eski
    // toplam anahtarı kontrol kolunda tarihsel doğrulama sırasını korur.
    if (candidateIdentity === "edge-pair" && edges.has(key)) {
      if (instrument) instrument.duplicateCandidateCount++;
      return;
    }

    const candidate = { rayIds: [compA, compB], ordinal: ordinal++, candidateId: exactKey };

    // ObjectOcc koridorları ayrık ise ışınlar geometrik olarak kesişemez. Yalnız ortak
    // üçgen taşıyan az sayıdaki çiftte kesin segment testi gerekir.
    if (!deferGeometry && !koptCandidateRayGeometryValid(candidate, world, id1, id2, instrument)) return;
    if (!edges.has(key)) edges.set(key, candidate);
    else if (instrument) instrument.duplicateCandidateCount++;
  }

  // -------------------------------------------------------------
  //  n1 ve n2’nin görünür listelerini tara
  // -------------------------------------------------------------
  function scan(vis) {
    for (const u of vis.keys()) {
      const nu = world.totalNoktaList[u];

      tryEdge(u, nu.bag1); // u-bag1
      tryEdge(u, nu.bag2); // u-bag2
    }
  }

  scan(vis1); // önce n1
  //scan(vis2);   // sonra n2

  return edges;
}
