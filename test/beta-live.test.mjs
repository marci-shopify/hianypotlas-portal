// Élő teszt a béta pontozó ügynök-kapujára az ÉLES backenden: `npm run test:beta`
// Azt az utat járja, amit az AI-ügynök (kód az URL-ben, curl helyett fetch) és amit az admin böngészője (JWT).
// Csak saját, „teszt-” nevű sorokat és egy ideiglenes admin fiókot hoz létre, a végén mindent töröl.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { docs, base, good, res } from "./beta.fixture.mjs";

process.loadEnvFile(new URL("../.env", import.meta.url));
const { SUPABASE_ACCESS_TOKEN: token, SUPABASE_PROJECT_REF: ref } = process.env;
const cfgText = readFileSync(new URL("../docs/config.js", import.meta.url), "utf8");
const cfg = (k) => cfgText.match(new RegExp(`${k}: "([^"]+)"`))[1];
const [url, pub, domain] = [cfg("supabaseUrl"), cfg("supabaseKey"), cfg("authDomain")];
const res0 = await fetch(`https://api.supabase.com/v1/projects/${ref}/api-keys?reveal=true`, { headers: { Authorization: `Bearer ${token}` } });
if (!res0.ok) throw new Error(`api-keys → ${res0.status} (lejárt a SUPABASE_ACCESS_TOKEN?)`);
const keys = await res0.json();
const svc = createClient(url, (keys.find((k) => k.type === "secret") ?? keys.find((k) => k.name === "service_role")).api_key, { auth: { persistSession: false } });

const run = randomBytes(3).toString("hex");
const tok = (p) => p + randomBytes(32).toString("hex");
const need = ({ data, error }) => { assert.ifError(error); return data; };
let n = 0;
const ok = (cond, label) => { assert.ok(cond, label); n++; console.log("  ✓", label); };
const FN = `${url}/functions/v1/beta`;
const agent = async (t, body, q = "") => {
  const r = await fetch(`${FN}?t=${t}${q}`, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
};

const before = need(await svc.from("projects").select("id", { count: "exact", head: false })).length;
let callId, adminId;
try {
  const ft = tok("f"), et = tok("e"), soon = new Date(Date.now() + 3600e3).toISOString();
  callId = need(await svc.from("beta_calls").insert({ title: `teszt-felhívás ${run}`, docs, agent_token: ft, agent_expires: soon }).select("id").single()).id;
  const evalId = need(await svc.from("beta_evals").insert({ call_id: callId, company: `teszt-cég ${run}`, facts: "Létszám 7 fő.", agent_token: et, agent_expires: soon }).select("id").single()).id;

  // ── jogosulatlan hívások ──
  ok((await agent(tok("f"))).status === 403, "ismeretlen kód: 403");
  ok((await agent("")).status === 403, "kód nélkül, JWT nélkül: 403");
  ok((await fetch(FN, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${pub}` }, body: JSON.stringify({ action: "task", kind: "call", id: callId }) })).status === 403, "névtelen kulccsal az admin-út: 403");

  // ── felhívás: feladat le, kivonat be ──
  let r = await agent(ft);
  ok(r.status === 200 && r.text.includes("# Feladat: pályázati felhívás teljes kivonata") && r.text.includes("2. oldal =====") && r.text.includes(`?t=${ft}`), "az ügynök megkapja a feladatot a szöveggel és a saját beküldési címével");
  r = await agent(et);
  ok(r.status === 400 && /nincs kivonat/.test(r.json.error), "értékelés kivonat nélkül: érthető hiba");
  r = await agent(ft, "{ez nem json");
  ok(r.status === 400 && /nem érvényes JSON/.test(r.json.error), "hibás JSON: érthető hiba");
  r = await agent(ft, base());
  ok(r.status === 200 && r.json.kesz === false && r.json.lefedetlen.some((l) => l.megjegyzes), "elbagatellizált kivonat: nincs kész, a Jogosulatlan-mondat visszajön");
  ok(need(await svc.from("beta_calls").select("review").eq("id", callId).single()).review.kesz === false, "a félkész állapot is mentve (a tanácsadó látja)");
  r = await agent(ft, good());
  ok(r.json.kesz === true && r.json.stat.megtalalt === r.json.stat.idezetek, "javított kivonat: kész, minden idézet megtalálva");
  const saved = need(await svc.from("beta_calls").select("catalog, review").eq("id", callId).single());
  ok(saved.catalog.feltetelek.length === 2 && saved.review.hely.F02.oldal === 2, "a kivonat és az idézetek oldalszáma mentve");

  // ── értékelés ──
  r = await agent(et);
  ok(r.status === 200 && r.text.includes(`teszt-cég ${run}`) && r.text.includes('"III.2"') && !r.text.includes("2. oldal ====="), "értékelés-feladat a kivonattal, a teljes szöveg nélkül");
  ok((await agent(et, undefined, "&szoveg=1")).text.includes("2. oldal ====="), "&szoveg=1: a teljes szöveggel");
  const badRes = res(); badRes.feltetelek.F02 = { allapot: "megfelel", indok: "biztos vállalja", forras: "nincs_adat" };
  r = await agent(et, badRes);
  ok(r.json.kesz === false && r.json.hibak.some((h) => /találgatni tilos/.test(h)), "adat nélküli döntés: elutasítva");
  r = await agent(et, res());
  ok(r.json.kesz === true && r.json.stat.nyitott === 1, "helyes értékelés: kész, 1 nyitott kérdés");
  ok(need(await svc.from("beta_evals").select("result").eq("id", evalId).single()).result.pontok["III.2"].szint === 2, "az értékelés mentve");

  // ── a kód csak a saját sorához ad hozzáférést, és lejár ──
  r = await agent(et, good());
  ok(r.json.kesz === false, "az értékelés kódjával nem lehet kivonatot beküldeni (értékelésként ellenőrzi)");
  ok(need(await svc.from("beta_calls").select("catalog").eq("id", callId).single()).catalog.feltetelek.length === 2, "…és a kivonat érintetlen");
  need(await svc.from("beta_calls").update({ agent_expires: new Date(Date.now() - 1000).toISOString() }).eq("id", callId));
  ok((await agent(ft)).status === 403, "lejárt kód: 403");

  // ── admin böngészőből (ha az ügynöknek nincs internete): feladat letöltése, eredmény beillesztése ──
  const adminName = `teszt-admin-${run}`, pw = randomBytes(12).toString("base64url");
  adminId = need(await svc.auth.admin.createUser({ email: `${adminName}@${domain}`, password: pw, email_confirm: true })).user.id;
  need(await svc.from("profiles").insert({ id: adminId, role: "admin", username: adminName, name: "Teszt Admin" }));
  const admin = createClient(url, pub, { auth: { persistSession: false } });
  assert.ifError((await admin.auth.signInWithPassword({ email: `${adminName}@${domain}`, password: pw })).error);
  let d = need(await admin.functions.invoke("beta", { body: { action: "task", kind: "call", id: callId } }));
  ok(d.text.includes("# Feladat: pályázati felhívás"), "admin letölti a feladatot");
  d = need(await admin.functions.invoke("beta", { body: { action: "submit", kind: "eval", id: evalId, data: res() } }));
  ok(d.kesz === true, "admin beilleszti az eredményt");
  ok(need(await admin.from("beta_calls").select("id").eq("id", callId)).length === 1, "admin a táblát is eléri (RLS)");
  const anon = createClient(url, pub, { auth: { persistSession: false } });
  const { data: anonRows, error: anonErr } = await anon.from("beta_calls").select("id");
  ok(anonErr || anonRows.length === 0, "névtelen a táblából semmit nem kap");
} finally {
  if (callId) await svc.from("beta_calls").delete().eq("id", callId);
  if (adminId) await svc.auth.admin.deleteUser(adminId);
  const left = need(await svc.from("beta_calls").select("id").like("title", `teszt-felhívás ${run}`)).length
    + need(await svc.from("profiles").select("id").eq("username", `teszt-admin-${run}`)).length;
  assert.equal(left, 0, "maradt tesztadat");
  assert.equal(need(await svc.from("projects").select("id")).length, before, "az éles projektek száma változott");
}
console.log(`OK – ${n} élő ellenőrzés sikeres, tesztadat nem maradt`);
