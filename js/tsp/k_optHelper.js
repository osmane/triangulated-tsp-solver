function triPolygonPerimeter(start, limit) {

    const prev = world.totalNoktaList[start.bag1];
    const distance = traversePolygon(
        start,
        world,
        (acc, a, b) => acc + routeEdgeLengthRaw(a, b),
        0,
        limit,
        prev
    );

    return distance;
}

function triPolygonPerimeterTsplib(start, limit) {
    const prev = world.totalNoktaList[start.bag1];
    return traversePolygon(
        start,
        world,
        (acc, a, b) => acc + routeEdgeCost(a, b),
        0,
        limit,
        prev
    );
}

function triPolygonPerimeterRegular() {
    let totalLength = 0;
    let poly = world.polygonList[0].polyNoktaList;
    for (let i = 0; i < poly.length; i++) {
        let nextIndex = (i + 1) % poly.length;

        totalLength += routeEdgeLengthRaw(
            world.totalNoktaList[poly[i]],
            world.totalNoktaList[poly[nextIndex]]
        );
    }
    return totalLength;
}

//------ Yardımcı: Cantor 2→1 eşlemesi (53-bit güvenli) -----------------
function cantor(a, b) {
    const s = a + b;
    return ((s * (s + 1)) >>> 1) + b;
}

//------ Yardımcı: iki doğru parçası kesişiyor mu? ----------------------
function segmentsIntersect(viewerA, seenA, viewerB, seenB, world) {
    const kenar = { uc1NoktaNo: viewerA, uc2NoktaNo: seenA };
    const hangiNokta = world.totalNoktaList[viewerB];
    let finishNokta;
    if (Object.hasOwn(seenB, "x" )) {
        finishNokta = seenB;
    } else {
        finishNokta = world.totalNoktaList[seenB].kendiYeri;
    }
    const cevap = collKesisimHesapla(kenar, hangiNokta, finishNokta, 0.00000001, world.totalNoktaList);
    return cevap.durum > 1;         // 1 = uçta, 2 = içerde
}


function findShortestRay(mapInstance, score = value => value.delta ?? value.length) {

    if (!mapInstance || mapInstance.size === 0) {
        //console.log("Sağlanan Map (mapInstance) boş veya tanımsız.");
        return null;
    }

    let smallestLength = Infinity;
    let valueOfSmallestEntry = null;

    for (const [key, value] of mapInstance) {
        const candidateScore = score(value);
        if (candidateScore < smallestLength) {
            smallestLength = candidateScore;
            valueOfSmallestEntry = value;
        }
    }

    return valueOfSmallestEntry;
}

