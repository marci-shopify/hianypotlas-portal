// A béta pontozó ellenőrző magjának próbája (supabase/functions/beta/check.js). Futtatás: node test/beta.test.mjs
import assert from "node:assert/strict";
import { checkCatalog, checkEval, findQuote, indexDocs } from "../supabase/functions/beta/check.js";
import { callTask, evalTask } from "../supabase/functions/beta/tasks.js";
import { docs, base, good as goodCat, res } from "./beta.fixture.mjs";


let n = 0;
const ok = (c, label) => { n++; assert.ok(c, label); };
const idx = indexDocs(docs);

// idézet: szóköz-hibák és sortörés nem számít; lábjegyzetszám miatt […] kell; az oldalszámot a szerver adja
ok(findQuote(idx, "üzleti  évben minimum 3fő volt").oldal === 1, "idézet megtalálva, 1. oldal");
ok(findQuote(idx, "heti 20 órás […] munkaidőben").oldal === 2, "kihagyásos idézet, 2. oldal");
ok(findQuote(idx, "heti 20 órás munkaidőben").error, "beékelődött lábjegyzetszám miatt kihagyás nélkül nincs találat");
ok(findQuote(idx, "legalább 5 fő női munkavállalót").error, "kitalált idézet nincs meg");
ok(findQuote(idx, "rövid").error, "túl rövid idézet elutasítva");

// a valódi hiba: a „Jogosulatlan” mondatot nem kizáró tétel fedi → lefedetlen marad
let r = checkCatalog(docs, base());
ok(!r.kesz, "elbagatellizált kivonat nincs kész");
ok(r.lefedetlen.some((l) => l.oldal === 3 && l.megjegyzes), "a Jogosulatlan-mondat lefedetlen, magyarázattal");
ok(r.hely.F02.oldal === 2 && r.hely["III.2"].oldal === 3, "oldalszám az idézetből");

// javítva: jogosulatlan szint a szempontnál → kész
const good = goodCat();
r = checkCatalog(docs, good);
ok(r.kesz, `javított kivonat kész (${JSON.stringify([r.hibak, r.lefedetlen.map((l) => l.szoveg)])})`);
ok(r.stat.megtalalt === r.stat.idezetek && r.stat.kizaro === 2, "statisztika");

// szerkezeti szabályok
let bad = base(); bad.feltetelek[0].kizaro = false;
ok(checkCatalog(docs, bad).hibak.some((h) => /mindig "kizaro": true/.test(h)), "jogosultsági feltétel nem lehet nem kizáró");
bad = base(); bad.pontozas.csoportok[0].max = 15;
ok(checkCatalog(docs, bad).hibak.some((h) => /szempontok maximuma összesen 5/.test(h)), "pontozótábla összege nem egyezik");
bad.pontozas.elteres = "a felhívás maga hibás";
r = checkCatalog(docs, bad);
ok(!r.hibak.some((h) => /maximuma/.test(h)) && r.figyelmeztetesek.length, "indokolt eltérés csak figyelmeztetés");
bad = base(); bad.feltetelek[1].idezet = "legalább 2 fő női munkavállalót foglalkoztat";
ok(checkCatalog(docs, bad).hibak.some((h) => /nem található/.test(h)), "hamis idézet hiba");
bad = base(); bad.feltetelek.push({ ...bad.feltetelek[0] });
ok(checkCatalog(docs, bad).hibak.some((h) => /kétszer szerepel/.test(h)), "ismétlődő azonosító");
ok(!checkCatalog(docs, "nem json").kesz && !checkCatalog(docs, []).kesz, "nem objektum");

// az átnézés (2026-11-24) nyomán: tény idézete nem fed le, a "pontozas" kulcs kötelező, idézet-lista a tényeknél is jó
bad = goodCat(); bad.feltetelek.splice(1, 1); bad.tenyek.push({ cimke: "Női munkavállaló", ertek: "1 fő", idezet: ["legalább 1 fő női munkavállalót foglalkoztat minimum heti 20 órás"] });
r = checkCatalog(docs, bad);
ok(!r.hibak.length && r.lefedetlen.some((l) => l.oldal === 2), "vállalás-mondatot tény idézete nem fed le");
bad = goodCat(); delete bad.pontozas;
ok(checkCatalog(docs, bad).hibak.some((h) => /"pontozas" kulcs hiányzik/.test(h)), "hiányzó pontozás nem csúszik át");
for (const junk of [{ feltetelek: { F01: {} } }, { feltetelek: [null] }, { pontozas: { max: 10 } }, { pontozas: "nincs" }, { tenyek: [null] }, { hivatkozott: "x" },
  { pontozas: { max: 5, csoportok: [null] } }, { pontozas: { max: 5, csoportok: [{ id: "I", cim: "x", max: 5 }] } }, { pontozas: { max: 5, csoportok: [{ id: "I", cim: "x", max: 5, szempontok: [{ id: "S", szintek: [null, { ha: "x", pont: "5" }] }] }] } }])
  ok(checkCatalog(docs, { ...goodCat(), ...junk }).hibak.length > 0, `torz kivonat hibát ad, nem mentődik: ${JSON.stringify(junk).slice(0, 40)}`);
for (const junk of [{ teendok: "szöveg" }, { adatok: "x" }, { adatok: [null] }, { feltetelek: null }, { pontok: [] }])
  ok(!checkEval(good, { ...res(), ...junk }).kesz, `torz értékelés nem kész: ${JSON.stringify(junk)}`);

// elvetés indokkal lefedi a mondatot
const cand = checkCatalog(docs, base()).lefedetlen[0];
bad = base(); bad.elvetett[cand.id] = "teszt indok";
ok(!checkCatalog(docs, bad).lefedetlen.some((l) => l.id === cand.id), "indokolt elvetés elfogadva");

// értékelés
r = checkEval(good, res());
ok(r.kesz && r.stat.nyitott === 1, `helyes értékelés kész (${r.hibak})`);
let e = res(); delete e.feltetelek.F02;
ok(checkEval(good, e).hibak.some((h) => /F02: hiányzik/.test(h)), "kimaradt feltétel");
e = res(); e.feltetelek.F02 = { allapot: "megfelel", indok: "biztos vállalja", forras: "nincs_adat" };
ok(checkEval(good, e).hibak.some((h) => /találgatni tilos/.test(h)), "adat nélküli döntés elutasítva");
e = res(); e.pontok["III.2"].szint = 3;
ok(checkEval(good, e).hibak.some((h) => /sorszáma/.test(h)), "nem létező szint");
e = res(); delete e.pontok["III.2"].hivatkozas;
ok(checkEval(good, e).hibak.some((h) => /hivatkozas/.test(h)), "nyilvános forrás hivatkozás nélkül");
e = res(); e.feltetelek.X9 = e.feltetelek.F01;
ok(checkEval(good, e).hibak.some((h) => /nincs ilyen azonosító/.test(h)), "ismeretlen azonosító");

// a feladat szövege tartalmazza az adatot, a megjegyzést és a beküldési címet
const call = { title: "Teszt felhívás", docs, catalog: good, notes: { _: "Nézd át a 2. oldalt", F02: "ez kizáró!" } };
let t = callTask(call, "https://x/beta?t=f1");
ok(t.includes("2. oldal =====") && t.includes("ez kizáró!") && t.includes("https://x/beta?t=f1") && t.includes('"F02"'), "felhívás-feladat");
t = evalTask({ company: "Minta Kft.", tax_no: "123", facts: "7 fő", manual: { feltetelek: { F02: { valasz: "igen, vállalja" } } }, result: null }, call, "https://x/beta?t=e1", false);
ok(t.includes("Minta Kft.") && t.includes("igen, vállalja") && t.includes('"III.2"') && !t.includes("2. oldal ====="), "értékelés-feladat");

// ── a minősítés (docs/beta.js verdict): mindig a portál számol, nem az ügynök ──
const { verdict } = await import("../docs/beta.js");
const ev = (result, manual = {}) => ({ result, manual });
let v = verdict(good, ev(null));
ok(v.state === "nincs", "értékelés nélkül: nincs minősítés");
v = verdict(good, ev(res()));                                        // F02 kizáró és nyitott; III.2 = női projektvezető (5 pont)
ok(v.state === "kerdes" && v.koOpen === 1 && v.lo === 5 && v.hi === 5, "nyitott kizáró kérdés: még nem dönthető el");
v = verdict(good, ev(res(), { feltetelek: { F02: { allapot: "megfelel" } } }));
ok(v.state === "ok", "a tanácsadó döntése után: megfelel");
v = verdict(good, ev(res(), { feltetelek: { F02: { allapot: "nem_felel_meg" } } }));
ok(v.state === "nem" && v.koFail.length === 1, "kizáró feltétel nem teljesül: jogosulatlan");
v = verdict(good, ev(res(), { feltetelek: { F02: { allapot: "megfelel" } }, pontok: { "III.2": { szint: 0 } } }));
ok(v.state === "nem" && /női/.test(v.koFail[0]), "„jogosulatlan” pontozási szint: jogosulatlan, bármennyi a pont");
v = verdict(good, ev(res(), { feltetelek: { F02: { allapot: "megfelel" } }, pontok: { "III.2": { szint: 1 } } }));
ok(v.state === "pont" && v.hi === 0, "0 pont a 3-as küszöbhöz: nem éri el a pontküszöböt");
const open = res(); open.pontok["III.2"] = { szint: null, indok: "nincs adat", forras: "nincs_adat", kerdes: "?" };
v = verdict(good, ev(open, { feltetelek: { F02: { allapot: "megfelel" } } }));
ok(v.state === "kerdes" && v.lo === 0 && v.hi === 5 && v.openPts === 1, "nyitott szempont: pontsáv 0–5, a küszöb még elérhető");
const noMin = goodCat(); noMin.pontozas.min = null;
v = verdict(noMin, ev(open, { feltetelek: { F02: { allapot: "megfelel" } } }));
ok(v.state === "kerdes" && v.koOpen === 1, "nyitott szempont „jogosulatlan” szinttel: küszöb nélkül sem lehet zöld");

console.log(`OK – ${n} ellenőrzés sikeres`);
