/* Pályázatsegítő – egyoldalas alkalmazás, build-lépés nélkül.
   Adat: Supabase (táblák RLS-sel + Storage + egy Edge Function). Részletek: AGENTS.md
   XSS-védelem: minden DOM a h() segéddel épül, felhasználói szöveg csak text node-ként kerül ki. */

import { pdfPages, extractPoints, extractMeta, splitTitle } from "./hp-parse.js";

const cfg = window.PORTAL_CONFIG;
// A munkamenet az alapértelmezett localStorage-ben él: az e-mailben kapott link új fülön is belépve nyílik.
// Ez csak azért biztonságos, mert a portál SAJÁT eredeten fut (palyazatsegito.hu) – lásd AGENTS.md 4. pont.
const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey);
const app = document.getElementById("app");
const MAX_FILE = 50 * 1024 * 1024; // a Storage bucket limitje is ennyi

const STATUS = { hianyzik: "Hiányzik", feltoltve: "Ellenőrzésre vár", javitando: "Javítandó", elfogadva: "Rendben" };
let me = null;                       // a belépett felhasználó profilja
let brand = "Pályázatsegítő";
let renderNo = 0;                    // versenyhelyzet ellen: csak a legutolsó render írhat a DOM-ba
const openState = new Map();         // pont id → nyitva van-e (újrarajzolás után megmarad)
const drafts = new Map();            // pont id → félbehagyott üzenet

// ───────────────────────── segédek ─────────────────────────

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false || k === "value") continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  el.append(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  if (attrs?.value != null) el.value = attrs.value;
  return el;
}

// Nyitott <dialog> esetén abba kerül (a modál a „top layer”-ben van, különben eltakarná).
function toast(text, isError) {
  const t = h("div", { class: "toast" + (isError ? " err" : "") }, text);
  const host = [...document.querySelectorAll("dialog[open]")].pop() || document.body;
  (host.querySelector(":scope > .toasts") || host.appendChild(h("div", { class: "toasts", role: "status", "aria-live": "polite" }))).append(t);
  setTimeout(() => t.remove(), isError ? 7000 : 3500);
}

const need = ({ data, error }) => { if (error) throw error; return data; };

const ERRORS = [
  [/row-level security|permission denied|forbidden/i, "Ehhez a művelethez nincs jogosultsága."],
  [/Failed to fetch|NetworkError/i, "Nincs kapcsolat a szerverrel. Ellenőrizze az internetet, majd próbálja újra."],
  [/exceeded the maximum allowed size/i, "A fájl túl nagy (legfeljebb 50 MB lehet)."],
  [/Password should be|weak/i, "A jelszó túl gyenge: legalább 8 karakter legyen."],
  [/same.*password|different from the old/i, "Az új jelszó nem egyezhet a régivel."],
  [/profiles_notify_email_check/i, "Érvénytelen e-mail-cím."],
];
const explain = (e) => {
  const m = e?.message || String(e);
  return (ERRORS.find(([re]) => re.test(m)) || [])[1] || m;
};

// Gomb/űrlap művelet futtatása: letiltja a gombot, a hibát érthetően kiírja.
async function run(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); }
  catch (e) { console.error(e); toast(explain(e), true); }
  finally { if (btn) btn.disabled = false; }
}

async function api(action, payload) {
  const { data, error } = await sb.functions.invoke("portal", { body: { action, ...payload } });
  if (error) {
    let msg = error.message;
    try { msg = (await error.context.json()).error || msg; } catch { /* nem JSON válasz */ }
    throw new Error(msg);
  }
  return data;
}

const fmtTime = (iso) => new Intl.DateTimeFormat("hu-HU", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
const fmtDate = (d) => new Intl.DateTimeFormat("hu-HU", { dateStyle: "long" }).format(new Date(d + "T12:00:00"));
const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " kB");
const daysLeft = (d) => Math.round((new Date(d + "T00:00:00") - new Date(new Date().toDateString())) / 86400000);
const byPos = (a, b) => a.position - b.position || a.id.localeCompare(b.id);
const byTime = (a, b) => a.created_at.localeCompare(b.created_at);
const noAccents = (s) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "");
// Storage-kulcsba csak ASCII mehet; az eredeti nevet a files.name őrzi.
const asciiName = (n) => noAccents(n).replace(/[^A-Za-z0-9._-]+/g, "_").slice(-80) || "fajl";
const genPassword = () => {
  const abc = "abcdefghjkmnpqrstuvwxyz23456789"; // félreolvasható karakterek nélkül
  const r = crypto.getRandomValues(new Uint32Array(12));
  return [...r].map((x, i) => (i && i % 4 === 0 ? "-" : "") + abc[x % abc.length]).join("");
};
const slug = (s) => noAccents(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30);
const initials = (s) => s.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
// „1. Cégkivonat”, „2) …”, „- …” → a sorszámot/jelölőt levágjuk, a sorrend úgyis megmarad.
// Hosszú pont (pl. a felszólításból beolvasott bekezdés): rövid cím + a teljes szöveg leírásként.
const parsePoints = (text) => text.split("\n").map((l) => l.replace(/^\s*(\d+\s*[.)]|[-–•*])\s*/, "").trim()).filter(Boolean).map((t) => splitTitle(t));
const ADVISOR = { name: "Nagy Henrietta", role: "vezető tanácsadó", photo: "img/henrietta.jpg" };
const advisor = (cls) => h("div", { class: "advisor " + (cls || "") },
  h("img", { src: ADVISOR.photo, alt: ADVISOR.name, width: 96, height: 96 }),
  h("span", {}, h("b", {}, ADVISOR.name), h("small", {}, ADVISOR.role)));

// A felszólítás PDF-jének beolvasása (a pdf.js csak most töltődik be, és csak adminnál).
async function readNotice(file) {
  const pdfjs = await import("./vendor/pdfjs/pdf.min.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("./vendor/pdfjs/pdf.worker.min.mjs", import.meta.url).href;
  const pages = await pdfPages(pdfjs, new Uint8Array(await file.arrayBuffer()));
  return { points: extractPoints(pages), meta: extractMeta(pages) };
}
async function uploadNotice(projectId, file) {
  const path = `${projectId}/forras/${crypto.randomUUID()}-${asciiName(file.name)}`;
  need(await sb.storage.from("docs").upload(path, file, { contentType: "application/pdf" }));
  need(await sb.from("projects").update({ source_path: path, source_name: file.name }).eq("id", projectId));
}
const pdfInput = (onFile) => h("input", { type: "file", accept: "application/pdf,.pdf", onchange: (ev) => ev.target.files[0] && onFile(ev.target.files[0], ev.target) });

function dueLabel(deadline) {
  if (!deadline) return null;
  const d = daysLeft(deadline);
  const txt = d > 1 ? `${d} nap van hátra` : d === 1 ? "holnap jár le" : d === 0 ? "ma jár le" : `${-d} napja lejárt`;
  return h("span", { class: "due" + (d <= 3 ? " soon" : "") }, `Határidő: ${fmtDate(deadline)} · ${txt}`);
}
const stamp = (status) => h("span", { class: `stamp s-${status}` }, STATUS[status]);
const segbar = (points) => h("div", { class: "segbar", role: "img", "aria-label": progressText(points) },
  [...points].sort(byPos).map((p) => h("span", { class: `s-${p.status}`, title: `${p.title ?? ""} – ${STATUS[p.status]}`.replace(/^ – /, "") })));
const count = (points, status) => points.filter((p) => p.status === status).length;
function progressText(points) {
  const [ok, fix, miss] = [count(points, "elfogadva"), count(points, "javitando"), count(points, "hianyzik")];
  if (!points.length) return "Még nincs pont";
  if (ok === points.length) return "Minden pont rendben";
  const wait = points.length - ok - fix - miss;
  return `${ok} / ${points.length} rendben` + (wait ? ` · ${wait} ellenőrzésre vár` : "") + (fix ? ` · ${fix} javítandó` : "") + (miss ? ` · ${miss} hiányzik` : "");
}
const mark = () => h("span", { class: "mark", "aria-hidden": "true" });

// Párbeszédablak a natív <dialog>-gal. A build() megkapja a bezáró függvényt. lockEscape: Esc nem zárja be.
function modal(title, build, lockEscape) {
  const d = h("dialog", {});
  const close = () => {
    const left = d.querySelector(":scope > .toasts");
    d.close(); d.remove();
    if (left?.children.length) [...left.children].forEach((t) => toast(t.textContent, t.classList.contains("err")));
  };
  d.append(h("h2", {}, title), ...[build(close)].flat());
  d.addEventListener("cancel", (ev) => { ev.preventDefault(); if (!lockEscape) close(); });
  document.body.append(d);
  d.showModal();
  return close;
}
const confirmBox = (text, okLabel = "Törlés") => new Promise((resolve) => {
  modal("Biztosan?", (close) => [
    h("p", {}, text),
    h("div", { class: "row end actions" },
      h("button", { class: "btn", onclick: () => { close(); resolve(false); } }, "Mégsem"),
      h("button", { class: "btn warn", onclick: () => { close(); resolve(true); } }, okLabel)),
  ]);
});
// Űrlapos párbeszédablak: fields → {név: input}, onSubmit kapja az értékeket.
function formModal(title, fields, submitLabel, onSubmit) {
  modal(title, (close) => {
    const form = h("form", {
      onsubmit: (ev) => {
        ev.preventDefault();
        const values = Object.fromEntries(new FormData(form));
        run(form.querySelector("[type=submit]"), async () => { await onSubmit(values); close(); });
      },
    }, fields, h("div", { class: "row end actions" },
      h("button", { class: "btn", type: "button", onclick: close }, "Mégsem"),
      h("button", { class: "btn primary", type: "submit" }, submitLabel)));
    return form;
  });
}
const field = (label, input, hint) => h("label", {}, label, hint && h("span", { class: "hint" }, hint), input);

// ───────────────────────── indulás, útválasztás ─────────────────────────

async function loadMe() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return (me = null);
  me = need(await sb.from("profiles").select("*").eq("id", session.user.id).maybeSingle());
  if (!me) await sb.auth.signOut();   // fiók profil nélkül: nem engedjük be
}

async function boot() {
  try {
    const s = need(await sb.from("settings").select("brand").maybeSingle());
    if (s?.brand) brand = s.brand;
    document.title = brand;
    await loadMe();
  } catch (e) {
    app.replaceChildren(h("p", { class: "loading" }, explain(e)));
    return;
  }
  window.addEventListener("hashchange", () => render());
  render();
}

async function render(keepScroll) {
  const no = ++renderNo;
  const y = window.scrollY;
  let view;
  if (!me) view = loginView();
  else if (me.role === "client" && !me.notify_email) view = emailGate();
  else {
    const [, route, id] = location.hash.split("/");
    const admin = me.role === "admin";
    const narrow = route === "beallitasok";
    try {
      const main = route === "p" && id ? await projectView(id)
        : route === "ugyfelek" && admin ? await clientsView()
        : route === "beallitasok" ? await settingsView()
        : await homeView();
      if (!main) return; // a nézet átirányított
      view = [header(route), h("main", { class: "wrap" + (narrow ? " narrow" : "") }, main)];
    } catch (e) {
      console.error(e);
      view = [header(route), h("main", { class: "wrap" }, h("p", { class: "loading" }, explain(e)))];
    }
  }
  if (no !== renderNo) return;
  app.replaceChildren(...[view].flat());
  window.scrollTo(0, keepScroll ? y : 0);
  if (me?.role === "client" && me.notify_email && !seenTour() && !document.querySelector("dialog[open]")) tour();
}

// Ügyfél első belépése: gyors, 4 lépéses bemutató. Utána a fejléc „Súgó” gombjával újranyitható.
const TOUR_KEY = () => `tour-${me.id}`;
const seenTour = () => { try { return localStorage.getItem(TOUR_KEY()) === "1"; } catch { return true; } };
const TOUR = [
  ["Üdvözöljük!", `Ez a felület ${ADVISOR.name} (${brand}) és az Ön közös munkaterülete a hiánypótláshoz. Négy lépésben megmutatjuk, hogyan működik.`],
  ["A pontok", "A hivatal felszólításának minden pontja külön sorban szerepel. Kattintson egy pontra, és lenyílik: ott látja, mit kér a hivatal, mi a teendője (kék betűvel), és mi a pont állapota (Hiányzik, Ellenőrzésre vár, Javítandó, Rendben)."],
  ["Feltöltés", "A kinyitott ponton a „Fájlok kiválasztása” mezővel töltheti fel a kért dokumentumokat – telefonról fotót is készíthet. Feltöltés után a pont „Ellenőrzésre vár” lesz."],
  ["Üzenet és az eredeti felszólítás", "Minden pont alján üzenetet írhat, ha kérdése van. Az oldal tetején az „Eredeti felszólítás” gombbal bármikor megnézheti a hivatal levelét. Ha valamit javítani kell, e-mailben szólunk."],
];
function tour(step = 0) {
  modal(TOUR[step][0], (close) => [
    h("p", { class: "tour-step" }, `${step + 1} / ${TOUR.length}`),
    h("p", {}, TOUR[step][1]),
    h("div", { class: "row end actions" },
      step > 0 && h("button", { class: "btn", onclick: () => { close(); tour(step - 1); } }, "Vissza"),
      h("button", { class: "btn primary", onclick: () => {
        close();
        if (step + 1 < TOUR.length) return tour(step + 1);
        try { localStorage.setItem(TOUR_KEY(), "1"); } catch { /* privát mód: legközelebb újra megjelenik */ }
      } }, step + 1 < TOUR.length ? "Tovább" : "Kezdhetjük")),
  ], true);
}
const refresh = () => render(true);

function header(route) {
  const link = (href, text, key) => h("a", { href, "aria-current": route === key || (!route && !key) || (route === "p" && !key) ? "page" : null }, text);
  return h("header", { class: "top" }, h("div", { class: "inner" },
    h("a", { class: "brand-block", href: "#/" }, h("span", { class: "brand" }, mark(), brand), advisor("small"), h("span", { class: "role-pill" + (me.role === "admin" ? " admin" : "") }, me.role === "admin" ? "Admin felület" : "Ügyfélportál")),
    h("nav", {},
      link("#/", "Projektek", undefined),
      me.role === "admin" && link("#/ugyfelek", "Ügyfelek", "ugyfelek"),
      link("#/beallitasok", "Beállítások", "beallitasok"),
      me.role === "client" && h("button", { onclick: () => tour() }, "Súgó"),
      h("button", { onclick: async () => { await sb.auth.signOut(); me = null; location.hash = "#/"; render(); } }, "Kilépés"))));
}

// ───────────────────────── belépés ─────────────────────────

// A belépő és az e-mail-kapu közös kerete: bal oldalt a mélyzöld „borító”, jobb oldalt az űrlap.
const authShell = (formTitle, formSub, form, note) => h("div", { class: "auth" },
  h("aside", { class: "auth-art" },
    h("div", { class: "deco", "aria-hidden": "true" }, h("i"), h("i"), h("i")),
    h("div", { class: "brand light" }, mark(), brand),
    advisor("light"),
    h("h1", { class: "motto-h" }, h("em", {}, "Interaktív felület"), " a pályázatok megvalósítási szakaszában"),
    h("p", { class: "lead" }, "Hiánypótlása során pontról pontra látja, mi hiányzik még, mit kell javítani, és mi van már elfogadva."),
    h("ol", { class: "steps" },
      h("li", {}, "Belép a kapott felhasználónévvel és jelszóval"),
      h("li", {}, "Pontonként feltölti a kért dokumentumokat"),
      h("li", {}, "Átnézzük, és e-mailben jelzünk, ha teendője van"))),
  h("main", { class: "auth-form" }, h("div", { class: "box" },
    h("h2", {}, formTitle), h("p", { class: "sub" }, formSub), form, h("p", { class: "note" }, note))));

function loginView() {
  const form = h("form", {
    onsubmit: (ev) => {
      ev.preventDefault();
      const { username, password } = Object.fromEntries(new FormData(form));
      run(form.querySelector("button"), async () => {
        const { error } = await sb.auth.signInWithPassword({
          email: `${username.trim().toLowerCase()}@${cfg.authDomain}`, password,
        });
        if (error) throw new Error(/Invalid login|invalid/i.test(error.message) ? "Hibás felhasználónév vagy jelszó." : error.message);
        await loadMe();
        if (!me) throw new Error("Ehhez a fiókhoz nem tartozik hozzáférés.");
        render();
      });
    },
  },
    field("Felhasználónév", h("input", { type: "text", name: "username", required: true, autocomplete: "username", autocapitalize: "none", spellcheck: "false" })),
    field("Jelszó", h("input", { type: "password", name: "password", required: true, autocomplete: "current-password" })),
    h("button", { class: "btn primary", type: "submit" }, "Belépés"));
  return authShell("Belépés", "Hiánypótlási dokumentumok feltöltése", form,
    "A belépési adatokat a pályázatírójától kapta meg. Ha elvesztek, kérjen tőle új jelszót.");
}

// Ügyfél első belépése: értesítési e-mail-cím kötelező.
function emailGate() {
  const form = h("form", {
    onsubmit: (ev) => {
      ev.preventDefault();
      run(form.querySelector("button"), async () => {
        const email = new FormData(form).get("email").trim();
        need(await sb.from("profiles").update({ notify_email: email }).eq("id", me.id));
        me.notify_email = email;
        render();
      });
    },
  },
    field("E-mail-cím", h("input", { type: "email", name: "email", required: true, autocomplete: "email" })),
    h("button", { class: "btn primary", type: "submit" }, "Tovább"));
  return authShell("Hová küldjük az értesítést?", "Erre a címre írunk, ha üzenetet kap, vagy valamelyik dokumentumot javítani kell.", form,
    "A címet csak a hiánypótlással kapcsolatos értesítésekre használjuk. Később a Beállításokban módosíthatja.");
}

// ───────────────────────── projektlista: füles mappák ─────────────────────────

async function homeView() {
  const admin = me.role === "admin";
  const showArchived = sessionStorage.getItem("archived") === "1";
  const projects = need(await sb.from("projects")
    .select("id, title, reference, deadline, archived, created_at, client:profiles(name), points(id, position, title, status, client_unread, admin_unread)"));
  const unread = (p) => p.points.filter((x) => (admin ? x.admin_unread : x.client_unread)).length;
  const shown = projects.filter((p) => !admin || p.archived === showArchived)
    .sort((a, b) => (unread(b) > 0) - (unread(a) > 0) || (a.deadline || "9").localeCompare(b.deadline || "9") || byTime(b, a));

  // Ügyfél egyetlen projekttel: egyből oda visszük.
  if (!admin && projects.length === 1) { location.replace(`#/p/${projects[0].id}`); return null; }

  let failedMail = null;
  if (admin) {
    const last = need(await sb.from("mail_log").select("error, created_at, recipients").order("id", { ascending: false }).limit(1));
    if (last[0]?.error) failedMail = last[0];
  }
  const waiting = shown.reduce((n, p) => n + count(p.points, "feltoltve"), 0);

  return [
    h("div", { class: "page-head spread" },
      h("div", {},
        h("h1", {}, admin ? (showArchived ? "Archivált projektek" : "Projektek") : "Hiánypótlásai"),
        admin && !showArchived && shown.length > 0 && h("p", { class: "sub" }, waiting ? `${waiting} pont vár az Ön ellenőrzésére.` : "Most nincs ellenőrzésre váró pont.")),
      admin && h("div", { class: "row" },
        h("button", { class: "btn quiet", onclick: () => { sessionStorage.setItem("archived", showArchived ? "0" : "1"); render(); } }, showArchived ? "Aktív projektek" : "Archiváltak"),
        h("button", { class: "btn primary", onclick: () => newProjectDialog() }, "+ Új projekt"))),
    admin && !me.notify_email && h("div", { class: "banner" }, "Még nincs megadva az Ön értesítési e-mail-címe, ezért nem kap levelet, ha egy ügyfél feltölt vagy ír. ", h("a", { href: "#/beallitasok" }, "Megadom most")),
    failedMail && h("div", { class: "banner" }, `A legutóbbi e-mail kiküldése nem sikerült (${fmtTime(failedMail.created_at)}, ${failedMail.recipients}): ${failedMail.error} `, h("a", { href: "#/beallitasok" }, "Részletek")),
    shown.length ? h("div", { class: "folders" }, shown.map((p) => h("a", { class: "folder" + (p.archived ? " archived" : ""), href: `#/p/${p.id}` },
      h("span", { class: "tab" }, h("b", {}, admin ? p.client.name : p.reference || "Hiánypótlás"), unread(p) > 0 && h("i", { title: "Új tevékenység" })),
      h("span", { class: "sheet" },
        h("span", { class: "f-title" }, p.title, " ", unread(p) > 0 && h("span", { class: "dot" }, admin ? `${unread(p)} új` : "Új")),
        admin && p.reference && h("span", { class: "f-meta" }, p.reference),
        segbar(p.points),
        h("span", { class: "f-foot" }, h("strong", {}, progressText(p.points)), dueLabel(p.deadline))))))
      : h("div", { class: "empty" }, admin
        ? (showArchived ? "Nincs archivált projekt."
          : [h("strong", {}, "Itt lesznek a mappák"), "Az „Új projekt” gombbal vehet fel egyet – az ügyfelet is ott lehet létrehozni."])
        : [h("strong", {}, "Nincs teendője"), "Jelenleg nincs hiánypótlási feladata."]),
  ];
}

async function newProjectDialog(presetClientId) {
  const clients = need(await sb.from("profiles").select("id, name").eq("role", "client").order("name"));
  if (!clients.length) return clientDialog(null, (id) => newProjectDialog(id));
  let notice = null;
  const title = h("input", { type: "text", name: "title", required: true, maxlength: 200, placeholder: "pl. Telephelyfejlesztés – hiánypótlás" });
  const reference = h("input", { type: "text", name: "reference", maxlength: 100, placeholder: "nem kötelező" });
  const pointsBox = h("textarea", { name: "points", rows: 7, placeholder: "1. Cégkivonat (30 napnál nem régebbi)\n2. Aláírási címpéldány\n3. Árajánlatok" });
  const pdfStatus = h("span", { class: "hint" }, "A pontokat a program felismeri belőle, és az ügyfél is látni fogja az eredetit.");
  const onPdf = (file) => run(null, async () => {
    pdfStatus.textContent = "Beolvasás…";
    const { points, meta } = await readNotice(file).catch((e) => { pdfStatus.textContent = "Ezt a PDF-et nem sikerült beolvasni – a pontokat írja be kézzel."; throw e; });
    notice = file;
    if (!title.value && meta.title) title.value = meta.title;
    if (!reference.value && meta.reference) reference.value = meta.reference;
    if (points.length) pointsBox.value = points.map((p, i) => `${i + 1}. ${p}`).join("\n");
    pdfStatus.textContent = points.length
      ? `${points.length} pontot ismertem fel – lent ellenőrizheti és javíthatja.${meta.days ? ` A felszólítás szerint ${meta.days} nap a határidő a kézhezvételtől.` : ""}`
      : "A pontokat nem sikerült felismerni – kérem, írja be vagy másolja be őket lent. A PDF így is csatolva lesz.";
  });
  formModal("Új projekt", [
    field("Hiánypótlási felszólítás (PDF)", pdfInput(onPdf), pdfStatus),
    field("Ügyfél", h("select", { name: "client_id", required: true, value: presetClientId || clients[0].id },
      clients.map((c) => h("option", { value: c.id }, c.name)))),
    h("p", { class: "small", style: "margin:-.6rem 0 .6rem" }, h("button", { class: "btn quiet", type: "button", onclick: (ev) => { ev.target.closest("dialog").close(); ev.target.closest("dialog").remove(); clientDialog(null, (id) => newProjectDialog(id)); } }, "+ Új ügyfél felvétele")),
    field("Projekt neve", title),
    h("div", { class: "two" },
      field("Pályázati azonosító", reference),
      field("Határidő (nem kötelező)", h("input", { type: "date", name: "deadline" }))),
    field("Hiánypótlási pontok", pointsBox, "Soronként egy pont. Később is bővíthető."),
  ], "Létrehozás", async (v) => {
    const proj = need(await sb.from("projects").insert({
      client_id: v.client_id, title: v.title.trim(), reference: v.reference.trim() || null, deadline: v.deadline || null,
    }).select("id").single());
    const pts = parsePoints(v.points);
    if (pts.length) {
      const { error } = await sb.from("points").insert(pts.map((p, i) => ({ project_id: proj.id, position: i + 1, ...p })));
      if (error) toast(`A projekt létrejött, de a pontok mentése nem sikerült (${explain(error)}). A „Pontok hozzáadása” gombbal pótolhatók.`, true);
    }
    if (notice) await uploadNotice(proj.id, notice).catch((e) => toast(`A felszólítás PDF-jét nem sikerült csatolni (${explain(e)}). A projekt oldalán újra feltölthető.`, true));
    location.hash = `#/p/${proj.id}`;
  });
}

// ───────────────────────── projekt nézet ─────────────────────────

async function projectView(id) {
  const admin = me.role === "admin";
  const project = need(await sb.from("projects")
    .select("*, client:profiles(id, name, username, notify_email, notify_email2), points(*, files(*), messages(*))").eq("id", id).maybeSingle());
  if (!project) return h("div", { class: "empty", style: "margin-top:2.5rem" }, h("strong", {}, "Ez a projekt nem található"), h("a", { href: "#/" }, "Vissza a listához"));
  const points = project.points.sort(byPos);

  // Az „Új” jelzőt ebben a megjelenítésben még mutatjuk, a szerveren viszont már töröljük.
  // Csak a most betöltött állapotig jelölünk: ami a lekérdezés után változott, annak megmarad a jelzője és a levele.
  if (points.some((p) => (admin ? p.admin_unread : p.client_unread))) {
    const before = points.map((p) => p.updated_at).sort().pop();
    sb.rpc("mark_seen", { p_project: id, p_before: before }).then(({ error }) => error && console.error(error));
  }

  const files = points.flatMap((p) => p.files);
  const ok = count(points, "elfogadva");
  return [
    h("section", { class: "hero" },
      h("a", { class: "back", href: "#/" }, "← Projektek"),
      h("div", { class: "hero-main" },
        h("div", {},
          h("p", { class: "client" }, [admin && project.client.name, project.reference].filter(Boolean).join(" · ") || "Hiánypótlás"),
          h("h1", {}, project.title),
          h("div", { class: "facts" }, h("span", {}, progressText(points)), dueLabel(project.deadline),
            project.source_path && h("button", { class: "source", onclick: () => openFile({ path: project.source_path, name: project.source_name || "felszolitas.pdf" }) }, "Eredeti felszólítás (PDF)"))),
        points.length > 0 && h("div", { class: "ring", style: `--p:${Math.round((ok / points.length) * 100)}`, role: "img", "aria-label": `${ok} / ${points.length} pont rendben` },
          h("span", {}, String(ok), h("small", {}, ` / ${points.length}`)))),
      points.length > 0 && segbar(points)),
    admin && notifyBar(project, points),
    admin && h("div", { class: "toolbar" },
      !project.source_path && h("label", { class: "btn quiet" }, "Felszólítás (PDF) csatolása",
        h("input", { type: "file", accept: "application/pdf,.pdf", hidden: true, onchange: (ev) => run(null, async () => { await uploadNotice(project.id, ev.target.files[0]); toast("Csatolva – az ügyfél is látja."); refresh(); }) })),
      h("button", { class: "btn quiet", onclick: () => addPointsDialog(project, points) }, "+ Pontok hozzáadása"),
      h("button", { class: "btn quiet", onclick: () => editProjectDialog(project) }, "Adatok szerkesztése"),
      files.length > 0 && h("button", { class: "btn quiet", onclick: (ev) => run(ev.target, () => downloadZip(project, points)) }, `Összes fájl letöltése (${files.length})`),
      h("button", { class: "btn quiet", onclick: (ev) => run(ev.target, async () => { need(await sb.from("projects").update({ archived: !project.archived }).eq("id", id)); toast(project.archived ? "Visszaállítva." : "Archiválva."); refresh(); }) }, project.archived ? "Visszaállítás az aktívak közé" : "Archiválás"),
      h("button", { class: "btn danger", onclick: () => deleteProject(project, files) }, "Projekt törlése")),
    points.length ? points.map((p, i) => pointCard(project, p, i + 1))
      : h("div", { class: "empty" }, h("strong", {}, "Üres a mappa"), admin ? "Ehhez a projekthez még nincs hiánypótlási pont." : "Ehhez a projekthez még nincs feltöltendő dokumentum."),
  ];
}

// Az admin pontonkénti, ÁLLANDÓ utasítása az ügyfélnek (nem üzenet): az ügyfél kék betűvel látja a pont szövege alatt.
// Mentéskor a pont olvasatlan lesz az ügyfélnek, így a következő kézi értesítésbe bekerül.
function instructionEditor(p) {
  const box = h("textarea", { rows: 2, maxlength: 5000, "aria-label": "Teendő az ügyfélnek", placeholder: "Mit kell az ügyfélnek csinálnia ennél a pontnál? (az ügyfél kék betűvel látja)" }, p.instruction || "");
  const save = h("button", { class: "btn", type: "button", onclick: (ev) => run(ev.target, async () => {
    const v = box.value.trim() || null;
    need(await sb.from("points").update({ instruction: v, client_unread: true, updated_at: new Date().toISOString() }).eq("id", p.id));
    p.instruction = v; save.textContent = "✓ Mentve"; setTimeout(() => (save.textContent = "Teendő mentése"), 2500);
  }) }, "Teendő mentése");
  return h("div", { class: "instruction-edit" }, h("h3", {}, "Teendő az ügyfélnek"), box, h("div", { class: "row" }, save));
}

// Az ügyfél CSAK erre a gombra kap e-mailt: összefoglaló a még nem látott pontokról (új pont, üzenet, státusz).
function notifyBar(project, points) {
  const c = project.client;
  const to = [c.notify_email, c.notify_email2].filter(Boolean);
  const fresh = points.filter((p) => p.client_unread && (!project.client_notified_at || p.updated_at > project.client_notified_at)).length;
  const editEmails = h("button", { class: "linkish", onclick: () => clientDialog(c, refresh) }, to.length ? "címek módosítása" : "e-mail-cím megadása");
  return h("div", { class: "notify-bar" },
    h("div", {},
      h("strong", {}, fresh ? `${fresh} pontnál van újdonság, amiről az ügyfél még nem kapott e-mailt.` : "Nincs elküldetlen újdonság."),
      h("div", { class: "small" }, to.length ? `Címzett: ${to.join(", ")} · ` : "Az ügyfélnek még nincs e-mail-címe · ", editEmails)),
    h("button", {
      class: "btn primary", disabled: !fresh || !to.length || null,
      onclick: (ev) => run(ev.target, async () => {
        if (!(await confirmBox(`Elküldi az összefoglaló e-mailt ide: ${to.join(", ")}?`, "Küldés"))) return;
        const r = await api("notify_client", { project_id: project.id });
        toast(r?.sent ? `E-mail elküldve (${to.join(", ")}).` : "Nem ment levél: az ügyfél már mindent látott a portálon.");
        refresh();
      }),
    }, "Értesítés küldése az ügyfélnek"));
}

function pointCard(project, p, no) {
  const admin = me.role === "admin";
  const locked = !admin && p.status === "elfogadva";
  const isNew = admin ? p.admin_unread : p.client_unread;
  const open = openState.has(p.id) ? openState.get(p.id) : p.status !== "elfogadva" || isNew;
  const myFiles = (f) => admin || (f.uploaded_by === me.id && !locked);
  // A felszólításból beolvasott hosszú pontnál a cím a leírás eleje – ne jelenjen meg kétszer.
  const repeats = !!p.description && p.title.endsWith("…") && p.description.startsWith(p.title.slice(0, -1));

  const text = h("textarea", {
    rows: 2, maxlength: 5000, "aria-label": "Üzenet",
    placeholder: admin ? "Üzenet az ügyfélnek – pl. mit kell még javítani" : "Kérdése van? Írja ide.",
    oninput: () => drafts.set(p.id, text.value),
  }, drafts.get(p.id) || "");
  const send = (status, mustWrite) => (ev) => run(ev.target, async () => {
    const body = text.value.trim();
    if (mustWrite && !body) { text.focus(); throw new Error("Írja le röviden, mit kell javítani – ezt kapja meg az ügyfél."); }
    if (!body && !status) { text.focus(); return; }
    need(await sb.rpc("post_message", { p_point: p.id, p_body: body || null, p_status: status }));
    drafts.delete(p.id);
    if (status === "elfogadva") openState.delete(p.id);
    toast(!admin ? "Elküldve."
      : "Elküldve. Az ügyfél a portálon látja; e-mailt akkor kap, ha fent az „Értesítés küldése” gombra kattint.");
    refresh();
  });

  const status = h("span", { class: "small muted upload-status" });
  const input = h("input", { type: "file", multiple: true, onchange: () => { upload(project, p, input.files, status); } });
  const drop = h("label", {
    class: "drop",
    ondragover: (ev) => { ev.preventDefault(); drop.classList.add("over"); },
    ondragleave: () => drop.classList.remove("over"),
    ondrop: (ev) => { ev.preventDefault(); drop.classList.remove("over"); upload(project, p, ev.dataTransfer.files, status); },
  }, input, h("span", {}, h("strong", {}, "Fájlok kiválasztása"), " vagy húzza ide őket"), h("span", { class: "small" }, "Több fájl is feltölthető, egyenként legfeljebb 50 MB. Telefonról fotó is készíthető."));

  return h("details", {
    class: `point s-${p.status}`, open, id: `pont-${p.id}`,
    ontoggle: (ev) => openState.set(p.id, ev.target.open),
  },
    h("summary", {},
      h("span", { class: "no" }, String(no).padStart(2, "0")),
      h("span", { class: "title" }, repeats ? [h("span", { class: "t-short" }, p.title), h("span", { class: "t-full" }, p.description)] : p.title),
      h("span", { class: "badges" }, isNew && h("span", { class: "dot" }, "Új"), stamp(p.status))),
    h("div", { class: "body" },
      !repeats && p.description && h("div", { class: "desc" }, p.description),
      admin ? instructionEditor(p) : p.instruction && h("div", { class: "instruction" }, h("b", {}, "Teendő: "), p.instruction),

      h("h3", {}, "Dokumentumok"),
      p.files.length ? h("ul", { class: "files" }, p.files.sort(byTime).map((f) => h("li", {},
        h("span", { class: "ext" }, (f.name.includes(".") ? f.name.split(".").pop() : "fájl").slice(0, 4).toUpperCase()),
        h("button", { class: "fname", onclick: () => openFile(f) }, f.name),
        h("span", { class: "info" }, `${fmtSize(f.size)} · ${fmtTime(f.created_at)}${f.from_admin ? ` · ${admin ? "Ön mellékelte" : "a pályázatíró mellékelte"}` : ""}`),
        h("button", { class: "act", onclick: (ev) => run(ev.target, () => openFile(f, true)) }, "letöltés"),
        myFiles(f) && h("button", { class: "act del", onclick: () => deleteFile(f) }, "törlés"))))
        : h("p", { class: "muted small", style: "margin:0" }, "Még nincs feltöltött fájl."),
      locked ? h("p", { class: "locked" }, "✓ Ezt a pontot elfogadtuk, további teendője nincs vele.") : [drop, status],

      h("h3", {}, "Üzenetek"),
      p.messages.length > 0 && h("div", { class: "thread" }, p.messages.sort(byTime).map((m) => h("div", { class: "msg" + (m.from_admin === admin ? " mine" : "") },
        h("div", { class: "who" }, `${m.from_admin === admin ? "Ön" : admin ? project.client.name : brand} · ${fmtTime(m.created_at)}`),
        h("div", { class: "text" }, m.body)))),
      h("div", { class: "composer" }, text, h("div", { class: "row" },
        admin ? [
          h("button", { class: "btn", onclick: send(null) }, "Üzenet küldése"),
          p.status !== "javitando" && h("button", { class: "btn warn", onclick: send("javitando", true) }, "Javítást kérek"),
          p.status !== "elfogadva" && h("button", { class: "btn ok", onclick: send("elfogadva") }, "Elfogadom"),
        ] : h("button", { class: "btn primary", onclick: send(null) }, "Üzenet küldése"))),

      admin && h("div", { class: "tools row" },
        h("button", { class: "btn quiet", onclick: () => editPointDialog(p) }, "Pont szerkesztése"),
        p.status !== "hianyzik" && h("button", { class: "btn quiet", onclick: send("hianyzik") }, "Visszaállítás: hiányzik"),
        h("button", { class: "btn danger", onclick: () => deletePoint(p) }, "Pont törlése"))));
}

// ───────────────────────── fájlok ─────────────────────────

async function upload(project, point, fileList, statusEl) {
  const list = [...fileList];
  if (!list.length) return;
  const errors = [];
  let done = 0;
  for (const [i, f] of list.entries()) {
    statusEl.textContent = `Feltöltés… ${i + 1}/${list.length}: ${f.name}`;
    if (f.size > MAX_FILE) { errors.push(`${f.name}: nagyobb, mint 50 MB`); continue; }
    if (!f.size) { errors.push(`${f.name}: üres fájl`); continue; }
    const path = `${project.id}/${point.id}/${crypto.randomUUID()}-${asciiName(f.name)}`;
    const up = await sb.storage.from("docs").upload(path, f, { contentType: f.type || "application/octet-stream" });
    if (up.error) { errors.push(`${f.name}: ${explain(up.error)}`); continue; }
    const row = await sb.from("files").insert({ point_id: point.id, path, name: f.name, size: f.size });
    if (row.error) { errors.push(`${f.name}: ${explain(row.error)}`); continue; }   // az árva objektumot a pont/projekt törlése viszi
    done++;
  }
  statusEl.textContent = "";
  if (errors.length) toast(`Nem sikerült: ${errors.join("; ")}`, true);
  if (done) toast(done === 1 ? "1 fájl feltöltve." : `${done} fájl feltöltve.`);
  refresh();
}

const signedUrl = async (f) =>
  need(await sb.storage.from("docs").createSignedUrl(f.path, 120, { download: f.name })).signedUrl;

// PDF/kép új lapon nyílik (gyors átnézés), minden más letöltődik.
// Az előnézet típusát a kiterjesztésből MI adjuk meg (nem a feltöltő által küldött Content-Type-ból),
// így egy .pdf-nek álcázott HTML/SVG legfeljebb hibás PDF-ként jelenik meg, kódként nem fut le.
const PREVIEW = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
async function openFile(f, forceDownload) {
  const type = !forceDownload && PREVIEW[f.name.split(".").pop().toLowerCase()];
  const tab = type ? window.open("", "_blank") : null;   // a kattintással szinkron kell nyitni
  if (tab) tab.opener = null;                            // az új lap ne érje el a portál ablakát
  try {
    if (!tab) return location.assign(await signedUrl(f));
    const blob = need(await sb.storage.from("docs").download(f.path));
    const url = URL.createObjectURL(new Blob([blob], { type }));
    tab.location = url;
    setTimeout(() => URL.revokeObjectURL(url), 10 * 60000);
  } catch (e) { tab?.close(); toast(explain(e), true); }
}

async function deleteFile(f) {
  if (!(await confirmBox(`Törli ezt a fájlt? „${f.name}”`))) return;
  run(null, async () => { await api("delete_file", { id: f.id }); refresh(); });
}

async function downloadZip(project, points) {
  if (!window.JSZip) await new Promise((ok, no) => document.head.append(h("script", { src: "vendor/jszip.min.js", onload: ok, onerror: () => no(new Error("A tömörítő nem töltődött be.")) })));
  const zip = new window.JSZip();
  const clean = (s) => s.replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 80);
  for (const [i, p] of points.entries()) {
    const used = new Set();
    for (const f of p.files) {
      let name = clean(f.name) || "fajl";
      for (let n = 2; used.has(name.toLowerCase()); n++) name = clean(f.name).replace(/(\.[^.]*)?$/, ` (${n})$1`);
      used.add(name.toLowerCase());
      const res = await fetch(await signedUrl(f));
      if (!res.ok) throw new Error(`Nem tölthető le: ${f.name}`);
      zip.file(`${String(i + 1).padStart(2, "0")} ${clean(p.title)}/${name}`, await res.blob());
    }
  }
  const url = URL.createObjectURL(await zip.generateAsync({ type: "blob" }));
  const a = h("a", { href: url, download: `${clean(project.client.name)} - ${clean(project.title)}.zip` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ───────────────────────── admin: projekt/pont szerkesztés ─────────────────────────

function addPointsDialog(project, points) {
  formModal("Pontok hozzáadása", [
    field("Új hiánypótlási pontok", h("textarea", { name: "points", rows: 6, required: true }), "Soronként egy pont."),
  ], "Hozzáadás", async (v) => {
    const start = Math.max(0, ...points.map((p) => p.position));
    const pts = parsePoints(v.points);
    if (!pts.length) throw new Error("Írjon be legalább egy pontot.");
    need(await sb.from("points").insert(pts.map((title, i) => ({ project_id: project.id, position: start + i + 1, title }))));
    refresh();
  });
}

function editProjectDialog(project) {
  formModal("Projekt adatai", [
    field("Projekt neve", h("input", { type: "text", name: "title", required: true, maxlength: 200, value: project.title })),
    h("div", { class: "two" },
      field("Pályázati azonosító", h("input", { type: "text", name: "reference", maxlength: 100, value: project.reference || "" })),
      field("Határidő", h("input", { type: "date", name: "deadline", value: project.deadline || "" }))),
  ], "Mentés", async (v) => {
    need(await sb.from("projects").update({ title: v.title.trim(), reference: v.reference.trim() || null, deadline: v.deadline || null }).eq("id", project.id));
    refresh();
  });
}

function editPointDialog(p) {
  formModal("Pont szerkesztése", [
    field("Megnevezés", h("input", { type: "text", name: "title", required: true, maxlength: 300, value: p.title })),
    field("Részletek az ügyfélnek", h("textarea", { name: "description", rows: 5, maxlength: 5000 }, p.description || ""), "Pl. milyen formátum, mire figyeljen. Nem kötelező."),
    field("Sorszám", h("input", { type: "text", name: "position", inputmode: "numeric", pattern: "[0-9]+", required: true, value: p.position }), "A pontok e szerint követik egymást."),
  ], "Mentés", async (v) => {
    need(await sb.from("points").update({ title: v.title.trim(), description: v.description.trim() || null, position: Number(v.position) }).eq("id", p.id));
    refresh();
  });
}

async function deletePoint(p) {
  if (!(await confirmBox(`Törli a(z) „${p.title}” pontot a feltöltött fájlokkal és üzenetekkel együtt? Ez nem vonható vissza.`))) return;
  run(null, async () => { await api("delete_point", { id: p.id }); refresh(); });
}

async function deleteProject(project, files) {
  if (!(await confirmBox(`Törli a(z) „${project.title}” projektet minden ponttal, fájllal (${files.length} db) és üzenettel együtt? Ez nem vonható vissza.`))) return;
  run(null, async () => { await api("delete_project", { id: project.id }); toast("Projekt törölve."); location.hash = "#/"; });
}

// ───────────────────────── admin: ügyfelek ─────────────────────────

async function clientsView() {
  const clients = need(await sb.from("profiles").select("*, projects(id)").eq("role", "client").order("name"));
  return [
    h("div", { class: "page-head spread" }, h("h1", {}, "Ügyfelek"),
      h("button", { class: "btn primary", onclick: () => clientDialog(null, refresh) }, "+ Új ügyfél")),
    clients.length ? h("div", { class: "people" }, clients.map((c) => h("div", { class: "person" },
      h("div", { class: "avatar", "aria-hidden": "true" }, initials(c.name)),
      h("div", {},
        h("div", { class: "name" }, c.name),
        h("div", { class: "muted small" }, `Felhasználónév: ${c.username} · ${[c.notify_email, c.notify_email2].filter(Boolean).join(", ") || "nincs e-mail-cím"} · ${c.projects.length} projekt`)),
      h("div", { class: "row small" },
        h("button", { class: "btn quiet", onclick: () => newProjectDialog(c.id) }, "Új projekt"),
        h("button", { class: "btn quiet", onclick: () => clientDialog(c, refresh) }, "Szerkesztés"),
        h("button", { class: "btn quiet", onclick: () => resetPassword(c) }, "Belépési adatok elküldése"),
        h("button", { class: "btn danger", onclick: () => deleteClient(c) }, "Törlés")))))
      : h("div", { class: "empty" }, h("strong", {}, "Még nincs ügyfél"), "Az „Új ügyfél” gombbal vehet fel egyet."),
  ];
}

// Új ügyfél (c = null) vagy meglévő szerkesztése. Siker után then(id).
function clientDialog(c, then) {
  const username = h("input", { type: "text", name: "username", required: true, pattern: "[a-z0-9._\\-]{3,40}", autocapitalize: "none", spellcheck: "false" });
  let touched = false;
  username.addEventListener("input", () => (touched = true));
  formModal(c ? "Ügyfél szerkesztése" : "Új ügyfél", [
    field("Név", h("input", { type: "text", name: "name", required: true, maxlength: 200, value: c?.name || "", placeholder: "Cégnév vagy kapcsolattartó", oninput: (ev) => { if (!c && !touched) username.value = slug(ev.target.value); } })),
    !c && field("Felhasználónév", username, "Ezzel lép be: kisbetű, szám, pont, kötőjel."),
    h("div", { class: "two" },
      field("E-mail-cím", h("input", { type: "email", name: "notify_email", value: c?.notify_email || "" })),
      field("Második e-mail-cím", h("input", { type: "email", name: "notify_email2", value: c?.notify_email2 || "" }))),
    h("p", { class: "hint", style: "margin:-.4rem 0 .9rem" }, "Az értesítések mindkét címre mennek, de csak akkor, ha a projekt oldalán Ön elküldi őket. Nem kötelező – később is megadható."),
    !c && field("Jelszó", h("input", { type: "text", name: "password", required: true, minlength: 8, value: genPassword(), autocomplete: "off" }), "Előre generáltuk; átírható (legalább 8 karakter)."),
  ], c ? "Mentés" : "Létrehozás", async (v) => {
    if (c) {
      await api("update_client", { id: c.id, name: v.name, notify_email: v.notify_email, notify_email2: v.notify_email2 });
      then(c.id);
    } else {
      const { id } = await api("create_client", v);
      credentialsDialog({ id, name: v.name.trim(), username: v.username.trim().toLowerCase(), email: v.notify_email.trim(), email2: v.notify_email2.trim() }, v.password, () => then(id));
    }
  });
}

function resetPassword(c) {
  formModal(`Belépési adatok – ${c.name}`, [
    h("p", { class: "muted" }, "A jelszót titkosítva tároljuk, ezért a régit nem tudjuk elküldeni: új jelszót kap, a következő lépésben pedig átnézheti és elküldheti a levelet."),
    field("Új jelszó", h("input", { type: "text", name: "password", required: true, minlength: 8, value: genPassword(), autocomplete: "off" }), "A régi jelszó azonnal érvényét veszti."),
  ], "Tovább a levélhez", async (v) => {
    await api("update_client", { id: c.id, password: v.password });
    credentialsDialog({ id: c.id, name: c.name, username: c.username, email: c.notify_email || "", email2: c.notify_email2 || "" }, v.password, () => {});
  });
}

// A jelszót csak most látjuk. Az admin itt ellenőrzi (és átírhatja) a levelet, majd innen el is küldheti az ügyfélnek.
function credentialsDialog(client, password, then) {
  const letter = h("textarea", { class: "letter", "aria-label": "A levél szövege", maxlength: 5000 },
    `Tisztelt ${client.name}!\n\nA hiánypótláshoz szükséges dokumentumokat az alábbi oldalon tudja feltölteni:\n${location.origin}${location.pathname}\n\nFelhasználónév: ${client.username}\nJelszó: ${password}\n\nAz első belépéskor meg kell adnia egy e-mail-címet – erre küldünk értesítést, ha üzenetet írunk, vagy valamit javítani kell.\n\nÜdvözlettel:\n${brand}`);
  const to = h("input", { type: "email", name: "to", value: client.email, placeholder: "ugyfel@pelda.hu", autocomplete: "off" });
  const to2 = h("input", { type: "email", name: "to2", value: client.email2 || "", placeholder: "nem kötelező", autocomplete: "off" });
  modal("Belépési adatok", (close) => [
    h("p", { class: "muted" }, "Ez a levél megy az ügyfélnek – küldés előtt átírható. A jelszó később nem jeleníthető meg újra (új viszont bármikor adható)."),
    field("A levél szövege", letter),
    h("div", { class: "two" }, field("Címzett e-mail-címe", to), field("Második címzett", to2)),
    h("div", { class: "row end actions" },
      h("button", { class: "btn quiet", onclick: (ev) => run(ev.target, async () => { await navigator.clipboard.writeText(letter.value); toast("Vágólapra másolva."); }) }, "Szöveg másolása"),
      h("button", { class: "btn", onclick: () => { close(); then(); } }, "Bezárás"),
      h("button", {
        class: "btn primary", onclick: (ev) => run(ev.target, async () => {
          const email = to.value.trim(), email2 = to2.value.trim();
          if (!EMAIL.test(email)) { to.focus(); throw new Error("Adja meg az ügyfél e-mail-címét."); }
          if (email2 && !EMAIL.test(email2)) { to2.focus(); throw new Error("A második e-mail-cím hibás."); }
          if (!letter.value.trim()) { letter.focus(); throw new Error("A levél szövege üres."); }
          const list = [email, email2].filter(Boolean);
          await api("send_credentials", { id: client.id, to: list, text: letter.value });
          ev.target.textContent = "✓ Elküldve"; ev.target.classList.replace("primary", "done");
          toast(`A levél elment ide: ${list.join(", ")}`);
        }),
      }, "E-mail küldése")),
  ], true);
}

async function deleteClient(c) {
  if (!(await confirmBox(`Törli a(z) „${c.name}” ügyfelet? Vele együtt törlődik mind a(z) ${c.projects.length} projektje, minden feltöltött fájl és üzenet. Ez nem vonható vissza.`))) return;
  run(null, async () => { await api("delete_client", { id: c.id }); toast("Ügyfél törölve."); refresh(); });
}

// ───────────────────────── beállítások ─────────────────────────

async function settingsView() {
  const admin = me.role === "admin";
  const simpleForm = (fields, label, onSubmit) => {
    const form = h("form", { onsubmit: (ev) => { ev.preventDefault(); run(form.querySelector("button"), () => onSubmit(Object.fromEntries(new FormData(form)), form)); } },
      fields, h("button", { class: "btn primary", type: "submit" }, label));
    return form;
  };
  const log = admin ? need(await sb.from("mail_log").select("*").order("id", { ascending: false }).limit(25)) : [];

  return [
    h("div", { class: "page-head" }, h("h1", {}, "Beállítások"), h("p", { class: "sub" }, `${me.name} · felhasználónév: ${me.username}`)),

    h("section", { class: "card" }, h("h2", {}, "Értesítési e-mail-cím"),
      simpleForm([field("E-mail-cím", h("input", { type: "email", name: "email", required: true, value: me.notify_email || "" }),
        admin ? "Ide érkezik levél, ha egy ügyfél fájlt tölt fel vagy üzenetet ír. Az ügyfelek erre a címre tudnak válaszolni." : "Ide küldünk értesítést, ha üzenetet kap, vagy valamit javítani kell."),
        !admin && field("Második e-mail-cím (nem kötelező)", h("input", { type: "email", name: "email2", value: me.notify_email2 || "" }), "Pl. a könyvelő vagy egy kolléga – ő is megkapja az értesítést.")],
        "Mentés", async (v) => {
          const patch = { notify_email: v.email.trim(), ...(admin ? {} : { notify_email2: v.email2.trim() || null }) };
          need(await sb.from("profiles").update(patch).eq("id", me.id));
          Object.assign(me, patch); toast("Mentve.");
        }),
      admin && h("p", { style: "margin:1rem 0 0" }, h("button", { class: "btn", onclick: (ev) => run(ev.target, async () => { await api("test_email"); toast(`Próbalevél elküldve ide: ${me.notify_email}`); refresh(); }) }, "Próbalevél küldése magamnak"))),

    h("section", { class: "card" }, h("h2", {}, "Jelszó módosítása"),
      simpleForm(field("Új jelszó", h("input", { type: "password", name: "password", required: true, minlength: 8, autocomplete: "new-password" }), "Legalább 8 karakter."),
        "Jelszó módosítása", async (v, form) => {
          const { error } = await sb.auth.updateUser({ password: v.password });
          if (error) throw error;
          form.reset(); toast("A jelszó megváltozott.");
        })),

    admin && h("section", { class: "card" }, h("h2", {}, "Cégnév"),
      simpleForm(field("A portál fejlécében és az e-mailek feladójaként megjelenő név", h("input", { type: "text", name: "brand", required: true, maxlength: 80, value: brand })),
        "Mentés", async (v) => {
          need(await sb.from("settings").update({ brand: v.brand.trim() }).eq("id", true));
          brand = v.brand.trim(); document.title = brand; toast("Mentve."); refresh();
        })),

    admin && h("section", { class: "card" }, h("h2", {}, "Kiküldött levelek"),
      log.length ? h("div", { class: "scroll-x" }, h("table", { class: "log" }, log.map((l) => h("tr", {},
        h("td", { style: "white-space:nowrap" }, fmtTime(l.created_at)),
        h("td", {}, l.recipients),
        h("td", {}, l.subject, l.error && h("div", { class: "s-javitando" }, `Hiba: ${l.error}`))))))
        : h("p", { class: "muted small" }, "Még nem ment ki levél."),
      h("p", { class: "muted small", style: "margin:.75rem 0 0" }, "Az Ön értesítése az utolsó ügyfél-tevékenység után kb. 5 perccel megy ki, egy levélben összefoglalva. Az ügyfél csak akkor kap levelet, ha a projekt oldalán az „Értesítés küldése” gombra kattint.")),
  ];
}

boot();
