function connectPoints(targetNokta, lookingNokta, lookAralik, kkbAnswer, cizilenPolygonNo, world) {
    // Yerel değişkenlerin tanımlanması
    let tmpUcgen = null;
    let tmpKenar = null;
    let activeUcgenNo = 0;
    let komsuUcgen = null;
    let komsuAktifKenar = null;
    let kesCev1 = new KesisimCevap();
    let kesCev2 = new KesisimCevap();
    let kesNok = new KesisimCevap();
    let kesPoint = { x: 0, y: 0 };
    let tmpKenarNo = 0;
    let tmpKenarNo2 = 0;
    let kesilenKenar = null;
    let kesilenKenar2 = null;

    world.museumPolygonGiden = [];
    world.museumPolygonGelen = [];
    world.tmpUcgenList = [];
    world.istikametList = [];

    activeUcgenNo = lookAralik.ucgenNo;
    tmpUcgen = world.totalUcgenList[activeUcgenNo];
    tmpKenar = tmpUcgen.kenarList[lookAralik.ucgeniciKarsiKenarNo];

    if (!targetNokta) {
        kkbAnswer.connected = false;
        return kkbAnswer;
    }

    // Eğer lookingNokta veya targetNokta, tmpKenar’ın uç noktalarından biri ise bağlantı sağlanmış sayılıyor
    if (
        tmpKenar.uc1NoktaNo === lookingNokta.noktaNo ||
        tmpKenar.uc2NoktaNo === lookingNokta.noktaNo ||
        tmpKenar.uc1NoktaNo === targetNokta.noktaNo ||
        tmpKenar.uc2NoktaNo === targetNokta.noktaNo
    ) {
        kkbAnswer.connected = true;
        return kkbAnswer;
    }

    if (tmpKenar.komsuNo >= 0 && targetNokta.kendiYeri !== lookingNokta.kendiYeri) {
        komsuUcgen = world.totalUcgenList[tmpKenar.komsuNo];
        komsuAktifKenar = komsuUcgen.kenarList[tmpKenar.komsudaKacinciKenarNo];
    } else {
        world.tmpUcgenList = [];
        world.istikametList = [];
        world.museumPolygonGiden = [];
        world.museumPolygonGelen = [];
        kkbAnswer.connected = false;
        return kkbAnswer;
    }

    kesNok = collKesisimHesapla(tmpKenar, lookingNokta, targetNokta.kendiYeri, 0, world.totalNoktaList);
    kkbAnswer.kesNok = kesNok.kesisimNok;

    if (kesNok.durum > 0 && targetNokta) {
        world.istikametList.push(activeUcgenNo);
        tmpUcgen.cikisPoint.x = kesNok.kesisimNok.x;
        tmpUcgen.cikisPoint.y = kesNok.kesisimNok.y;
        tmpUcgen.cikilanKenarNo = lookAralik.ucgeniciKarsiKenarNo;
        world.totalUcgenList[tmpKenar.komsuNo].girilenKenarNo = tmpKenar.komsudaKacinciKenarNo;

        world.totalUcgenList[tmpKenar.komsuNo].girisPoint = { ...tmpUcgen.cikisPoint };
        world.museumPolygonGiden.push(tmpUcgen.kenarList[lookAralik.ucgeniciGidenKenarNo]);
        world.museumPolygonGelen.unshift(tmpUcgen.kenarList[lookAralik.ucgeniciGelenKenarNo]);
        kesPoint = { ...tmpUcgen.cikisPoint };

        do {
            if (tmpKenar.komsuNo < 0) {
                world.tmpUcgenList = [];
                world.istikametList = [];
                world.museumPolygonGiden = [];
                world.museumPolygonGelen = [];
                kkbAnswer.connected = false;
                return kkbAnswer;
            } else {
                komsuUcgen = world.totalUcgenList[tmpKenar.komsuNo];
                komsuAktifKenar = komsuUcgen.kenarList[tmpKenar.komsudaKacinciKenarNo];

                if (tmpKenar.komsuNo < 0) {
                    world.tmpUcgenList = [];
                    world.istikametList = [];
                    world.museumPolygonGiden = [];
                    world.museumPolygonGelen = [];
                    kkbAnswer.connected = false;
                    return kkbAnswer;
                }

                // Döngünün başındaki ucgen tekrar ziyaret ediliyorsa döngüden çık
                if (world.istikametList.length > 0 && tmpKenar.komsuNo === world.istikametList[0]) {
                    break;
                }

                world.istikametList.push(tmpKenar.komsuNo);
                world.totalUcgenList[tmpKenar.komsuNo].girilenKenarNo = tmpKenar.komsudaKacinciKenarNo;
                world.totalUcgenList[tmpKenar.komsuNo].girisPoint = { ...komsuUcgen.cikisPoint };

                if (world.totalNoktaList[komsuUcgen.kenarList[komsuUcgen.girilenKenarNo].karsiNoktaNo].kendiYeri === targetNokta.kendiYeri) {
                    break;
                }

                tmpKenarNo = (tmpKenar.komsudaKacinciKenarNo + 1) % 3;
                tmpKenarNo2 = (tmpKenar.komsudaKacinciKenarNo + 2) % 3;
                kesilenKenar = komsuUcgen.kenarList[tmpKenarNo];
                kesilenKenar2 = komsuUcgen.kenarList[tmpKenarNo2];
                kesCev1 = collKesisimHesapla(kesilenKenar, lookingNokta, targetNokta.kendiYeri, 0, world.totalNoktaList);
                kkbAnswer.kesNok = kesCev1.kesisimNok;
                if (kesCev1.durum === 2) {
                    komsuUcgen.cikisPoint.x = kesCev1.kesisimNok.x;
                    komsuUcgen.cikisPoint.y = kesCev1.kesisimNok.y;
                    komsuUcgen.cikilanKenarNo = tmpKenarNo;
                    tmpKenar = kesilenKenar;
                    kesPoint = { ...kesCev1.kesisimNok };
                } else {
                    kesCev2 = collKesisimHesapla(kesilenKenar2, lookingNokta, targetNokta.kendiYeri, 0, world.totalNoktaList);
                    if (kesCev2.durum === 2) {
                        kkbAnswer.kesNok = kesCev2.kesisimNok;
                        komsuUcgen.cikisPoint.x = kesCev2.kesisimNok.x;
                        komsuUcgen.cikisPoint.y = kesCev2.kesisimNok.y;
                        komsuUcgen.cikilanKenarNo = tmpKenarNo2;
                        tmpKenar = kesilenKenar2;
                        tmpKenarNo = tmpKenarNo2;
                        kesPoint = { ...kesCev2.kesisimNok };
                    } else {
                        if (kesCev1.durum === 0 && kesCev2.durum === 0) {
                            world.tmpUcgenList = [];
                            world.istikametList = [];
                            world.museumPolygonGiden = [];
                            world.museumPolygonGelen = [];
                            kkbAnswer.connected = false;
                            return kkbAnswer;
                        }
                        break;
                    }
                }

                komsuAktifKenar = world.totalUcgenList[tmpKenar.komsuNo].kenarList[tmpKenar.komsudaKacinciKenarNo];

                if (!kkbAnswer.oncekiDoluKenar && tmpKenar.kenarPolyNo > -1) {
                    kkbAnswer.sonKesilenDoluPoly = tmpKenar.kenarPolyNo;
                    kkbAnswer.oncekiDoluKenar = tmpKenar;
                } else if (!kkbAnswer.oncekiDoluKenar && komsuAktifKenar.kenarPolyNo > -1) {
                    kkbAnswer.sonKesilenDoluPoly = komsuAktifKenar.kenarPolyNo;
                    kkbAnswer.oncekiDoluKenar = komsuAktifKenar;
                }

                if (!kkbAnswer.ilKesilenDiskenar && (tmpKenar.polyKenar || tmpKenar.disKenar)) {
                    kkbAnswer.ilKesilenDiskenar = tmpKenar;
                } else if (!kkbAnswer.ilKesilenDiskenar && (komsuAktifKenar.polyKenar || komsuAktifKenar.disKenar)) {
                    kkbAnswer.ilKesilenDiskenar = komsuAktifKenar;
                }

                if (
                    komsuUcgen.kenarList[komsuUcgen.cikilanKenarNo].karsiNoktaNo ===
                    world.museumPolygonGiden[world.museumPolygonGiden.length - 1].uc2NoktaNo
                ) {
                    world.museumPolygonGiden.push(komsuUcgen.kenarList[(komsuUcgen.cikilanKenarNo + 2) % 3]);
                } else {
                    world.museumPolygonGelen.unshift(komsuUcgen.kenarList[(komsuUcgen.cikilanKenarNo + 1) % 3]);
                }
            }
        } while (true);
    } else {
        world.tmpUcgenList = [];
        world.istikametList = [];
        world.museumPolygonGiden = [];
        world.museumPolygonGelen = [];
        kkbAnswer.connected = false;
        return kkbAnswer;
    }

    if (world.istikametList.length > 0) {
        let sonUcgen = world.totalUcgenList[world.istikametList[world.istikametList.length - 1]];
        let sonUcgenTepe = null;
        let sonUcgenYan1 = null;
        let sonUcgenYan2 = null;
        let sonUcgenTepeAra = null;
        let sonUcgenYanAra1 = null;
        let sonUcgenYanAra2 = null;

        sonUcgenTepe = world.totalNoktaList[sonUcgen.kenarList[sonUcgen.girilenKenarNo].karsiNoktaNo];
        if (sonUcgenTepe.noktaNo !== targetNokta.noktaNo) { // TODO: bu koşul incelenecek, bazı durumlarda hataya sebep oluyor            
            let istikametNoktaMap = new Map(); // debug

            for (const istUcgenNo of world.istikametList) {
                let istUcgen = world.totalUcgenList[istUcgenNo];
                for (const kenar of istUcgen.kenarList) {
                    console.log(istUcgenNo, kenar.uc1NoktaNo,kenar.uc2NoktaNo);
                    istikametNoktaMap.set(kenar.uc1NoktaNo, world.totalNoktaList[kenar.uc1NoktaNo]);
                    istikametNoktaMap.set(kenar.uc2NoktaNo, world.totalNoktaList[kenar.uc2NoktaNo]);
                }
            }
            let istikametNoktaList = Array.from(istikametNoktaMap.values());

            let xmlStr = noktalariXMLeCevir(istikametNoktaList, { start: 0, escape: true });

            console.error("fatal error on connect points", "targetNokta", targetNokta, "lookingNokta", lookingNokta, xmlStr);
        }
        sonUcgenTepeAra = sonUcgenTepe.aralikList[sonUcgen.kenarList[sonUcgen.girilenKenarNo].karsiNoktaAralikNo];

        sonUcgenYan1 = world.totalNoktaList[sonUcgen.kenarList[sonUcgenTepeAra.ucgeniciGelenKenarNo].uc1NoktaNo];
        sonUcgenYanAra1 = sonUcgenYan1.aralikList[sonUcgen.kenarList[sonUcgenTepeAra.ucgeniciGidenKenarNo].karsiNoktaAralikNo];

        sonUcgenYan2 = world.totalNoktaList[sonUcgen.kenarList[sonUcgenTepeAra.ucgeniciGelenKenarNo].uc2NoktaNo];
        sonUcgenYanAra2 = sonUcgenYan2.aralikList[sonUcgen.kenarList[sonUcgenTepeAra.ucgeniciGelenKenarNo].karsiNoktaAralikNo];

        for (let i = 0; i < world.istikametList.length; i++) {
            let isUcgenNo = world.istikametList[i];
            let isUcgen = world.totalUcgenList[isUcgenNo];
            for (let kenarSay = 0; kenarSay <= 2; kenarSay++) {
                let aralik = world.totalNoktaList[isUcgen.kenarList[kenarSay].karsiNoktaNo].aralikList[isUcgen.kenarList[kenarSay].karsiNoktaAralikNo];
                if (!aralik.disabled) {
                    aralik.disabled = true;
                    world.totalNoktaList[isUcgen.kenarList[kenarSay].karsiNoktaNo].disableList.push(isUcgen.kenarList[kenarSay].karsiNoktaAralikNo);
                }
            }
        }

        if (
            sonUcgen.kenarList[sonUcgenTepeAra.ucgeniciGelenKenarNo].uc1NoktaNo ===
            world.museumPolygonGiden[world.museumPolygonGiden.length - 1].uc2NoktaNo
        ) {
            world.museumPolygonGiden.push(sonUcgen.kenarList[sonUcgenTepeAra.ucgeniciGelenKenarNo]);
        }

        let gidenSonKenar = new Kenar();
        if (
            world.museumPolygonGiden[world.museumPolygonGiden.length - 1].uc1NoktaNo !== world.museumPolygonGiden[world.museumPolygonGiden.length - 1].uc2NoktaNo &&
            world.museumPolygonGiden[world.museumPolygonGiden.length - 1].uc2NoktaNo !== world.museumPolygonGiden[0].uc1NoktaNo
        ) {
            gidenSonKenar.uc1NoktaNo = world.museumPolygonGiden[world.museumPolygonGiden.length - 1].uc2NoktaNo;
            gidenSonKenar.uc2NoktaNo = world.museumPolygonGiden[0].uc1NoktaNo;
            gidenSonKenar.komsudaKacinciKenarNo = 2;
            if (
                world.totalNoktaList[gidenSonKenar.uc1NoktaNo].noktaPolyNo ===
                world.totalNoktaList[gidenSonKenar.uc2NoktaNo].noktaPolyNo
            ) {
                gidenSonKenar.kenarPolyNo = world.totalNoktaList[gidenSonKenar.uc1NoktaNo].noktaPolyNo;
            }
            world.museumPolygonGiden.push(gidenSonKenar);
        }
        world.tmpMuseumPolygonGiden = world.museumPolygonGiden.slice();
        world.tmpUcgenList = [];

        if (
            world.museumPolygonGelen[0].uc1NoktaNo !== sonUcgen.kenarList[sonUcgenTepeAra.ucgeniciGidenKenarNo].uc1NoktaNo &&
            world.museumPolygonGelen[0].uc2NoktaNo !== sonUcgen.kenarList[sonUcgenTepeAra.ucgeniciGidenKenarNo].uc2NoktaNo
        ) {
            world.museumPolygonGelen.unshift(sonUcgen.kenarList[sonUcgenTepeAra.ucgeniciGidenKenarNo]);
        }

        let gelenSonKenar = new Kenar();
        gelenSonKenar.uc1NoktaNo = gidenSonKenar.uc2NoktaNo;
        gelenSonKenar.uc2NoktaNo = gidenSonKenar.uc1NoktaNo;
        gelenSonKenar.komsudaKacinciKenarNo = 2;
        if (
            world.totalNoktaList[gelenSonKenar.uc1NoktaNo].noktaPolyNo ===
            world.totalNoktaList[gelenSonKenar.uc2NoktaNo].noktaPolyNo
        ) {
            gelenSonKenar.kenarPolyNo = world.totalNoktaList[gelenSonKenar.uc1NoktaNo].noktaPolyNo;
        }
        world.museumPolygonGelen.push(gelenSonKenar);

        world.tmpMuseumPolygonGelen = world.museumPolygonGelen.slice(); // TODO: buna gerek var mı bakılacak

        EarClipping(world.museumPolygonGiden, true, lookingNokta.noktaNo, targetNokta.noktaNo, cizilenPolygonNo, world);
        kkbAnswer.earSonUcgen = EarClipping(world.museumPolygonGelen, false, lookingNokta.noktaNo, targetNokta.noktaNo, cizilenPolygonNo, world);

        kkbAnswer.connected = true;
        return kkbAnswer;
    } else {
        world.tmpUcgenList = [];
        world.istikametList = [];
        world.museumPolygonGiden = [];
        world.museumPolygonGelen = [];
        kkbAnswer.connected = false;
        return kkbAnswer;
    }
}
