function SelectPolyGons(world) {
    let SifirUcgeni = null;
    let ActiveTestUcgen = null;
    let Mod0U = null;
    let Mod1U = null;
    let Mod2U = null;
    let KenarAl = 0;
    let DoldurmaTestList = [];
    let TmpDoldurmaTestList = [];
    let NoktaSay = 0;
    let DUcgenNo = 0;
    let AralikSay = 0;
    let SelIlkNokta = null;
    let SelIlkAralik = null;
    const totalNoktaList = world.totalNoktaList;
    const totalUcgenList = world.totalUcgenList;
    const polygonList = world.polygonList;

    for (NoktaSay = 0; NoktaSay < totalNoktaList.length; NoktaSay++) {
        SelIlkNokta = totalNoktaList[NoktaSay];
        for (AralikSay = 0; AralikSay < SelIlkNokta.aralikList.length; AralikSay++) {
            if (!SelIlkNokta.aralikList[AralikSay].disabled) {
                SelIlkAralik = SelIlkNokta.aralikList[AralikSay];
                SifirUcgeni = totalUcgenList[SelIlkAralik.ucgenNo];
                break;
            }
        }
        if (SifirUcgeni) break;
    }

    for (KenarAl = 0; KenarAl <= 2; KenarAl++) {
        if (SifirUcgeni.kenarList[KenarAl].komsuNo > -1) {
            DoldurmaTestList.push(SifirUcgeni.kenarList[KenarAl].komsuNo);
            totalUcgenList[SifirUcgeni.kenarList[KenarAl].komsuNo].doldurmaKenari = SifirUcgeni.kenarList[KenarAl].komsudaKacinciKenarNo;
        }
    }
    SifirUcgeni.islemGordu = true;

    do {
        TmpDoldurmaTestList = [];
        for (DUcgenNo = 0; DUcgenNo < DoldurmaTestList.length; DUcgenNo++) {
            ActiveTestUcgen = totalUcgenList[DoldurmaTestList[DUcgenNo]];
            if (!ActiveTestUcgen.islemGordu) {
                if (ActiveTestUcgen.kenarList[ActiveTestUcgen.doldurmaKenari].polyKenar) {
                    ActiveTestUcgen.kenarList[ActiveTestUcgen.doldurmaKenari].polyKenar = false;
                    Mod0U = totalUcgenList[ActiveTestUcgen.kenarList[ActiveTestUcgen.doldurmaKenari].komsuNo];
                    Mod0U.kenarList[ActiveTestUcgen.kenarList[ActiveTestUcgen.doldurmaKenari].komsudaKacinciKenarNo].polyKenar = false;

                    ActiveTestUcgen.kenarList[(ActiveTestUcgen.doldurmaKenari + 1) % 3].polyKenar = !ActiveTestUcgen.kenarList[(ActiveTestUcgen.doldurmaKenari + 1) % 3].polyKenar;
                    Mod1U = totalUcgenList[ActiveTestUcgen.kenarList[(ActiveTestUcgen.doldurmaKenari + 1) % 3].komsuNo];
                    Mod1U.kenarList[ActiveTestUcgen.kenarList[(ActiveTestUcgen.doldurmaKenari + 1) % 3].komsudaKacinciKenarNo].polyKenar = ActiveTestUcgen.kenarList[(ActiveTestUcgen.doldurmaKenari + 1) % 3].polyKenar;

                    ActiveTestUcgen.kenarList[(ActiveTestUcgen.doldurmaKenari + 2) % 3].polyKenar = !ActiveTestUcgen.kenarList[(ActiveTestUcgen.doldurmaKenari + 2) % 3].polyKenar;
                    Mod2U = totalUcgenList[ActiveTestUcgen.kenarList[(ActiveTestUcgen.doldurmaKenari + 2) % 3].komsuNo];
                    Mod2U.kenarList[ActiveTestUcgen.kenarList[(ActiveTestUcgen.doldurmaKenari + 2) % 3].komsudaKacinciKenarNo].polyKenar = ActiveTestUcgen.kenarList[(ActiveTestUcgen.doldurmaKenari + 2) % 3].polyKenar;

                    ActiveTestUcgen.dolu = true;
                }
                for (KenarAl = 0; KenarAl <= 2; KenarAl++) {
                    if (ActiveTestUcgen.kenarList[KenarAl].komsuNo > -1) {
                        if (!totalUcgenList[ActiveTestUcgen.kenarList[KenarAl].komsuNo].islemGordu) {
                            TmpDoldurmaTestList.push(ActiveTestUcgen.kenarList[KenarAl].komsuNo);
                            totalUcgenList[ActiveTestUcgen.kenarList[KenarAl].komsuNo].doldurmaKenari = ActiveTestUcgen.kenarList[KenarAl].komsudaKacinciKenarNo;
                        }
                    }
                }
                ActiveTestUcgen.islemGordu = true;

                for (KenarAl = 0; KenarAl <= 2; KenarAl++) {
                    if (ActiveTestUcgen.kenarList[KenarAl].kenarPolyNo > -1 && ActiveTestUcgen.dolu) {
                        ActiveTestUcgen.ucgenPolyNo = ActiveTestUcgen.kenarList[KenarAl].kenarPolyNo;
                        ActiveTestUcgen.kenarList[0].kenarPolyNo = ActiveTestUcgen.ucgenPolyNo;
                        world.activePolygon = polygonList[ActiveTestUcgen.ucgenPolyNo];
                        if (!ActiveTestUcgen.PolyEklendi) {
                            world.activePolygon.ucgenList.push(DoldurmaTestList[DUcgenNo]);
                            ActiveTestUcgen.PolyEklendi = true;
                            ActiveTestUcgen.PolyListSira = world.activePolygon.ucgenList.length - 1;
                        }
                        if (ActiveTestUcgen.kenarList[0].komsuNo > -1) {
                            Mod0U = totalUcgenList[ActiveTestUcgen.kenarList[0].komsuNo];
                            Mod0U.kenarList[ActiveTestUcgen.kenarList[0].komsudaKacinciKenarNo].kenarPolyNo = ActiveTestUcgen.ucgenPolyNo;
                            if (Mod0U.dolu) {
                                Mod0U.ucgenPolyNo = ActiveTestUcgen.ucgenPolyNo;
                                if (!Mod0U.PolyEklendi) {
                                    world.activePolygon.ucgenList.push(ActiveTestUcgen.kenarList[0].komsuNo);
                                    Mod0U.PolyEklendi = true;
                                    Mod0U.PolyListSira = world.activePolygon.ucgenList.length - 1;
                                }
                            }
                        }
                        ActiveTestUcgen.kenarList[1].kenarPolyNo = ActiveTestUcgen.ucgenPolyNo;
                        Mod1U = totalUcgenList[ActiveTestUcgen.kenarList[1].komsuNo];
                        Mod1U.kenarList[ActiveTestUcgen.kenarList[1].komsudaKacinciKenarNo].kenarPolyNo = ActiveTestUcgen.ucgenPolyNo;
                        if (Mod1U.dolu) {
                            Mod1U.ucgenPolyNo = ActiveTestUcgen.ucgenPolyNo;
                            if (!Mod1U.PolyEklendi) {
                                world.activePolygon.ucgenList.push(ActiveTestUcgen.kenarList[1].komsuNo);
                                Mod1U.PolyEklendi = true;
                                Mod1U.PolyListSira = world.activePolygon.ucgenList.length - 1;
                            }
                        }
                        ActiveTestUcgen.kenarList[2].kenarPolyNo = ActiveTestUcgen.ucgenPolyNo;
                        Mod2U = totalUcgenList[ActiveTestUcgen.kenarList[2].komsuNo];
                        Mod2U.kenarList[ActiveTestUcgen.kenarList[2].komsudaKacinciKenarNo].kenarPolyNo = ActiveTestUcgen.ucgenPolyNo;
                        if (Mod2U.dolu) {
                            Mod2U.ucgenPolyNo = ActiveTestUcgen.ucgenPolyNo;
                            if (!Mod2U.PolyEklendi) {
                                world.activePolygon.ucgenList.push(ActiveTestUcgen.kenarList[2].komsuNo);
                                Mod2U.PolyEklendi = true;
                                Mod2U.PolyListSira = world.activePolygon.ucgenList.length - 1;
                            }
                        }
                        break;
                    }
                }
            }
        }
        DoldurmaTestList = [...TmpDoldurmaTestList];
        if (DoldurmaTestList.length < 1) break;
    } while (true);

    for (DUcgenNo = 0; DUcgenNo < totalUcgenList.length; DUcgenNo++) {
        totalUcgenList[DUcgenNo].islemGordu = false;
    }
    const NextPolygon = new Polygon(world);
    world.polygonList.push(NextPolygon);
    world.activePolygon = world.polygonList[polygonList.length - 1];
    //world.closingPointNo = world.totalNoktaList.length;
}

function EarClipping(MusePolyGon, Duz, bakan, hedef, EarPolygonNo, world) {
    let KenarNo = 0;
    let ModLimit = MusePolyGon.length;
    let SeciliKenar = null;
    let SonrakiKenar = null;
    let DahaSonrakiKenar = null;
    let OncekiKenar = null;
    let BuyukAci = 0;
    let KucukAci = 0;
    let BakisAcisi = 0;
    let EksiMod = 0;
    let EarSonUcgen = 0;
    let Sayac = 0;
    const totalNoktaList = world.totalNoktaList;
    const totalUcgenList = world.totalUcgenList;

    // Poligonun en az 3 kenarı olmalı
    if (MusePolyGon.length < 3) {
        console.error("EarClipping: Polygon has fewer than 3 edges");
        return 0;
    }

    // Düz yönde ise son yönü al
    if (Duz) world.backistikamet = world.istikametList.length - 1;

    do {
        if (MusePolyGon.length < 3) break;
        SeciliKenar = MusePolyGon[KenarNo];
        SonrakiKenar = MusePolyGon[KenarNo + 1];

        // Kenarların poligon numaralarını komşudan güncelle, eğer yoksa
        if (SeciliKenar.kenarPolyNo < 0 && SeciliKenar.komsuNo > -1) {
            SeciliKenar.kenarPolyNo = totalUcgenList[SeciliKenar.komsuNo].kenarList[SeciliKenar.komsudaKacinciKenarNo].kenarPolyNo;
        }
        if (SonrakiKenar.kenarPolyNo < 0 && SonrakiKenar.komsuNo > -1) {
            SonrakiKenar.kenarPolyNo = totalUcgenList[SonrakiKenar.komsuNo].kenarList[SonrakiKenar.komsudaKacinciKenarNo].kenarPolyNo;
        }

        // Önceki kenarı modüler olarak hesapla
        EksiMod = (KenarNo - 1 + MusePolyGon.length) % MusePolyGon.length;
        OncekiKenar = MusePolyGon[EksiMod];

        // Açı hesaplamaları
        KucukAci = aciBul(totalNoktaList[SeciliKenar.uc1NoktaNo].kendiYeri, totalNoktaList[OncekiKenar.uc1NoktaNo].kendiYeri);
        BuyukAci = aciBul(totalNoktaList[SeciliKenar.uc1NoktaNo].kendiYeri, totalNoktaList[SeciliKenar.uc2NoktaNo].kendiYeri);
        BakisAcisi = aciBul(totalNoktaList[SeciliKenar.uc1NoktaNo].kendiYeri, totalNoktaList[SonrakiKenar.uc2NoktaNo].kendiYeri);

        const EarAngle = getAngle(
            totalNoktaList[SonrakiKenar.uc2NoktaNo].kendiYeri,
            totalNoktaList[SeciliKenar.uc2NoktaNo].kendiYeri,
            totalNoktaList[SeciliKenar.uc1NoktaNo].kendiYeri
        );

        // Açılar negatifse 360 ekle
        if (BuyukAci < KucukAci) BuyukAci += 360;
        if (BakisAcisi < KucukAci) BakisAcisi += 360;

        // Yeni kenar oluştur ve kesişim testi yap
        const Kenar0 = new Kenar(SeciliKenar.uc1NoktaNo, SonrakiKenar.uc2NoktaNo);
        const insideTest = collKesisimHesapla(
            Kenar0,
            totalNoktaList[OncekiKenar.uc1NoktaNo],
            totalNoktaList[SeciliKenar.uc2NoktaNo].kendiYeri,
            0,
            totalNoktaList
        );

        // Kulak kesme koşulu
        if (
            (BakisAcisi <= BuyukAci && EarAngle <= 180) ||
            (BakisAcisi <= BuyukAci && insideTest.durum === 0 && EarAngle < 180) ||
            MusePolyGon.length === 3
        ) {
            const YeniUcgen = new Ucgen(world);
            const yeniKenar3 = new Kenar(Kenar0.uc2NoktaNo, Kenar0.uc1NoktaNo);
            YeniUcgen.kenarList.push(SeciliKenar, SonrakiKenar, yeniKenar3);

            // Daha sonraki kenarı belirle
            if (KenarNo + 2 < MusePolyGon.length) {
                DahaSonrakiKenar = MusePolyGon[KenarNo + 2];
            } else {
                DahaSonrakiKenar = MusePolyGon[KenarNo + 1];
            }

            // Komşuluk ilişkilerini güncelle
            if (
                (SonrakiKenar.uc1NoktaNo === DahaSonrakiKenar.uc2NoktaNo && SonrakiKenar.uc2NoktaNo === DahaSonrakiKenar.uc1NoktaNo) ||
                (SonrakiKenar.uc2NoktaNo === DahaSonrakiKenar.uc2NoktaNo && SonrakiKenar.uc1NoktaNo === DahaSonrakiKenar.uc1NoktaNo)
            ) {
                SonrakiKenar.komsuNo = -1;
            }

            // Poligon numarasını ata
            if (SeciliKenar.kenarPolyNo === SonrakiKenar.kenarPolyNo) {
                Kenar0.kenarPolyNo = SonrakiKenar.kenarPolyNo;
                YeniUcgen.kenarList[2].kenarPolyNo = SonrakiKenar.kenarPolyNo;
            }

            world.tmpUcgenList.push(YeniUcgen);
            EarSonUcgen = EarBagYaz(YeniUcgen, Duz, world);

            Kenar0.komsuNo = EarSonUcgen;
            Kenar0.komsudaKacinciKenarNo = 2;

            if (
                (SonrakiKenar.uc1NoktaNo === DahaSonrakiKenar.uc2NoktaNo && SonrakiKenar.uc2NoktaNo === DahaSonrakiKenar.uc1NoktaNo) ||
                (SonrakiKenar.uc2NoktaNo === DahaSonrakiKenar.uc2NoktaNo && SonrakiKenar.uc1NoktaNo === DahaSonrakiKenar.uc1NoktaNo)
            ) {
                DahaSonrakiKenar.komsuNo = EarSonUcgen;
                DahaSonrakiKenar.komsudaKacinciKenarNo = 1;
            }

            // Poligon listesini güncelle
            MusePolyGon[KenarNo] = Kenar0;
            MusePolyGon.splice(KenarNo + 1, 1);
            ModLimit = MusePolyGon.length;
            KenarNo--;
        } else {
            KenarNo++;
        }

        Sayac++;
        if (Sayac >= 100) {
            console.error(`EarClipping error: ${bakan}-to-${hedef}`);
            return 0;
        }
        if (KenarNo >= ModLimit - 1 || KenarNo < 0) KenarNo = 0;
    } while (true);

    // Yönlendirme ve komşuluk güncellemeleri
    if (Duz) world.gidenMuseumSonUcgen = EarSonUcgen;
    else {
        totalUcgenList[EarSonUcgen].kenarList[2].komsuNo = world.gidenMuseumSonUcgen;
        totalUcgenList[EarSonUcgen].kenarList[2].komsudaKacinciKenarNo = 2;
        totalUcgenList[world.gidenMuseumSonUcgen].kenarList[2].komsuNo = EarSonUcgen;
        totalUcgenList[world.gidenMuseumSonUcgen].kenarList[2].komsudaKacinciKenarNo = 2;
        totalUcgenList[EarSonUcgen].kenarList[2].polyKenar = true;
        totalUcgenList[EarSonUcgen].kenarList[2].disKenar = true;
        totalUcgenList[EarSonUcgen].kenarList[2].kenarPolyNo = EarPolygonNo;
        totalUcgenList[world.gidenMuseumSonUcgen].kenarList[2].polyKenar = true;
        totalUcgenList[world.gidenMuseumSonUcgen].kenarList[2].disKenar = true;
        totalUcgenList[world.gidenMuseumSonUcgen].kenarList[2].kenarPolyNo = EarPolygonNo;
    }
    return EarSonUcgen;
}

function EarBagYaz(RefUcgen, Duz, world) {
    const totalNoktaList = world.totalNoktaList;
    const totalUcgenList = world.totalUcgenList;

    const K0 = RefUcgen.kenarList[0]; // Birinci kenar
    const K1 = RefUcgen.kenarList[1]; // İkinci kenar
    const K2 = RefUcgen.kenarList[2]; // Üçüncü kenar
    let tmpucgen = RefUcgen;
    let EarSonUcgen = 0;

    // **Birinci kenar (K0) için karşı nokta ve aralık ayarları**
    K0.karsiNoktaNo = K1.uc2NoktaNo;
    if (totalNoktaList[K0.karsiNoktaNo].disableList.length > 0) {
        K0.karsiNoktaAralikNo = totalNoktaList[K0.karsiNoktaNo].disableList.pop();
        totalNoktaList[K0.karsiNoktaNo].aralikList[K0.karsiNoktaAralikNo].disabled = false;
    } else {
        const YeniAralik0 = new Aralik();
        totalNoktaList[K0.karsiNoktaNo].aralikList.push(YeniAralik0);
        K0.karsiNoktaAralikNo = totalNoktaList[K0.karsiNoktaNo].aralikList.length - 1;
    }
    totalNoktaList[K0.karsiNoktaNo].aralikList[K0.karsiNoktaAralikNo].disabled = false;
    totalNoktaList[K0.karsiNoktaNo].aralikList[K0.karsiNoktaAralikNo].gelenUcNo = K0.uc2NoktaNo;
    totalNoktaList[K0.karsiNoktaNo].aralikList[K0.karsiNoktaAralikNo].gidenUcNo = K0.uc1NoktaNo;
    totalNoktaList[K0.karsiNoktaNo].aralikList[K0.karsiNoktaAralikNo].ucgeniciGelenKenarNo = 1;
    totalNoktaList[K0.karsiNoktaNo].aralikList[K0.karsiNoktaAralikNo].ucgeniciGidenKenarNo = 2;
    totalNoktaList[K0.karsiNoktaNo].aralikList[K0.karsiNoktaAralikNo].ucgeniciKarsiKenarNo = 0;

    // **İkinci kenar (K1) için karşı nokta ve aralık ayarları**
    K1.karsiNoktaNo = K2.uc2NoktaNo;
    if (totalNoktaList[K1.karsiNoktaNo].disableList.length > 0) {
        K1.karsiNoktaAralikNo = totalNoktaList[K1.karsiNoktaNo].disableList.pop();
        totalNoktaList[K1.karsiNoktaNo].aralikList[K1.karsiNoktaAralikNo].disabled = false;
    } else {
        const YeniAralik1 = new Aralik();
        totalNoktaList[K1.karsiNoktaNo].aralikList.push(YeniAralik1);
        K1.karsiNoktaAralikNo = totalNoktaList[K1.karsiNoktaNo].aralikList.length - 1;
    }
    totalNoktaList[K1.karsiNoktaNo].aralikList[K1.karsiNoktaAralikNo].disabled = false;
    totalNoktaList[K1.karsiNoktaNo].aralikList[K1.karsiNoktaAralikNo].gelenUcNo = K1.uc2NoktaNo;
    totalNoktaList[K1.karsiNoktaNo].aralikList[K1.karsiNoktaAralikNo].gidenUcNo = K1.uc1NoktaNo;
    totalNoktaList[K1.karsiNoktaNo].aralikList[K1.karsiNoktaAralikNo].ucgeniciGelenKenarNo = 2;
    totalNoktaList[K1.karsiNoktaNo].aralikList[K1.karsiNoktaAralikNo].ucgeniciGidenKenarNo = 0;
    totalNoktaList[K1.karsiNoktaNo].aralikList[K1.karsiNoktaAralikNo].ucgeniciKarsiKenarNo = 1;

    // **Üçüncü kenar (K2) için karşı nokta ve aralık ayarları**
    K2.karsiNoktaNo = K0.uc2NoktaNo;
    if (totalNoktaList[K2.karsiNoktaNo].disableList.length > 0) {
        K2.karsiNoktaAralikNo = totalNoktaList[K2.karsiNoktaNo].disableList.pop();
        totalNoktaList[K2.karsiNoktaNo].aralikList[K2.karsiNoktaAralikNo].disabled = false;
    } else {
        const YeniAralik2 = new Aralik();
        totalNoktaList[K2.karsiNoktaNo].aralikList.push(YeniAralik2);
        K2.karsiNoktaAralikNo = totalNoktaList[K2.karsiNoktaNo].aralikList.length - 1;
    }
    totalNoktaList[K2.karsiNoktaNo].aralikList[K2.karsiNoktaAralikNo].disabled = false;
    totalNoktaList[K2.karsiNoktaNo].aralikList[K2.karsiNoktaAralikNo].gelenUcNo = K2.uc2NoktaNo;
    totalNoktaList[K2.karsiNoktaNo].aralikList[K2.karsiNoktaAralikNo].gidenUcNo = K2.uc1NoktaNo;
    totalNoktaList[K2.karsiNoktaNo].aralikList[K2.karsiNoktaAralikNo].ucgeniciGelenKenarNo = 0;
    totalNoktaList[K2.karsiNoktaNo].aralikList[K2.karsiNoktaAralikNo].ucgeniciGidenKenarNo = 1;
    totalNoktaList[K2.karsiNoktaNo].aralikList[K2.karsiNoktaAralikNo].ucgeniciKarsiKenarNo = 2;

    // **Üçgen numarasını belirleme**
    if (world.backistikamet > -1) {
        EarSonUcgen = world.istikametList[world.backistikamet];
        totalNoktaList[K0.karsiNoktaNo].aralikList[K0.karsiNoktaAralikNo].ucgenNo = EarSonUcgen;
        totalNoktaList[K1.karsiNoktaNo].aralikList[K1.karsiNoktaAralikNo].ucgenNo = EarSonUcgen;
        totalNoktaList[K2.karsiNoktaNo].aralikList[K2.karsiNoktaAralikNo].ucgenNo = EarSonUcgen;

        yenilenecekKenarEkle(totalUcgenList[EarSonUcgen].kenarList, world);
        totalUcgenList[EarSonUcgen].kenarList = [...tmpucgen.kenarList];
    } else {
        EarSonUcgen = totalUcgenList.length;
        totalNoktaList[K0.karsiNoktaNo].aralikList[K0.karsiNoktaAralikNo].ucgenNo = EarSonUcgen;
        totalNoktaList[K1.karsiNoktaNo].aralikList[K1.karsiNoktaAralikNo].ucgenNo = EarSonUcgen;
        totalNoktaList[K2.karsiNoktaNo].aralikList[K2.karsiNoktaAralikNo].ucgenNo = EarSonUcgen;
        totalUcgenList.push(tmpucgen);
    }

    // **Özel komşuluk durumu (-5)**
    if (K0.komsuNo === -5) {
        if (Duz) {
            world.earKesisimKenarGidenUcgen = EarSonUcgen;
            totalUcgenList[world.earKesisimKenarGidenUcgen].cikilanKenarNo = 0;
        } else {
            world.earKesisimKenarGelenUcgen = EarSonUcgen;
            totalUcgenList[world.earKesisimKenarGelenUcgen].cikilanKenarNo = 0;
        }
    }
    if (K1.komsuNo === -5) {
        if (Duz) {
            world.earKesisimKenarGidenUcgen = EarSonUcgen;
            totalUcgenList[world.earKesisimKenarGidenUcgen].cikilanKenarNo = 1;
        } else {
            world.earKesisimKenarGelenUcgen = EarSonUcgen;
            totalUcgenList[world.earKesisimKenarGelenUcgen].cikilanKenarNo = 1;
        }
    }

    // **Komşu üçgenleri güncelleme**
    if (K0.komsuNo > -1) {
        totalUcgenList[K0.komsuNo].kenarList[K0.komsudaKacinciKenarNo].komsudaKacinciKenarNo = 0;
        totalUcgenList[K0.komsuNo].kenarList[K0.komsudaKacinciKenarNo].komsuNo = EarSonUcgen;
        K0.kenarPolyNo = totalUcgenList[K0.komsuNo].kenarList[K0.komsudaKacinciKenarNo].kenarPolyNo;
    }
    if (K1.komsuNo > -1) {
        totalUcgenList[K1.komsuNo].kenarList[K1.komsudaKacinciKenarNo].komsudaKacinciKenarNo = 1;
        totalUcgenList[K1.komsuNo].kenarList[K1.komsudaKacinciKenarNo].komsuNo = EarSonUcgen;
        K1.kenarPolyNo = totalUcgenList[K1.komsuNo].kenarList[K1.komsudaKacinciKenarNo].kenarPolyNo;
    }

    world.backistikamet--;
    return EarSonUcgen;
}

function yenilenecekKenarEkle(kenarListesi, world) {
    let yenilenecekKenarlar = world.yenilenecekKenarlar;
    const totalNoktaList = world.totalNoktaList;
    kenarListesi.filter(tmpKenar => tmpKenar.disKenar).forEach(tmpKenar => {

        if (tmpKenar.polyKenar == null || tmpKenar.polyKenar == undefined) {
            console.log('null veya undefined');
        }
        if (
            !totalNoktaList[tmpKenar.uc1NoktaNo].turemis &&
            !totalNoktaList[tmpKenar.uc2NoktaNo].turemis
        ) {
            const key = `${tmpKenar.uc1NoktaNo}_${tmpKenar.uc2NoktaNo}`;
            const keyReverse = `${tmpKenar.uc2NoktaNo}_${tmpKenar.uc1NoktaNo}`;

            let kenar = null;
            if (yenilenecekKenarlar.has(key)) {
                kenar = yenilenecekKenarlar.get(key);
            } else if (yenilenecekKenarlar.has(keyReverse)) {
                kenar = yenilenecekKenarlar.get(keyReverse);
            }
            if (kenar === null) {
                tmpKenar.yenile = true;
                // Eğer tmpKenar clone() metoduna sahip değilse, yeni bir Kenar örneği oluşturup özellikleri aktarıyoruz
                // TODO: Kenar nesnesi bazen yanlış oluşturuluyor. 
                // Aslında burada yapılması gereken kenar nesnesinin nerelerde yanlış oluşturulduğunu bulmaktır.
                if (typeof tmpKenar.clone === "function") {
                    yenilenecekKenarlar.set(key, tmpKenar.clone());
                } else {
                    const newKenar = Object.assign(
                        new Kenar(
                            tmpKenar.uc1NoktaNo,
                            tmpKenar.uc2NoktaNo,
                            tmpKenar.komsuNo,
                            tmpKenar.kenarPolyNo,
                            tmpKenar.karsiNoktaNo,
                            tmpKenar.komsudaKacinciKenarNo,
                            tmpKenar.karsiNoktaAralikNo,
                            tmpKenar.disKenar,
                            tmpKenar.polyKenar
                        ),
                        tmpKenar
                    );
                    newKenar.yenile = true;
                    if (newKenar.polyKenar == null || newKenar.polyKenar == undefined) {
                        console.log('null veya undefined');
                    }
                    newKenar.polyKenar = tmpKenar.polyKenar;

                    newKenar.disKenar = tmpKenar.disKenar;
                    yenilenecekKenarlar.set(key, newKenar);
                }
            } else {
                kenar.yenile = true;
                if (kenar.polyKenar == null || kenar.polyKenar == undefined) {
                    console.log('kenar polyKenar null veya undefined');
                }
            }
        }
    });
}