// SICAK YOL. Bu predicate objectOcc'un ~%64'unu tasiyor (n >= 250 gercek TSPLIB,
// CPU self-time: collKesisimHesapla %42.5 + icinden cagrilan mesafeHesapla %21.6;
// benchmarks/objectocc-cpuprof-d493-20260905.json). n = 1173'te tek rebuild'de
// 5.2 milyon cagri. Asagidaki duzenlemeler yalniz SABIT KATSAYI icindir:
// aritmetik ifadelerin islenenleri ve islem sirasi degismedi, dolayisiyla sonuc
// bit-birebir aynidir (Phase 9 §6.2 exact digest kapisi, §10 Adim 2).
function collKesisimHesapla(kenar, hangiNokta, finishNokta, minKesArea, totalNoktaList) {
    const cevap = new KesisimCevap();

    // İlgili noktaların alınması
    const p1 = totalNoktaList[kenar.uc1NoktaNo].kendiYeri;
    const p2 = totalNoktaList[kenar.uc2NoktaNo].kendiYeri;
    const p3 = hangiNokta.kendiYeri;
    const p4 = finishNokta;
    // Koordinatlar ve epsilon bir kez okunur; alan erisimi cagri basina
    // onlarca kez tekrarlaniyordu.
    const p1x = p1.x, p1y = p1.y, p2x = p2.x, p2y = p2.y;
    const p3x = p3.x, p3y = p3.y, p4x = p4.x, p4y = p4.y;
    const eps = epsilon;
    const dx12 = p1x - p2x, dy12 = p1y - p2y;
    const dx34 = p3x - p4x, dy34 = p3y - p4y;

    // İki doğru arasındaki determinant hesabı
    const det = dx12 * dy34 - dy12 * dx34;
    if (Math.abs(det) < eps) {
        // Doğrular paralel veya çakışık ise
        cevap.durum = 0;
        cevap.sifirKesisim = true;
        return cevap;
    }

    // Kesişim noktasının hesaplanması
    const numerator = (p1x * p2y - p1y * p2x);
    const cross34 = (p3x * p4y - p3y * p4x);
    const xi = (numerator * dx34 - dx12 * cross34) / det;
    const yi = (numerator * dy34 - dy12 * cross34) / det;
    // Yapicinin ayirdigi {x,y} yeniden kullanilir; eskiden her cagri bir nesne
    // ayirip yapicininkini cope atiyordu. Referans yalniz bu cevaba aittir.
    const kesisimNok = cevap.kesisimNok;
    kesisimNok.x = xi;
    kesisimNok.y = yi;

    // Kesişimin, her iki doğru parçası üzerinde olup olmadığının kontrolü
    const isOnSegment1 = ((p1x - xi) * (xi - p2x) >= 0) && ((p1y - yi) * (yi - p2y) >= 0);
    const isOnSegment2 = ((p3x - xi) * (xi - p4x) >= 0) && ((p3y - yi) * (yi - p4y) >= 0);

    if (isOnSegment1 && isOnSegment2) {
        // Her iki parça üzerinde ise; minKesArea kontrolü yapılıyor.
        // uc1toKN/uc2toKN birer karekoktur, tanim geregi >= 0'dir; bu yuzden
        // minKesArea <= 0 iken kosul HER ZAMAN dogrudur ve iki karekok
        // hesaplanmadan durum = 2 yazilabilir. Uretimdeki butun cagrilar
        // minKesArea = 0 verir. Bu dalda durum 1 veya 2 olur, hicbir zaman 0
        // olmaz; alanlari okuyan tek yer (_isValidProjection, yalniz
        // durum === 0 iken okur) buradan erisemez.
        if (minKesArea > 0) {
            const e1x = p1x - xi, e1y = p1y - yi;
            const e2x = p2x - xi, e2y = p2y - yi;
            cevap.uc1toKN = Math.sqrt(e1x * e1x + e1y * e1y);
            cevap.uc2toKN = Math.sqrt(e2x * e2x + e2y * e2y);
            if (cevap.uc1toKN >= minKesArea && cevap.uc2toKN >= minKesArea) {
                cevap.durum = 2;
            } else {
                cevap.durum = 0;
                cevap.sifirKesisim = true;
            }
        } else {
            cevap.durum = 2;
        }

        // Eğer kesişim noktası p4 noktasına denk geliyorsa
        if (Math.abs(xi - p4x) < eps && Math.abs(yi - p4y) < eps) {
            cevap.durum = 1;
        }
    } else {
        // Bu dalda uzakliklar karar degistirir (kolineerlik testi) ve durum 0
        // kalabildigi icin _isValidProjection tarafindan okunur; hesaplanir.
        const e1x = p1x - xi, e1y = p1y - yi;
        const e2x = p2x - xi, e2y = p2y - yi;
        cevap.uc1toKN = Math.sqrt(e1x * e1x + e1y * e1y);
        cevap.uc2toKN = Math.sqrt(e2x * e2x + e2y * e2y);

        // Kesilme uzunluklarının hesaplanması
        const kesenUzunlugu = Math.sqrt(dx34 * dx34 + dy34 * dy34);
        const e3x = p3x - xi, e3y = p3y - yi;
        const kesisimUzakligi = Math.sqrt(e3x * e3x + e3y * e3y);
        cevap.kesenUzunlugu = kesenUzunlugu;
        cevap.kesisimUzakligi = kesisimUzakligi;

        // İlgili açısal farkların (sinüs ve kosinüs farkı) hesaplanması
        const qSin = Math.abs(((xi - p3x) / kesisimUzakligi) - ((p4x - p3x) / kesenUzunlugu));
        const qCos = Math.abs(((yi - p3y) / kesisimUzakligi) - ((p4y - p3y) / kesenUzunlugu));

        if (qSin < 0.9 && qCos < 0.9) {
            const totalDistance = Math.sqrt(dx12 * dx12 + dy12 * dy12);
            if ((cevap.uc1toKN + cevap.uc2toKN - totalDistance) <= eps) {
                cevap.sifirKesisim = true;
                if ((kesenUzunlugu - kesisimUzakligi) <= 0.0) {
                    cevap.durum = 1;
                } else {
                    cevap.durum = 2;
                }
            }
        } else {
            cevap.durum = 0;
        }
    }

    return cevap;
}

function collKesisimHesaplaTest(kenar, hangiNokta, finishNokta, minKesArea, totalNoktaList) {
    const cevap = new KesisimCevap();

    // İlgili noktaların alınması
    const p1 = totalNoktaList[kenar.uc1NoktaNo].kendiYeri;
    const p2 = totalNoktaList[kenar.uc2NoktaNo].kendiYeri;
    const p3 = hangiNokta.kendiYeri;
    const p4 = finishNokta;

    // Determinant hesabı (ortak payda)
    const det = (p1.x - p2.x) * (p3.y - p4.y) - (p1.y - p2.y) * (p3.x - p4.x);

    if (Math.abs(det) < epsilon) { // epsilon yerine daha standart bir küçük sayı
        // Doğrular paralel veya çakışık
        cevap.durum = 0;
        cevap.sifirKesisim = true;
        return cevap;
    }

    // Parametrelerin pay kısımlarının hesaplanması
    const t_num = (p1.x - p3.x) * (p3.y - p4.y) - (p1.y - p3.y) * (p3.x - p4.x);
    const u_num = -((p1.x - p2.x) * (p1.y - p3.y) - (p1.y - p2.y) * (p1.x - p3.x));

    // t ve u parametrelerinin hesaplanması
    const t = t_num / det;
    const u = u_num / det;

    const isOnSegment1 = (t >= 0 && t <= 1);
    const isOnSegment2 = (u >= 0 && u <= 1);

    cevap.kesisimNok = {
        x: p1.x + t * (p2.x - p1.x),
        y: p1.y + t * (p2.y - p1.y)
    };

    // Kesişim sadece 1. doğru parçası (p1-p2) üzerindeyse ilgileniyoruz
    if (isOnSegment1) {
        if (isOnSegment2) {
            // DURUM 2 ve 3: Kesişim her iki doğru parçası üzerinde
            // Bu durumda mesafe hesabı gerekli
            const totalDistanceP1P2 = mesafeHesapla(p1, p2);
            cevap.uc1toKN = t * totalDistanceP1P2;
            cevap.uc2toKN = (1 - t) * totalDistanceP1P2;

            if (cevap.uc1toKN >= minKesArea && cevap.uc2toKN >= minKesArea) {
                cevap.durum = 2;
                cevap.sifirKesisim = false;
            } else {
                cevap.durum = 0;
                //cevap.sifirKesisim = true;            
            }
            if (Math.abs(cevap.kesisimNok.x - p4.x) < epsilon && Math.abs(cevap.kesisimNok.y - p4.y) < epsilon) {
                cevap.durum = 1;
            }
        } else {
            // DURUM 1 ve 0: Kesişim sadece 1. parça üzerinde, 2. parça üzerinde değil.
            // Orijinal koddaki qSin/qCos kontrolü, u'nun işaretini kontrol etmenin dolaylı bir yoluydu.
            if (u > 0) { // Kesişim p3->p4 ışını yönünde ama parça üzerinde değil
                cevap.durum = 1;
            } else { // Kesişim p3->p4 ışınının ters yönünde
                cevap.durum = 0;
            }
        }
    } else {
        // Kesişim p1-p2 doğru parçasının üzerinde değilse,
        // orijinal kodunuz bu durumu genellikle durum=0 olarak veya tanımsız bırakarak ele alıyordu.
        // Bu, genellikle "kesişim yok" olarak kabul edilir.
        cevap.durum = 0; // Veya senaryonuza uygun başka bir değer
        cevap.sifirKesisim = true;
    }

    // Eğer herhangi bir geçerli kesişim bulunduysa ve koordinatlar gerekiyorsa, burada hesaplanabilir.
    //if (cevap.durum >= 0 && cevap.durum <= 2) {

    //}

    return cevap;
}

function pointToPointQuery2(bakanNokta, hedefNokta, showCember, lookAralik, minKesArea, totalNoktaList, totalUcgenList, world) {
    const answer = new PointToAnswer();
    answer.polyNo = -7;
    answer.durum = 0;
    answer.sonKesilenDoluPoly = -1;
    answer.onKesilenDoluPoly = -1;
    answer.oncekiDoluKenar = null;
    answer.kesilenKenarSay = 0;
    answer.ihlal = false;

    if (!lookAralik.disabled) {
        let currentUcgen = totalUcgenList[lookAralik.ucgenNo];
        let neighborUcgen = currentUcgen;
        let volumKenar = currentUcgen.kenarList[lookAralik.ucgeniciKarsiKenarNo];
        const kesnok = collKesisimHesapla(volumKenar, bakanNokta, hedefNokta, minKesArea, totalNoktaList);

        if (kesnok.durum === 0) {
            answer.ihlal = true;
        }

        if (kesnok.durum > 0) {
            answer.ucgenNo = lookAralik.ucgenNo;
            answer.durum = 1;
            answer.polyNo = neighborUcgen.ucgenPolyNo;
            answer.kesNok = kesnok.kesisimNok;
            if (answer.polyNo > -1) {
                answer.kesilenKenarSay++;
                answer.sonKesilenDoluPoly = answer.polyNo;
            }

            if (kesnok.durum === 2) {
                do {
                    if (volumKenar.komsuNo >= 0) {
                        neighborUcgen = totalUcgenList[volumKenar.komsuNo];
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

                        if (answer.sonKesilenDoluPoly > -1) {
                            if (
                                (
                                    (volumKenar.uc1NoktaNo === bakanNokta.noktaNo) ||
                                    pointsEqual(totalNoktaList[volumKenar.uc1NoktaNo].kendiYeri, hedefNokta)
                                ) ||
                                (
                                    (volumKenar.uc2NoktaNo === bakanNokta.noktaNo) ||
                                    (pointsEqual(totalNoktaList[volumKenar.uc2NoktaNo].kendiYeri, hedefNokta))
                                )
                            ) {
                                answer.ihlal = false;
                            } else {
                                answer.ihlal = true;
                            }
                        }

                        if (answer.polyNo > -1) {
                            answer.kesilenKenarSay++;
                            if (answer.kesilenKenarSay > 1) answer.onKesilenDoluPoly = answer.sonKesilenDoluPoly;
                            answer.sonKesilenDoluPoly = answer.polyNo;
                        }

                        if (showCember) {
                            neighborUcgen.boya = true;
                        }

                        // Bakan nokta karşı noktada ise döngüden çık                        
                        if (pointsEqual(bakanNokta.kendiYeri, totalNoktaList[neighborUcgen.kenarList[volumKenar.komsudaKacinciKenarNo].karsiNoktaNo].kendiYeri)) {
                            break;
                        }

                        // Komşu kenarlar üzerinden kesişim sorgusu
                        const kenarNo1 = (volumKenar.komsudaKacinciKenarNo + 1) % 3;
                        const kenarNo2 = (volumKenar.komsudaKacinciKenarNo + 2) % 3;
                        const kesilenKenar1 = neighborUcgen.kenarList[kenarNo1];
                        const kesilenKenar2 = neighborUcgen.kenarList[kenarNo2];

                        const kesCev1 = collKesisimHesapla(kesilenKenar1, bakanNokta, hedefNokta, minKesArea, totalNoktaList);
                        if (kesCev1.durum === 2) {
                            volumKenar = kesilenKenar1;
                            answer.kesNok = kesCev1.kesisimNok;
                        } else {
                            const kesCev2 = collKesisimHesapla(kesilenKenar2, bakanNokta, hedefNokta, minKesArea, totalNoktaList);
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
                                answer.durum = 0;
                                answer.ihlal = true;
                                break;
                            }
                        }

                        if (volumKenar.komsuNo > -1) {
                            neighborUcgen = totalUcgenList[volumKenar.komsuNo];
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

                        if (volumKenar.komsuNo >= 0 && showCember) {
                            for (let cemberSay = 0; cemberSay <= 2; cemberSay++) {
                                if (mesafeHesapla(
                                    totalNoktaList[totalUcgenList[volumKenar.komsuNo].kenarList[cemberSay].uc1NoktaNo].kendiYeri,
                                    hedefNokta) < 2 /* Magnetism varsayılan olarak 1 alındı */ ||
                                    mesafeHesapla(
                                        totalNoktaList[totalUcgenList[volumKenar.komsuNo].kenarList[cemberSay].uc1NoktaNo].kendiYeri,
                                        answer.kesNok) < 2 /* Magnetism */) {
                                    world.getCemberList().push(totalUcgenList[volumKenar.komsuNo].kenarList[cemberSay].uc1NoktaNo);
                                }
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

                if (answer.sonKesilenDoluPoly > -1) {
                    if (!answer.ihlal) {
                        if (
                            (
                                volumKenar.uc1NoktaNo === bakanNokta.noktaNo ||
                                pointsEqual(totalNoktaList[volumKenar.uc1NoktaNo].kendiYeri, hedefNokta)
                            ) ||
                            (
                                volumKenar.uc2NoktaNo === bakanNokta.noktaNo ||
                                pointsEqual(totalNoktaList[volumKenar.uc2NoktaNo].kendiYeri, hedefNokta)
                            )
                        ) {
                            answer.ihlal = false;
                        } else {
                            answer.ihlal = true;
                        }
                    }
                }
            }

            if (volumKenar.komsuNo < 0) {
                answer.ihlal = true;
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

    /*if (!showCember) {  // geçici
        if (world.getCemberList().length > 0) {
            answer.ihlal = true;
        }
    }*/

    return answer;
}