/**
 *
 *
 * This system implements a custom triangulation algorithm specifically designed for
 * triangle-based occlusion and visibility calculations. It is NOT Delaunay triangulation.
 */

class World {
    // Private alanlar için `#` kullanıyoruz (ES2022+)

    //#closingPointNo = 0;
    #earKesisimKenarGidenUcgen = 0;
    #earKesisimKenarGelenUcgen = 0;
    //#backistikamet = 0;
    #gidenMuseumSonUcgen = 0;
    #aramailkNoktasi = null;

    constructor() {
        this.polygonList = [];
        this.totalNoktaList = [];
        this.totalUcgenList = [];
        this.tmpMuseumPolygonGiden = [];
        this.tmpMuseumPolygonGelen = [];
        this.museumPolygonGiden = [];
        this.museumPolygonGelen = [];
        this.istikametList = [];
        this.tmpUcgenList = [];
        this.poinLineIntList = [];
        this.cemberList = [];
        this.normalList = [];
        this.drectionList = [];
        
        this.sonBasilanNokta = new Nokta(this);
        this.picXMin = 1;
        this.picXMax = 1500;
        this.picYMin = 1;
        this.picYMax = 850;
        this.polyMoveEnabled = false;
        this.fatalError = false;
        this.collisionFound = false;
        this.moveEtkinGeo = new PointToAnswer();
        this.logImpacts = false;
        this.tmpSayac = 0;
        
        this.yenilenecekKenarlar = new Map();
        this.mouseSeciliAralik = 0;
        this.etkinGeo = new PointToAnswer();
        this.targetNokta = new Nokta(this);

        // Nokta oluşturma
        this.createNokta(this.picXMin, this.picYMin, [4, 3, 0, 2, 1, 0], [1, 4, 1, 1, 0, 2]);
        this.createNokta(this.picXMax, this.picYMin, [4, 0, 1, 2, 1, 0], [2, 4, 2, 1, 0, 2]);
        this.createNokta(this.picXMax, this.picYMax, [4, 1, 2, 2, 1, 0], [3, 4, 3, 1, 0, 2]);
        this.createNokta(this.picXMin, this.picYMax, [4, 2, 3, 2, 1, 0], [0, 4, 0, 1, 0, 2]);
        this.createNokta(40, 40, [3, 0, 0, 0, 2, 1], [0, 1, 1, 0, 2, 1], [1, 2, 2, 0, 2, 1], [2, 3, 3, 0, 2, 1]);

        // Üçgen oluşturma
        this.createUcgen([3, 0, -10, -10, 4, 0, 0], [0, 4, 1, 0, 3, 2, 1], [4, 3, 3, 0, 0, 1, 0]);
        this.createUcgen([0, 1, -20, -20, 4, 0, 1], [1, 4, 2, 0, 0, 2, 1], [4, 0, 0, 0, 1, 1, 0]);
        this.createUcgen([1, 2, -30, -30, 4, 0, 2], [2, 4, 3, 0, 1, 2, 1], [4, 1, 1, 0, 2, 1, 0]);
        this.createUcgen([2, 3, -40, -40, 4, 0, 3], [3, 4, 0, 0, 2, 2, 1], [4, 2, 2, 0, 3, 1, 0]);

        // Son işlemler
        this.sonBasilanNokta = this.totalNoktaList[this.totalNoktaList.length - 1];
        const p1 = new Polygon(this);
        p1.polyNoktaList.push(this.totalNoktaList.length - 1);
        this.polygonList.push(p1);
        this.activePolygon = this.polygonList[0];
        this.closingPointNo = 4;
        this.#aramailkNoktasi = this.totalNoktaList[0];
        this.#earKesisimKenarGidenUcgen = 0;
        this.#earKesisimKenarGelenUcgen = 0;
        this.#gidenMuseumSonUcgen = 0;
        this.backistikamet = 0;
        this.basaYakin = false;
        this.eskiCiz = true;
        this.earCiz = true;
        this.rays = new Map(); // Tüm ray (görünür bağlantılar), k-opt değişiklikleri sırasında nokta görünürlerini dinamik olarak set edebilmek için        
        // Point-to-point ObjectOcc rays, keyed by stable endpoint ids.  Geometry rays keep
        // their coordinate BigInt key in `rays`; this second sparse index makes visibility
        // and cached route-length lookups O(1) without rebuilding canonical coordinates.
        this.pointRayIndex = new Map();
        // Sparse TSPLIB edge-cost cache.  It grows only for edges actually considered by
        // the optimizer; unlike an n*n matrix it remains suitable for 4k-5k point routes.
        this.routeMetricCache = new Map();
        // Raw Euclidean metric cache used by optimizer decisions. TSPLIB costs remain in
        // routeMetricCache only for benchmark/report compatibility.
        this.routeRawMetricCache = new Map();
        this.projectionTasks = new UniqueQueue();
        this.edgeTasks = new UniqueQueue();
        this.lookAtTasks = new UniqueQueue();
        this.pocketTreeOverlay = null;
    }

    createNokta(x, y, ...araliklar) {
        const nokta = new Nokta(this);
        nokta.kendiYeri.x = x;
        nokta.kendiYeri.y = y;
        for (const [gidenUcNo, gelenUcNo, ucgenNo, karsiKenarNo, gidenKenarNo, gelenKenarNo] of araliklar) {
            const aralik = new Aralik(gidenUcNo, gelenUcNo, ucgenNo, karsiKenarNo, gidenKenarNo, gelenKenarNo);
            nokta.aralikList.push(aralik);
        }
        nokta.noktaNo = this.totalNoktaList.length;
        this.totalNoktaList.push(nokta);

        if ((nokta.noktaNo >= 0) && (nokta.noktaNo <= 3)) {
            nokta.bag1 = (nokta.noktaNo - 1 + 4) % 4;  // önceki
            nokta.bag2 = (nokta.noktaNo + 1) % 4;      // sonraki
        }

        return nokta;
    }

    createUcgen(...kenarlar) {
        const ucgen = new Ucgen(this);
        for (const [uc1NoktaNo, uc2NoktaNo, komsuNo, kenarPolyNo, karsiNoktaNo, komsudaKacinciKenarNo, karsiNoktaAralikNo] of kenarlar) {
            const kenar = new Kenar(uc1NoktaNo, uc2NoktaNo, komsuNo, kenarPolyNo, karsiNoktaNo, komsudaKacinciKenarNo, karsiNoktaAralikNo);
            ucgen.kenarList.push(kenar);
        }
        this.totalUcgenList.push(ucgen);
        return ucgen;
    }

    getCemberList() {
        return this.cemberList;
    }

    setCemberList(value) {
        this.cemberList = value;
    }

    get aramailkNoktasi() {
        return this.#aramailkNoktasi;
    }

    set aramailkNoktasi(value) {
        this.#aramailkNoktasi = value;
    }

    get earKesisimKenarGidenUcgen() {
        return this.#earKesisimKenarGidenUcgen;
    }

    set earKesisimKenarGidenUcgen(value) {
        // Gerekirse kontrol ekleyin
        this.#earKesisimKenarGidenUcgen = value;
    }

    get earKesisimKenarGelenUcgen() {
        return this.#earKesisimKenarGelenUcgen;
    }

    set earKesisimKenarGelenUcgen(value) {
        this.#earKesisimKenarGelenUcgen = value;
    }

    get gidenMuseumSonUcgen() {
        return this.#gidenMuseumSonUcgen;
    }

    set gidenMuseumSonUcgen(value) {
        this.#gidenMuseumSonUcgen = value;
    }
}

// KenarKey için bir yardımcı sınıf (Map anahtarı olarak kullanılabilir)
class KenarKey {
    constructor(uc1, uc2) {
        this.uc1 = uc1;
        this.uc2 = uc2;
    }

    toString() {
        return `${this.uc1}-${this.uc2}`;
    }
}

class Nokta {
    constructor(world) {
        this.world = world;
        this.totalNoktaList = world.totalNoktaList;
        this.polygonList = world.polygonList;
        this.aralikList = [];
        this.kendiYeri = { x: 0, y: 0 };
        // Route optimization coordinates. Geometry/mesh continues to use
        // kendiYeri, while TSPLIB EUC_2D costs use this unscaled position.
        this.metricPosition = null;
        this.turemis = false;
        this.disableList = [];
        this.noktaPolyNo = -1;
        this.noktaNo = world.totalNoktaList.length;
        // Stable identity from the input file. Unlike noktaNo, this must not
        // change when a route is reordered by k-opt/double bridge.
        this.sourcePointId = null;
        this.bag1 = null;
        this.bag2 = null;
        this.uzaklik = 0;
        this.minRotation = { x: 0, y: 0 };
        this.aci = 0;
        this.moving = { x: 0, y: 0 };
        this.oldMoving = { x: 0, y: 0 };
        this.moveKucult = false;
        this.aralikSayIlk = 0;
        this.movedaBasildi = false;
        this.noktaSilindi = false;
        this.silmeYontemi = 0;
        this.daraldi = false;
        this.darKarsi = new Kenar();
        this.siliniyor = 0;
        this.color = "black";
        this.connectibleNoktalar = new Set();
        this.relatedRays = new Set();
        this.invisibleList = new Set();
        this.visibleList = new Map();
        this.lookAtTasks = new UniqueQueue();
        /* 
        nokta.visibleList {integer, boolean} değerler alır, yani nokta no ve görünümün doğrudan/dolaylı olup olmadığı bilgisi,
        dolaylı olması demek sıralı LookAtNext kontrolünde değil, başka bir noktanın bakışı sırasında görünürlük sağlandığı anlamına gelir
        */
    }
}

class Ucgen {
    constructor(world) {
        this.totalNoktaList = world.totalNoktaList;
        this.kenarList = [];
        this.boya = false;
        this.girilenKenarNo = 0;
        this.cikilanKenarNo = 0;
        this.girisPoint = { x: 0, y: 0 };
        this.cikisPoint = { x: 0, y: 0 };
        this.dolu = false;
        this.islemGordu = false;
        this.doldurmaKenari = 0;
        this.disabled = false;
        this.ucgenPolyNo = -1;
        this.polyListSira = -1;
        this.polyEklendi = false;
        this.sonKontrolTick = 0;
        this.triCenter = { x: 0, y: 0 };
        this.area = 0;
        this.kendiNo = 0;
        this.rayKeys = new Set();
    }
}

class Kenar {
    constructor(uc1NoktaNo = 0, uc2NoktaNo = 0, komsuNo = 0, kenarPolyNo = -1, karsiNoktaNo = 0, komsudaKacinciKenarNo = 0, karsiNoktaAralikNo = 0) {
        this.uc1NoktaNo = uc1NoktaNo;
        this.uc2NoktaNo = uc2NoktaNo;
        this.komsuNo = komsuNo;
        this.komsudaKacinciKenarNo = komsudaKacinciKenarNo;
        this.karsiNoktaNo = karsiNoktaNo;
        this.karsiNoktaAralikNo = karsiNoktaAralikNo;
        // Varsayılan değer atamalarını setter üzerinden yapıyoruz:
        this.polyKenar = false;
        this.kenarPolyNo = kenarPolyNo;
        this.disKenar = false;
        this.karsiYakinlik = 0;
        this.impactNoktaNo = 0;
        this.angle = 0;
        this.kendiUcgeni = null;
        this.start = { x: 0, y: 0 };
        this.finish = { x: 0, y: 0 };
        this.kalem = null;
        this.yenile = false;
        this.projectionLoc = { x: 0, y: 0 };
        this.relatedRays = new Set();
        this.draw = null;
    }

    get polyKenar() {
        return this._polyKenar;
    }
    set polyKenar(value) {
        /*if (value === null || value === undefined) {
            this.triggerEvent('polyKenarNullEvent');
        }*/
        this._polyKenar = value;
    }

    get disKenar() {
        return this._disKenar;
    }
    set disKenar(value) {        
        this._disKenar = value;
    }

    /*triggerEvent(eventName) {
        console.log(`Olay tetiklendi: ${eventName}`, this);
    }*/

    clone() {
        return Object.assign(new Kenar(), this);
    }

    static fromKenar(kenar) {
        return kenar.clone();
    }

    isEqual(matchedKenar) {
        return matchedKenar.uc1NoktaNo === this.uc1NoktaNo && matchedKenar.uc2NoktaNo === this.uc2NoktaNo;
    }
}

class Polygon {
    #newPolyMoveHypo = 0;
    #polyMoveHypo = 0;
    #snapHypo = 0;
    #dumyNokta = { x: 0, y: 0 };
    #snapTarget = { x: 0, y: 0 };

    constructor(world) {
        this.world = world;
        this.totalUcgenList = world.totalUcgenList;
        this.totalNoktaList = world.totalNoktaList;
        this.poinLineIntList = world.poinLineIntList;
        this.normalList = world.normalList;
        this.drectionList = world.drectionList;
        this.polygonList = world.polygonList;
        this.polyNoktaList = [];
        this.ucgenList = [];
        this.polyPolyNo = world.polygonList?.length ?? 0;
        this.uzakliklar = [];
        this.polyMerkez = { x: 0, y: 0 };
        this.enUzakNokta = 0;
        this.enUzakMesafe = 0;
        this.enUzakMesafeX = 0;
        this.enUzakMesafeY = 0;
        this.moveKucult = false;
        this.polygonSilindi = false;
        this.mass = 1;
        this.totalArea = 1;
        this.velocityX = 0;
        this.velocityY = 0;
        this.velocityW = 0;
        this.newColl = null;
        this.oldColl = null;
        this.collisionFound = false;
        this.elasticity = 1;
        this.angle = 0;

        this.lineerpen = { color: "black", width: 1 };
        this.angularpen = { color: "red", width: 1 };
    }

}

class PointToAnswer {
    constructor() {
        this.ucgenNo = 0;
        this.poligonized = false;
        this.polyNo = 0;
        this.earSonUcgen = 0;
        this.durum = 0;
        this.daralma = false;
        this.sonKesilenDoluPoly = 0;
        this.onKesilenDoluPoly = 0;
        this.kesNok = { x: 0, y: 0 };
        this.oncekiDoluKenar = null;
        this.colledKenar = null;
        this.kesilenKenarSay = 0;
        this.ihlal = false;
        this.connected = true;
        this.ilKesilenDiskenar = null;
        this.karsiNokta = null;
        this.triangles = new Set();
        this.sifirKesisim = false;
        this.intervalId = 0;
    }
}

class Aralik {
    constructor(gidenUcNo = 0, gelenUcNo = 0, ucgenNo = 0, karsiKenarNo = 0, gidenKenarNo = 0, gelenKenarNo = 0) {
        this.gidenUcNo = gidenUcNo;
        this.gelenUcNo = gelenUcNo;
        this.ucgenNo = ucgenNo;
        this.ucgeniciGidenKenarNo = gidenKenarNo;
        this.ucgeniciGelenKenarNo = gelenKenarNo;
        this.ucgeniciKarsiKenarNo = karsiKenarNo;
        this.boya = false;
        this.disabled = false;
        this.izdusum = -1;
        this.gidenMesafe = 0;
        this.sonrakiGidenMesafe = 0;
        this.noktaNo = 0;
        this.polyMerkez = { x: 0, y: 0 };
    }

    clone() {
        return Object.assign(new Aralik(), this);
    }
}

class KesisimCevap {
    constructor() {
        this.durum = 0;             // Kesişim durumu (0: yok, 1: uçta, 2: içerde)
        this.kesisimNok = { x: 0, y: 0 }; // Kesişim noktası (PointF)
        this.uc1toKN = 0;           // Uc1’den kesişim noktasına mesafe
        this.uc2toKN = 0;           // Uc2’den kesişim noktasına mesafe
        this.kesenUzunlugu = 0;     // Kesici doğru parçasının uzunluğu
        this.kesisimUzakligi = 0;   // Başlangıç noktasından kesişime mesafe
        this.sifirKesisim = false;  // Paralel veya çakışık durum
    }
}

class Ray {
    constructor({
        p1Loc = { x: 0, y: 0 },
        p2Loc = { x: 0, y: 0 },
        p1No = -1,
        p2No = -1,
        triangles = [],
        key = null,
        projectFrom = null,
        length = 0,
        projEdgeTip1 = null,
        projEdgeTip2 = null,
        intervalId = null,
        metricLength = null,
        rawMetricLength = null,
    } = {}) {               // = {} → parametre hiç gelmezse de sorun çıkmasın
        this.p1Loc = p1Loc;
        this.p2Loc = p2Loc;
        this.p1No = p1No;
        this.p2No = p2No;
        this.triangles = triangles;
        this.key = key;
        this.projectFrom = projectFrom;
        this.length = length;
        this.projEdgeTip1 = projEdgeTip1,
        this.projEdgeTip2 = projEdgeTip2,
        this.intervalId = intervalId;
        this.metricLength = metricLength;
        this.rawMetricLength = rawMetricLength;
    }
}

class ListNode {
    constructor(key, item) {
        this.key = key;
        this.item = item;
        this.prev = null;
        this.next = null;
    }
}

class UniqueQueue {
    constructor() {
        this._map = new Map();    // key → node
        this._head = null;        // first node in queue
        this._tail = null;        // last node in queue
        this._length = 0;
        // Constructor: O(1)
    }

    /**
     * Kuyruğa ekleme veya mevcut anahtarı güncelleme
     * @param {*} item  Eklenecek veri
     * @param {number|string} key  Benzersiz anahtar
     * @returns {void}
     * Time Complexity: O(1)
     */
    enqueue(item, key) {
        if (this._map.has(key)) {
            // Mevcut anahtarın değerini güncelle – O(1)
            const node = this._map.get(key);
            node.item = item;
        } else {
            // Yeni node oluştur ve kuyruğa ekle – O(1)
            const node = new ListNode(key, item);
            if (!this._head) {
                this._head = this._tail = node;
            } else {
                this._tail.next = node;
                node.prev = this._tail;
                this._tail = node;
            }
            this._map.set(key, node);
            this._length++;
        }
    }

    /**
     * Baştan çıkarma
     * @returns {*} Çıkarılan öğe veya undefined
     * Time Complexity: O(1)
     */
    dequeue() {
        if (!this._head) return undefined; // O(1)
        const node = this._head;
        const { key, item } = node;
        if (this._head === this._tail) {
            this._head = this._tail = null;
        } else {
            this._head = node.next;
            this._head.prev = null;
        }
        this._map.delete(key); // O(1)
        this._length--;
        return item;
    }

    /**
     * Anahtara göre ortadaki bir elemanı çıkarma
     * @param {number|string} key
     * @returns {*} Çıkarılan öğe veya undefined
     * Time Complexity: O(1)
     */
    remove(key) {
        const node = this._map.get(key); // O(1)
        if (!node) return undefined;
        if (node.prev) node.prev.next = node.next;  // O(1)
        else this._head = node.next;
        if (node.next) node.next.prev = node.prev;  // O(1)
        else this._tail = node.prev;
        this._map.delete(key); // O(1)
        this._length--;
        return node.item;
    }

    /**
     * Anahtara göre ortadaki bir öğeyi okumak
     * @param {number|string} key
     * @returns {*} Okunan öğe veya undefined
     * Time Complexity: O(1)
     */
    get(key) {
        const node = this._map.get(key); // O(1)
        return node ? node.item : undefined;
    }

    /**
     * Baştaki öğeyi gözleme
     * @returns {*} Kuyruğun başındaki öğe veya undefined
     * Time Complexity: O(1)
     */
    peek() {
        return this._head ? this._head.item : undefined; // O(1)
    }

    /**
     * Boş mu?
     * @returns {boolean}
     * Time Complexity: O(1)
     */
    isEmpty() {
        return this._length === 0; // O(1)
    }

    /**
     * Kuyruktaki eleman sayısı
     * @returns {number}
     * Time Complexity: O(1)
     */
    size() {
        return this._length; // O(1)
    }
}

class FastDeque {
  constructor(capacity = 16) {
    this._cap  = this._nextPow2(capacity);
    this._mask = this._cap - 1;
    this._buf  = new Array(this._cap);
    this._head = 0;
    this._tail = 0;
    this._len  = 0;
  }

  /* ----- temel API ----- */
  push(v) {                     // sona ekle
    this._growIfFull();
    this._buf[this._tail] = v;
    this._tail = (this._tail + 1) & this._mask;
    ++this._len;
  }
  unshift(v) {                  // başa ekle
    this._growIfFull();
    this._head = (this._head - 1) & this._mask;
    this._buf[this._head] = v;
    ++this._len;
  }
  get length() { return this._len; }

  clear() {                     // O(1) – dizi elemanlarını “del” etmiyoruz
    this._head = this._tail = this._len = 0;
  }

  clone() {                     // aynı tipte boş yapıya tam kopya
    const d = new FastDeque(this._len);
    for (let i = 0; i < this._len; ++i) {
      d._buf[i] = this._buf[(this._head + i) & this._mask];
    }
    d._tail = d._len = this._len;
    return d;
  }

  /* ----- iç gereçler ----- */
  _growIfFull() {
    if (this._len < this._cap) return;
    const oldBuf = this._buf;
    this._cap <<= 1;
    this._mask = this._cap - 1;
    this._buf  = new Array(this._cap);
    for (let i = 0; i < this._len; ++i) {
      this._buf[i] = oldBuf[(this._head + i) & (oldBuf.length - 1)];
    }
    this._head = 0;
    this._tail = this._len;
  }
  _nextPow2(n) {                // 2ⁿ ≥ n
    let p = 1;
    while (p < n) p <<= 1;
    return p;
  }
}
