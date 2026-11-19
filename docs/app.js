/* Hiánypótlás portál – egyoldalas alkalmazás, build-lépés nélkül.
   Adat: Supabase (táblák RLS-sel + Storage + egy Edge Function). Részletek: AGENTS.md
   XSS-védelem: minden DOM a h() segéddel épül, felhasználói szöveg csak text node-ként kerül ki. */

const cfg = window.PORTAL_CONFIG;
const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey);
const app = document.getElementById("app");
const MAX_FILE = 50 * 1024 * 1024; // a Storage bucket limitje is ennyi

const STATUS = { hianyzik: "Hiányzik", feltoltve: "Ellenőrzésre vár", javitando: "Javítandó", elfogadva: "Rendben" };
let me = null;                       // a belépett felhasználó profilja
let brand = "Hiánypótlás portál";
let renderNo = 0;                    // versenyhelyzet ellen: csak a legutolsó render írhat a DOM-ba
const openState = new Map();         // pont id → nyitva van-e (újrarajzolás után megmarad)
const drafts = new Map();            // pont id → félbehagyott megjegyzés

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

function toast(text, isError) {
  const t = h("div", { class: "toast" + (isError ? " err" : "") }, text);
  document.getElementById("toasts").append(t);
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
// Storage-kulcsba csak ASCII mehet; az eredeti nevet a files.name őrzi.
const asciiName = (n) => n.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9._-]+/g, "_").slice(-80) || "fajl";
const genPassword = () => {
  const abc = "abcdefghjkmnpqrstuvwxyz23456789"; // félreolvasható karakterek nélkül
  const r = crypto.getRandomValues(new Uint32Array(12));
  return [...r].map((x, i) => (i && i % 4 === 0 ? "-" : "") + abc[x % abc.length]).join("");
};
const slug = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30);
// „1. Cégkivonat”, „2) …”, „- …” → a sorszámot/jelölőt levágjuk, a sorrend úgyis megmarad
const parsePoints = (text) => text.split("\n").map((l) => l.replace(/^\s*(\d+\s*[.)]|[-–•*])\s*/, "").trim()).filter(Boolean);

function dueLabel(deadline) {
  if (!deadline) return null;
  const d = daysLeft(deadline);
  const txt = d > 1 ? `${d} nap van hátra` : d === 1 ? "holnap jár le" : d === 0 ? "ma jár le" : `${-d} napja lejárt`;
  return h("span", { class: "due" + (d <= 3 ? " soon" : "") }, `Határidő: ${fmtDate(deadline)} · ${txt}`);
}
const stamp = (status) => h("span", { class: `stamp s-${status}` }, STATUS[status]);
const segbar = (points) => h("div", { class: "segbar", role: "img", "aria-label": progressText(points) },
  [...points].sort(byPos).map((p) => h("span", { class: `s-${p.status}`, title: `${p.title ?? ""} – ${STATUS[p.status]}`.replace(/^ – /, "") })));
function progressText(points) {
  const ok = points.filter((p) => p.status === "elfogadva").length;
  const fix = points.filter((p) => p.status === "javitando").length;
  const miss = points.filter((p) => p.status === "hianyzik").length;
  if (!points.length) return "Még nincs pont";
  if (ok === points.length) return "Minden pont rendben";
  const wait = points.length - ok - fix - miss;
  return `${ok} / ${points.length} rendben` + (wait ? ` · ${wait} ellenőrzésre vár` : "") + (fix ? ` · ${fix} javítandó` : "") + (miss ? ` · ${miss} hiányzik` : "");
}

// Párbeszédablak a natív <dialog>-gal. A build() megkapja a bezáró függvényt.
function modal(title, build) {
  const d = h("dialog", {});
  const close = () => { d.close(); d.remove(); };
  d.append(h("h2", {}, title), ...[build(close)].flat());
  d.addEventListener("cancel", () => setTimeout(() => d.remove()));
  document.body.append(d);
  d.showModal();
  return close;
}
const confirmBox = (text, okLabel = "Törlés") => new Promise((resolve) => {
  modal("Biztosan?", (close) => [
    h("p", {}, text),
    h("div", { class: "row end" },
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
    }, fields, h("div", { class: "row end" },
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
    try {
      const main = route === "p" && id ? await projectView(id)
        : route === "ugyfelek" && admin ? await clientsView()
        : route === "beallitasok" ? await settingsView()
        : await homeView();
      if (!main) return; // a nézet átirányított
      view = [header(route), h("main", { class: "wrap" }, main)];
    } catch (e) {
      console.error(e);
      view = [header(route), h("main", { class: "wrap" }, h("p", { class: "loading" }, explain(e)))];
    }
  }
  if (no !== renderNo) return;
  app.replaceChildren(...[view].flat());
  window.scrollTo(0, keepScroll ? y : 0);
}
const refresh = () => render(true);

function header(route) {
  const link = (href, text, key) => h("a", { href, "aria-current": route === key || (!route && !key) ? "page" : null }, text);
  return h("header", { class: "top" }, h("div", { class: "inner" },
    h("a", { class: "brand", href: "#/" }, brand),
    h("nav", {},
      link("#/", "Projektek", undefined),
      me.role === "admin" && link("#/ugyfelek", "Ügyfelek", "ugyfelek"),
      link("#/beallitasok", "Beállítások", "beallitasok"),
      h("button", { onclick: async () => { await sb.auth.signOut(); me = null; location.hash = "#/"; render(); } }, "Kilépés"))));
}

// ───────────────────────── belépés ─────────────────────────

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
  return h("div", { class: "gate" }, h("div", { class: "box" },
    h("h1", {}, brand),
    h("p", { class: "sub" }, "Hiánypótlási dokumentumok feltöltése"),
    form,
    h("p", { class: "muted small", style: "margin:1.25rem 0 0" }, "A belépési adatokat a pályázatírójától kapta meg. Ha elvesztek, kérjen tőle új jelszót.")));
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
  return h("div", { class: "gate" }, h("div", { class: "box" },
    h("h1", {}, "Hová küldjük az értesítést?"),
    h("p", { class: "sub" }, "Erre a címre írunk, ha üzenetet kap, vagy valamelyik dokumentumot javítani kell."),
    form,
    h("p", { class: "muted small", style: "margin:1.25rem 0 0" }, "A címet csak a hiánypótlással kapcsolatos értesítésekre használjuk. Később a Beállításokban módosíthatja.")));
}

// ───────────────────────── projektlista ─────────────────────────

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

  return [
    h("div", { class: "page-head spread" },
      h("h1", {}, admin ? (showArchived ? "Archivált projektek" : "Projektek") : "Hiánypótlásai"),
      admin && h("div", { class: "row" },
        h("button", { class: "btn quiet", onclick: () => { sessionStorage.setItem("archived", showArchived ? "0" : "1"); render(); } }, showArchived ? "Aktívak" : "Archiváltak"),
        h("button", { class: "btn primary", onclick: () => newProjectDialog() }, "+ Új projekt"))),
    failedMail && h("div", { class: "banner" }, `A legutóbbi értesítő e-mail kiküldése nem sikerült (${fmtTime(failedMail.created_at)}, ${failedMail.recipients}): ${failedMail.error} `, h("a", { href: "#/beallitasok" }, "Részletek")),
    shown.length ? h("ul", { class: "list" }, shown.map((p) => h("li", {}, h("a", { class: "proj", href: `#/p/${p.id}` },
      h("div", {},
        h("div", { class: "name" }, admin ? p.client.name : p.title, " ", unread(p) > 0 && h("span", { class: "dot" }, admin ? `${unread(p)} új` : "Új")),
        h("div", { class: "meta" }, [admin && p.title, p.reference].filter(Boolean).join(" · "))),
      h("div", { class: "right" }, h("div", {}, progressText(p.points)), dueLabel(p.deadline)),
      segbar(p.points)))))
      : h("div", { class: "empty" }, admin
        ? (showArchived ? "Nincs archivált projekt." : "Még nincs projekt. Az „Új projekt” gombbal vehet fel egyet – az ügyfelet is ott lehet létrehozni.")
        : "Jelenleg nincs hiánypótlási feladata."),
  ];
}

async function newProjectDialog(presetClientId) {
  const clients = need(await sb.from("profiles").select("id, name").eq("role", "client").order("name"));
  if (!clients.length) return clientDialog(null, (id) => newProjectDialog(id));
  formModal("Új projekt", [
    field("Ügyfél", h("select", { name: "client_id", required: true, value: presetClientId || clients[0].id },
      clients.map((c) => h("option", { value: c.id }, c.name)))),
    h("p", { class: "small", style: "margin-top:-.5rem" }, h("button", { class: "btn quiet", type: "button", onclick: (ev) => { ev.target.closest("dialog").close(); ev.target.closest("dialog").remove(); clientDialog(null, (id) => newProjectDialog(id)); } }, "+ Új ügyfél felvétele")),
    field("Projekt neve", h("input", { type: "text", name: "title", required: true, maxlength: 200, placeholder: "pl. Telephelyfejlesztés – hiánypótlás" })),
    field("Pályázati azonosító", h("input", { type: "text", name: "reference", maxlength: 100 }), "nem kötelező"),
    field("Hiánypótlási határidő", h("input", { type: "date", name: "deadline" }), "nem kötelező"),
    field("Hiánypótlási pontok", h("textarea", { name: "points", rows: 7, placeholder: "1. Cégkivonat (30 napnál nem régebbi)\n2. Aláírási címpéldány\n3. Árajánlatok" }),
      "Soronként egy pont – a felszólítás listája egyben bemásolható. Később is bővíthető."),
  ], "Létrehozás", async (v) => {
    const proj = need(await sb.from("projects").insert({
      client_id: v.client_id, title: v.title.trim(), reference: v.reference.trim() || null, deadline: v.deadline || null,
    }).select("id").single());
    const pts = parsePoints(v.points);
    if (pts.length) need(await sb.from("points").insert(pts.map((title, i) => ({ project_id: proj.id, position: i + 1, title }))));
    location.hash = `#/p/${proj.id}`;
  });
}

// ───────────────────────── projekt nézet ─────────────────────────

async function projectView(id) {
  const admin = me.role === "admin";
  const project = need(await sb.from("projects")
    .select("*, client:profiles(id, name, username, notify_email), points(*, files(*), messages(*))").eq("id", id).maybeSingle());
  if (!project) return h("div", { class: "empty", style: "margin-top:2rem" }, "Ez a projekt nem található. ", h("a", { href: "#/" }, "Vissza a listához"));
  const points = project.points.sort(byPos);

  // Az „Új” jelzőt ebben a megjelenítésben még mutatjuk, a szerveren viszont már töröljük.
  if (points.some((p) => (admin ? p.admin_unread : p.client_unread))) sb.rpc("mark_seen", { p_project: id }).then(() => {});

  const files = points.flatMap((p) => p.files);
  return [
    h("div", { class: "page-head" },
      h("a", { class: "back", href: "#/" }, "← Projektek"),
      h("h1", {}, project.title),
      h("p", { class: "muted", style: "margin:.35rem 0 0" }, [admin && project.client.name, project.reference].filter(Boolean).join(" · "))),
    h("section", { class: "summary" },
      h("div", { class: "facts" }, h("strong", {}, progressText(points)), dueLabel(project.deadline)),
      segbar(points),
      admin && !project.client.notify_email && h("div", { class: "small s-javitando" }, "Az ügyfél még nem adott meg e-mail-címet (első belépéskor kérjük be), addig nem kap értesítést."),
      admin && h("div", { class: "row small" },
        h("button", { class: "btn quiet", onclick: () => addPointsDialog(project, points) }, "+ Pontok hozzáadása"),
        h("button", { class: "btn quiet", onclick: () => editProjectDialog(project) }, "Adatok szerkesztése"),
        files.length > 0 && h("button", { class: "btn quiet", onclick: (ev) => run(ev.target, () => downloadZip(project, points)) }, `Összes fájl letöltése (${files.length})`),
        h("button", { class: "btn quiet", onclick: (ev) => run(ev.target, async () => { need(await sb.from("projects").update({ archived: !project.archived }).eq("id", id)); toast(project.archived ? "Visszaállítva." : "Archiválva."); refresh(); }) }, project.archived ? "Visszaállítás az aktívak közé" : "Archiválás"),
        h("button", { class: "btn danger", onclick: () => deleteProject(project, files) }, "Projekt törlése"))),
    points.length ? points.map((p, i) => pointCard(project, p, i + 1))
      : h("div", { class: "empty" }, admin ? "Ehhez a projekthez még nincs hiánypótlási pont." : "Ehhez a projekthez még nincs feltöltendő dokumentum."),
  ];
}

function pointCard(project, p, no) {
  const admin = me.role === "admin";
  const locked = !admin && p.status === "elfogadva";
  const isNew = admin ? p.admin_unread : p.client_unread;
  const open = openState.has(p.id) ? openState.get(p.id) : p.status !== "elfogadva" || isNew;
  const myFiles = (f) => admin || (f.uploaded_by === me.id && !locked);

  const text = h("textarea", {
    rows: 2, maxlength: 5000, "aria-label": "Megjegyzés",
    placeholder: admin ? "Üzenet az ügyfélnek – pl. mit kell még javítani" : "Megjegyzés a pályázatírónak (nem kötelező)",
    oninput: () => drafts.set(p.id, text.value),
  }, drafts.get(p.id) || "");
  const send = (status, mustWrite) => (ev) => run(ev.target, async () => {
    const body = text.value.trim();
    if (mustWrite && !body) { text.focus(); throw new Error("Írja le röviden, mit kell javítani – ezt kapja meg az ügyfél."); }
    if (!body && !status) { text.focus(); return; }
    need(await sb.rpc("post_message", { p_point: p.id, p_body: body || null, p_status: status }));
    drafts.delete(p.id);
    if (status === "elfogadva") openState.delete(p.id);
    toast(admin ? "Elküldve. Az ügyfél néhány percen belül e-mailt kap róla." : "Elküldve.");
    refresh();
  });

  const status = h("span", { class: "small muted" });
  const input = h("input", { type: "file", multiple: true, onchange: () => { upload(project, p, input.files, status); } });
  const drop = h("label", {
    class: "drop",
    ondragover: (ev) => { ev.preventDefault(); drop.classList.add("over"); },
    ondragleave: () => drop.classList.remove("over"),
    ondrop: (ev) => { ev.preventDefault(); drop.classList.remove("over"); upload(project, p, ev.dataTransfer.files, status); },
  }, input, h("strong", {}, "Fájlok kiválasztása"), " vagy húzza ide őket", h("br"), h("span", { class: "small" }, "Több fájl is feltölthető, egyenként legfeljebb 50 MB. Telefonról fotó is készíthető."));

  return h("details", {
    class: `point s-${p.status}`, open, id: `pont-${p.id}`,
    ontoggle: (ev) => openState.set(p.id, ev.target.open),
  },
    h("summary", {},
      h("span", { class: "no" }, String(no).padStart(2, "0")),
      h("span", { class: "title" }, p.title),
      h("span", { class: "badges" }, isNew && h("span", { class: "dot" }, "Új"), stamp(p.status))),
    h("div", { class: "body" },
      p.description && h("div", { class: "desc" }, p.description),

      h("h3", {}, "Dokumentumok"),
      p.files.length ? h("ul", { class: "files" }, p.files.sort(byTime).map((f) => h("li", {},
        h("button", { class: "fname", onclick: () => openFile(f) }, f.name),
        h("span", { class: "info" }, `${fmtSize(f.size)} · ${fmtTime(f.created_at)}${f.from_admin ? ` · ${admin ? "Ön mellékelte" : "a pályázatíró mellékelte"}` : ""}`),
        h("button", { class: "act", onclick: (ev) => run(ev.target, () => openFile(f, true)) }, "letöltés"),
        myFiles(f) && h("button", { class: "act", onclick: () => deleteFile(f) }, "törlés"))))
        : h("p", { class: "muted small" }, "Még nincs feltöltött fájl."),
      locked ? h("p", { class: "locked" }, "✓ Ezt a pontot elfogadtuk, további teendője nincs vele.") : [drop, status],

      h("h3", {}, "Megjegyzések"),
      p.messages.sort(byTime).map((m) => h("div", { class: "msg" + (m.from_admin === admin ? " mine" : "") },
        h("div", { class: "who" }, `${m.from_admin === admin ? "Ön" : admin ? project.client.name : brand} · ${fmtTime(m.created_at)}`),
        h("div", { class: "text" }, m.body))),
      h("div", { class: "composer" }, text, h("div", { class: "row" },
        admin ? [
          h("button", { class: "btn", onclick: send(null) }, "Üzenet küldése"),
          p.status !== "javitando" && h("button", { class: "btn warn", onclick: send("javitando", true) }, "Javítást kérek"),
          p.status !== "elfogadva" && h("button", { class: "btn ok", onclick: send("elfogadva") }, "Elfogadom"),
        ] : h("button", { class: "btn primary", onclick: send(null) }, "Megjegyzés küldése"))),

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
    if (row.error) { await sb.storage.from("docs").remove([path]); errors.push(`${f.name}: ${explain(row.error)}`); continue; }
    done++;
  }
  statusEl.textContent = "";
  if (errors.length) toast(`Nem sikerült: ${errors.join("; ")}`, true);
  if (done) toast(done === 1 ? "1 fájl feltöltve." : `${done} fájl feltöltve.`);
  refresh();
}

const signedUrl = async (f, download) =>
  need(await sb.storage.from("docs").createSignedUrl(f.path, 120, download ? { download: f.name } : undefined)).signedUrl;

// PDF/kép új lapon nyílik (gyors átnézés), minden más letöltődik.
async function openFile(f, forceDownload) {
  const inline = !forceDownload && /\.(pdf|png|jpe?g|gif|webp)$/i.test(f.name);
  const tab = inline ? window.open("", "_blank") : null;   // a kattintással szinkron kell nyitni
  try {
    const url = await signedUrl(f, !inline);
    if (tab) tab.location = url; else location.assign(url);
  } catch (e) { tab?.close(); toast(explain(e), true); }
}

async function deleteFile(f) {
  if (!(await confirmBox(`Törli ezt a fájlt? „${f.name}”`))) return;
  run(null, async () => {
    const gone = need(await sb.from("files").delete().eq("id", f.id).select("id"));
    if (!gone.length) throw new Error("Ezt a fájlt már nem lehet törölni.");
    await sb.storage.from("docs").remove([f.path]);
    refresh();
  });
}

async function removeStored(files) {
  for (let i = 0; i < files.length; i += 100) need(await sb.storage.from("docs").remove(files.slice(i, i + 100).map((f) => f.path)));
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
    field("Pályázati azonosító", h("input", { type: "text", name: "reference", maxlength: 100, value: project.reference || "" })),
    field("Hiánypótlási határidő", h("input", { type: "date", name: "deadline", value: project.deadline || "" })),
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
  if (!(await confirmBox(`Törli a(z) „${p.title}” pontot a feltöltött fájlokkal és megjegyzésekkel együtt? Ez nem vonható vissza.`))) return;
  run(null, async () => { await removeStored(p.files); need(await sb.from("points").delete().eq("id", p.id)); refresh(); });
}

async function deleteProject(project, files) {
  if (!(await confirmBox(`Törli a(z) „${project.title}” projektet minden ponttal, fájllal (${files.length} db) és megjegyzéssel együtt? Ez nem vonható vissza.`))) return;
  run(null, async () => { await removeStored(files); need(await sb.from("projects").delete().eq("id", project.id)); location.hash = "#/"; });
}

// ───────────────────────── admin: ügyfelek ─────────────────────────

async function clientsView() {
  const clients = need(await sb.from("profiles").select("*, projects(id)").eq("role", "client").order("name"));
  return [
    h("div", { class: "page-head spread" }, h("h1", {}, "Ügyfelek"),
      h("button", { class: "btn primary", onclick: () => clientDialog(null, refresh) }, "+ Új ügyfél")),
    clients.length ? h("ul", { class: "list" }, clients.map((c) => h("li", { class: "plain-row" },
      h("div", {},
        h("div", { class: "name", style: "font-family:var(--serif);font-size:1.1rem;font-weight:600" }, c.name),
        h("div", { class: "muted small" }, `Felhasználónév: ${c.username} · ${c.notify_email || "e-mail-címet még nem adott meg"} · ${c.projects.length} projekt`)),
      h("div", { class: "row small" },
        h("button", { class: "btn quiet", onclick: () => newProjectDialog(c.id) }, "Új projekt"),
        h("button", { class: "btn quiet", onclick: () => clientDialog(c, refresh) }, "Szerkesztés"),
        h("button", { class: "btn quiet", onclick: () => resetPassword(c) }, "Új jelszó"),
        h("button", { class: "btn danger", onclick: () => deleteClient(c) }, "Törlés")))))
      : h("div", { class: "empty" }, "Még nincs ügyfél."),
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
    field("Értesítési e-mail-cím", h("input", { type: "email", name: "notify_email", value: c?.notify_email || "" }), "Nem kötelező – ha üres, az ügyfél adja meg az első belépéskor."),
    !c && field("Jelszó", h("input", { type: "text", name: "password", required: true, minlength: 8, value: genPassword(), autocomplete: "off" }), "Előre generáltuk; átírható (legalább 8 karakter)."),
  ], c ? "Mentés" : "Létrehozás", async (v) => {
    if (c) {
      await api("update_client", { id: c.id, name: v.name, notify_email: v.notify_email });
      then(c.id);
    } else {
      const { id } = await api("create_client", v);
      credentialsDialog(v.name.trim(), v.username.trim().toLowerCase(), v.password, () => then(id));
    }
  });
}

function resetPassword(c) {
  formModal(`Új jelszó – ${c.name}`, [
    field("Új jelszó", h("input", { type: "text", name: "password", required: true, minlength: 8, value: genPassword(), autocomplete: "off" }), "A régi jelszó azonnal érvényét veszti."),
  ], "Jelszó beállítása", async (v) => {
    await api("update_client", { id: c.id, password: v.password });
    credentialsDialog(c.name, c.username, v.password, () => {});
  });
}

// A jelszót csak most látjuk – kész, kimásolható levélszöveget adunk az adminnak.
function credentialsDialog(name, username, password, then) {
  const text = `Tisztelt ${name}!\n\nA hiánypótláshoz szükséges dokumentumokat az alábbi oldalon tudja feltölteni:\n${location.origin}${location.pathname}\n\nFelhasználónév: ${username}\nJelszó: ${password}\n\nAz első belépéskor meg kell adnia egy e-mail-címet – erre küldünk értesítést, ha üzenetet írunk, vagy valamit javítani kell.`;
  modal("Belépési adatok", (close) => [
    h("p", {}, "Küldje el ezt az ügyfélnek. A jelszó később nem jeleníthető meg újra (új viszont bármikor adható)."),
    h("pre", {}, text),
    h("div", { class: "row end" },
      h("button", { class: "btn", onclick: (ev) => run(ev.target, async () => { await navigator.clipboard.writeText(text); toast("Vágólapra másolva."); }) }, "Szöveg másolása"),
      h("button", { class: "btn primary", onclick: () => { close(); then(); } }, "Kész")),
  ]);
}

async function deleteClient(c) {
  if (!(await confirmBox(`Törli a(z) „${c.name}” ügyfelet? Vele együtt törlődik mind a(z) ${c.projects.length} projektje, minden feltöltött fájl és megjegyzés. Ez nem vonható vissza.`))) return;
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
    h("div", { class: "page-head" }, h("h1", {}, "Beállítások"), h("p", { class: "muted", style: "margin:.35rem 0 0" }, `${me.name} · felhasználónév: ${me.username}`)),

    h("section", { class: "card" }, h("h2", {}, "Értesítési e-mail-cím"),
      simpleForm(field("E-mail-cím", h("input", { type: "email", name: "email", required: true, value: me.notify_email || "" }),
        admin ? "Ide érkezik levél, ha egy ügyfél fájlt tölt fel vagy megjegyzést ír. Az ügyfelek erre a címre tudnak válaszolni." : "Ide küldünk értesítést, ha üzenetet kap, vagy valamit javítani kell."),
        "Mentés", async (v) => {
          need(await sb.from("profiles").update({ notify_email: v.email.trim() }).eq("id", me.id));
          me.notify_email = v.email.trim(); toast("Mentve.");
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

    admin && h("section", { class: "card" }, h("h2", {}, "Kiküldött értesítések"),
      log.length ? h("div", { class: "scroll-x" }, h("table", { class: "log" }, log.map((l) => h("tr", {},
        h("td", { style: "white-space:nowrap" }, fmtTime(l.created_at)),
        h("td", {}, l.recipients),
        h("td", {}, l.subject, l.error && h("div", { class: "s-javitando" }, `Hiba: ${l.error}`))))))
        : h("p", { class: "muted small" }, "Még nem ment ki értesítés."),
      h("p", { class: "muted small", style: "margin:.75rem 0 0" }, "Az értesítés az utolsó változás után kb. 5 perccel megy ki, egy levélben összefoglalva. Ha a címzett közben megnézte a portálon, nem küldünk levelet.")),
  ];
}

boot();
