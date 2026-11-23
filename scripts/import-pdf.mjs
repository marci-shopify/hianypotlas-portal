// Projekt létrehozása egy hiánypótlási felszólítás PDF-jéből (ugyanaz a felismerő, mint a felületen: docs/hp-parse.js).
//   node scripts/import-pdf.mjs <felszolitas.pdf> "<Ügyfél neve>" [felhasználónév]
// Ha az ügyfél (név vagy felhasználónév szerint) még nincs meg, létrehozza – e-mail-cím és levél NÉLKÜL.
// Belépési adatot az admin a felületen ad: Ügyfelek → „Belépési adatok elküldése” → a levél ott elküldhető.
// Az ügyfél semmilyen e-mailt nem kap: értesítés csak a projekt oldalán az „Értesítés küldése” gombbal megy.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { createClient } from "@supabase/supabase-js";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { pdfPages, extractPoints, extractMeta, splitTitle } from "../docs/hp-parse.js";

process.loadEnvFile(new URL("../.env", import.meta.url));
const { SUPABASE_ACCESS_TOKEN: token, SUPABASE_PROJECT_REF: ref } = process.env;
const [file, clientName, wantUser] = process.argv.slice(2);
if (!file || !clientName) throw new Error('Használat: node scripts/import-pdf.mjs <felszolitas.pdf> "<Ügyfél neve>" [felhasználónév]');

const keys = await (await fetch(`https://api.supabase.com/v1/projects/${ref}/api-keys?reveal=true`, { headers: { Authorization: `Bearer ${token}` } })).json();
const secret = (keys.find((k) => k.type === "secret") ?? keys.find((k) => k.name === "service_role"))?.api_key;
if (!secret) throw new Error(`Nem kaptam service kulcsot (lejárt a token?): ${JSON.stringify(keys).slice(0, 200)}`);
const db = createClient(`https://${ref}.supabase.co`, secret, { auth: { persistSession: false } });
const need = ({ data, error }) => { if (error) throw error; return data; };

const bytes = readFileSync(file);
const pages = await pdfPages(pdfjs, new Uint8Array(bytes));
const points = extractPoints(pages);
const meta = extractMeta(pages);
if (!points.length) throw new Error("Nem találtam számozott pontokat a PDF-ben – a felületen kézzel vehetők fel.");

const slug = (s) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30);
const username = (wantUser || slug(clientName)).toLowerCase();
let client = need(await db.from("profiles").select("id, name").eq("role", "client").or(`username.eq.${username},name.eq."${clientName.replaceAll('"', "")}"`).limit(1).maybeSingle());
if (!client) {
  const password = randomBytes(18).toString("base64url");   // senki nem látja; az admin „Belépési adatok elküldése” gombbal ad valódit
  const { data, error } = await db.auth.admin.createUser({ email: `${username}@portal.local`, password, email_confirm: true });
  if (error) throw error;
  need(await db.from("profiles").insert({ id: data.user.id, role: "client", username, name: clientName }));
  client = { id: data.user.id, name: clientName };
  console.log(`Új ügyfél: ${clientName} (felhasználónév: ${username}) – e-mail-cím nélkül, levél nem ment.`);
}

const proj = need(await db.from("projects").insert({ client_id: client.id, title: meta.title || basename(file, ".pdf"), reference: meta.reference }).select("id").single());
need(await db.from("points").insert(points.map((t, i) => ({ project_id: proj.id, position: i + 1, ...splitTitle(t) }))));
const ascii = basename(file).normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/[^A-Za-z0-9._-]+/g, "_").slice(-80);
const path = `${proj.id}/forras/${crypto.randomUUID()}-${ascii}`;
need(await db.storage.from("docs").upload(path, bytes, { contentType: "application/pdf" }));
need(await db.from("projects").update({ source_path: path, source_name: basename(file) }).eq("id", proj.id));
console.log(`Projekt kész: ${points.length} pont, felszólítás csatolva → ${process.env.PORTAL_URL}/#/p/${proj.id}`);
