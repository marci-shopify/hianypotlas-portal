// BÉTA pontozó – a szerveroldali ellenőrzés magja. Tiszta függvények (se hálózat, se adatbázis), ezért a
// test/beta.test.mjs Node-ból is futtatja. Az elv: az ügynök állításait nem hisszük el, hanem visszamérjük.
//   1) minden idézetet megkeresünk a feltöltött szövegben (az oldalszámot innen vesszük, nem az ügynöktől);
//   2) a felhívás minden „kötelező hangú” mondatára kell hivatkoznia egy tételnek, vagy indokolt elvetés kell;
//   3) kizáró hangú mondatot („jogosulatlan”, „elutasítjuk”, „nem nyújtható”…) csak kizáró tétel fedhet le;
//   4) a pontozótábla számai egymással egyeznek (szintek ↔ szempont ↔ csoport ↔ összesen).

// A PDF-ből kinyert szövegben szóközök szakítják meg a szavakat („va gy”, „minő sül”), ezért minden
// összehasonlítás csak betűkön és számokon megy.
export const norm = (s) => String(s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

const KO = ["jogosulatlan", "elutasít", "nemnyújtható", "nemnyújthatbe", "nemjogosult", "nemrészesülhet", "kizáróok"].map(norm);
const SOFT = ["nemtámogatható", "kizárólag", "nemhaladhatjameg", "meghaladja", "legalább", "minimum", "maximum", "legfeljebb",
  "vállalja", "vállalni", "köteles", "kötelező", "szükséges", "feltétele", "nemlehet", "nincslehetőség",
  "nemszámolhatóel", "nemelszámolható", "visszafizet"].map(norm);

export const TIPUS = ["jogosultsag", "kizaro_ok", "vallalas", "koltseg", "egyeb"];
export const ALLAPOT = ["megfelel", "nem_felel_meg", "kerdes", "nem_relevans"];
const FORRAS = ["megadott", "nyilvanos", "szamitas", "tanacsado", "nincs_adat"];

// docs: [{ name, pages: [szöveg] }] → dokumentumonként egy összefűzött, normalizált szöveg + oldalhatárok + jelölt mondatok.
export function indexDocs(docs) {
  return (docs || []).map((d, di) => {
    let text = "";
    const pageStart = [], cands = [];
    (d.pages || []).forEach((p, pi) => {
      pageStart.push(text.length);
      let k = 0;
      for (const raw of String(p).replace(/\s+/g, " ").split(/(?<=[.;:!?])\s+(?=[\p{L}\d(„"•-])/u)) {
        const n = norm(raw);
        const ko = KO.some((t) => n.includes(t));
        if (n.length >= 30 && !raw.includes("....") && (ko || SOFT.some((t) => n.includes(t))))
          cands.push({ id: `${di + 1}-${pi + 1}-${++k}`, dok: di + 1, oldal: pi + 1, start: text.length, end: text.length + n.length, ko, szoveg: raw.trim() });
        text += n;
      }
    });
    return { text, pageStart, cands };
  });
}
const pageOf = (doc, off) => { let p = 0; while (p + 1 < doc.pageStart.length && doc.pageStart[p + 1] <= off) p++; return p + 1; };

// Idézet → hol van. A „[…]” (vagy „…”) kihagyást jelöl: a darabok sorrendben, egymás közelében kellenek.
export function findQuote(idx, quote) {
  const frags = String(quote ?? "").split(/\[\s*(?:\.{3}|…)\s*\]|…|\.{3}/).map(norm).filter(Boolean);
  if (!frags.length) return { error: "üres idézet" };
  if (frags.some((f) => f.length < 10)) return { error: "túl rövid idézet(darab): legalább 10 betű kell" };
  for (const [di, d] of idx.entries()) {
    for (let from = d.text.indexOf(frags[0]); from >= 0; from = d.text.indexOf(frags[0], from + 1)) {
      const ranges = [[from, from + frags[0].length]];
      let pos = from + frags[0].length, ok = true;
      for (const f of frags.slice(1)) {
        const i = d.text.indexOf(f, pos);
        if (i < 0 || i - pos > 2500) { ok = false; break; }
        ranges.push([i, i + f.length]); pos = i + f.length;
      }
      if (ok) return { dok: di + 1, oldal: pageOf(d, from), ranges };
    }
  }
  return { error: "nem található a feltöltött szövegben" };
}

const isStr = (v) => typeof v === "string" && v.trim().length > 0;
const short = (s, n = 70) => { s = String(s).replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n) + "…" : s; };

// A kivonat ellenőrzése. Visszaad: { kesz, hibak, figyelmeztetesek, lefedetlen, elvetettek, stat, hely, oldalak }
export function checkCatalog(docs, cat) {
  const idx = indexDocs(docs);
  const hibak = [], figy = [], hely = {};
  const cover = idx.map(() => []);   // dokumentumonként: [start, end, kizáró-e]
  const perPage = idx.map((d) => d.pageStart.map(() => 0));
  let quotes = 0, found = 0;

  const quote = (key, label, q, ko, covers = true) => {
    for (const one of [q].flat()) {
      quotes++;
      const r = findQuote(idx, one);
      if (r.error) { hibak.push(`${label}: az idézet ${r.error} – „${short(one)}”`); continue; }
      found++;
      hely[key] ??= { dok: r.dok, oldal: r.oldal };
      perPage[r.dok - 1][r.oldal - 1]++;
      if (covers) for (const [s, e] of r.ranges) cover[r.dok - 1].push([s, e, ko]);
    }
  };

  if (!cat || typeof cat !== "object" || Array.isArray(cat)) return { kesz: false, hibak: ["A beküldött adat nem JSON objektum."], lefedetlen: [], stat: {}, hely: {}, oldalak: [] };
  const ids = new Set();
  const uniq = (id, label) => { if (!isStr(id)) hibak.push(`${label}: hiányzik az "id"`); else if (ids.has(id)) hibak.push(`${label}: az "${id}" azonosító kétszer szerepel`); else ids.add(id); };

  // ── feltételek ──
  const felt = Array.isArray(cat.feltetelek) ? cat.feltetelek : [];
  if (!felt.length) hibak.push('A "feltetelek" lista hiányzik vagy üres.');
  felt.forEach((f, i) => {
    const L = `feltetelek[${i}]${isStr(f?.id) ? ` (${f.id})` : ""}`;
    if (!f || typeof f !== "object") return hibak.push(`${L}: nem objektum`);
    uniq(f.id, L);
    if (!TIPUS.includes(f.tipus)) hibak.push(`${L}: a "tipus" csak ez lehet: ${TIPUS.join(", ")}`);
    if (typeof f.kizaro !== "boolean") hibak.push(`${L}: a "kizaro" kötelező (true/false)`);
    else if (!f.kizaro && (f.tipus === "jogosultsag" || f.tipus === "kizaro_ok")) hibak.push(`${L}: jogosultsági feltétel és kizáró ok mindig "kizaro": true`);
    for (const k of ["cim", "leiras", "kerdes"]) if (!isStr(f[k])) hibak.push(`${L}: hiányzik a "${k}"`);
    if (!f.idezet || ![f.idezet].flat().every(isStr)) hibak.push(`${L}: hiányzik az "idezet"`);
    else quote(f.id, L, f.idezet, f.kizaro === true);
  });

  // ── pontozás ──
  const pz = cat.pontozas;
  let szempontok = 0;
  if (!("pontozas" in cat)) hibak.push('A "pontozas" kulcs hiányzik (ha a felhívásban nincs pontozás: "pontozas": null).');
  if (pz != null) {
    const soft = isStr(pz.elteres) ? figy : hibak;   // ha a felhívás számai maguk sem egyeznek, az ügynök ezt megindokolhatja
    if (typeof pz.max !== "number") hibak.push('pontozas: hiányzik a "max" (szám)');
    if (pz.min != null && typeof pz.min !== "number") hibak.push('pontozas: a "min" szám vagy null');
    const csop = Array.isArray(pz.csoportok) ? pz.csoportok : [];
    if (!csop.length) hibak.push('pontozas: a "csoportok" lista hiányzik vagy üres');
    let total = 0;
    csop.forEach((c, ci) => {
      const CL = `pontozas.csoportok[${ci}]${isStr(c?.id) ? ` (${c.id})` : ""}`;
      if (!isStr(c?.id) || !isStr(c?.cim) || typeof c?.max !== "number") return hibak.push(`${CL}: "id", "cim" és "max" kötelező`);
      if (c.min != null && typeof c.min !== "number") hibak.push(`${CL}: a "min" szám vagy null`);
      let sum = 0;
      (Array.isArray(c.szempontok) ? c.szempontok : []).forEach((s, si) => {
        const SL = `${CL}.szempontok[${si}]${isStr(s?.id) ? ` (${s.id})` : ""}`;
        if (!s || typeof s !== "object") return hibak.push(`${SL}: nem objektum`);
        szempontok++;
        uniq(s.id, SL);
        for (const k of ["cim", "kerdes"]) if (!isStr(s[k])) hibak.push(`${SL}: hiányzik a "${k}"`);
        const sz = Array.isArray(s.szintek) ? s.szintek : [];
        if (sz.length < 2) hibak.push(`${SL}: legalább két "szintek" elem kell`);
        sz.forEach((z, zi) => {
          if (!isStr(z?.ha)) hibak.push(`${SL}.szintek[${zi}]: hiányzik a "ha"`);
          if (z?.jogosulatlan !== true && typeof z?.pont !== "number") hibak.push(`${SL}.szintek[${zi}]: "pont" (szám) vagy "jogosulatlan": true kell`);
        });
        const top = Math.max(0, ...sz.filter((z) => typeof z?.pont === "number").map((z) => z.pont));
        if (typeof s.max !== "number") hibak.push(`${SL}: hiányzik a "max" (szám)`);
        else { sum += s.max; if (top !== s.max) soft.push(`${SL}: a legmagasabb szint ${top} pont, de a "max" ${s.max}`); }
        if (!s.idezet || ![s.idezet].flat().every(isStr)) hibak.push(`${SL}: hiányzik az "idezet"`);
        else quote(s.id, SL, s.idezet, sz.some((z) => z?.jogosulatlan === true));
      });
      if (!sum) hibak.push(`${CL}: nincs szempontja`);
      else if (sum !== c.max) soft.push(`${CL}: a szempontok maximuma összesen ${sum}, de a csoport "max" értéke ${c.max} – hiányzik szempont, vagy egy összeadódó részt nem bontottál külön szempontra`);
      total += c.max;
    });
    if (csop.length && typeof pz.max === "number" && total !== pz.max) soft.push(`pontozas: a csoportok maximuma összesen ${total}, de a "max" ${pz.max}`);
  }

  // ── tények, hivatkozott dokumentumok ──
  const teny = Array.isArray(cat.tenyek) ? cat.tenyek : [];
  if (!teny.length) hibak.push('A "tenyek" lista hiányzik vagy üres.');
  teny.forEach((t, i) => {
    const L = `tenyek[${i}]`;
    if (!isStr(t?.cimke) || !isStr(t?.ertek)) return hibak.push(`${L}: "cimke" és "ertek" kötelező`);
    if (!t.idezet || ![t.idezet].flat().every(isStr)) hibak.push(`${L} (${t.cimke}): hiányzik az "idezet"`);
    else quote(`t${i}`, `${L} (${t.cimke})`, t.idezet, false, false);
  });
  if (!Array.isArray(cat.hivatkozott)) hibak.push('A "hivatkozott" lista hiányzik (lehet üres: []).');
  else cat.hivatkozott.forEach((x, i) => {
    if (!isStr(x?.nev) || !isStr(x?.miert)) return hibak.push(`hivatkozott[${i}]: "nev" és "miert" kötelező`);
    if (x.idezet != null && ![x.idezet].flat().every(isStr)) hibak.push(`hivatkozott[${i}] (${x.nev}): az "idezet" szöveg vagy szöveglista`);
    else if (x.idezet != null) quote(`h${i}`, `hivatkozott[${i}] (${x.nev})`, x.idezet, false, false);
  });

  // ── lefedettség: minden jelölt mondatra hivatkozik tétel, vagy indokkal el van vetve ──
  const elv = cat.elvetett && typeof cat.elvetett === "object" && !Array.isArray(cat.elvetett) ? cat.elvetett : {};
  const lefedetlen = [], elvetettek = [];
  let jeloltek = 0, lefedett = 0, elvetett = 0;
  const uncovered = idx.map((d) => d.pageStart.map(() => 0));
  idx.forEach((d, di) => d.cands.forEach((c) => {
    jeloltek++;
    // Érdemi átfedés kell (a szomszéd mondatból átlógó pár szó nem elég); a kihagyásos idézet darabjai összeadódnak.
    // Egy idézetdarab akkor fedi a mondatot, ha teljesen benne van; a csak részben belelógó darabokból legalább 30 betű kell.
    const need = Math.min(30, (c.end - c.start) / 2);
    const covered = (ko) => {
      let sum = 0;
      for (const [s, e, k] of cover[di]) {
        if (ko && !k) continue;
        if (s >= c.start && e <= c.end) return true;
        sum += Math.max(0, Math.min(e, c.end) - Math.max(s, c.start));
      }
      return sum >= need;
    };
    const softOnly = c.ko && covered(false) && !covered(true);
    if (covered(false) && !softOnly) return lefedett++;
    if (isStr(elv[c.id]) && elv[c.id].trim().length >= 3) { elvetettek.push({ id: c.id, dok: c.dok, oldal: c.oldal, szoveg: c.szoveg, ok: elv[c.id].trim(), kizaro: c.ko }); return elvetett++; }
    uncovered[di][c.oldal - 1]++;
    lefedetlen.push({ id: c.id, dok: c.dok, oldal: c.oldal, szoveg: c.szoveg,
      ...(softOnly ? { megjegyzes: 'Kizáró hangú mondat, de csak nem kizáró tétel hivatkozik rá: a tétel legyen "kizaro": true (pontozási szempontnál "jogosulatlan": true szint), vagy vesd el indokkal.' } : {}) });
  }));
  const known = new Set(idx.flatMap((d) => d.cands.map((c) => c.id)));
  for (const k of Object.keys(elv)) if (!known.has(k)) figy.push(`elvetett: nincs "${k}" azonosítójú mondat`);

  return {
    kesz: !hibak.length && !lefedetlen.length, hibak, figyelmeztetesek: figy, lefedetlen, elvetettek, hely,
    oldalak: idx.map((_, di) => ({ tetel: perPage[di], lefedetlen: uncovered[di] })),
    stat: {
      oldalak: idx.reduce((n, d) => n + d.pageStart.length, 0), idezetek: quotes, megtalalt: found,
      jeloltek, lefedett, elvetett, feltetelek: felt.length, kizaro: felt.filter((f) => f?.kizaro === true).length, szempontok,
    },
  };
}

// A kivonat tételei egy listában (az értékelés ezekre ad választ).
export const catalogIds = (cat) => ({
  feltetelek: (cat?.feltetelek || []).map((f) => f.id),
  szempontok: (cat?.pontozas?.csoportok || []).flatMap((c) => c.szempontok || []),
});

// Egy vállalkozás értékelésének ellenőrzése a kivonathoz képest. Visszaad: { kesz, hibak, stat }
export function checkEval(cat, res) {
  const hibak = [];
  if (!res || typeof res !== "object" || Array.isArray(res)) return { kesz: false, hibak: ["A beküldött adat nem JSON objektum."], stat: {} };
  const { feltetelek, szempontok } = catalogIds(cat);
  const src = (L, x, open) => {
    if (!FORRAS.includes(x.forras)) return hibak.push(`${L}: a "forras" csak ez lehet: ${FORRAS.join(", ")}`);
    if (x.forras === "nincs_adat" && !open) hibak.push(`${L}: "nincs_adat" forrással nem lehet dönteni – ilyenkor kérdés kell (találgatni tilos)`);
    if (x.forras === "nyilvanos" && !isStr(x.hivatkozas)) hibak.push(`${L}: nyilvános forrásnál kötelező a "hivatkozas" (URL és mit néztél meg)`);
  };
  const F = res.feltetelek && typeof res.feltetelek === "object" ? res.feltetelek : {};
  let nyitott = 0;
  for (const id of feltetelek) {
    const x = F[id], L = `feltetelek.${id}`;
    if (!x || typeof x !== "object") { hibak.push(`${L}: hiányzik (minden feltételre kell válasz)`); continue; }
    if (!ALLAPOT.includes(x.allapot)) { hibak.push(`${L}: az "allapot" csak ez lehet: ${ALLAPOT.join(", ")}`); continue; }
    if (!isStr(x.indok)) hibak.push(`${L}: hiányzik az "indok"`);
    const open = x.allapot === "kerdes";
    if (open) { nyitott++; if (!isStr(x.kerdes)) hibak.push(`${L}: "kerdes" állapotnál kötelező a tanácsadónak szóló konkrét "kerdes"`); }
    src(L, x, open);
  }
  for (const k of Object.keys(F)) if (!feltetelek.includes(k)) hibak.push(`feltetelek.${k}: nincs ilyen azonosító a kivonatban`);

  const P = res.pontok && typeof res.pontok === "object" ? res.pontok : {};
  for (const s of szempontok) {
    const x = P[s.id], L = `pontok.${s.id}`;
    if (!x || typeof x !== "object") { hibak.push(`${L}: hiányzik (minden szempontra kell válasz)`); continue; }
    const open = x.szint == null;
    if (!open && !(Number.isInteger(x.szint) && x.szint >= 0 && x.szint < s.szintek.length)) { hibak.push(`${L}: a "szint" a szintek sorszáma (0–${s.szintek.length - 1}) vagy null`); continue; }
    if (!isStr(x.indok)) hibak.push(`${L}: hiányzik az "indok"`);
    if (open) { nyitott++; if (!isStr(x.kerdes)) hibak.push(`${L}: ha a "szint" null, kötelező a konkrét "kerdes"`); }
    src(L, x, open);
  }
  for (const k of Object.keys(P)) if (!szempontok.some((s) => s.id === k)) hibak.push(`pontok.${k}: nincs ilyen azonosító a kivonatban`);

  if (!Array.isArray(res.adatok)) hibak.push('Az "adatok" lista hiányzik.');
  else res.adatok.forEach((a, i) => { if (!isStr(a?.cimke) || !isStr(a?.ertek) || !isStr(a?.forras)) hibak.push(`adatok[${i}]: "cimke", "ertek" és "forras" kötelező`); });
  if (!isStr(res.osszegzes)) hibak.push('Hiányzik az "osszegzes".');
  if (!Array.isArray(res.teendok)) hibak.push('A "teendok" lista hiányzik (lehet üres: []).');

  return { kesz: !hibak.length, hibak, stat: { feltetelek: feltetelek.length, szempontok: szempontok.length, nyitott } };
}
