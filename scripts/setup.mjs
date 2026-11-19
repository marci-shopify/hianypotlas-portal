// A Supabase projekt beállítása a .env alapján. Többször is futtatható (idempotens).
//   node scripts/setup.mjs                      ← secretek, értesítés-bekötés, auth-beállítás, docs/config.js
//   node scripts/setup.mjs admin <felhasználónév> "<Név>"   ← admin fiók létrehozása VAGY jelszavának cseréje
// Előfeltétel: a migráció lefutott (scripts/sql.mjs) és a function telepítve van (lásd AGENTS.md).
import { randomBytes } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const envPath = new URL("../.env", import.meta.url);
process.loadEnvFile(envPath);
const env = process.env;
const ref = env.SUPABASE_PROJECT_REF;
if (!env.SUPABASE_ACCESS_TOKEN || !ref) throw new Error("A .env-ben SUPABASE_ACCESS_TOKEN és SUPABASE_PROJECT_REF kell.");

const AUTH_DOMAIN = "portal.local"; // = docs/config.js authDomain = functions/portal/index.ts AUTH_DOMAIN
const url = `https://${ref}.supabase.co`;

async function mgmt(method, path, body) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: body && JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
const sql = (query) => mgmt("POST", "/database/query", { query });
const lit = (s) => `'${String(s).replaceAll("'", "''")}'`;
const keys = await mgmt("GET", "/api-keys?reveal=true");
const key = (type, legacyName) =>
  (keys.find((k) => k.type === type) ?? keys.find((k) => k.name === legacyName))?.api_key;

if (process.argv[2] === "admin") {
  const [username, name] = [process.argv[3]?.toLowerCase(), process.argv[4]];
  if (!/^[a-z0-9._-]{3,40}$/.test(username ?? "") || !name) throw new Error('Használat: node scripts/setup.mjs admin <felhasználónév> "<Név>"');
  const db = createClient(url, key("secret", "service_role"), { auth: { persistSession: false } });
  const abc = "abcdefghjkmnpqrstuvwxyz23456789";
  const password = [...randomBytes(16)].map((b, i) => (i && i % 4 === 0 ? "-" : "") + abc[b % abc.length]).join("");
  const { data: existing } = await db.from("profiles").select("id, role").eq("username", username).maybeSingle();
  if (existing) {
    if (existing.role !== "admin") throw new Error("Ez a felhasználónév egy ügyfélé.");
    const { error } = await db.auth.admin.updateUserById(existing.id, { password });
    if (error) throw error;
  } else {
    const { data, error } = await db.auth.admin.createUser({ email: `${username}@${AUTH_DOMAIN}`, password, email_confirm: true });
    if (error) throw error;
    const { error: pErr } = await db.from("profiles").insert({ id: data.user.id, role: "admin", username, name });
    if (pErr) { await db.auth.admin.deleteUser(data.user.id); throw pErr; }
  }
  console.log(`${existing ? "Admin jelszó lecserélve" : "Admin fiók létrehozva"}.\n  felhasználónév: ${username}\n  jelszó:         ${password}\n(Csak most látható – a Beállításokban azonnal cserélhető.)`);
  process.exit(0);
}

// 1) Titok a pg_cron → Edge Function híváshoz (egyszer generáljuk, a .env őrzi)
let notifySecret = env.NOTIFY_SECRET;
if (!notifySecret) {
  notifySecret = randomBytes(32).toString("hex");
  appendFileSync(envPath, `NOTIFY_SECRET=${notifySecret}\n`);
}
const portalUrl = (env.PORTAL_URL || "").replace(/\/$/, "");
if (!portalUrl) throw new Error("A .env-ben PORTAL_URL kell (a portál nyilvános címe, pl. https://valami.github.io/hianypotlas-portal).");

// 2) Edge Function secretek. Az SMTP_* csak akkor megy fel, ha a .env-ben ki van töltve.
const secrets = { NOTIFY_SECRET: notifySecret, PORTAL_URL: portalUrl };
for (const k of ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "MAIL_FROM"]) if (env[k]) secrets[k] = env[k];
await mgmt("POST", "/secrets", Object.entries(secrets).map(([name, value]) => ({ name, value })));
console.log("Function secretek:", Object.keys(secrets).join(", "));

// 3) Az adatbázis tudja, hová és milyen titokkal szóljon (értesítés + napi ébrentartó ping)
const publishable = key("publishable", "anon");
await sql(`insert into private.config (key, value) values
  ('notify_url', ${lit(`${url}/functions/v1/portal`)}),
  ('notify_secret', ${lit(notifySecret)}),
  ('keepalive_url', ${lit(`${url}/rest/v1/settings?select=brand&apikey=${publishable}`)})
  on conflict (key) do update set value = excluded.value`);
console.log("private.config frissítve.");

// 4) Auth: nyilvános regisztráció tiltva (fiókot csak az admin hoz létre a function-ön át)
await mgmt("PATCH", "/config/auth", { disable_signup: true, password_min_length: 8, site_url: portalUrl });
console.log("Auth: regisztráció letiltva, min. jelszóhossz 8.");

// 5) A frontend nyilvános konfigurációja
const cfgPath = new URL("../docs/config.js", import.meta.url);
writeFileSync(cfgPath, readFileSync(cfgPath, "utf8")
  .replace(/supabaseUrl: "[^"]*"/, `supabaseUrl: "${url}"`)
  .replace(/supabaseKey: "[^"]*"/, `supabaseKey: "${publishable}"`));
console.log("docs/config.js kitöltve:", url);
