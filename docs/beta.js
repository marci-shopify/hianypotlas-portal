/* Pályázatsegítő – BÉTA pontozó. Külön modul: csak akkor töltődik be, ha az admin bekapcsolta a bétát
   (Beállítások), és megnyitja a „Pontozó” fület. Az éles felület (app.js) ebből semmit nem használ.
   Felhívás (PDF) → az AI-ügynök kivonata (a szerver visszaméri) → vállalkozásonként értékelés.
   Leírás: AGENTS.md 13. pont. A végső minősítést és a pontokat MINDIG ez a fájl számolja (verdict), nem az ügynök. */

import { pdfPages } from "./hp-parse.js";

let X;                                   // az app.js-től kapott segédek: sb, cfg, h, need, run, toast, modal, …
const h = (...a) => X.h(...a);
const open = new Map();                  // lenyitott lapok (újrarajzolás után megmarad)
const docMeta = new Map();               // felhívás id → [{ name, pages }] (a 300 kB-os szöveget csak egyszer töltjük le)
let filter = "mind";

const TIPUS = { jogosultsag: "Jogosultság", kizaro_ok: "Kizáró ok", vallalas: "Vállalás", koltseg: "Költségszabály", egyeb: "Egyéb" };
const ALLAPOT = { nem_felel_meg: "Nem felel meg", kerdes: "Kérdés", megfelel: "Megfelel", nem_relevans: "Nem releváns" };
const SCLS = { megfelel: "s-elfogadva", nem_felel_meg: "s-javitando", kerdes: "s-feltoltve", nem_relevans: "s-hianyzik" };
const FORRAS = { megadott: "megadott adat", tanacsado: "az Ön válasza", nyilvanos: "nyilvános forrás", szamitas: "számítás", nincs_adat: "nincs adat" };

export async function betaView(ctx, parts) {
  X = ctx;
  if (!document.getElementById("bx-css")) document.head.append(h("link", { id: "bx-css", rel: "stylesheet", href: `beta.css?v=${ctx.v}` }));
  const [kind, id] = parts;
  return kind === "f" && id ? callView(id) : kind === "e" && id ? evalView(id) : listView();
}

// ───────────────────────── segédek ─────────────────────────

const stamp = (cls, text) => h("span", { class: `stamp ${cls}` }, text);
const plural = (n, word) => `${n} ${word}`;
const fnUrl = (t) => `${X.cfg.supabaseUrl}/functions/v1/beta?t=${t}`;
async function fn(body) {
  const { data, error } = await X.sb.functions.invoke("beta", { body });
  if (error) {
    let msg = error.message;
    try { msg = (await error.context.json()).error || msg; } catch { /* nem JSON válasz */ }
    throw new Error(msg);
  }
  return data;
}
// Az ügynök kódja: csak ehhez az egy sorhoz ad hozzáférést, 30 napig. Lejárat előtt a megnyitás megújítja.
const newToken = (prefix) => ({
  agent_token: prefix + (crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", ""),
  agent_expires: new Date(Date.now() + 30 * 864e5).toISOString(),
});
async function ensureToken(table, row, prefix) {
  if (row.agent_token && new Date(row.agent_expires) - Date.now() > 864e5) return;
  const patch = newToken(prefix);
  X.need(await X.sb.from(table).update(patch).eq("id", row.id));
  Object.assign(row, patch);
}
async function readPdf(file) {
  const pdfjs = await import("./vendor/pdfjs/pdf.min.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("./vendor/pdfjs/pdf.worker.min.mjs", import.meta.url).href;
  const pages = (await pdfPages(pdfjs, new Uint8Array(await file.arrayBuffer()))).map((rows) => rows.map((r) => r.text).join("\n"));
  if (pages.join("").length < 200) throw new Error(`„${file.name}”: ebben a PDF-ben nincs kinyerhető szöveg (szkennelt kép). Szöveges PDF kell.`);
  return { name: file.name, pages };
}
const details = (key, cls, summary, body) => h("details", { class: `point bx-item ${cls}`, open: open.get(key) || null, ontoggle: (ev) => open.set(key, ev.target.open) },
  h("summary", {}, summary), h("div", { class: "body" }, body));
const pills = (cur, opts, on) => h("div", { class: "bx-pills" }, opts.filter(([, , n]) => n !== 0).map(([key, label, n]) =>
  h("button", { class: cur === key ? "on" : null, onclick: () => on(key) }, label, n != null && h("i", {}, n))));
const quotes = (q, where) => [q].flat().filter(Boolean).map((t, i) => h("blockquote", { class: "bx-quote" }, t,
  i === 0 && where && h("cite", {}, `${where.oldal}. oldal`)));

const PROMPT = {
  call: (url) => `Egy pályázati felhívás teljes kivonatát kell elkészítened a Pályázatsegítő portálra.

1. Töltsd le a feladatot (benne a részletes útmutató és a felhívás teljes szövege):
   curl -s "${url}" -o feladat.md
2. Olvasd végig az egész fájlt az elejétől a végéig, és pontosan kövesd az útmutatót.
3. Az eredményt JSON fájlként küldd be:
   curl -s -X POST "${url}" -H "Content-Type: application/json" --data-binary @eredmeny.json
4. A válasz megmondja, mi hibás és mi maradt ki. Javítsd, és küldd be újra, amíg "kesz": true nem jön vissza.

Ne rövidíts: a portál minden idézetet visszakeres a felhívásban, és megszámolja a kihagyott kötelező mondatokat.
Windowson curl.exe-t használj. Ha nem éred el a címet, állj meg, és szólj nekem.`,
  eval: (url) => `Egy vállalkozást kell előminősítened egy pályázati felhívásra a Pályázatsegítő portálon.

1. Töltsd le a feladatot (benne a részletes útmutató, a felhívás ellenőrzött kivonata és a vállalkozás adatai):
   curl -s "${url}" -o feladat.md
2. Olvasd végig az egész fájlt, és pontosan kövesd az útmutatót.
3. Az eredményt JSON fájlként küldd be:
   curl -s -X POST "${url}" -H "Content-Type: application/json" --data-binary @eredmeny.json
4. A válasz megmondja, mi hibás. Javítsd, és küldd be újra, amíg "kesz": true nem jön vissza.

Ne találgass: amire nincs adat, arra kérdést írj – a portálon válaszolok rá, és újra lefuttatlak.
Windowson curl.exe-t használj. Ha nem éred el a címet, állj meg, és szólj nekem.`,
};

// A kimásolható prompt + a kézi út (ha az ügynök nem éri el az internetet): feladat letöltése, eredmény beillesztése.
function agentBox(kind, row, title, sub) {
  const text = PROMPT[kind](fnUrl(row.agent_token));
  return h("section", { class: "card bx-agent" },
    h("h2", {}, title), h("p", { class: "muted" }, sub),
    h("textarea", { class: "bx-prompt", readonly: true, rows: 6, "aria-label": "Prompt az AI-ügynöknek", value: text, onfocus: (ev) => ev.target.select() }),
    h("div", { class: "row" },
      h("button", { class: "btn primary", onclick: (ev) => X.run(ev.target, async () => { await navigator.clipboard.writeText(text); ev.target.textContent = "✓ Kimásolva"; }) }, "Prompt másolása"),
      h("button", { class: "btn", onclick: () => X.refresh() }, "Eredmény frissítése"),
      h("button", { class: "btn quiet", title: "Ha az ügynök nem éri el az internetet: ezt a fájlt adja oda neki", onclick: (ev) => X.run(ev.target, async () => {
        const { text: task } = await fn({ action: "task", kind, id: row.id });
        const a = h("a", { href: URL.createObjectURL(new Blob([task], { type: "text/markdown" })), download: "feladat.md" });
        a.click(); URL.revokeObjectURL(a.href);
      }) }, "Feladat letöltése"),
      h("button", { class: "btn quiet", title: "Ha az ügynök nem tudja beküldeni: illessze be ide a kapott JSON-t", onclick: () => pasteDialog(kind, row) }, "Eredmény beillesztése")));
}

function pasteDialog(kind, row) {
  X.modal("Eredmény beillesztése", (close) => {
    const box = h("textarea", { rows: 9, placeholder: "{ … az ügynöktől kapott JSON … }", "aria-label": "Az ügynök eredménye" });
    const out = h("div", {});
    return [box, out, h("div", { class: "row end actions" },
      h("button", { class: "btn", onclick: () => { close(); X.refresh(); } }, "Bezárás"),
      h("button", { class: "btn primary", onclick: (ev) => X.run(ev.target, async () => {
        let data;
        try { data = JSON.parse(box.value.replace(/^[^{]*/, "").replace(/[^}]*$/, "")); } catch { throw new Error("Ez nem érvényes JSON. A teljes választ illessze be, a nyitó { jeltől a záró } jelig."); }
        const rep = await fn({ action: "submit", kind, id: row.id, data });
        if (rep.kesz) { close(); X.toast("Rendben: minden ellenőrzésen átment."); return X.refresh(); }
        if (!(rep.hibak || []).length) X.toast("Mentve, de az ügynöknek még van dolga.");
        const back = [...(rep.hibak || []).map((x) => `HIBA: ${x}`), ...(rep.lefedetlen || []).map((l) => `LEFEDETLEN ${l.id} (${l.oldal}. oldal): ${l.szoveg}${l.megjegyzes ? ` – ${l.megjegyzes}` : ""}`)].join("\n");
        out.replaceChildren(h("p", { class: "notice" }, `Még nincs kész: ${(rep.hibak || []).length} hiba${(rep.hibak || []).length ? " (ezért nincs elmentve)" : ""}, ${(rep.lefedetlen || []).length} lefedetlen mondat. Ezt másolja vissza az ügynöknek:`),
          h("textarea", { rows: 7, readonly: true, value: `Javítsd ki ezeket, és add vissza újra a TELJES JSON-t:\n${back}`, onfocus: (e) => e.target.select() }));
      }) }, "Ellenőrzés és mentés"))];
  });
}

// ───────────────────────── a minősítés (mindig itt számoljuk, nem az ügynök) ─────────────────────────

const stateOf = (ev, f) => ev.manual?.feltetelek?.[f.id]?.allapot || ev.result?.feltetelek?.[f.id]?.allapot || "kerdes";
const levelOf = (ev, s) => {
  const m = ev.manual?.pontok?.[s.id]?.szint, r = ev.result?.pontok?.[s.id]?.szint;
  const v = m != null ? m : r;
  return Number.isInteger(v) && s.szintek[v] ? v : null;
};
export function verdict(cat, ev) {
  const items = (cat.feltetelek || []).map((f) => ({ f, s: stateOf(ev, f) }));
  const koFail = items.filter((x) => x.f.kizaro && x.s === "nem_felel_meg").map((x) => x.f.cim);
  let koOpen = items.filter((x) => x.f.kizaro && x.s === "kerdes").length;
  const softFail = items.filter((x) => !x.f.kizaro && x.s === "nem_felel_meg").length;
  const pz = cat.pontozas;
  let lo = 0, hi = 0, openPts = 0;
  const groups = (pz?.csoportok || []).map((c) => {
    let glo = 0, ghi = 0;
    for (const s of c.szempontok || []) {
      const lv = levelOf(ev, s), pts = s.szintek.map((z) => z.pont || 0);
      if (lv == null) { openPts++; if (s.szintek.some((z) => z.jogosulatlan)) koOpen++; glo += Math.min(...pts); ghi += Math.max(...pts); continue; }
      if (s.szintek[lv].jogosulatlan) koFail.push(`${s.cim}: ${s.szintek[lv].ha}`);
      glo += pts[lv]; ghi += pts[lv];
    }
    lo += glo; hi += ghi;
    return { c, lo: glo, hi: ghi, fail: c.min != null && ghi < c.min, open: c.min != null && glo < c.min && ghi >= c.min };
  });
  const ptFail = pz ? (pz.min != null && hi < pz.min) || groups.some((g) => g.fail) : false;
  const ptOpen = pz ? (pz.min != null && lo < pz.min) || groups.some((g) => g.open) : false;
  const state = !ev.result ? "nincs" : koFail.length ? "nem" : ptFail ? "pont" : koOpen || ptOpen ? "kerdes" : "ok";
  return { state, koFail, koOpen, softFail, lo, hi, openPts, groups, max: pz?.max ?? null, min: pz?.min ?? null,
    open: items.filter((x) => x.s === "kerdes").length + openPts };
}
const VERDICT = {
  nincs: ["Még nincs értékelés", "s-hianyzik"], nem: ["Jogosulatlan", "s-javitando"], pont: ["Nem éri el a pontküszöböt", "s-javitando"],
  kerdes: ["Még nem dönthető el", "s-feltoltve"], ok: ["Megfelel a feltételeknek", "s-elfogadva"],
};
const range = (lo, hi) => (lo === hi ? `${lo}` : `${lo}–${hi}`);

// ───────────────────────── felhívások listája ─────────────────────────

async function listView() {
  const calls = X.need(await X.sb.from("beta_calls").select("id, title, created_at, stat:review->stat, kesz:review->kesz, beta_evals(id)").order("created_at", { ascending: false }));
  return [
    h("div", { class: "page-head spread" },
      h("div", {}, h("h1", { class: "bx-title" }, "Pontozó ", h("em", {}, "béta")), h("p", { class: "sub" }, "Felhívásból kivonat, kivonatból jogosultság és pontszám – az AI-ügynökével.")),
      h("button", { class: "btn primary", onclick: newCallDialog }, "+ Új felhívás")),
    calls.length ? h("div", { class: "folders" }, calls.map((c) => h("a", { class: "folder", href: `#/pontozo/f/${c.id}` },
      h("span", { class: "tab" }, h("b", {}, c.kesz ? "Kivonat kész" : c.stat ? "Kivonat folyamatban" : "Kivonatra vár")),
      h("span", { class: "sheet" },
        h("span", { class: "f-title" }, c.title),
        h("span", { class: "f-foot" },
          h("strong", {}, c.stat ? `${c.stat.feltetelek} feltétel · ${c.stat.szempontok} pontozási szempont` : "Még nincs kivonat"),
          h("span", {}, plural(c.beta_evals.length, "értékelés")))))))
      : h("div", { class: "empty" }, h("strong", {}, "Itt lesznek a felhívások"), "Az „Új felhívás” gombbal töltse fel a megjelent felhívás PDF-jét."),
  ];
}

function newCallDialog() {
  let docs = [];
  const title = h("input", { type: "text", name: "title", required: true, maxlength: 300, placeholder: "pl. GINOP Plusz-2.1.3-24" });
  const status = h("span", { class: "hint" }, "A felhívás és a mellékletei – egyszerre több is kijelölhető.");
  const files = h("input", { type: "file", accept: "application/pdf,.pdf", multiple: true, required: true, onchange: (ev) => X.run(null, async () => {
    status.textContent = "Beolvasás…"; docs = [];
    try { for (const f of ev.target.files) docs.push(await readPdf(f)); }
    catch (e) { status.textContent = "Nem sikerült beolvasni."; ev.target.value = ""; docs = []; throw e; }
    if (!title.value && docs[0]) title.value = docs[0].name.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").replace(/\s*\(\d+\)$/, "").trim();
    status.textContent = docs.map((d) => `${d.name}: ${d.pages.length} oldal`).join(" · ");
  }) });
  X.formModal("Új felhívás", [X.field("Felhívás (PDF)", files, status), X.field("Megnevezés", title)], "Feltöltés", async (v) => {
    if (!docs.length) throw new Error("Válassza ki a felhívás PDF-jét.");
    const row = X.need(await X.sb.from("beta_calls").insert({ title: v.title.trim(), docs, ...newToken("f") }).select("id").single());
    location.hash = `#/pontozo/f/${row.id}`;
  });
}

// ───────────────────────── egy felhívás: prompt, kivonat, értékelések ─────────────────────────

async function callView(id) {
  const cached = docMeta.get(id);
  const call = X.need(await X.sb.from("beta_calls").select(cached ? "id, title, catalog, review, notes, agent_token, agent_expires, updated_at" : "*").eq("id", id).maybeSingle());
  if (!call) { location.replace("#/pontozo"); return null; }
  if (!cached) docMeta.set(id, call.docs.map((d) => ({ name: d.name, pages: d.pages.length })));
  const docs = docMeta.get(id);
  await ensureToken("beta_calls", call, "f");
  const evals = X.need(await X.sb.from("beta_evals").select("id, company, result, manual, updated_at").eq("call_id", id).order("created_at"));
  const cat = call.catalog, rev = call.review, st = rev?.stat;
  const note = (key, label) => h("label", { class: "bx-note" }, label,
    h("textarea", { rows: key === "_" ? 3 : 1, value: call.notes[key] || "", placeholder: key === "_" ? "pl. Hiányzik a 2.3 pont 9) alpontja; a III.2 szempont első sora kizáró." : "Mit javítson ezen az AI?", onchange: (ev) => X.run(null, async () => {
      const notes = { ...call.notes, [key]: ev.target.value.trim() };
      if (!notes[key]) delete notes[key];
      X.need(await X.sb.from("beta_calls").update({ notes }).eq("id", id));
      call.notes = notes; X.toast("Megjegyzés mentve – a következő futtatáskor az ügynök megkapja.");
    }) }));
  const addDoc = h("input", { type: "file", accept: "application/pdf,.pdf", hidden: true, onchange: (ev) => X.run(null, async () => {
    const doc = await readPdf(ev.target.files[0]);
    const all = X.need(await X.sb.from("beta_calls").select("docs").eq("id", id).single()).docs;
    X.need(await X.sb.from("beta_calls").update({ docs: [...all, doc], ...(call.review ? { review: { ...call.review, kesz: false, uj_melleklet: true } } : {}) }).eq("id", id));
    docMeta.set(id, [...docs, { name: doc.name, pages: doc.pages.length }]);
    X.toast(`Hozzáadva: ${doc.name} (${doc.pages.length} oldal). Futtassa újra az ügynököt, hogy ezt is feldolgozza.`); X.refresh();
  }) });

  const head = h("div", { class: "hero bx-hero" },
    h("a", { class: "back", href: "#/pontozo" }, "← Felhívások"),
    h("h1", {}, call.title),
    h("div", { class: "facts" },
      docs.map((d) => h("span", {}, `${d.name} · ${d.pages} oldal`)),
      h("button", { class: "source bx-chip", onclick: () => addDoc.click() }, "+ Melléklet"), addDoc));

  if (!cat) return [head, agentBox("call", call, "1. Másolja be ezt az AI-ügynökének", "Csak írja be neki – ebből tudja, hol van a felhívás, és pontosan mit kell csinálnia. Ha végzett, kattintson az „Eredmény frissítése” gombra."),
    h("p", { class: "tools" }, h("button", { class: "btn danger", onclick: () => deleteCall(call, evals.length) }, "Felhívás törlése"))];

  const felt = cat.feltetelek || [], ko = felt.filter((f) => f.kizaro);
  const flt = filter === "kizaro" || TIPUS[filter] ? filter : "mind";
  const shown = (flt === "mind" ? felt : flt === "kizaro" ? ko : felt.filter((f) => f.tipus === flt))
    .slice().sort((a, b) => (b.kizaro === true) - (a.kizaro === true));
  const dismissed = rev?.elvetettek || [];

  return [
    head,
    !rev?.kesz && h("div", { class: "banner" }, rev?.uj_melleklet ? "Új mellékletet töltött fel: a kivonat ezt még nem tartalmazza. Futtassa újra az ügynököt."
      : `Az ügynök még nem végzett: ${rev?.lefedetlen?.length || 0} kötelező hangú mondatot még nem rendezett. Amíg ez nem nulla, a kivonat hiányos lehet.`),
    st && h("div", { class: "bx-check" },
      h("div", {}, h("b", {}, `${st.megtalalt} / ${st.idezetek}`), "idézet megtalálva a felhívásban"),
      h("div", {}, h("b", {}, `${st.lefedett + st.elvetett} / ${st.jeloltek}`), "kötelező hangú mondat rendezve"),
      h("div", {}, h("b", {}, st.kizaro), "kizáró feltétel"),
      h("div", {}, h("b", {}, st.szempontok), "pontozási szempont")),
    rev?.oldalak && h("div", { class: "bx-strips" }, rev.oldalak.map((d, di) => h("div", { class: "bx-strip", role: "img", "aria-label": "Melyik oldalról hány tétel származik" },
      d.tetel.map((n, pi) => h("span", { class: (n ? `n${Math.min(n, 3)}` : "") + (d.lefedetlen[pi] ? " gap" : ""), title: `${docs[di]?.name || ""} ${pi + 1}. oldal: ${n} idézet${d.lefedetlen[pi] ? `, ${d.lefedetlen[pi]} lefedetlen mondat` : ""}` }))))),
    (cat.hivatkozott || []).length > 0 && h("div", { class: "notice" }, h("b", {}, "A felhívás ezekre a dokumentumokra hivatkozik, de nincsenek feltöltve: "),
      h("ul", { class: "bx-list" }, cat.hivatkozott.map((x) => h("li", {}, h("b", {}, x.nev), ` – ${x.miert}`))),
      "Töltse fel őket a „+ Melléklet” gombbal, és futtassa újra az ügynököt."),

    h("div", { class: "bx-facts" }, (cat.tenyek || []).map((t, i) => h("div", { title: t.idezet }, h("small", {}, t.cimke), h("b", {}, t.ertek), rev?.hely?.[`t${i}`] && h("i", {}, `${rev.hely[`t${i}`].oldal}. o.`)))),

    h("h2", { class: "bx-h" }, "Feltételek"),
    pills(flt, [["mind", "Mind", felt.length], ["kizaro", "Kizáró", ko.length], ...Object.entries(TIPUS).map(([k, v]) => [k, v, felt.filter((f) => f.tipus === k).length])], (k) => { filter = k; X.refresh(); }),
    shown.map((f) => details(`c-${f.id}`, f.kizaro ? "s-javitando" : "s-hianyzik", [
      h("span", { class: "no" }, f.id), h("span", { class: "title" }, f.cim),
      h("span", { class: "badges" }, f.kizaro && stamp("s-javitando", "Kizáró"), h("span", { class: "bx-type" }, TIPUS[f.tipus] || f.tipus), rev?.hely?.[f.id] && h("span", { class: "bx-type" }, `${rev.hely[f.id].oldal}. o.`)),
    ], [
      h("p", { class: "desc" }, f.leiras), quotes(f.idezet, rev?.hely?.[f.id]),
      h("h3", {}, "Amit a vállalkozásról tudni kell"), h("p", {}, f.kerdes),
      f.igazolas && [h("h3", {}, "Igazolás"), h("p", {}, f.igazolas)],
      note(f.id, "Megjegyzés az AI-nak"),
    ])),

    cat.pontozas && [
      h("h2", { class: "bx-h" }, "Pontozás ", h("small", {}, `${cat.pontozas.max} pont${cat.pontozas.min != null ? ` · legalább ${cat.pontozas.min} kell` : ""}`)),
      cat.pontozas.csoportok.map((c) => h("section", { class: "card bx-score" },
        h("h3", {}, `${c.id}. ${c.cim}`, h("span", {}, `${c.max} pont${c.min != null ? ` · legalább ${c.min}` : ""}`)),
        c.szempontok.map((s) => h("div", { class: "bx-crit" },
          h("div", { class: "bx-crit-h" }, h("b", {}, `${s.id} ${s.cim}`), h("span", {}, `${s.max} pont`, rev?.hely?.[s.id] && ` · ${rev.hely[s.id].oldal}. o.`)),
          h("ul", { class: "bx-levels" }, s.szintek.map((z) => h("li", {}, h("span", {}, z.ha), z.jogosulatlan ? stamp("s-javitando", "Jogosulatlan") : h("b", {}, z.pont)))))))),
    ],

    (rev?.lefedetlen || []).length > 0 && h("details", { class: "bx-more" }, h("summary", {}, `Lefedetlen kötelező mondatok (${rev.lefedetlen.length})`),
      h("ul", { class: "bx-list" }, rev.lefedetlen.map((l) => h("li", {}, h("i", {}, `${l.oldal}. o. `), l.szoveg)))),
    dismissed.length > 0 && h("details", { class: "bx-more" }, h("summary", {}, `Az AI által elvetett mondatok (${dismissed.length})`),
      h("ul", { class: "bx-list" }, dismissed.map((d) => h("li", {}, h("i", {}, `${d.oldal}. o. `), d.szoveg, h("br"), h("b", {}, d.kizaro ? "Kizáró hangú mondat – az AI indoka: " : "Az AI indoka: "), d.ok)))),
    (rev?.figyelmeztetesek || []).length > 0 && h("details", { class: "bx-more" }, h("summary", {}, `Figyelmeztetések (${rev.figyelmeztetesek.length})`),
      h("ul", { class: "bx-list" }, rev.figyelmeztetesek.map((x) => h("li", {}, x)))),

    h("section", { class: "card" }, note("_", "Általános megjegyzés az AI-nak"),
      h("p", { class: "muted small", style: "margin:0" }, "Amit ide vagy egy tételhez ír, azt az ügynök a következő futtatáskor kötelező javításként kapja meg.")),
    agentBox("call", call, "Kivonat újrafuttatása", "Ha megjegyzést írt vagy mellékletet töltött fel: másolja be újra az ügynökének."),

    h("div", { class: "spread bx-h" }, h("h2", {}, "Értékelések"), h("button", { class: "btn primary", onclick: () => newEvalDialog(call) }, "+ Vállalkozás értékelése")),
    evals.length ? h("div", { class: "people" }, evals.map((e) => {
      const v = verdict(cat, e);
      return h("a", { class: "person bx-eval", href: `#/pontozo/e/${e.id}` },
        h("div", { class: "avatar", "aria-hidden": "true" }, v.max != null && e.result ? range(v.lo, v.hi) : "–"),
        h("div", {}, h("div", { class: "name" }, e.company), h("div", { class: "muted small" }, e.result ? `${v.open} nyitott kérdés · frissítve ${X.fmtTime(e.updated_at)}` : "Az ügynök még nem értékelte")),
        stamp(VERDICT[v.state][1], VERDICT[v.state][0]));
    })) : h("div", { class: "empty" }, h("strong", {}, "Még nincs értékelés"), "Adja meg egy vállalkozás alapadatait, és az ügynök végigmegy a kivonat minden tételén."),
    h("p", { class: "tools" }, h("button", { class: "btn danger", onclick: () => deleteCall(call, evals.length) }, "Felhívás törlése")),
  ];
}

async function deleteCall(call, evals) {
  if (!(await X.confirmBox(`Törli a(z) „${call.title}” felhívást a kivonatával${evals ? ` és mind a(z) ${evals} értékelésével` : ""} együtt? Ez nem vonható vissza.`))) return;
  X.run(null, async () => { X.need(await X.sb.from("beta_calls").delete().eq("id", call.id)); docMeta.delete(call.id); location.hash = "#/pontozo"; });
}

function newEvalDialog(call) {
  const facts = h("textarea", { name: "facts", rows: 9, placeholder: "Amit a vállalkozásról és a tervezett projektről tud: alapítás, cégforma, székhely, létszám, az utolsó három év árbevétele, saját tőke, export; a projekt összköltsége, az igényelt támogatás, a tervezett tevékenységek…" });
  const questions = [...(call.catalog.feltetelek || []), ...(call.catalog.pontozas?.csoportok || []).flatMap((c) => c.szempontok)].map((x) => x.kerdes).filter(Boolean);
  X.formModal("Vállalkozás értékelése", [
    h("div", { class: "two" },
      X.field("Vállalkozás neve", h("input", { type: "text", name: "company", required: true, maxlength: 300 })),
      X.field("Adószám", h("input", { type: "text", name: "tax_no", maxlength: 20, placeholder: "nem kötelező" }))),
    X.field("Alapadatok", facts, "Amit nem ad meg, arra az ügynök rákérdez – később is bővíthető."),
    h("p", { class: "small", style: "margin:-.5rem 0 0" }, h("button", { class: "btn quiet", type: "button", onclick: () => { facts.value = [...new Set(questions)].map((q) => `${q}\n→ `).join("\n"); facts.focus(); } }, `A felhívás ${new Set(questions).size} kérdésének beillesztése`)),
  ], "Létrehozás", async (v) => {
    const row = X.need(await X.sb.from("beta_evals").insert({ call_id: call.id, company: v.company.trim(), tax_no: v.tax_no.trim() || null, facts: v.facts.trim() || null, ...newToken("e") }).select("id").single());
    location.hash = `#/pontozo/e/${row.id}`;
  });
}

// ───────────────────────── egy vállalkozás értékelése ─────────────────────────

async function evalView(id) {
  const ev = X.need(await X.sb.from("beta_evals").select("*, call:beta_calls(id, title, catalog, updated_at)").eq("id", id).maybeSingle());
  if (!ev) { location.replace("#/pontozo"); return null; }
  await ensureToken("beta_evals", ev, "e");
  const cat = ev.call.catalog || {}, res = ev.result, v = verdict(cat, ev);
  const felt = cat.feltetelek || [], crits = (cat.pontozas?.csoportok || []).flatMap((c) => c.szempontok);

  // A tanácsadó döntése / válasza: a `manual` oszlopba kerül, az ügynök a következő futáskor megkapja, és nem írhatja felül.
  const setManual = (group, key, patch) => X.run(null, async () => {
    const manual = structuredClone(ev.manual || {});
    const cur = { ...(manual[group]?.[key] || {}), ...patch };
    for (const k of Object.keys(cur)) if (cur[k] == null || cur[k] === "") delete cur[k];
    manual[group] = { ...(manual[group] || {}) };
    if (Object.keys(cur).length) manual[group][key] = cur; else delete manual[group][key];
    ev.manual = manual;                 // azonnal, hogy a közvetlenül utána jövő mentés már erre épüljön
    X.need(await X.sb.from("beta_evals").update({ manual }).eq("id", id));
    X.refresh();
  });
  const answer = (group, key, q) => h("label", { class: "bx-note" }, q,
    h("textarea", { rows: 1, placeholder: "Válasz…", value: ev.manual?.[group]?.[key]?.valasz || "", onchange: (e) => setManual(group, key, { valasz: e.target.value.trim() }) }));
  const why = (r) => r && [h("p", { class: "desc" }, r.indok),
    h("p", { class: "muted small" }, `Forrás: ${FORRAS[r.forras] || r.forras}`, r.hivatkozas && ` – ${r.hivatkozas}`)];

  const openQ = [
    ...felt.filter((f) => stateOf(ev, f) === "kerdes").map((f) => ["feltetelek", f.id, res?.feltetelek?.[f.id]?.kerdes || f.kerdes, f.kizaro]),
    ...crits.filter((s) => levelOf(ev, s) == null).map((s) => ["pontok", s.id, res?.pontok?.[s.id]?.kerdes || s.kerdes, false]),
  ];
  const answered = openQ.filter(([g, k]) => ev.manual?.[g]?.[k]?.valasz).length;
  const counts = Object.fromEntries(Object.keys(ALLAPOT).map((k) => [k, felt.filter((f) => stateOf(ev, f) === k).length]));
  const flt = Object.keys(ALLAPOT).includes(filter) ? filter : "mind";
  const order = Object.keys(ALLAPOT);
  const shown = felt.filter((f) => flt === "mind" || stateOf(ev, f) === flt)
    .slice().sort((a, b) => order.indexOf(stateOf(ev, a)) - order.indexOf(stateOf(ev, b)) || (b.kizaro === true) - (a.kizaro === true));

  const hero = h("div", { class: "hero bx-hero" },
    h("div", { class: "hero-main" },
      h("div", {},
        h("a", { class: "back", href: `#/pontozo/f/${ev.call.id}` }, `← ${ev.call.title}`),
        h("h1", {}, ev.company),
        h("div", { class: "facts" },
          h("span", { class: `bx-v v-${v.state}` }, VERDICT[v.state][0]),
          ev.tax_no && h("span", {}, `Adószám: ${ev.tax_no}`),
          res && h("span", {}, `${v.open} nyitott kérdés`),
          res && v.softFail > 0 && h("span", {}, `${v.softFail} nem kizáró feltétel nem teljesül`))),
      v.max != null && res && h("div", { class: "ring", style: `--p:${Math.round((v.lo / v.max) * 100)}`, role: "img", "aria-label": `${range(v.lo, v.hi)} pont a ${v.max}-ból` },
        h("span", {}, range(v.lo, v.hi), h("small", {}, ` /${v.max}`)))));

  const dataCard = h("section", { class: "card" }, h("h2", {}, "A vállalkozás adatai"),
    (() => {
      const form = h("form", { onsubmit: (e) => { e.preventDefault(); X.run(form.querySelector("button"), async () => {
        const f = Object.fromEntries(new FormData(form));
        X.need(await X.sb.from("beta_evals").update({ company: f.company.trim(), tax_no: f.tax_no.trim() || null, facts: f.facts.trim() || null }).eq("id", id));
        X.toast("Mentve – a következő futtatáskor az ügynök ezekkel dolgozik."); X.refresh();
      }); } },
        h("div", { class: "bx-two" },
          X.field("Vállalkozás neve", h("input", { type: "text", name: "company", required: true, maxlength: 300, value: ev.company })),
          X.field("Adószám", h("input", { type: "text", name: "tax_no", maxlength: 20, value: ev.tax_no || "" }))),
        X.field("Alapadatok", h("textarea", { name: "facts", rows: 7, value: ev.facts || "" })),
        h("button", { class: "btn primary", type: "submit" }, "Mentés"));
      return form;
    })());

  if (!res) return [hero, dataCard,
    agentBox("eval", ev, "Másolja be ezt az AI-ügynökének", "Az ügynök a kivonat minden tételén végigmegy. Amire nincs adat, arra kérdést ír – nem találgat."),
    h("p", { class: "tools" }, h("button", { class: "btn danger", onclick: () => deleteEval(ev) }, "Értékelés törlése"))];

  return [
    hero,
    ev.call.updated_at > ev.updated_at && h("div", { class: "banner" }, "A felhívás kivonata az értékelés óta változott. Futtassa újra az ügynököt, hogy az értékelés a friss kivonatra épüljön."),
    v.koFail.length > 0 && h("div", { class: "notice" }, h("b", {}, "Kizáró ok: "), h("ul", { class: "bx-list" }, v.koFail.map((t) => h("li", {}, t)))),
    v.max != null && h("div", { class: "bx-check" },
      h("div", { class: v.min != null ? (v.hi < v.min ? "bad" : v.lo >= v.min ? "good" : "") : "" }, h("b", {}, `${range(v.lo, v.hi)} / ${v.max}`), v.min != null ? `összpontszám · legalább ${v.min} kell` : "összpontszám"),
      v.groups.map((g) => h("div", { class: g.c.min != null ? (g.fail ? "bad" : g.open ? "" : "good") : "" }, h("b", {}, `${range(g.lo, g.hi)} / ${g.c.max}`), `${g.c.id}. ${g.c.cim}${g.c.min != null ? ` · legalább ${g.c.min}` : ""}`))),
    h("p", { class: "bx-sum" }, res.osszegzes),
    (res.teendok || []).length > 0 && h("section", { class: "card" }, h("h2", {}, "Teendők"), h("ol", { class: "bx-todo" }, res.teendok.map((t) => h("li", {}, t)))),

    openQ.length > 0 && h("section", { class: "card bx-questions" },
      h("h2", {}, `Nyitott kérdések `, h("small", {}, `${answered} / ${openQ.length} megválaszolva`)),
      h("p", { class: "muted" }, "Válaszoljon, amire tud, majd futtassa újra az ügynököt – a válaszait tényként kezeli."),
      openQ.map(([g, k, q, ko]) => h("div", { class: "bx-q" }, h("span", { class: "no" }, k), ko && stamp("s-javitando", "Kizáró"), answer(g, k, q)))),
    agentBox("eval", ev, openQ.length ? "Újrafuttatás a válaszaival" : "Újrafuttatás", "Másolja be újra az ügynökének, ha adatot vagy választ adott meg."),

    h("h2", { class: "bx-h" }, "Feltételek"),
    pills(flt, [["mind", "Mind", felt.length], ...order.map((k) => [k, ALLAPOT[k], counts[k]])], (k) => { filter = k; X.refresh(); }),
    shown.map((f) => {
      const s = stateOf(ev, f), r = res.feltetelek?.[f.id], m = ev.manual?.feltetelek?.[f.id];
      return details(`e-${f.id}`, SCLS[s], [
        h("span", { class: "no" }, f.id), h("span", { class: "title" }, f.cim),
        h("span", { class: "badges" }, f.kizaro && stamp("s-javitando", "Kizáró"), stamp(SCLS[s], ALLAPOT[s] + (m?.allapot ? " · kézi" : ""))),
      ], [
        r ? why(r) : h("p", { class: "muted" }, "Erre a tételre az ügynök még nem adott választ (a kivonat azóta változott) – futtassa újra."),
        s === "kerdes" && answer("feltetelek", f.id, r?.kerdes || f.kerdes),
        h("h3", {}, "A felhívás szerint"), h("p", { class: "desc" }, f.leiras), quotes(f.idezet),
        h("h3", {}, "Az Ön döntése"),
        h("div", { class: "bx-pills" }, Object.entries(ALLAPOT).map(([k, label]) => h("button", { class: m?.allapot === k ? "on" : null, onclick: () => setManual("feltetelek", f.id, { allapot: m?.allapot === k ? null : k }) }, label))),
      ]);
    }),

    cat.pontozas && [
      h("h2", { class: "bx-h" }, "Pontozás ", h("small", {}, "kattintson egy szintre, ha felülbírálná")),
      v.groups.map((g) => h("section", { class: "card bx-score" },
        h("h3", {}, `${g.c.id}. ${g.c.cim}`, h("span", {}, `${range(g.lo, g.hi)} / ${g.c.max} pont${g.c.min != null ? ` · legalább ${g.c.min}` : ""}`)),
        g.c.szempontok.map((s) => {
          const lv = levelOf(ev, s), r = res.pontok?.[s.id], m = ev.manual?.pontok?.[s.id];
          return h("div", { class: "bx-crit" },
            h("div", { class: "bx-crit-h" }, h("b", {}, `${s.id} ${s.cim}`), h("span", {}, lv == null ? "nyitott" : s.szintek[lv].jogosulatlan ? "jogosulatlan" : `${s.szintek[lv].pont} / ${s.max} pont`)),
            h("ul", { class: "bx-levels pick" }, s.szintek.map((z, zi) => h("li", {}, h("button", { class: lv === zi ? "on" : null, "aria-pressed": lv === zi ? "true" : "false",
              onclick: () => setManual("pontok", s.id, { szint: m?.szint === zi ? null : zi }) },
              h("span", {}, z.ha, r?.szint === zi && h("i", { class: "bx-ai" }, "AI"), m?.szint === zi && h("i", { class: "bx-ai me" }, "kézi")),
              z.jogosulatlan ? stamp("s-javitando", "Jogosulatlan") : h("b", {}, z.pont))))),
            why(r), lv == null && answer("pontok", s.id, r?.kerdes || s.kerdes));
        }))),
    ],

    (res.adatok || []).length > 0 && h("section", { class: "card" }, h("h2", {}, "Felhasznált adatok"),
      h("div", { class: "scroll-x" }, h("table", { class: "log" }, res.adatok.map((a) => h("tr", {}, h("td", {}, a.cimke), h("td", {}, h("b", {}, a.ertek)), h("td", { class: "muted" }, a.forras)))))),
    dataCard,
    h("p", { class: "tools" }, h("button", { class: "btn danger", onclick: () => deleteEval(ev) }, "Értékelés törlése")),
  ];
}

async function deleteEval(ev) {
  if (!(await X.confirmBox(`Törli a(z) „${ev.company}” értékelését? Ez nem vonható vissza.`))) return;
  X.run(null, async () => { X.need(await X.sb.from("beta_evals").delete().eq("id", ev.id)); location.hash = `#/pontozo/f/${ev.call.id}`; });
}
