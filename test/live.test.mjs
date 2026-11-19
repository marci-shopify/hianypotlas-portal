// Élő végponttól végpontig teszt az ÉLES Supabase projekten: `npm run test:live`
// Saját, „teszt-” előtagú ideiglenes fiókokat hoz létre, és a végén mindent töröl maga után.
// Pontosan azt az utat járja, amit a böngésző: publikus kulcs + bejelentkezés + RLS + Storage + Edge Function.
// Ha a .env-ben van TEST_EMAIL és SMTP, egy valódi értesítő levelet is kiküld oda.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

process.loadEnvFile(new URL("../.env", import.meta.url));
const { SUPABASE_ACCESS_TOKEN: token, SUPABASE_PROJECT_REF: ref, TEST_EMAIL } = process.env;
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
const fn = async (c, action, payload) => {
  const { data, error } = await c.functions.invoke("portal", { body: { action, ...payload } });
  if (error) throw new Error((await error.context?.json?.().catch(() => null))?.error ?? error.message);
  return data;
};
const need = ({ data, error }) => { assert.ifError(error); return data; };
let n = 0;
const ok = (cond, label) => { assert.ok(cond, label); n++; console.log("  ✓", label); };
const fails = async (label, promise) => {
  let res; try { res = await promise; } catch { return ok(true, `TILTVA: ${label}`); }
  // Megtagadás = hiba, VAGY üres találat. (Az RPC siker esetén data: null-t ad, az tehát NEM megtagadás.)
  ok(res?.error || (Array.isArray(res?.data) && res.data.length === 0), `TILTVA: ${label}`);
};

const adminName = `teszt-admin-${run}`, adminPw = pw();
let adminId;
const created = [];
try {
  // ── ideiglenes admin (service kulccsal; az igazi admin fiókhoz nem nyúlunk) ──
  adminId = need(await svc.auth.admin.createUser({ email: `${adminName}@${domain}`, password: adminPw, email_confirm: true })).user.id;
  need(await svc.from("profiles").insert({ id: adminId, role: "admin", username: adminName, name: "Teszt Admin" }));
  const admin = await login(adminName, adminPw);

  // ── admin: ügyfelek + projektek ──
  const [aPw, bPw] = [pw(), pw()];
  const a = (await fn(admin, "create_client", { username: `teszt-a-${run}`, name: "Teszt Alfa Kft.", password: aPw })).id;
  const b = (await fn(admin, "create_client", { username: `teszt-b-${run}`, name: "Teszt Béta Bt.", password: bPw })).id;
  created.push(a, b);
  ok(a && b, "admin két ügyfelet hoz létre a function-ön át");
  await assert.rejects(fn(admin, "create_client", { username: `teszt-a-${run}`, name: "x", password: aPw }), /foglalt/);
  ok(true, "foglalt felhasználónév érthető hibát ad");

  const pa = need(await admin.from("projects").insert({ client_id: a, title: `Teszt projekt ${run}`, deadline: "2030-01-15" }).select("id").single()).id;
  const pb = need(await admin.from("projects").insert({ client_id: b, title: `Teszt B ${run}` }).select("id").single()).id;
  const [pt1, pt2] = need(await admin.from("points").insert([
    { project_id: pa, position: 1, title: "Cégkivonat" }, { project_id: pa, position: 2, title: "Árajánlatok" },
  ]).select("id")).map((r) => r.id);
  const ptB = need(await admin.from("points").insert({ project_id: pb, position: 1, title: "Címpéldány" }).select("id").single()).id;

  // ── A ügyfél: csak a sajátját látja, feltölt, üzen ──
  const ca = await login(`teszt-a-${run}`, aPw);
  ok(need(await ca.from("projects").select("id")).length === 1, "A csak a saját projektjét látja");
  ok(need(await ca.from("profiles").select("id")).length === 1, "A csak a saját profilját látja");
  if (TEST_EMAIL) need(await ca.from("profiles").update({ notify_email: TEST_EMAIL }).eq("id", a));

  const path = `${pa}/${pt1}/${crypto.randomUUID()}-cegkivonat.pdf`;
  const content = `teszt-${run}`;
  need(await ca.storage.from("docs").upload(path, new Blob([content], { type: "application/pdf" })));
  need(await ca.from("files").insert({ point_id: pt1, path, name: "cégkivonat.pdf", size: content.length }));
  ok(need(await ca.from("points").select("status").eq("id", pt1).single()).status === "feltoltve", "feltöltés után a pont „Ellenőrzésre vár”");
  need(await ca.rpc("post_message", { p_point: pt1, p_body: "Feltöltöttem a cégkivonatot." }));

  await fails("A feltölt B mappájába", ca.storage.from("docs").upload(`${pb}/${ptB}/x.pdf`, new Blob(["x"])));
  await fails("A olvassa B projektjét", ca.from("projects").select("id").eq("id", pb));
  await fails("A státuszt ír át", ca.from("points").update({ status: "elfogadva" }).eq("id", pt1).select("id"));
  await fails("A adminná teszi magát", ca.from("profiles").update({ role: "admin" }).eq("id", a).select("id"));
  await fails("A státuszt állít RPC-vel", ca.rpc("post_message", { p_point: pt1, p_body: "x", p_status: "elfogadva" }));
  await fails("A üzen B pontjához", ca.rpc("post_message", { p_point: ptB, p_body: "x" }));
  await fails("A ügyfelet hoz létre a function-nel", fn(ca, "create_client", { username: `teszt-x-${run}`, name: "x", password: aPw }));
  await fails("A törli B-t a function-nel", fn(ca, "delete_client", { id: b }));

  // ── B ügyfél: A-ból semmit ──
  const cb = await login(`teszt-b-${run}`, bPw);
  await fails("B látja A fájlsorát", cb.from("files").select("id"));
  await fails("B látja A üzenetét", cb.from("messages").select("id"));
  await fails("B aláírt URL-t kér A fájljára", cb.storage.from("docs").createSignedUrl(path, 60));
  await fails("B letölti A fájlját", cb.storage.from("docs").download(path));
  await fails("B törli A fájlját", cb.storage.from("docs").remove([path]));

  // ── admin: látja, letölti, javítást kér ──
  const signed = need(await admin.storage.from("docs").createSignedUrl(path, 60)).signedUrl;
  ok((await (await fetch(signed)).text()) === content, "admin letölti az ügyfél fájlját (aláírt URL)");
  ok(need(await admin.from("points").select("admin_unread").eq("id", pt1).single()).admin_unread, "admin oldalon „új” jelző");
  need(await admin.rpc("post_message", { p_point: pt1, p_body: "Kérem 30 napnál nem régebbit.", p_status: "javitando" }));
  need(await admin.rpc("post_message", { p_point: pt2, p_status: "elfogadva" }));
  const seen = need(await ca.from("points").select("status, client_unread").eq("project_id", pa).order("position"));
  ok(seen[0].status === "javitando" && seen[1].status === "elfogadva" && seen[0].client_unread, "az ügyfél látja a javítási kérést és az elfogadást");
  await fails("A elfogadott pontra tölt fel", ca.storage.from("docs").upload(`${pa}/${pt2}/late.pdf`, new Blob(["x"])));

  // ── értesítés: pg_cron → pg_net → Edge Function (az admin-oldalit töröljük, hogy az igazi admin ne kapjon tesztlevelet) ──
  await sql(`update public.projects set admin_notify_at = null where id in ('${pa}', '${pb}');
             update public.projects set client_notify_at = now() where id = '${pa}';
             update public.projects set client_notify_at = null where id = '${pb}';`);
  process.stdout.write("  … várakozás a percenkénti ütemezőre");
  let resp;
  for (let i = 0; i < 30 && !resp; i++) {
    await new Promise((r) => setTimeout(r, 5000)); process.stdout.write(".");
    const queued = await sql(`select client_notify_at from public.projects where id = '${pa}'`);
    if (queued[0].client_notify_at === null) {
      await new Promise((r) => setTimeout(r, 6000));
      resp = (await sql(`select status_code, content from net._http_response order by id desc limit 1`))[0];
    }
  }
  console.log();
  ok(resp, "az ütemező kiküldte az esedékes értesítést");
  ok(resp.status_code === 200 || /SMTP|E-mail hiba/.test(resp.content), `a function válaszolt: ${resp.status_code} ${resp.content}`);
  if (TEST_EMAIL) {
    const log = need(await admin.from("mail_log").select("recipients, subject, error").eq("project_id", pa));
    ok(log.length === 1 && log[0].recipients === TEST_EMAIL, `levélnapló: „${log[0]?.subject}” → ${log[0]?.recipients}${log[0]?.error ? " | HIBA: " + log[0].error : " | elküldve"}`);
  }

  // ── ügyfél törlése viszi a fájlt is ──
  const del = await fn(admin, "delete_client", { id: a });
  ok(del.files_removed === 1, "ügyfél törlésekor a Storage-fájl is törlődik");
  ok(need(await svc.storage.from("docs").list(`${pa}/${pt1}`)).length === 0, "a Storage-mappa üres");
  ok(need(await svc.from("projects").select("id").eq("id", pa)).length === 0, "a projekt sorai is törlődtek");
  await assert.rejects(login(`teszt-a-${run}`, aPw));
  ok(true, "a törölt ügyfél nem tud belépni");
} finally {
  for (const id of created) await svc.auth.admin.deleteUser(id).catch(() => {});
  if (adminId) await svc.auth.admin.deleteUser(adminId);
  const left = await sql(`select count(*)::int as c from public.profiles where username like 'teszt-%-${run}'`);
  console.log(left[0].c === 0 ? "Takarítás kész." : `FIGYELEM: ${left[0].c} tesztfiók megmaradt!`);
}
console.log(`OK – ${n} élő ellenőrzés sikeres`);
