const epsilon = 1e-6;
const isZero = (v, eps = epsilon) => Math.abs(v) <= eps;
function mesafeHesapla(nokta1, nokta2) {
    const hedefXFark = nokta1.x - nokta2.x;
    const hedefYFark = nokta1.y - nokta2.y;
    const hedefMesafe = Math.sqrt(hedefXFark * hedefXFark + hedefYFark * hedefYFark);
    return hedefMesafe;
}

function mesafeHesaplaKaresi(p1, p2) {
    const hedefXFark = p1.x - p2.x;
    const hedefYFark = p1.y - p2.y;
    // Math.pow(x, 2) yerine x * x kullanmak genellikle biraz daha hızlıdır.
    return hedefXFark * hedefXFark + hedefYFark * hedefYFark;
}

function pointsEqual(p1, p2) {
    return Math.abs(p1.x - p2.x) < epsilon && Math.abs(p1.y - p2.y) < epsilon;
}

function aciBul(nokta1, nokta2) {
    const hedefXFark = nokta1.x - nokta2.x;
    const hedefYFark = nokta1.y - nokta2.y;
    const hedefUzaklik = Math.sqrt(hedefXFark * hedefXFark + hedefYFark * hedefYFark);
    const hedefCos = hedefXFark / hedefUzaklik;
    const hedefSin = hedefYFark / hedefUzaklik;
    let tmpAci = Math.atan2(hedefSin, hedefCos * -1) * (180 / Math.PI);
    return tmpAci < 0 ? 360 + tmpAci : tmpAci;
}

function getAngle(gelenUc, ortaUc, gidenUc) {
    let angle = Math.atan2(
        crossProductLength(gelenUc.x, gelenUc.y, ortaUc.x, ortaUc.y, gidenUc.x, gidenUc.y),
        dotProduct(gelenUc.x, gelenUc.y, ortaUc.x, ortaUc.y, gidenUc.x, gidenUc.y)
    ) * (180 / Math.PI);
    return angle < 0 ? 360 + angle : angle;
}

function crossProductLength(Ax, Ay, Bx, By, Cx, Cy) {
    const BAx = Ax - Bx;
    const BAy = Ay - By;
    const BCx = Cx - Bx;
    const BCy = Cy - By;

    return BAx * BCy - BAy * BCx;
}

function dotProduct(Ax, Ay, Bx, By, Cx, Cy) {
    const BAx = Ax - Bx;
    const BAy = Ay - By;
    const BCx = Cx - Bx;
    const BCy = Cy - By;

    return BAx * BCx + BAy * BCy;
}

function projectPointOnLine(p, a, b) {

    const ab = { x: b.x - a.x, y: b.y - a.y };

    const ap = { x: p.x - a.x, y: p.y - a.y };

    const t = (ap.x * ab.x + ap.y * ab.y) / (ab.x * ab.x + ab.y * ab.y);

    return { x: a.x + t * ab.x, y: a.y + t * ab.y };
}

function areLinesParallel(a, b, c, d) {

    const ab = { x: b.x - a.x, y: b.y - a.y };

    const cd = { x: d.x - c.x, y: d.y - c.y };

    const cross = ab.x * cd.y - ab.y * cd.x;

    return Math.abs(cross) < epsilon;
}


// Çizgileri 1 boyutlu değil 2 boyutlu davranmaya zorlayarak bir çok kayan nokta derdinden kurtulunabilinir
// ve geometriyi bir ızgaraya oturtma sorunu da kalmaz
function pointToSegmentDistanceSquared(p, a, b) {
    const l2 = mesafeHesaplaKaresi(a, b); // Segment uzunluğunun karesi (mevcut yardımcı ile)
    if (isZero(l2)) { // Sıfır uzunluk kontrolü (mevcut yardımcı ile)
        return mesafeHesaplaKaresi(p, a); // Noktaya uzaklığın karesi
    }

    // projectPointOnLine fonksiyonundaki 't' hesaplama mantığını burada tekrar kullanalım.
    // t = dot(ap, ab) / dot(ab, ab) = dot(ap, ab) / l2
    // Vektörleri tanımla
    const ap_x = p.x - a.x;
    const ap_y = p.y - a.y;
    const ab_x = b.x - a.x;
    const ab_y = b.y - a.y;

    // Dot product (iç çarpım) hesapla
    const dot_ap_ab = ap_x * ab_x + ap_y * ab_y;

    // t parametresini hesapla ve [0, 1] aralığına kelepçele
    const t = Math.max(0, Math.min(1, dot_ap_ab / l2));

    // Segment üzerindeki en yakın noktayı bul
    const closestPoint = {
        x: a.x + t * ab_x,
        y: a.y + t * ab_y
    };

    // Nokta (p) ile segment üzerindeki en yakın nokta arasındaki mesafenin karesini döndür
    // (mevcut yardımcı ile)
    return mesafeHesaplaKaresi(p, closestPoint);
}

/**
 * Yeni oluşturulacak segmentin (segmentStartPoint -> segmentEndPointLoc),
 * mevcut diğer noktalara (segmentin başlangıç noktası hariç)
 * minimum mesafeden (minDistance) daha yakın olup olmadığını kontrol eder.
 * @param {Nokta} segmentStartPoint - Yeni segmentin başlangıç Nokta nesnesi.
 * @param {{x: number, y: number}} segmentEndPointLoc - Yeni segmentin bitiş noktasının konumu.
 * @param {World} world - World nesnesi.
 * @param {number} minDistance - Segmentin diğer noktalara olması gereken minimum uzaklık.
 * @returns {boolean} Segment tüm diğer noktalara yeterince uzaksa true, değilse false.
 */
function isNewSegmentFarEnoughFromPoints(segmentStartPoint, segmentEndPointLoc, world, minDistance) {
    const minDistanceSquared = minDistance * minDistance;
    const startPointLoc = segmentStartPoint.kendiYeri; // Başlangıç noktasının konumu

    // World içerisindeki tüm noktaları kontrol et
    for (const existingPoint of world.totalNoktaList) {
        // Kontrol edilen noktanın, yeni segmentin başlangıç noktası olup olmadığını kontrol et.
        // Eğer aynıysa, bu noktayı atla (çünkü segmente uzaklığı 0 olacaktır).
        if (existingPoint === segmentStartPoint) {
            continue;
        }

        const existingPointLoc = existingPoint.kendiYeri;

        // Mevcut noktanın (existingPointLoc), yeni segmente (startPointLoc -> segmentEndPointLoc)
        // olan en kısa mesafesinin karesini hesapla.
        const distSq = pointToSegmentDistanceSquared(existingPointLoc, startPointLoc, segmentEndPointLoc);

        // Eğer mesafe (karesi) minimumun karesinden küçükse, segment bir noktaya çok yakın demektir.
        if (distSq < minDistanceSquared) {
            console.warn(`Geçersiz Segment: Yeni segment [(${startPointLoc.x.toFixed(1)},${startPointLoc.y.toFixed(1)}) -> (${segmentEndPointLoc.x.toFixed(1)},${segmentEndPointLoc.y.toFixed(1)})] mevcut noktaya (${existingPointLoc.x.toFixed(1)},${existingPointLoc.y.toFixed(1)}) çok yakın (mesafe^2: ${distSq.toFixed(2)} < ${minDistanceSquared}).`);
            return false; // Yeterince uzak değil
        }
    }

    // Döngü bitti ve segmentin çok yakın olduğu bir nokta bulunmadı.
    return true; // Segment diğer noktalara yeterince uzak.
}

function consoleXml() {
    copyPoints();
}

function copyPoints() {
    const xmlEsc = linkedListXMLOutputXML(world, { escape: true });
    console.log(xmlEsc);
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(xmlEsc).catch(() => {});
    }
}

function pastePoints() {
    const xmlInput = document.getElementById('xmlInput');
    if (!xmlInput || !navigator.clipboard || !navigator.clipboard.readText) {
        return;
    }
    navigator.clipboard.readText()
        .then((text) => {
            xmlInput.value = String(text ?? '');
        })
        .catch(() => {});
}

function linkedListXMLOutputXML(world, { escape = false } = {}) {
    const totalNoktaList = world.totalNoktaList;
    const polygonList = world.polygonList;

    // Eğer escape = true ise & ve " karakterlerini XML uyumlu hale getiriyoruz
    const esc = (v) =>
        escape && typeof v === "string"
            ? v.replace(/&/g, "&amp;").replace(/"/g, "&quot;")
            : v;

    let rows = "";

    // Her bir Polygon nesnesini dolaşıyoruz
    polygonList.forEach((polygon) => {
        const polyNoktaIndices = polygon.polyNoktaList;
        if (!Array.isArray(polyNoktaIndices) || polyNoktaIndices.length === 0) {
            // Eğer bu poligonun nokta listesi boşsa atla
            return;
        }

        // İlk indeksi alıp, totalNoktaList içinden başlangıç nodunu çıkarıyoruz
        const startIndex = polyNoktaIndices[0];
        const startNode = totalNoktaList[startIndex];
        if (!startNode) return;

        // Bu poligonun bütün noktalarını traversePolygon ile XML satırlarına dönüştürüyoruz
        rows += traversePolygon(
            startNode,
            world,
            (acc, curr, next, step) => {
                const metric = curr.metricPosition || curr.kendiYeri;
                const exportedPointId = Number.isSafeInteger(curr.sourcePointId)
                    ? curr.sourcePointId
                    : curr.noktaNo;
                acc +=
                    `  <P ` +
                    `X="${esc(Math.round(curr.kendiYeri.x))}" ` +
                    `Y="${esc(Math.round(curr.kendiYeri.y))}" ` +
                    `MetricX="${esc(metric.x)}" ` +
                    `MetricY="${esc(metric.y)}" ` +
                    `PolyNo="${esc(curr.noktaPolyNo)}" ` +
                    `NoktaNo="${esc(exportedPointId)}" ` +
                    `/>\n`;
                return acc;
            },
            ""
        );
    });

    return `<Points>\n${rows}</Points>`;
}

/**
 * Aday noktanın (newLoc), belirtilen poligonun tüm mevcut kenarlarına
 * minimum mesafeden (minDistance) daha uzak olup olmadığını kontrol eder.
 * @param {{x: number, y: number}} newLoc - Aday yeni noktanın konumu.
 * @param {number} polyIndex - İncelenecek poligonun world.polygonList içindeki indeksi.
 * @param {World} world - World nesnesi.
 * @param {number} minDistance - Noktanın kenarlara olması gereken minimum uzaklık.
 * @returns {boolean} Nokta tüm kenarlara yeterince uzaksa true, değilse false.
 */
function isFarEnoughFromEdges(newLoc, polyIndex, world, minDistance) {
    if (polyIndex < 0 || polyIndex >= world.polygonList.length || !world.polygonList[polyIndex]) {
        return true; // Poligon yoksa kontrol anlamsız, geçerli say.
    }
    const polyPointsIndices = world.polygonList[polyIndex].polyNoktaList;
    if (polyPointsIndices.length < 2) {
        return true; // Kenar yoksa kontrol anlamsız, geçerli say.
    }

    const minDistanceSquared = minDistance * minDistance; // Karesiyle çalışmak daha verimli

    // Poligonun mevcut kenarları üzerinde döngü
    for (let i = 0; i < polyPointsIndices.length - 1; i++) {
        const p1Index = polyPointsIndices[i];
        const p2Index = polyPointsIndices[i + 1];

        // Kenar noktalarının geçerliliğini kontrol et (ekstra güvenlik)
        if (p1Index < 0 || p1Index >= world.totalNoktaList.length ||
            p2Index < 0 || p2Index >= world.totalNoktaList.length) {
            console.error(`isFarEnoughFromEdges: Geçersiz nokta index'i (${p1Index} veya ${p2Index})!`);
            continue; // Bu kenarı atla
        }

        const edgeStartPoint = world.totalNoktaList[p1Index].kendiYeri;
        const edgeEndPoint = world.totalNoktaList[p2Index].kendiYeri;

        // Noktanın kenara olan mesafesinin karesini hesapla
        // Çizgileri 1 boyutlu değil 2 boyutlu davranmaya zorlayarak bir çok kayan nokta derdinden kurtulunabilinir
        // ve geometriyi bir ızgaraya oturtma sorunu da kalmaz
        const distSq = pointToSegmentDistanceSquared(newLoc, edgeStartPoint, edgeEndPoint);

        // Eğer mesafe (karesi) minimumun karesinden küçükse, nokta çok yakın demektir.
        if (distSq < minDistanceSquared) {
            console.warn(`Geçersiz Nokta: Nokta ${JSON.stringify(newLoc)} kenara (${p1Index}-${p2Index}) çok yakın (mesafe^2: ${distSq} < ${minDistanceSquared}).`);
            return false; // Yeterince uzak değil
        }
    }

    // Döngü bitti ve hiçbir kenara çok yakın nokta bulunmadı.
    return true; // Nokta tüm kenarlara yeterince uzak.
}

/**
* Verilen konumun mevcut noktalara çok yakın olup olmadığını kontrol eder.
*/
function isTooClose(newLoc, points, minDistance, workMeter) {
    // points dizisinin Nokta nesneleri içerdiği varsayılıyor (kendiYeri özelliği var)
    // Optimized: Using squared distance to avoid expensive sqrt operations
    const minDistanceSquared = minDistance * minDistance;
    return points.some(nokta => {
        if (workMeter) workMeter.proximityTests = (workMeter.proximityTests || 0) + 1;
        return mesafeHesaplaKaresi(nokta.kendiYeri, newLoc) < minDistanceSquared;
    });
}

/**
 * Optimized distance comparison - avoids sqrt when possible
 * @param {Object} p1 - First point with x,y properties
 * @param {Object} p2 - Second point with x,y properties
 * @param {number} threshold - Distance threshold
 * @returns {boolean} True if distance is less than threshold
 */
function isWithinDistance(p1, p2, threshold) {
    return mesafeHesaplaKaresi(p1, p2) < threshold * threshold;
}

/**
 * Optimized distance comparison for "close to" checks
 * @param {Object} p1 - First point
 * @param {Object} p2 - Second point
 * @param {number} epsilon - Tolerance value
 * @returns {boolean} True if points are within epsilon distance
 */
function isPointsClose(p1, p2, epsilon) {
    return mesafeHesaplaKaresi(p1, p2) < epsilon * epsilon;
}


function triangleArea(p1, p2, p3) {
    const area = Math.abs(
        (p1.x * (p2.y - p3.y) +
         p2.x * (p3.y - p1.y) +
         p3.x * (p1.y - p2.y)) / 2
    );
    return area;
}

function fract(x) {
  return x - Math.floor(x);
}

function pseudoRandom01(n, salt) {
  const A = 12.9898, B = 78.233, C = 43758.5453;
  return fract(Math.sin((n + salt) * A + salt * B) * C);
}

function jitter(n, salt, decimals = 3) {
  const base  = 0.1;
  const range = 0.4;
  const r     = pseudoRandom01(n, salt);       // 0…1 arası
  const mag   = base + range * r;              // 0.1…0.5 arası
  const signed = (n % 2 === 0 ? +1 : -1) * mag; // işaret  

  return quantize(signed, decimals);
}

function jitteredXY(x, y, decimals = 3) {
  const jx = jitter(x, 0, decimals);
  const jy = jitter(y, 1, decimals);

  return {
    x: quantize(x + jx, decimals),
    y: quantize(y + jy, decimals)
  };
}

function revertJitter(value) {
  return Math.round(value);
}

function quantize(value, n) {
  const factor = Math.pow(10, n);  
  return Math.trunc(value * factor) / factor;
}

// =================================================================
// ÖNCEKİ FONKSİYONLAR VE YARDIMCILAR
// =================================================================

/** Noktasal çarpım hesaplayan yardımcı fonksiyon */
function dotProduct2(v1, v2) {
  return v1.x * v2.x + v1.y * v2.y;
}

/**
 * Verilen bir çizgiyi ve genişliği kullanarak bir dikdörtgenin 4 köşe noktasını hesaplar.
 * (Bu fonksiyon önceki cevaplarla aynıdır, bir değişiklik yoktur.)
 */
function createRectangleFromLine(p1, p2, width) {
  const halfWidth = width / 2;
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const length = Math.hypot(dx, dy);

  if (length === 0) {
    return { a: p1, b: p1, c: p1, d: p1 };
  }
  
  const normalX = -dy / length;
  const normalY = dx / length;
  const offsetX = normalX * halfWidth;
  const offsetY = normalY * halfWidth;

  const cornerA = { x: p1.x + offsetX, y: p1.y + offsetY };
  const cornerB = { x: p2.x + offsetX, y: p2.y + offsetY };
  const cornerC = { x: p2.x - offsetX, y: p2.y - offsetY };
  const cornerD = { x: p1.x - offsetX, y: p1.y - offsetY };

  return { a: cornerA, b: cornerB, c: cornerC, d: cornerD };
}


function isPointInRectangle(point, a, b, d, eps = 1e-10) {
  const ab_vector = { x: b.x - a.x, y: b.y - a.y };
  const ad_vector = { x: d.x - a.x, y: d.y - a.y };
  const ap_vector = { x: point.x - a.x, y: point.y - a.y };
  const proj_ap_on_ab = dotProduct2(ap_vector, ab_vector);
  const proj_ap_on_ad = dotProduct2(ap_vector, ad_vector);
  const rectWidthSquared = dotProduct2(ab_vector, ab_vector);
  const rectHeightSquared = dotProduct2(ad_vector, ad_vector);
  const isInX = (proj_ap_on_ab >= -eps) && (proj_ap_on_ab <= rectWidthSquared + eps);
  const isInY = (proj_ap_on_ad >= -eps) && (proj_ap_on_ad <= rectHeightSquared + eps);
  return isInX && isInY;
}

