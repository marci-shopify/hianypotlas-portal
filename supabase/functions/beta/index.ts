// Pályázatsegítő – BÉTA pontozó: az AI-ügynök kapuja. Külön function, hogy az éles `portal` functionhöz ne kelljen nyúlni.
//   Ügynök (kód az URL-ben, egyetlen sorhoz ad hozzáférést):
//     GET  /functions/v1/beta?t=<kód>             → a feladat szövege (útmutató + adatok), text/plain
//     POST /functions/v1/beta?t=<kód>  + JSON     → ellenőrzés + mentés; a válasz megmondja, mi hibás / mi maradt ki
//   Admin böngészőből (JWT), ha az ügynöknek nincs internete: { action: "task" | "submit", kind: "call" | "eval", id, data? }
// Telepítés: npx supabase functions deploy beta --remote=<ref> --use-api --yes   (verify_jwt = false, lásd config.toml)
import { createClient } from "npm:@supabase/supabase-js@2";
import { checkCatalog, checkEval } from "./check.js";
import { callTask, evalTask } from "./tasks.js";

const env = (k: string) => Deno.env.get(k) ?? "";
const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
});
const SELF = `${env("SUPABASE_URL")}/functions/v1/beta`;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 1), { status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" } });
const fail = (message: string): never => { throw new Error(message); };

type Kind = "call" | "eval";
// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;
const TABLE = { call: "beta_calls", eval: "beta_evals" };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = new URL(req.url);
    const t = url.searchParams.get("t");
    if (t) {
      const kind: Kind | null = t[0] === "f" ? "call" : t[0] === "e" ? "eval" : null;
      const { data: row } = kind && t.length >= 40
        ? await db.from(TABLE[kind]).select("*").eq("agent_token", t).gt("agent_expires", new Date().toISOString()).maybeSingle()
        : { data: null };
      if (!kind || !row) return json({ error: "Érvénytelen vagy lejárt kód. Kérd el a tanácsadótól a portálon látható friss promptot." }, 403);
      const self = `${SELF}?t=${t}`;
      if (req.method === "GET") {
        return new Response(await task(kind, row, self, url.searchParams.get("szoveg") === "1"),
          { headers: { ...cors, "Content-Type": "text/plain; charset=utf-8" } });
      }
      if (req.method === "POST") return json(await submit(kind, row, await body(req)));
      return json({ error: "GET vagy POST" }, 405);
    }

    if (req.method !== "POST") return json({ error: "forbidden" }, 403);
    if (!(await isAdmin(req))) return json({ error: "forbidden" }, 403);
    const b = await body(req);
    const kind: Kind = b.kind === "eval" ? "eval" : "call";
    const { data: row } = await db.from(TABLE[kind]).select("*").eq("id", b.id).maybeSingle();
    if (!row) fail("Nincs ilyen sor.");
    if (b.action === "task") return json({ text: await task(kind, row, `${SELF}?t=${row.agent_token}`, false) });
    if (b.action === "submit") return json(await submit(kind, row, b.data));
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

async function body(req: Request) {
  const raw = await req.text();
  if (raw.length > 3_000_000) fail("Túl nagy a beküldött adat (legfeljebb 3 MB).");
  try { return JSON.parse(raw); } catch { return fail("A beküldött adat nem érvényes JSON. Ellenőrizd az idézőjeleket és a vesszőket, majd küldd újra."); }
}

async function isAdmin(req: Request) {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return false;
  const { data: { user } } = await db.auth.getUser(token);
  if (!user) return false;
  const { data } = await db.from("profiles").select("role").eq("id", user.id).maybeSingle();
  return data?.role === "admin";
}

async function callOf(ev: Row): Promise<Row> {
  const { data } = await db.from("beta_calls").select("*").eq("id", ev.call_id).maybeSingle();
  if (!data?.catalog) fail("Ehhez a felhíváshoz még nincs kivonat – előbb a felhívás kivonatát kell elkészíteni.");
  return data as Row;
}

async function task(kind: Kind, row: Row, self: string, withText: boolean) {
  if (kind === "call") {
    if (!row.docs?.length) fail("Ehhez a felhíváshoz nincs feltöltött dokumentum.");
    return callTask(row, self);
  }
  return evalTask(row, await callOf(row), self, withText);
}

async function submit(kind: Kind, row: Row, data: unknown) {
  const at = new Date().toISOString();
  if (kind === "call") {
    const rep = checkCatalog(row.docs, data);
    // Hibás beküldést nem mentünk (a felület a tárolt kivonat alakjára épít, és a korábbi jó állapot megmarad).
    // A lefedetlen mondat nem hiba: a félkész, de ép kivonatot a tanácsadó már látja.
    if (rep.hibak.length) return { ...rep, uzenet: `Nem mentve: ${rep.hibak.length} hiba. Javítsd mindet, és küldd be újra a teljes JSON-t.` };
    const { error } = await db.from("beta_calls").update({ catalog: data, review: { ...rep, at }, updated_at: at }).eq("id", row.id);
    if (error) fail(error.message);
    return {
      kesz: rep.kesz, hibak: rep.hibak, figyelmeztetesek: rep.figyelmeztetesek, lefedetlen: rep.lefedetlen, stat: rep.stat,
      uzenet: rep.kesz ? "Kész: a kivonat minden ellenőrzésen átment, a tanácsadó látja a portálon."
        : `Mentve, de még nincs kész: ${rep.lefedetlen.length} lefedetlen mondat. Rendezd mindet (felvétel vagy indokolt elvetés), és küldd be újra a teljes JSON-t.`,
    };
  }
  const rep = checkEval((await callOf(row)).catalog, data);
  if (!rep.kesz) return { ...rep, uzenet: `Nem mentve: ${rep.hibak.length} hiba. Javítsd mindet, és küldd be újra a teljes JSON-t.` };
  const { error } = await db.from("beta_evals").update({ result: data, review: { ...rep, at }, updated_at: at }).eq("id", row.id);
  if (error) fail(error.message);
  return {
    ...rep,
    uzenet: `Kész: az értékelés mentve. Nyitott kérdés: ${rep.stat.nyitott}.`,
  };
}
