// SQL futtatása az éles adatbázison a Supabase Management API-n át (nem kell DB-jelszó, se Docker).
//   node scripts/sql.mjs supabase/migrations/20261119000000_init.sql     ← fájl
//   node scripts/sql.mjs "select count(*) from projects"                  ← egy lekérdezés
// A .env-ből olvas: SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF
import { readFileSync, existsSync } from "node:fs";

process.loadEnvFile(new URL("../.env", import.meta.url));
const { SUPABASE_ACCESS_TOKEN: token, SUPABASE_PROJECT_REF: ref } = process.env;
const arg = process.argv[2];
if (!token || !ref || !arg) {
  console.error("Használat: node scripts/sql.mjs <fájl.sql | \"SQL\">  (a .env-ben SUPABASE_ACCESS_TOKEN és SUPABASE_PROJECT_REF kell)");
  process.exit(1);
}

const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: existsSync(arg) ? readFileSync(arg, "utf8") : arg }),
});
const text = await res.text();
console.log(text);
if (!res.ok) process.exit(1);
