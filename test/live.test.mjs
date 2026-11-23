// Élő végponttól végpontig teszt az ÉLES Supabase projekten: `npm run test:live`
// Saját, „teszt-” előtagú ideiglenes fiókokat hoz létre, és a végén mindent töröl maga után.
// Pontosan azt az utat járja, amit a böngésző: publikus kulcs + bejelentkezés + RLS + Storage + Edge Function.
// Ha a .env-ben van TEST_EMAIL és SMTP, egy valódi értesítő levelet is kiküld oda, és megköveteli, hogy hibátlanul menjen ki.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

process.loadEnvFile(new URL("../.env", import.meta.url));
const { SUPABASE_ACCESS_TOKEN: token, SUPABASE_PROJECT_REF: ref, TEST_EMAIL, SMTP_HOST } = process.env;
const cfgText = readFileSync(new URL("../docs/config.js", import.meta.url), "utf8");
const cfg = (k) => cfgText.match(new RegExp(`${k}: "([^"]+)"`))[1];
const [url, pub, domain] = [cfg("supabaseUrl"), cfg("supabaseKey"), cfg("authDomain")];

const mgmt = async (method, path, body) => {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body && JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return res.json();
};
const sql = (query) => mgmt("POST", "/database/query", { query });
const keys = await mgmt("GET", "/api-keys?reveal=true");
const svc = createClient(url, (keys.find((k) => k.type === "secret") ?? keys.find((k) => k.name === "service_role")).api_key, { auth: { persistSession: false } });

const run = randomBytes(3).toString("hex");
const pw = () => randomBytes(12).toString("base64url");
const browser = () => createClient(url, pub, { auth: { persistSession: false } });
const login = async (username, password) => {
  const c = browser();
  const { error } = await c.auth.signInWithPassword({ email: `${username}@${domain}`, password });
  assert.ifError(error);
  return c;
};
// A function hívása; a hibát a HTTP-státusszal együtt dobja, hogy a „megtagadás” megkülönböztethető legyen a hálózati hibától.
const fn = async (c, action, payload) => {
  const { data, error } = await c.functions.invoke("portal", { body: { action, ...payload } });
  if (error) {
    const status = error.context?.status;
    const msg = (await error.context?.json?.().catch(() => null))?.error ?? error.message;
    throw Object.assign(new Error(msg), { status });
  }
  return data;
};
const need = ({ data, error }) => { assert.ifError(error); return data; };
let n = 0;
const ok = (cond, label) => { assert.ok(cond, label); n++; console.log("  ✓", label); };
// Megtagadás = a szerver VÁLASZOLT, és nemet mondott (4xx / Postgres 42501 / üres találat). Hálózati hiba nem számít annak.
const fails = async (label, promise) => {
  let res;
  try { res = await promise; }
  catch (e) { return ok([400, 401, 403].includes(e.status), `TILTVA: ${label}` + (e.status ? "" : ` – VÁRATLAN HIBA: ${e.message}`)); }
  const refused = res?.error && !/fetch failed|network/i.test(res.error.message ?? "");
  ok(refused || (Array.isArray(res?.data) && res.data.length === 0), `TILTVA: ${label}`);
};
const upload = async (c, project, point, name, content) => {
  const path = `${project}/${point}/${crypto.randomUUID()}-${name}`;
  need(await c.storage.from("docs").upload(path, new Blob([content], { type: "application/pdf" })));
  return path;
};
const stored = async (prefix) => need(await svc.rpc("storage_paths", { p_prefix: prefix })).length;

const adminName = `teszt-admin-${run}`, adminPw = pw();
let adminId, pa, pb;
const created = [];
try {
  // ── ideiglenes admin (service kulccsal; az igazi admin fiókhoz nem nyúlunk) ──
  adminId = need(await svc.auth.admin.createUser({ email: `${adminName}@${domain}`, password: adminPw, email_confirm: true })).user.id;
  need(await svc.from("profiles").insert({ id: adminId, role: "admin", username: adminName, name: "Teszt Admin" }));
  const admin = await login(adminName, adminPw);

  // ── admin: ügyfelek + projektek ──
  let aPw = pw();
  const bPw = pw();
  const a = (await fn(admin, "create_client", { username: `teszt-a-${run}`, name: "Teszt Alfa Kft.", password: aPw })).id;
  const b = (await fn(admin, "create_client", { username: `teszt-b-${run}`, name: "Teszt Béta Bt.", password: bPw })).id;
  created.push(a, b);
  ok(a && b, "admin két ügyfelet hoz létre a function-ön át");
  await assert.rejects(fn(admin, "create_client", { username: `teszt-a-${run}`, name: "x", password: aPw }), /foglalt/);
  ok(true, "foglalt felhasználónév érthető hibát ad");

  pa = need(await admin.from("projects").insert({ client_id: a, title: `Teszt projekt ${run}`, deadline: "2030-01-15" }).select("id").single()).id;
  pb = need(await admin.from("projects").insert({ client_id: b, title: `Teszt B ${run}` }).select("id").single()).id;
  const [pt1, pt2, pt3] = need(await admin.from("points").insert([
    { project_id: pa, position: 1, title: "Cégkivonat" }, { project_id: pa, position: 2, title: "Árajánlatok" }, { project_id: pa, position: 3, title: "Nyilatkozat" },
  ]).select("id, position").order("position")).map((r) => r.id);
  const ptB = need(await admin.from("points").insert({ project_id: pb, position: 1, title: "Címpéldány" }).select("id").single()).id;

  // ── B ügyfél feltölt egy saját fájlt: ennek MINDEN A-val kapcsolatos törlést túl kell élnie ──
  const cb = await login(`teszt-b-${run}`, bPw);
  const pathB = await upload(cb, pb, ptB, "b-titok.pdf", `b-${run}`);
  const fileB = need(await cb.from("files").insert({ point_id: ptB, path: pathB, name: "b-titok.pdf", size: 1 }).select("id").single()).id;

  // ── A ügyfél: csak a sajátját látja, feltölt, üzen ──
  let ca = await login(`teszt-a-${run}`, aPw);
  ok(need(await ca.from("projects").select("id")).length === 1, "A csak a saját projektjét látja");
  ok(need(await ca.from("profiles").select("id")).length === 1, "A csak a saját profilját látja");
  if (TEST_EMAIL) need(await ca.from("profiles").update({ notify_email: TEST_EMAIL }).eq("id", a));

  const content = `teszt-${run}`;
  const path = await upload(ca, pa, pt1, "cegkivonat.pdf", content);
  const fileA = need(await ca.from("files").insert({ point_id: pt1, path, name: "cégkivonat.pdf", size: 999999999 }).select("id, size, uploaded_by").single());
  ok(fileA.size === content.length && fileA.uploaded_by === a, "a fájlsor mérete és feltöltője a szerverről jön, nem a klienstől");
  ok(need(await ca.from("points").select("status").eq("id", pt1).single()).status === "feltoltve", "feltöltés után a pont „Ellenőrzésre vár”");
  need(await ca.rpc("post_message", { p_point: pt1, p_body: "Feltöltöttem a cégkivonatot." }));

  await fails("A fájlsort szúr be feltöltés nélkül", ca.from("files").insert({ point_id: pt1, path: `${pa}/${pt1}/nincs.pdf`, name: "x", size: 1 }).select("id"));
  await fails("A hamisítja a feltöltőt", ca.from("files").insert({ point_id: pt1, path, name: "x", size: 1, uploaded_by: b }).select("id"));
  await fails("A feltölt B mappájába", ca.storage.from("docs").upload(`${pb}/${ptB}/x.pdf`, new Blob(["x"])));
  await fails("A felülírja a saját feltöltött fájlját (csendes csere)", ca.storage.from("docs").upload(path, new Blob(["csere"]), { upsert: true }));
  await fails("A áthelyezi a fájlját", ca.storage.from("docs").move(path, `${pa}/${pt1}/masik.pdf`));
  await ca.storage.from("docs").remove([path]);   // a Storage API ilyenkor is 200-at ad üres listával
  ok((await (await fetch(need(await ca.storage.from("docs").createSignedUrl(path, 60)).signedUrl)).text()) === content, "A közvetlenül nem tudja törölni/kicserélni a feltöltött objektumot");
  await fails("A olvassa B projektjét", ca.from("projects").select("id").eq("id", pb));
  await fails("A státuszt ír át", ca.from("points").update({ status: "elfogadva" }).eq("id", pt1).select("id"));
  await fails("A adminná teszi magát", ca.from("profiles").update({ role: "admin" }).eq("id", a).select("id"));
  await fails("A státuszt állít RPC-vel", ca.rpc("post_message", { p_point: pt1, p_body: "x", p_status: "elfogadva" }));
  await fails("A üzen B pontjához", ca.rpc("post_message", { p_point: ptB, p_body: "x" }));
  await fails("A ügyfelet hoz létre a function-nel", fn(ca, "create_client", { username: `teszt-x-${run}`, name: "x", password: aPw }));
  await fails("A törli B-t a function-nel", fn(ca, "delete_client", { id: b }));
  await fails("A törli B projektjét a function-nel", fn(ca, "delete_project", { id: pb }));
  await fails("A törli B fájlját a function-nel", fn(ca, "delete_file", { id: fileB }));
  await fails("A levelet küld a function-nel (nyílt levéltovábbítás ellen)", fn(ca, "send_credentials", { id: b, to: "valaki@example.com", text: "x" }));
  // Resend tesztcímek (nem kézbesítenek valódi postafiókba); az „s” betűs cím a régi, backslash nélküli regex ellen is őr.
  ok((await fn(admin, "send_credentials", { id: b, to: ["delivered@resend.dev", "delivered+masodik@resend.dev"], text: "teszt" })).ok, "admin két címre küld belépési adatot");
  await assert.rejects(fn(admin, "send_credentials", { id: b, to: ["a@b.hu", "c@d.hu", "e@f.hu"], text: "x" }), /Érvénytelen/);
  await fails("névtelen levelet küld a function-nel", fn(browser(), "send_credentials", { id: b, to: "valaki@example.com", text: "x" }));
  await fails("névtelen hívja a function-t", fn(browser(), "delete_file", { id: fileB }));
  const badSecret = await fetch(`${url}/functions/v1/portal`, { method: "POST", headers: { "Content-Type": "application/json", "x-notify-secret": "rossz" }, body: JSON.stringify({ action: "notify", project_id: pa, side: "client" }) });
  ok(badSecret.status === 403, "értesítés rossz titokkal: 403");

  // ── B: A-ból semmit ──
  await fails("B látja A fájlsorát", cb.from("files").select("id").eq("point_id", pt1));
  await fails("B látja A üzenetét", cb.from("messages").select("id"));
  await fails("B aláírt URL-t kér A fájljára", cb.storage.from("docs").createSignedUrl(path, 60));
  await fails("B letölti A fájlját", cb.storage.from("docs").download(path));
  await fails("B törli A fájlját a function-nel", fn(cb, "delete_file", { id: fileA.id }));

  // ── A törli és újra feltölti a saját fájlját (a function-ön át) ──
  const tmp = await upload(ca, pa, pt3, "ideiglenes.pdf", "x");
  const tmpId = need(await ca.from("files").insert({ point_id: pt3, path: tmp, name: "ideiglenes.pdf", size: 1 }).select("id").single()).id;
  await fn(ca, "delete_file", { id: tmpId });
  ok(await stored(`${pa}/${pt3}/`) === 0, "A a function-ön át törli a saját fájlját (sor + Storage)");
  ok(need(await ca.from("points").select("status").eq("id", pt3).single()).status === "hianyzik", "minden fájl törlése után a pont újra „Hiányzik”");

  // ── admin: látja, letölti, javítást kér ──
  const signed = need(await admin.storage.from("docs").createSignedUrl(path, 60)).signedUrl;
  ok((await (await fetch(signed)).text()) === content, "admin letölti az ügyfél fájlját (aláírt URL)");
  ok(need(await admin.from("points").select("admin_unread").eq("id", pt1).single()).admin_unread, "admin oldalon „új” jelző");
  need(await admin.rpc("post_message", { p_point: pt1, p_body: "Kérem 30 napnál nem régebbit.", p_status: "javitando" }));
  need(await admin.rpc("post_message", { p_point: pt2, p_status: "elfogadva" }));
  const seen = need(await ca.from("points").select("status, client_unread").eq("project_id", pa).order("position"));
  ok(seen[0].status === "javitando" && seen[1].status === "elfogadva" && seen[0].client_unread, "az ügyfél látja a javítási kérést és az elfogadást");
  await fails("A elfogadott pontra tölt fel", ca.storage.from("docs").upload(`${pa}/${pt2}/late.pdf`, new Blob(["x"])));

  // ── jelszócsere: a régi munkamenet nem újítható meg ──
  const oldRefresh = (await ca.auth.getSession()).data.session.refresh_token;
  const oldPw = aPw; aPw = pw();
  await fn(admin, "update_client", { id: a, password: aPw });
  const reuse = await browser().auth.refreshSession({ refresh_token: oldRefresh });
  ok(reuse.error && !reuse.data.session, "jelszócsere után a régi munkamenet nem újítható meg");
  await assert.rejects(login(`teszt-a-${run}`, oldPw));
  ok(true, "a régi jelszóval nem lehet belépni");
  await login(`teszt-a-${run}`, aPw);

  // ── értesítés: pg_cron → pg_net → Edge Function → SMTP (az admin-oldalit töröljük, hogy az igazi admin ne kapjon tesztlevelet) ──
  await sql(`update public.projects set admin_notify_at = null where id in ('${pa}', '${pb}');
             update public.projects set client_notify_at = now() where id = '${pa}';
             update public.projects set client_notify_at = null where id = '${pb}';`);
  process.stdout.write("  … várakozás a percenkénti ütemezőre");
  let resp;
  for (let i = 0; i < 30 && !resp; i++) {
    await new Promise((r) => setTimeout(r, 5000)); process.stdout.write(".");
    const queued = await sql(`select client_notify_at from public.projects where id = '${pa}'`);
    if (queued[0].client_notify_at === null) {
      await new Promise((r) => setTimeout(r, 8000));
      resp = (await sql(`select status_code, content from net._http_response order by id desc limit 1`))[0];
    }
  }
  console.log();
  ok(resp?.status_code === 200, `az ütemező meghívta a function-t: ${resp?.status_code} ${resp?.content}`);
  if (TEST_EMAIL && SMTP_HOST) {
    const log = need(await admin.from("mail_log").select("recipients, subject, error").eq("project_id", pa));
    ok(log.length === 1 && log[0].recipients === TEST_EMAIL && log[0].error === null, `valódi levél hibátlanul kiment: „${log[0]?.subject}” → ${log[0]?.recipients}${log[0]?.error ? " | HIBA: " + log[0].error : ""}`);
    ok(need(await admin.from("projects").select("client_notified_at").eq("id", pa).single()).client_notified_at, "a kiküldés időpontja rögzítve");
  } else {
    ok(/nincs címzett/.test(resp.content), "címzett nélkül a function kihagyja a küldést (TEST_EMAIL/SMTP nincs beállítva – valódi levél NEM lett tesztelve)");
  }

  // ── törlések: árva objektum sem marad, és B fájlja mindent túlél ──
  ca = await login(`teszt-a-${run}`, aPw);
  await upload(ca, pa, pt3, "arva.pdf", "sor nélküli feltöltés");   // félbeszakadt feltöltés: objektum van, sor nincs
  const delPoint = await fn(admin, "delete_point", { id: pt3 });
  ok(delPoint.files_removed === 1 && await stored(`${pa}/${pt3}/`) === 0, "pont törlése az árva objektumot is viszi");
  const del = await fn(admin, "delete_client", { id: a });
  ok(del.files_removed === 1 && await stored(`${pa}/`) === 0, "ügyfél törlésekor a projekt minden Storage-fájlja törlődik");
  ok(need(await svc.from("projects").select("id").eq("id", pa)).length === 0, "a projekt sorai is törlődtek");
  ok((await (await cb.storage.from("docs").download(pathB)).data?.text()) === `b-${run}`, "B fájlja sértetlen A törlése után");
  await assert.rejects(login(`teszt-a-${run}`, aPw));
  ok(true, "a törölt ügyfél nem tud belépni");
  const delProj = await fn(admin, "delete_project", { id: pb });
  ok(delProj.files_removed === 1 && await stored(`${pb}/`) === 0, "projekt törlése viszi a fájljait");
} finally {
  for (const id of created) await svc.auth.admin.deleteUser(id).catch(() => {});
  if (adminId) await svc.auth.admin.deleteUser(adminId);
  for (const p of [pa, pb].filter(Boolean)) {   // ha a teszt félúton elbukott, a fájlokat akkor is eltakarítjuk
    const paths = (await svc.rpc("storage_paths", { p_prefix: `${p}/` })).data ?? [];
    if (paths.length) await svc.storage.from("docs").remove(paths);
  }
  const left = await sql(`select (select count(*)::int from public.profiles where username like 'teszt-%-${run}') as profiles,
                                 (select count(*)::int from storage.objects where bucket_id = 'docs') as objects`);
  console.log(left[0].profiles === 0 ? `Takarítás kész (a bucketben maradt objektum: ${left[0].objects}).` : `FIGYELEM: ${left[0].profiles} tesztfiók megmaradt!`);
}
console.log(`OK – ${n} élő ellenőrzés sikeres`);
