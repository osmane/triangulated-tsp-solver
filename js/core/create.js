function Ucgenle(PointKoord, EkranYenile, TargetNokta, CizilenPolygonNo, world) {
    let KesCev1 = new KesisimCevap();
    let KesCev2 = new KesisimCevap();
    let KesilenKenar = null;
    let KesilenKenar2 = null;
    let tmpKenar = null;
    let KomsuAktifKenar = null;
    let TmpKenarNo2 = 0;
    let KenarSay = 0;
    let BasaYakinlik = 0;
    let AralikSay = 0;
    let TmpKenarNo = 0;
    let KesNok = null;
    let tmpUcgen = null;
    let KomsuUcgen = null;
    let ActiveUcgenNo = 0;
    let ActiveNokta = null;
    let ActiveAralik = null;
    let PolyKomsu = null;
    let tmpPolyKenar = null;
    let KesPoint = { X: 0, Y: 0 };
    const totalNoktaList = world.totalNoktaList;
    const totalUcgenList = world.totalUcgenList;
    const polygonList = world.polygonList;
    let sonBasilanNokta = world.sonBasilanNokta;
    world.museumPolygonGiden = [];
    world.museumPolygonGelen = [];

    if (world.closingPointNo > 0) {
        // Optimized: Use squared distance comparison to avoid expensive sqrt operation
        if (mesafeHesaplaKaresi(PointKoord, totalNoktaList[world.closingPointNo].kendiYeri) < 25) { // 5*5 = 25
            BasaYakinlik = 5; // We know it's less than 5, so assign the threshold value or calculate if exact value is needed elsewhere
            world.basaYakin = true;
            TargetNokta.kendiYeri = totalNoktaList[world.closingPointNo].kendiYeri;
            PointKoord = totalNoktaList[world.closingPointNo].kendiYeri;
        } else {
            BasaYakinlik = mesafeHesapla(PointKoord, totalNoktaList[world.closingPointNo].kendiYeri);
            world.basaYakin = false;
        }
        world.eskiCiz = true;
    } else {
        world.eskiCiz = false;
        world.basaYakin = false;
    }

    let ModStart = 0;
    let ModKenarSay = 0;
    let KomsuUcgen0 = null;

    for (AralikSay = 0; AralikSay < sonBasilanNokta.aralikList.length; AralikSay++) {
        if (!sonBasilanNokta.aralikList[AralikSay].disabled) {
            if (PointKoord.x === totalNoktaList[sonBasilanNokta.aralikList[AralikSay].gidenUcNo].kendiYeri.x &&
                PointKoord.y === totalNoktaList[sonBasilanNokta.aralikList[AralikSay].gidenUcNo].kendiYeri.y ||
                PointKoord.x === totalNoktaList[sonBasilanNokta.aralikList[AralikSay].gelenUcNo].kendiYeri.x &&
                PointKoord.y === totalNoktaList[sonBasilanNokta.aralikList[AralikSay].gelenUcNo].kendiYeri.y) {
                if (world.closingPointNo > 0) {
                    world.eskiCiz = false;
                    world.earCiz = false;
                    const ucgen = totalUcgenList[sonBasilanNokta.aralikList[AralikSay].ucgenNo];
                    let kenar;
                    if (sonBasilanNokta.aralikList[AralikSay].gelenUcNo === world.closingPointNo) {
                        kenar = ucgen.kenarList[sonBasilanNokta.aralikList[AralikSay].ucgeniciGelenKenarNo];
                    } else if (sonBasilanNokta.aralikList[AralikSay].gidenUcNo === world.closingPointNo) {
                        kenar = ucgen.kenarList[sonBasilanNokta.aralikList[AralikSay].ucgeniciGidenKenarNo];
                    }
                    kenar.polyKenar = true;
                    kenar.disKenar = true;
                    kenar.kenarPolyNo = CizilenPolygonNo;
                    tmpPolyKenar = kenar;
                    PolyKomsu = totalUcgenList[tmpPolyKenar.komsuNo];
                    PolyKomsu.kenarList[tmpPolyKenar.komsudaKacinciKenarNo].polyKenar = true;
                    PolyKomsu.kenarList[tmpPolyKenar.komsudaKacinciKenarNo].disKenar = true;
                    PolyKomsu.kenarList[tmpPolyKenar.komsudaKacinciKenarNo].kenarPolyNo = CizilenPolygonNo;
                    break;
                }
            } else {
                ActiveUcgenNo = sonBasilanNokta.aralikList[AralikSay].ucgenNo;
                tmpUcgen = totalUcgenList[ActiveUcgenNo];
                tmpKenar = tmpUcgen.kenarList[sonBasilanNokta.aralikList[AralikSay].ucgeniciKarsiKenarNo];
                world.istikametList = [];
                KesNok = collKesisimHesapla(tmpKenar, sonBasilanNokta, TargetNokta.kendiYeri, 0, totalNoktaList);
                if (KesNok.durum > 0) {
                    if (KesNok.durum === 1) {
                        UcgenleKesnokDurum1(PointKoord, CizilenPolygonNo, tmpKenar, KenarSay, tmpUcgen, ActiveUcgenNo, ActiveNokta, ActiveAralik, PolyKomsu, tmpPolyKenar, KomsuUcgen0, world);
                    } else if (KesNok.durum === 2) {
                        UcgenleKesnokDurum2(PointKoord, TargetNokta, CizilenPolygonNo, KesCev1, KesCev2, KesilenKenar, KesilenKenar2, tmpKenar, KomsuAktifKenar, TmpKenarNo2, KenarSay, AralikSay, TmpKenarNo, KesNok, tmpUcgen, KomsuUcgen, ActiveUcgenNo, ActiveNokta, ActiveAralik, KesPoint, ModStart, ModKenarSay, KomsuUcgen0, world);
                    }
                    break;
                }
            }
        }
    }

    if (world.istikametList.length > 0) {
        const SonUcgen = totalUcgenList[world.istikametList[world.istikametList.length - 1]];
        if (!world.basaYakin) SonUcgen.girilenKenarNo = 0;

        const SonUcgenTepe = totalNoktaList[SonUcgen.kenarList[SonUcgen.girilenKenarNo].karsiNoktaNo];
        const SonUcgenTepeAra = SonUcgenTepe.aralikList[SonUcgen.kenarList[SonUcgen.girilenKenarNo].karsiNoktaAralikNo];
        const SonUcgenYan1 = totalNoktaList[SonUcgen.kenarList[SonUcgenTepeAra.ucgeniciGelenKenarNo].uc1NoktaNo];
        const SonUcgenYanAra1 = SonUcgenYan1.aralikList[SonUcgen.kenarList[SonUcgenTepeAra.ucgeniciGidenKenarNo].karsiNoktaAralikNo];
        const SonUcgenYan2 = totalNoktaList[SonUcgen.kenarList[SonUcgenTepeAra.ucgeniciGidenKenarNo].uc2NoktaNo];
        const SonUcgenYanAra2 = SonUcgenYan2.aralikList[SonUcgen.kenarList[SonUcgenTepeAra.ucgeniciGelenKenarNo].karsiNoktaAralikNo];

        if (world.earCiz) {
            if (polygonList[CizilenPolygonNo].polyNoktaList.length > 0) {
                for (KenarSay = 0; KenarSay <= 2; KenarSay++) {
                    const aralik = totalNoktaList[SonUcgen.kenarList[KenarSay].karsiNoktaNo].aralikList[SonUcgen.kenarList[KenarSay].karsiNoktaAralikNo];
                    if (!aralik.disabled) {
                        aralik.disabled = true;
                        totalNoktaList[SonUcgen.kenarList[KenarSay].karsiNoktaNo].disableList.push(SonUcgen.kenarList[KenarSay].karsiNoktaAralikNo);
                    }
                }
            }
            if (SonUcgen.kenarList[SonUcgenTepeAra.ucgeniciGelenKenarNo].uc1NoktaNo === world.museumPolygonGiden[world.museumPolygonGiden.length - 1].uc2NoktaNo) {
                world.museumPolygonGiden.push(SonUcgen.kenarList[SonUcgenTepeAra.ucgeniciGelenKenarNo]);
            }
            const GidenSonKenar = new Kenar();
            //Buradan itibaren world.museumPolygonGiden ve world.museumPolygonGelen referansları çalışmıyordu, sebebini anlamadım.
            if (world.museumPolygonGiden[world.museumPolygonGiden.length - 1].uc1NoktaNo !== world.museumPolygonGiden[world.museumPolygonGiden.length - 1].uc2NoktaNo &&
                world.museumPolygonGiden[world.museumPolygonGiden.length - 1].uc2NoktaNo !== world.museumPolygonGiden[0].uc1NoktaNo) {
                GidenSonKenar.uc1NoktaNo = world.museumPolygonGiden[world.museumPolygonGiden.length - 1].uc2NoktaNo;
                GidenSonKenar.uc2NoktaNo = world.museumPolygonGiden[0].uc1NoktaNo;
                GidenSonKenar.polyKenar = true;
                GidenSonKenar.disKenar = true;
                GidenSonKenar.kenarPolyNo = CizilenPolygonNo;
                GidenSonKenar.komsudaKacinciKenarNo = 2;
                world.museumPolygonGiden.push(GidenSonKenar);
            }
            world.tmpMuseumPolygonGiden = [...world.museumPolygonGiden];
            world.tmpUcgenList = [];

            if (world.museumPolygonGelen[0].uc1NoktaNo !== SonUcgen.kenarList[SonUcgenTepeAra.ucgeniciGidenKenarNo].uc1NoktaNo &&
                world.museumPolygonGelen[0].uc2NoktaNo !== SonUcgen.kenarList[SonUcgenTepeAra.ucgeniciGidenKenarNo].uc2NoktaNo) {
                world.museumPolygonGelen.unshift(SonUcgen.kenarList[SonUcgenTepeAra.ucgeniciGidenKenarNo]);
            }
            const GelenSonKenar = new Kenar();
            GelenSonKenar.uc1NoktaNo = GidenSonKenar.uc2NoktaNo;
            GelenSonKenar.uc2NoktaNo = GidenSonKenar.uc1NoktaNo;
            GelenSonKenar.komsudaKacinciKenarNo = 2;
            GelenSonKenar.polyKenar = true;
            GelenSonKenar.disKenar = true;
            GelenSonKenar.kenarPolyNo = CizilenPolygonNo;
            world.museumPolygonGelen.push(GelenSonKenar);
            tmpMuseumPolygonGelen = [...world.museumPolygonGelen];

            EarClipping(world.museumPolygonGiden, true, 0, 0, CizilenPolygonNo, world);
            EarClipping(world.museumPolygonGelen, false, 0, 0, CizilenPolygonNo, world);
        }
    }

    sonBasilanNokta = totalNoktaList[totalNoktaList.length - 1];
    world.sonBasilanNokta = sonBasilanNokta;
    world.eskiCiz = true;

    if (world.basaYakin) {

        totalNoktaList[world.closingPointNo].noktaPolyNo = polygonList.length - 1;
        totalNoktaList[world.closingPointNo].noktaNo = totalNoktaList.length;
        totalNoktaList.push(totalNoktaList[world.closingPointNo]);
        world.closingPointNo = totalNoktaList.length - 1;

        SelectPolyGons(world);

        const PolyilkNokta = totalNoktaList[polygonList[polygonList.length - 2].polyNoktaList[0]];
        const PolySonNokta = totalNoktaList[totalNoktaList.length - 1];
        PolyilkNokta.noktaNo = polygonList[polygonList.length - 2].polyNoktaList[0];        

        for (AralikSay = 0; AralikSay < PolyilkNokta.aralikList.length; AralikSay++) {
            const PolySonAralik = PolySonNokta.aralikList[AralikSay];
            const PolySonUcgen = totalUcgenList[PolySonAralik.ucgenNo];
            const PolySonKenar = PolySonUcgen.kenarList[PolySonAralik.ucgeniciKarsiKenarNo];
            const PolyilkAralik = PolyilkNokta.aralikList[AralikSay];
            const PolyilkUcgen = totalUcgenList[PolyilkAralik.ucgenNo];
            const PolyilkKenar = PolyilkUcgen.kenarList[PolyilkAralik.ucgeniciKarsiKenarNo];

            PolySonKenar.karsiNoktaNo = PolyilkKenar.karsiNoktaNo;
            for (KenarSay = 0; KenarSay <= 2; KenarSay++) {
                const PolyNextKenar = PolyilkUcgen.kenarList[KenarSay];
                if (PolyNextKenar.uc1NoktaNo === PolySonNokta.noktaNo) PolyNextKenar.uc1NoktaNo = PolyilkNokta.noktaNo;
                if (PolyNextKenar.uc2NoktaNo === PolySonNokta.noktaNo) PolyNextKenar.uc2NoktaNo = PolyilkNokta.noktaNo;
                const PolyNextNokta = totalNoktaList[PolyNextKenar.karsiNoktaNo];
                const PolyNextAralik = PolyNextNokta.aralikList[PolyNextKenar.karsiNoktaAralikNo];
                if (PolyNextAralik.gelenUcNo === PolySonNokta.noktaNo) PolyNextAralik.gelenUcNo = PolyilkNokta.noktaNo;
                if (PolyNextAralik.gidenUcNo === PolySonNokta.noktaNo) PolyNextAralik.gidenUcNo = PolyilkNokta.noktaNo;
            }
        }
        PolySonNokta.noktaNo = PolyilkNokta.noktaNo;
        totalNoktaList.pop(); // removes the last element
        let prevPoly = polygonList[polygonList.length - 2];
        PolyilkNokta.bag1 = totalNoktaList.length - 1;
        totalNoktaList[prevPoly.polyNoktaList[prevPoly.polyNoktaList.length - 1]].bag2 = prevPoly.polyNoktaList[0];        
        world.closingPointNo = 0;
        world.earCiz = false;
    } else {
        world.earCiz = true;
    }

    world.aramailkNoktasi = sonBasilanNokta;
}

function UcgenleKesnokDurum2(PointKoord, TargetNokta, CizilenPolygonNo, KesCev1, KesCev2, KesilenKenar, KesilenKenar2, tmpKenar, KomsuAktifKenar, TmpKenarNo2, KenarSay, AralikSay, TmpKenarNo, KesNok, tmpUcgen, KomsuUcgen, ActiveUcgenNo, ActiveNokta, ActiveAralik, KesPoint, ModStart, ModKenarSay, KomsuUcgen0, world) {
    let totalNoktaList = world.totalNoktaList;
    let totalUcgenList = world.totalUcgenList;
    let polygonList = world.polygonList;
    let sonBasilanNokta = world.sonBasilanNokta;
    let kendiYeriler = [];

    world.istikametList.push(ActiveUcgenNo);
    tmpUcgen.cikisPoint.x = KesNok.kesisimNok.x;
    tmpUcgen.cikisPoint.y = KesNok.kesisimNok.y;
    tmpUcgen.cikilanKenarNo = sonBasilanNokta.aralikList[AralikSay].ucgeniciKarsiKenarNo;
    /*if (!tmpKenar || (tmpKenar?.komsudaKacinciKenarNo == undefined) || tmpKenar.komsudaKacinciKenarNo == null) {
        console.log("tam burda sıçtık patron");
    }
    if (!tmpKenar || (tmpKenar?.komsuNo == undefined) || totalUcgenList[tmpKenar.komsuNo] == undefined) {
        console.log("tam burda sıçtık patron");
    }*/
    if (totalUcgenList[tmpKenar.komsuNo]?.girilenKenarNo == undefined) {
        console.log("tam burda sıçtık patron");
        world.totalNoktaList.forEach((nokta,) => {
            kendiYeriler.push(nokta.kendiYeri);
        });
    }
    totalUcgenList[tmpKenar.komsuNo].girilenKenarNo = tmpKenar.komsudaKacinciKenarNo;
    totalUcgenList[tmpKenar.komsuNo].girisPoint = tmpUcgen.cikisPoint;
    world.museumPolygonGiden.push(tmpUcgen.kenarList[sonBasilanNokta.aralikList[AralikSay].ucgeniciGidenKenarNo]);

    if (polygonList[CizilenPolygonNo].polyNoktaList.length > 0) {
        for (KenarSay = 0; KenarSay <= 2; KenarSay++) {
            const aralik = totalNoktaList[tmpUcgen.kenarList[KenarSay].karsiNoktaNo].aralikList[tmpUcgen.kenarList[KenarSay].karsiNoktaAralikNo];
            if (!aralik.disabled) {
                aralik.disabled = true;
                totalNoktaList[tmpUcgen.kenarList[KenarSay].karsiNoktaNo].disableList.push(tmpUcgen.kenarList[KenarSay].karsiNoktaAralikNo);
            }
        }
    }
    world.museumPolygonGelen.unshift(tmpUcgen.kenarList[sonBasilanNokta.aralikList[AralikSay].ucgeniciGelenKenarNo]);
    KesPoint.x = tmpUcgen.cikisPoint.x;
    KesPoint.y = tmpUcgen.cikisPoint.y;

    while (true) {
        if (tmpKenar.komsuNo >= 0) {
            KomsuUcgen = totalUcgenList[tmpKenar.komsuNo];
            KomsuAktifKenar = KomsuUcgen.kenarList[tmpKenar.komsudaKacinciKenarNo];
            KomsuUcgen.boya = true;

            if (tmpKenar.polyKenar) {
                console.warn("self intersection on:", KesPoint);
                ActiveUcgenNo = tmpKenar.komsuNo;
                const tmpsonBasilanNokta = new Nokta(world);
                tmpsonBasilanNokta.kendiYeri.x = KesPoint.x;
                tmpsonBasilanNokta.kendiYeri.y = KesPoint.y;
                tmpKenar.polyKenar = false;
                tmpKenar.disKenar = false;

                const KendiniKesmeNoktasi = new Nokta(world);
                KendiniKesmeNoktasi.kendiYeri.x = KesPoint.x;
                KendiniKesmeNoktasi.kendiYeri.y = KesPoint.y;
                KendiniKesmeNoktasi.noktaPolyNo = polygonList.length - 1;
                KendiniKesmeNoktasi.turemis = true;
                KendiniKesmeNoktasi.noktaNo = totalNoktaList.length;
                /*KendiniKesmeNoktasi.bag1 = totalNoktaList.length - 1;
                totalNoktaList[KendiniKesmeNoktasi.bag1].bag2 = KendiniKesmeNoktasi.noktaNo;*/
                totalNoktaList.push(KendiniKesmeNoktasi);
                polygonList[polygonList.length - 1].polyNoktaList.push(totalNoktaList.length - 1);

                const KesilenGidenKenar = new Kenar();
                KesilenGidenKenar.uc1NoktaNo = world.museumPolygonGiden[world.museumPolygonGiden.length - 1].uc2NoktaNo;
                KesilenGidenKenar.uc2NoktaNo = totalNoktaList.length - 1;
                KesilenGidenKenar.polyKenar = true;
                KesilenGidenKenar.disKenar = true;
                KesilenGidenKenar.kenarPolyNo = CizilenPolygonNo;
                KesilenGidenKenar.komsuNo = -5;
                world.museumPolygonGiden.push(KesilenGidenKenar);

                const GidenSonKenar = new Kenar();
                GidenSonKenar.uc1NoktaNo = world.museumPolygonGiden[world.museumPolygonGiden.length - 1].uc2NoktaNo;
                GidenSonKenar.uc2NoktaNo = world.museumPolygonGiden[0].uc1NoktaNo;
                GidenSonKenar.polyKenar = true;
                GidenSonKenar.disKenar = true;
                GidenSonKenar.kenarPolyNo = CizilenPolygonNo;
                GidenSonKenar.komsudaKacinciKenarNo = 2;
                world.museumPolygonGiden.push(GidenSonKenar);

                const KesilenGelenKenar = new Kenar();
                KesilenGelenKenar.uc1NoktaNo = totalNoktaList.length - 1;
                KesilenGelenKenar.uc2NoktaNo = world.museumPolygonGelen[0].uc1NoktaNo;
                KesilenGelenKenar.polyKenar = true;
                KesilenGelenKenar.disKenar = true;
                KesilenGelenKenar.kenarPolyNo = CizilenPolygonNo;
                KesilenGelenKenar.komsuNo = -5;
                world.museumPolygonGelen.unshift(KesilenGelenKenar);

                const GelenSonKenar = new Kenar();
                GelenSonKenar.uc1NoktaNo = world.museumPolygonGelen[world.museumPolygonGelen.length - 1].uc2NoktaNo;
                GelenSonKenar.uc2NoktaNo = KesilenGelenKenar.uc1NoktaNo;
                GelenSonKenar.komsudaKacinciKenarNo = 2;
                GelenSonKenar.polyKenar = true;
                GelenSonKenar.disKenar = true;
                GelenSonKenar.kenarPolyNo = CizilenPolygonNo;
                world.museumPolygonGelen.push(GelenSonKenar);

                EarClipping(world.museumPolygonGiden, true, 0, 0, CizilenPolygonNo, world);
                EarClipping(world.museumPolygonGelen, false, 0, 0, CizilenPolygonNo, world);
                world.museumPolygonGiden = [];
                world.museumPolygonGelen = [];

                const trsKesilenGidenKenar = new Kenar();
                trsKesilenGidenKenar.uc1NoktaNo = KesilenGidenKenar.uc2NoktaNo;
                trsKesilenGidenKenar.uc2NoktaNo = KesilenGidenKenar.uc1NoktaNo;
                trsKesilenGidenKenar.polyKenar = true;
                trsKesilenGidenKenar.disKenar = true;
                trsKesilenGidenKenar.kenarPolyNo = CizilenPolygonNo;
                trsKesilenGidenKenar.komsuNo = world.earKesisimKenarGidenUcgen;
                trsKesilenGidenKenar.komsudaKacinciKenarNo = totalUcgenList[world.earKesisimKenarGidenUcgen].cikilanKenarNo;
                world.museumPolygonGiden.push(trsKesilenGidenKenar);

                const trsKesilenGelenKenar = new Kenar();
                trsKesilenGelenKenar.uc1NoktaNo = KesilenGelenKenar.uc2NoktaNo;
                trsKesilenGelenKenar.uc2NoktaNo = KesilenGelenKenar.uc1NoktaNo;
                trsKesilenGelenKenar.polyKenar = true;
                trsKesilenGelenKenar.disKenar = true;
                trsKesilenGelenKenar.kenarPolyNo = CizilenPolygonNo;
                trsKesilenGelenKenar.komsuNo = world.earKesisimKenarGelenUcgen;
                trsKesilenGelenKenar.komsudaKacinciKenarNo = totalUcgenList[world.earKesisimKenarGelenUcgen].cikilanKenarNo;
                world.museumPolygonGelen.unshift(trsKesilenGelenKenar);

                world.tmpMuseumPolygonGiden = [...world.museumPolygonGiden];
                world.tmpMuseumPolygonGelen = [...world.museumPolygonGelen];
                world.istikametList = [];
            }

            world.istikametList.push(tmpKenar.komsuNo);
            totalUcgenList[tmpKenar.komsuNo].girilenKenarNo = tmpKenar.komsudaKacinciKenarNo;
            totalUcgenList[tmpKenar.komsuNo].girisPoint = KomsuUcgen.cikisPoint;

            TmpKenarNo = (tmpKenar.komsudaKacinciKenarNo + 1) % 3;
            TmpKenarNo2 = (tmpKenar.komsudaKacinciKenarNo + 2) % 3;
            KesilenKenar = KomsuUcgen.kenarList[TmpKenarNo];
            KesilenKenar2 = KomsuUcgen.kenarList[TmpKenarNo2];
            KesCev1 = collKesisimHesapla(KesilenKenar, sonBasilanNokta, TargetNokta.kendiYeri, 0, totalNoktaList);
            KesCev2 = collKesisimHesapla(KesilenKenar2, sonBasilanNokta, TargetNokta.kendiYeri, 0, totalNoktaList);

            if (KesCev1.durum === 2) {
                KomsuUcgen.cikisPoint.x = KesCev1.kesisimNok.x;
                KomsuUcgen.cikisPoint.y = KesCev1.kesisimNok.y;
                KomsuUcgen.cikilanKenarNo = TmpKenarNo;
                tmpKenar = KesilenKenar;
                KesPoint.x = KesCev1.kesisimNok.x;
                KesPoint.y = KesCev1.kesisimNok.y;
            } else if (KesCev2.durum === 2) {
                KomsuUcgen.cikisPoint.x = KesCev2.kesisimNok.x;
                KomsuUcgen.cikisPoint.y = KesCev2.kesisimNok.y;
                KomsuUcgen.cikilanKenarNo = TmpKenarNo2;
                tmpKenar = KesilenKenar2;
                TmpKenarNo = TmpKenarNo2;
                KesPoint.x = KesCev2.kesisimNok.x;
                KesPoint.y = KesCev2.kesisimNok.y;
            } else {
                break;
            }

            if (KomsuUcgen.kenarList[KomsuUcgen.cikilanKenarNo].karsiNoktaNo === world.museumPolygonGiden[world.museumPolygonGiden.length - 1].uc2NoktaNo) {
                world.museumPolygonGiden.push(KomsuUcgen.kenarList[(KomsuUcgen.cikilanKenarNo + 2) % 3]);
            } else {
                world.museumPolygonGelen.unshift(KomsuUcgen.kenarList[(KomsuUcgen.cikilanKenarNo + 1) % 3]);
            }

            if (polygonList[CizilenPolygonNo].polyNoktaList.length > 0) {
                for (KenarSay = 0; KenarSay <= 2; KenarSay++) {
                    const aralik = totalNoktaList[KomsuUcgen.kenarList[KenarSay].karsiNoktaNo].aralikList[KomsuUcgen.kenarList[KenarSay].karsiNoktaAralikNo];
                    if (!aralik.disabled) {
                        aralik.disabled = true;
                        totalNoktaList[KomsuUcgen.kenarList[KenarSay].karsiNoktaNo].disableList.push(KomsuUcgen.kenarList[KenarSay].karsiNoktaAralikNo);
                    }
                }
            }

            if (isPointsClose(KesPoint, PointKoord, epsilon)) {
                break;
            }
        } else {
            return;
        }
    }

    tmpUcgen = totalUcgenList[tmpKenar.komsuNo];
    ActiveUcgenNo = tmpKenar.komsuNo;
    ModStart = tmpKenar.komsudaKacinciKenarNo;
    tmpKenar = tmpUcgen.kenarList[ModStart];

    if (world.eskiCiz || world.closingPointNo === 0) {
        if (!world.basaYakin) {
            const YenisonBasilanNokta = new Nokta(world);
            YenisonBasilanNokta.kendiYeri = PointKoord;
            const TmpUcgenList = [];

            for (KenarSay = ModStart; KenarSay <= ModStart + 2; KenarSay++) {
                ModKenarSay = KenarSay % 3;
                tmpKenar = tmpUcgen.kenarList[ModKenarSay];
                ActiveNokta = totalNoktaList[tmpKenar.karsiNoktaNo];
                ActiveAralik = ActiveNokta.aralikList[tmpKenar.karsiNoktaAralikNo];

                ActiveAralik.gidenUcNo = totalNoktaList.length;
                ActiveAralik.ucgeniciGelenKenarNo = 0;
                ActiveAralik.ucgeniciGidenKenarNo = 1;
                ActiveAralik.ucgeniciKarsiKenarNo = 2;
                if (KenarSay !== ModStart + 2) {
                    ActiveAralik.ucgenNo = totalUcgenList.length + (KenarSay - ModStart);
                }

                const YeniAralik = new Aralik();
                YeniAralik.gelenUcNo = totalNoktaList.length;
                YeniAralik.gidenUcNo = tmpKenar.uc1NoktaNo;
                YeniAralik.ucgeniciGelenKenarNo = 2;
                YeniAralik.ucgeniciGidenKenarNo = 0;
                YeniAralik.ucgeniciKarsiKenarNo = 1;
                switch (KenarSay - ModStart) {
                    case 0: YeniAralik.ucgenNo = totalUcgenList.length + 1; break;
                    case 1: YeniAralik.ucgenNo = ActiveUcgenNo; break;
                    case 2: YeniAralik.ucgenNo = totalUcgenList.length; break;
                }
                ActiveNokta.aralikList.push(YeniAralik);

                const icYeniAralik = new Aralik();
                icYeniAralik.gelenUcNo = tmpKenar.uc2NoktaNo;
                icYeniAralik.gidenUcNo = tmpKenar.uc1NoktaNo;
                icYeniAralik.ucgeniciGelenKenarNo = 1;
                icYeniAralik.ucgeniciGidenKenarNo = 2;
                icYeniAralik.ucgeniciKarsiKenarNo = 0;
                if (ModKenarSay !== ModStart) {
                    icYeniAralik.ucgenNo = totalUcgenList.length + (KenarSay - ModStart) - 1;
                } else if (ModKenarSay === ModStart) {
                    icYeniAralik.ucgenNo = ActiveUcgenNo;
                }
                YenisonBasilanNokta.aralikList.push(icYeniAralik);

                if (tmpKenar.komsuNo > -1) {
                    KomsuUcgen0 = totalUcgenList[tmpKenar.komsuNo];
                    if (ModKenarSay !== ModStart) {
                        KomsuUcgen0.kenarList[tmpKenar.komsudaKacinciKenarNo].komsuNo = totalUcgenList.length + (KenarSay - ModStart) - 1;
                        KomsuUcgen0.kenarList[tmpKenar.komsudaKacinciKenarNo].komsudaKacinciKenarNo = 0;
                    }
                    if (world.closingPointNo === 0) {
                        KomsuUcgen0.kenarList[tmpKenar.komsudaKacinciKenarNo].komsudaKacinciKenarNo = 0;
                    }
                }

                const YeniUcgen = new Ucgen(world);
                const YeniKenar0 = new Kenar();
                YeniKenar0.uc1NoktaNo = tmpKenar.uc1NoktaNo;
                YeniKenar0.uc2NoktaNo = tmpKenar.uc2NoktaNo;
                YeniKenar0.komsuNo = tmpKenar.komsuNo;
                YeniKenar0.karsiNoktaNo = totalNoktaList.length;
                YeniKenar0.komsudaKacinciKenarNo = tmpKenar.komsudaKacinciKenarNo;
                YeniKenar0.karsiNoktaAralikNo = KenarSay - ModStart;
                YeniKenar0.polyKenar = tmpKenar.polyKenar;
                YeniKenar0.disKenar = tmpKenar.polyKenar;
                YeniKenar0.kenarPolyNo = tmpKenar.kenarPolyNo;
                YeniUcgen.kenarList.push(YeniKenar0);

                const YeniKenar1 = new Kenar();
                YeniKenar1.uc1NoktaNo = tmpKenar.uc2NoktaNo;
                YeniKenar1.uc2NoktaNo = totalNoktaList.length;
                switch (KenarSay - ModStart) {
                    case 0: YeniKenar1.komsuNo = totalUcgenList.length; break;
                    case 1: YeniKenar1.komsuNo = totalUcgenList.length + 1; break;
                    case 2: YeniKenar1.komsuNo = ActiveUcgenNo; break;
                }
                YeniKenar1.karsiNoktaNo = tmpKenar.uc1NoktaNo;
                YeniKenar1.komsudaKacinciKenarNo = 2;
                YeniKenar1.karsiNoktaAralikNo = totalNoktaList[YeniKenar1.karsiNoktaNo].aralikList.length - (((KenarSay - ModStart) * ((KenarSay - ModStart) - 1)) * 0.5);
                YeniKenar1.polyKenar = false;
                YeniKenar1.disKenar = false;
                YeniUcgen.kenarList.push(YeniKenar1);

                const YeniKenar2 = new Kenar();
                YeniKenar2.uc1NoktaNo = totalNoktaList.length;
                YeniKenar2.uc2NoktaNo = tmpKenar.uc1NoktaNo;
                switch (KenarSay - ModStart) {
                    case 0: YeniKenar2.komsuNo = totalUcgenList.length + 1; break;
                    case 1: YeniKenar2.komsuNo = ActiveUcgenNo; break;
                    case 2: YeniKenar2.komsuNo = totalUcgenList.length; break;
                }
                YeniKenar2.karsiNoktaNo = tmpKenar.uc2NoktaNo;
                YeniKenar2.komsudaKacinciKenarNo = 1;
                YeniKenar2.karsiNoktaAralikNo = tmpUcgen.kenarList[((Math.pow(ModKenarSay + 1, ModKenarSay) + 1) % 3)].karsiNoktaAralikNo;
                YeniKenar2.polyKenar = false;
                YeniKenar2.disKenar = false;
                YeniUcgen.kenarList.push(YeniKenar2);
                TmpUcgenList.push(YeniUcgen);
            }

            YenisonBasilanNokta.noktaPolyNo = polygonList.length - 1;
            YenisonBasilanNokta.noktaNo = totalNoktaList.length;

            if (YenisonBasilanNokta.noktaPolyNo == totalNoktaList[totalNoktaList.length - 1].noktaPolyNo) {
                YenisonBasilanNokta.bag1 = totalNoktaList.length - 1;
                totalNoktaList[YenisonBasilanNokta.bag1].bag2 = YenisonBasilanNokta.noktaNo;
            } else if ((polygonList.length - 2) > -1) {
                let prevPoly = polygonList[polygonList.length - 2];
                totalNoktaList[totalNoktaList.length - 1].bag2 = prevPoly.polyNoktaList[0];
                totalNoktaList[prevPoly.polyNoktaList[0]].bag1 = totalNoktaList.length - 1;
            }

            totalNoktaList.push(YenisonBasilanNokta);
            polygonList[polygonList.length - 1].polyNoktaList.push(totalNoktaList.length - 1);

            if (world.closingPointNo === 0) world.closingPointNo = totalNoktaList.length - 1;
            yenilenecekKenarEkle(tmpUcgen.kenarList, world);
            tmpUcgen.kenarList = [...TmpUcgenList[0].kenarList];
            totalUcgenList.push(TmpUcgenList[1], TmpUcgenList[2]);
        }
    }
}

function UcgenleKesnokDurum1(PointKoord, CizilenPolygonNo, tmpKenar, KenarSay, tmpUcgen, ActiveUcgenNo, ActiveNokta, ActiveAralik, PolyKomsu, tmpPolyKenar, KomsuUcgen0, world) {
    const totalNoktaList = world.totalNoktaList;
    const totalUcgenList = world.totalUcgenList;
    const polygonList = world.polygonList;

    if (PointKoord.x !== totalNoktaList[world.closingPointNo].kendiYeri.x ||
        PointKoord.y !== totalNoktaList[world.closingPointNo].kendiYeri.y ||
        world.closingPointNo === 0) {
        const YenisonBasilanNokta = new Nokta(world);
        YenisonBasilanNokta.kendiYeri = PointKoord;
        const TmpUcgenList = [];
        KomsuUcgen0 = null;

        for (KenarSay = 0; KenarSay <= 2; KenarSay++) {
            tmpKenar = tmpUcgen.kenarList[KenarSay];
            ActiveNokta = totalNoktaList[tmpKenar.karsiNoktaNo];
            ActiveAralik = ActiveNokta.aralikList[tmpKenar.karsiNoktaAralikNo];

            ActiveAralik.gidenUcNo = totalNoktaList.length;
            ActiveAralik.ucgeniciGelenKenarNo = 0;
            ActiveAralik.ucgeniciGidenKenarNo = 1;
            ActiveAralik.ucgeniciKarsiKenarNo = 2;
            if (KenarSay !== 2) ActiveAralik.ucgenNo = totalUcgenList.length + KenarSay;

            const YeniAralik = new Aralik();
            YeniAralik.gelenUcNo = totalNoktaList.length;
            YeniAralik.gidenUcNo = tmpKenar.uc1NoktaNo;
            YeniAralik.ucgeniciGelenKenarNo = 2;
            YeniAralik.ucgeniciGidenKenarNo = 0;
            YeniAralik.ucgeniciKarsiKenarNo = 1;
            switch (KenarSay) {
                case 0: YeniAralik.ucgenNo = totalUcgenList.length + 1; break;
                case 1: YeniAralik.ucgenNo = ActiveUcgenNo; break;
                case 2: YeniAralik.ucgenNo = totalUcgenList.length; break;
            }
            ActiveNokta.aralikList.push(YeniAralik);

            const icYeniAralik = new Aralik();
            icYeniAralik.gelenUcNo = tmpKenar.uc2NoktaNo;
            icYeniAralik.gidenUcNo = tmpKenar.uc1NoktaNo;
            icYeniAralik.ucgeniciGelenKenarNo = 1;
            icYeniAralik.ucgeniciGidenKenarNo = 2;
            icYeniAralik.ucgeniciKarsiKenarNo = 0;
            if (KenarSay > 0) icYeniAralik.ucgenNo = totalUcgenList.length + KenarSay - 1;
            else if (KenarSay === 0) icYeniAralik.ucgenNo = ActiveUcgenNo;
            YenisonBasilanNokta.aralikList.push(icYeniAralik);

            const YeniUcgen = new Ucgen(world);
            const YeniKenar0 = new Kenar();
            YeniKenar0.uc1NoktaNo = tmpKenar.uc1NoktaNo;
            YeniKenar0.uc2NoktaNo = tmpKenar.uc2NoktaNo;
            YeniKenar0.komsuNo = tmpKenar.komsuNo;
            YeniKenar0.karsiNoktaNo = totalNoktaList.length;
            YeniKenar0.komsudaKacinciKenarNo = tmpKenar.komsudaKacinciKenarNo;
            YeniKenar0.karsiNoktaAralikNo = KenarSay;
            YeniKenar0.polyKenar = tmpKenar.polyKenar;
            YeniKenar0.disKenar = tmpKenar.polyKenar;
            YeniKenar0.kenarPolyNo = tmpKenar.kenarPolyNo;
            YeniUcgen.kenarList.push(YeniKenar0);

            if (tmpKenar.komsuNo > -1) {
                KomsuUcgen0 = totalUcgenList[tmpKenar.komsuNo];
                if (KenarSay > 0) KomsuUcgen0.kenarList[tmpKenar.komsudaKacinciKenarNo].komsuNo = totalUcgenList.length + (KenarSay - 1);
                KomsuUcgen0.kenarList[tmpKenar.komsudaKacinciKenarNo].komsudaKacinciKenarNo = 0;
            }

            const YeniKenar1 = new Kenar();
            YeniKenar1.uc1NoktaNo = tmpKenar.uc2NoktaNo;
            YeniKenar1.uc2NoktaNo = totalNoktaList.length;
            YeniKenar1.komsuNo = ActiveAralik.ucgenNo;
            YeniKenar1.karsiNoktaNo = tmpKenar.uc1NoktaNo;
            YeniKenar1.komsudaKacinciKenarNo = 2;
            YeniKenar1.karsiNoktaAralikNo = totalNoktaList[YeniKenar1.karsiNoktaNo].aralikList.length - ((KenarSay * (KenarSay - 1)) * 0.5);
            YeniKenar1.polyKenar = false;
            YeniKenar1.disKenar = false;
            YeniUcgen.kenarList.push(YeniKenar1);

            const YeniKenar2 = new Kenar();
            YeniKenar2.uc1NoktaNo = totalNoktaList.length;
            YeniKenar2.uc2NoktaNo = tmpKenar.uc1NoktaNo;
            YeniKenar2.komsuNo = YeniAralik.ucgenNo;
            YeniKenar2.karsiNoktaNo = tmpKenar.uc2NoktaNo;
            YeniKenar2.komsudaKacinciKenarNo = 1;
            YeniKenar2.karsiNoktaAralikNo = tmpUcgen.kenarList[((Math.pow(KenarSay + 1, KenarSay) + 1) % 3)].karsiNoktaAralikNo;
            YeniKenar2.polyKenar = false;
            YeniKenar2.disKenar = false;
            YeniUcgen.kenarList.push(YeniKenar2);
            TmpUcgenList.push(YeniUcgen);
        }

        YenisonBasilanNokta.noktaPolyNo = polygonList.length - 1;
        YenisonBasilanNokta.noktaNo = totalNoktaList.length;
        YenisonBasilanNokta.bag1 = totalNoktaList.length - 1;
        totalNoktaList[YenisonBasilanNokta.bag1].bag2 = YenisonBasilanNokta.noktaNo;
        totalNoktaList.push(YenisonBasilanNokta);
        polygonList[polygonList.length - 1].polyNoktaList.push(totalNoktaList.length - 1);

        if (world.closingPointNo === 0) world.closingPointNo = totalNoktaList.length - 1;
        yenilenecekKenarEkle(tmpUcgen.kenarList, world);
        tmpUcgen.kenarList = [...TmpUcgenList[0].kenarList];
        totalUcgenList.push(TmpUcgenList[1], TmpUcgenList[2]);

        if (polygonList[polygonList.length - 1].polyNoktaList.length > 1) {
            for (KenarSay = 1; KenarSay <= 2; KenarSay++) {
                const kenar = totalUcgenList[totalUcgenList.length - 1].kenarList[KenarSay];
                if ((kenar.uc1NoktaNo === totalNoktaList.length - 1 && kenar.uc2NoktaNo === totalNoktaList.length - 2) ||
                    (kenar.uc2NoktaNo === totalNoktaList.length - 1 && kenar.uc1NoktaNo === totalNoktaList.length - 2)) {
                    kenar.polyKenar = true;
                    kenar.disKenar = true;
                    kenar.kenarPolyNo = CizilenPolygonNo;
                    tmpPolyKenar = kenar;
                    PolyKomsu = totalUcgenList[tmpPolyKenar.komsuNo];
                    PolyKomsu.kenarList[tmpPolyKenar.komsudaKacinciKenarNo].polyKenar = true;
                    PolyKomsu.kenarList[tmpPolyKenar.komsudaKacinciKenarNo].disKenar = true;
                    PolyKomsu.kenarList[tmpPolyKenar.komsudaKacinciKenarNo].kenarPolyNo = CizilenPolygonNo;
                }
            }
        }
    }
}
