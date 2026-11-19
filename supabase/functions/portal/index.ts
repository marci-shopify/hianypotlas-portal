// Hiánypótlás portál – az egyetlen Edge Function. Két dolgot csinál, amit a böngésző nem tehet meg:
//   1) ügyfél-fiókok kezelése (service role kell hozzá)  → csak admin JWT-vel hívható
//   2) összefoglaló értesítő e-mail kiküldése SMTP-n     → csak a pg_cron hívja, titkos fejléccel
// Telepítés: npx supabase functions deploy portal --no-verify-jwt   (a jogosultságot itt ellenőrizzük)
import { createClient } from "npm:@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@6.9.16";

const env = (k: string) => Deno.env.get(k) ?? "";
const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
});

// A Supabase Auth e-mail-címet vár; a felhasználónévből szintetikus címet képzünk.
// UGYANEZ az érték van a docs/config.js-ben (authDomain) – együtt kell változniuk.
const AUTH_DOMAIN = "portal.local";
const STATUS: Record<string, string> = {
  hianyzik: "Hiányzik", feltoltve: "Ellenőrzésre vár", javitando: "Javítandó", elfogadva: "Rendben",
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const fail = (message: string): never => { throw new Error(message); };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const body = await req.json();

    if (body.action === "notify") {
      const secret = env("NOTIFY_SECRET");
      if (!secret || req.headers.get("x-notify-secret") !== secret) return json({ error: "forbidden" }, 403);
      return json(await notify(body.project_id, body.side));
    }

    const me = await caller(req);
    if (me?.role !== "admin") return json({ error: "forbidden" }, 403);

    switch (body.action) {
      case "create_client": return json(await createClientUser(body));
      case "update_client": return json(await updateClientUser(body));
      case "delete_client": return json(await deleteClientUser(body.id));
      case "test_email": {
        if (!me.notify_email) fail("Előbb adjon meg értesítési e-mail-címet.");
        await sendMail(null, [me.notify_email], "Próbalevél a hiánypótlás portálról",
          "Ez egy próbalevél. Ha megkapta, az értesítések kiküldése működik.");
        return json({ ok: true });
      }
      default: return json({ error: "unknown action" }, 400);
    }
  } catch (e) {
    console.error(e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

async function caller(req: Request) {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data: { user } } = await db.auth.getUser(token);
  if (!user) return null;
  const { data } = await db.from("profiles").select("id, role, notify_email").eq("id", user.id).maybeSingle();
  return data;
}

// ───────────────────────── Ügyfél-fiókok ─────────────────────────

const cleanEmail = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

async function createClientUser(b: { username?: string; name?: string; password?: string; notify_email?: string }) {
  const username = (b.username ?? "").trim().toLowerCase();
  const name = (b.name ?? "").trim();
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) fail("A felhasználónév 3–40 karakter: kisbetű, szám, pont, kötőjel.");
  if (!name) fail("Adja meg az ügyfél nevét.");
  if ((b.password ?? "").length < 8) fail("A jelszó legalább 8 karakter legyen.");

  const { data, error } = await db.auth.admin.createUser({
    email: `${username}@${AUTH_DOMAIN}`, password: b.password, email_confirm: true,
  });
  if (error) fail(/already/i.test(error.message) ? "Ez a felhasználónév már foglalt." : error.message);

  const { error: pErr } = await db.from("profiles").insert({
    id: data.user!.id, role: "client", username, name, notify_email: cleanEmail(b.notify_email),
  });
  if (pErr) {
    await db.auth.admin.deleteUser(data.user!.id);   // ne maradjon profil nélküli fiók
    fail(pErr.code === "23505" ? "Ez a felhasználónév már foglalt." : pErr.message);
  }
  return { id: data.user!.id };
}

async function clientOnly(id: string) {
  const { data } = await db.from("profiles").select("role").eq("id", id).maybeSingle();
  if (data?.role !== "client") fail("Nincs ilyen ügyfél.");
}

async function updateClientUser(b: { id: string; name?: string; notify_email?: string | null; password?: string }) {
  await clientOnly(b.id);
  const patch: Record<string, unknown> = {};
  if (b.name !== undefined) patch.name = b.name.trim() || fail("Adja meg az ügyfél nevét.");
  if (b.notify_email !== undefined) patch.notify_email = cleanEmail(b.notify_email);
  if (Object.keys(patch).length) {
    const { error } = await db.from("profiles").update(patch).eq("id", b.id);
    if (error) fail(error.code === "23514" ? "Érvénytelen e-mail-cím." : error.message);
  }
  if (b.password !== undefined) {
    if (b.password.length < 8) fail("A jelszó legalább 8 karakter legyen.");
    const { error } = await db.auth.admin.updateUserById(b.id, { password: b.password });
    if (error) fail(error.message);
  }
  return { ok: true };
}

async function deleteClientUser(id: string) {
  await clientOnly(id);
  // A Storage-fájlokat az API-n át kell törölni; a sorokat utána az auth.users → profiles kaszkád viszi.
  const { data: files, error } = await db.from("files")
    .select("path, points!inner(projects!inner(client_id))").eq("points.projects.client_id", id);
  if (error) fail(error.message);
  const paths = (files ?? []).map((f) => f.path);
  for (let i = 0; i < paths.length; i += 100) {
    const { error: sErr } = await db.storage.from("docs").remove(paths.slice(i, i + 100));
    if (sErr) fail(sErr.message);
  }
  const { error: dErr } = await db.auth.admin.deleteUser(id);
  if (dErr) fail(dErr.message);
  return { ok: true, files_removed: paths.length };
}

// ───────────────────────── Értesítő e-mail ─────────────────────────

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const huDate = (d: string) => d.slice(0, 10).replaceAll("-", ". ") + ".";

type Point = {
  position: number; title: string; status: string; client_unread: boolean; admin_unread: boolean;
  files: { name: string; from_admin: boolean; created_at: string }[];
  messages: { body: string; from_admin: boolean; created_at: string }[];
};

async function notify(projectId: string, side: "client" | "admin") {
  const toClient = side === "client";
  const { data: p, error } = await db.from("projects")
    .select(`id, title, reference, deadline, client_notified_at, admin_notified_at,
             client:profiles(name, notify_email),
             points(position, title, status, client_unread, admin_unread,
                    files(name, from_admin, created_at), messages(body, from_admin, created_at))`)
    .eq("id", projectId).single();
  if (error) fail(error.message);
  const client = p!.client as unknown as { name: string; notify_email: string | null };
  const all = (p!.points as Point[]).sort((a, b) => a.position - b.position);
  all.forEach((x, i) => (x.position = i + 1));   // a levélben ugyanaz a sorszám, mint a portálon (1-től, hézag nélkül)

  // Csak az, amit a címzett még nem látott a portálon. Ha közben megnézte, nem megy levél.
  const points = all.filter((x) => (toClient ? x.client_unread : x.admin_unread));
  if (!points.length) return { skipped: "nincs olvasatlan" };

  const { data: admins } = await db.from("profiles").select("notify_email").eq("role", "admin").not("notify_email", "is", null);
  const adminMails = (admins ?? []).map((a) => a.notify_email as string);
  const to = toClient ? (client.notify_email ? [client.notify_email] : []) : adminMails;
  if (!to.length) return { skipped: "nincs címzett" };

  const since = Date.parse((toClient ? p!.client_notified_at : p!.admin_notified_at) ?? "1970-01-01");
  const fresh = <T extends { from_admin: boolean; created_at: string }>(xs: T[]) =>
    xs.filter((x) => x.from_admin === toClient && Date.parse(x.created_at) > since)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const items = points.map((pt) => ({ pt, msgs: fresh(pt.messages), files: fresh(pt.files) }));

  let subject: string, intro: string;
  if (toClient) {
    const head = all.every((x) => x.status === "elfogadva") ? "Minden pont rendben"
      : points.some((x) => x.status === "javitando") ? "Javítást kérünk"
      : items.some((i) => i.msgs.length) ? "Új üzenet"
      : "Hiánypótlási teendők";
    subject = `${head} – ${p!.title}`;
    intro = `Tisztelt ${client.name}!\n\nA(z) „${p!.title}” hiánypótlásában az alábbi pontoknál van újdonság.`;
  } else {
    subject = `${client.name}: új feltöltés vagy üzenet – ${p!.title}`;
    intro = `${client.name} az alábbi pontoknál töltött fel fájlt vagy írt megjegyzést („${p!.title}”).`;
  }
  const link = `${env("PORTAL_URL").replace(/\/$/, "")}/#/p/${p!.id}`;
  const deadline = p!.deadline ? `Határidő: ${huDate(p!.deadline)}` : "";

  const text = [
    intro, deadline, "",
    ...items.flatMap(({ pt, msgs, files }) => [
      `${pt.position}. ${pt.title} — ${STATUS[pt.status]}`,
      ...(files.length ? [`   Új fájl: ${files.map((f) => f.name).join(", ")}`] : []),
      ...msgs.map((m) => `   „${m.body}”`),
      "",
    ]),
    `Megnyitás a portálon: ${link}`,
  ].filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");

  const color: Record<string, string> = { hianyzik: "#7a7466", feltoltve: "#2456a6", javitando: "#b8400c", elfogadva: "#2a7548" };
  const html = `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#1b2430;line-height:1.5">
<p style="white-space:pre-line">${esc(intro)}</p>
${deadline ? `<p style="margin:0 0 16px"><strong>${esc(deadline)}</strong></p>` : ""}
${items.map(({ pt, msgs, files }) => `<div style="border-left:3px solid ${color[pt.status]};padding:6px 0 6px 14px;margin:0 0 14px">
<div><strong>${pt.position}. ${esc(pt.title)}</strong> <span style="color:${color[pt.status]};font-size:13px;white-space:nowrap">· ${STATUS[pt.status]}</span></div>
${files.length ? `<div style="font-size:14px;color:#555">Új fájl: ${esc(files.map((f) => f.name).join(", "))}</div>` : ""}
${msgs.map((m) => `<div style="font-size:15px;margin-top:6px;white-space:pre-line">${esc(m.body)}</div>`).join("")}
</div>`).join("")}
<p style="margin:24px 0"><a href="${esc(link)}" style="background:#1b2430;color:#fff;padding:11px 20px;text-decoration:none;border-radius:4px;font-family:Arial,sans-serif;font-size:15px">Megnyitás a portálon</a></p>
${toClient ? `<p style="font-size:13px;color:#777;font-family:Arial,sans-serif">A fájlokat és a választ a portálon tudja feltölteni, illetve megírni.</p>` : ""}
</div>`;

  await sendMail(p!.id, to, subject, text, html, toClient ? adminMails[0] : client.notify_email ?? undefined);
  await db.from("projects")
    .update(toClient ? { client_notified_at: new Date().toISOString() } : { admin_notified_at: new Date().toISOString() })
    .eq("id", p!.id);
  return { sent: to.length };
}

// Minden kiküldés (és minden hiba) bekerül a mail_log táblába – a csendes hiba a legrosszabb fajta.
async function sendMail(projectId: string | null, to: string[], subject: string, text: string, html?: string, replyTo?: string) {
  let error: string | null = null;
  try {
    if (!env("SMTP_HOST")) fail("Nincs beállítva SMTP (SMTP_HOST secret hiányzik).");
    const port = Number(env("SMTP_PORT") || 465);
    const { data: s } = await db.from("settings").select("brand").single();
    const transport = nodemailer.createTransport({
      host: env("SMTP_HOST"), port, secure: port === 465 || port === 2465,
      auth: { user: env("SMTP_USER"), pass: env("SMTP_PASS") },
    });
    await transport.sendMail({
      from: { name: s?.brand ?? "Hiánypótlás portál", address: env("MAIL_FROM") },
      to, replyTo, subject, text, html,
    });
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  await db.from("mail_log").insert({ project_id: projectId, recipients: to.join(", "), subject, error });
  if (error) fail(`E-mail hiba: ${error}`);
}
