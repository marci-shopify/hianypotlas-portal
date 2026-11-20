// Pályázatsegítő (hiánypótlás portál) – az egyetlen Edge Function. Két dolgot csinál, amit a böngésző nem tehet meg:
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
    if (!me) return json({ error: "forbidden" }, 403);
    // Az egyetlen akció, amit ügyfél is hívhat: saját fájl törlése (a jogot az RLS dönti el, lásd deleteFile).
    if (body.action === "delete_file") return json(await deleteFile(req, body.id));
    if (me.role !== "admin") return json({ error: "forbidden" }, 403);

    switch (body.action) {
      case "create_client": return json(await createClientUser(body));
      case "update_client": return json(await updateClientUser(body));
      case "delete_client": return json(await deleteClientUser(body.id));
      case "delete_project": return json(await deleteProject(body.id));
      case "delete_point": return json(await deletePoint(body.id));
      // Az ügyfél CSAK erre kap e-mailt (az admin kézi „Értesítés küldése” gombja), automatikusan soha.
      case "notify_client": return json(await notify(body.project_id, "client"));
      case "send_credentials": return json(await sendCredentials(body, me.notify_email));
      case "test_email": {
        if (!me.notify_email) fail("Előbb adjon meg értesítési e-mail-címet.");
        await sendMail(null, [me.notify_email], "Próbalevél",
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

async function createClientUser(b: { username?: string; name?: string; password?: string; notify_email?: string; notify_email2?: string }) {
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
    id: data.user!.id, role: "client", username, name, notify_email: cleanEmail(b.notify_email), notify_email2: cleanEmail(b.notify_email2),
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

async function updateClientUser(b: { id: string; name?: string; notify_email?: string | null; notify_email2?: string | null; password?: string }) {
  await clientOnly(b.id);
  const patch: Record<string, unknown> = {};
  if (b.name !== undefined) patch.name = b.name.trim() || fail("Adja meg az ügyfél nevét.");
  if (b.notify_email !== undefined) patch.notify_email = cleanEmail(b.notify_email);
  if (b.notify_email2 !== undefined) patch.notify_email2 = cleanEmail(b.notify_email2);
  if (Object.keys(patch).length) {
    const { error } = await db.from("profiles").update(patch).eq("id", b.id);
    if (error) fail(error.code === "23514" ? "Érvénytelen e-mail-cím." : error.message);
  }
  if (b.password !== undefined) {
    if (b.password.length < 8) fail("A jelszó legalább 8 karakter legyen.");
    const { error } = await db.auth.admin.updateUserById(b.id, { password: b.password });
    if (error) fail(error.message);
    // A régi jelszóval nyitott munkamenetek se éljenek tovább (a már kiadott token legfeljebb 1 óráig érvényes).
    const { error: rErr } = await db.rpc("revoke_sessions", { p_user: b.id });
    if (rErr) fail(rErr.message);
  }
  return { ok: true };
}

// A belépési adatok elküldése az ügyfélnek. A szöveget az admin a felületen látja és szerkeszti (benne a jelszó,
// amit csak az ő böngészője ismer); mi csak továbbítjuk. A levél tartalmát NEM naplózzuk, csak a címzettet és a tárgyat.
async function sendCredentials(b: { id: string; to?: string; text?: string }, replyTo: string | null) {
  await clientOnly(b.id);
  const to = (b.to ?? "").trim();
  const text = (b.text ?? "").trim();
  if (!/^[^@s]+@[^@s]+.[^@s]+$/.test(to)) fail("Érvénytelen e-mail-cím.");
  if (!text || text.length > 5000) fail("A levél szövege üres vagy túl hosszú.");
  const html = `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#14251f;line-height:1.55;white-space:pre-line">${esc(text)}</div>`;
  await sendMail(null, [to], "Belépési adatok a hiánypótláshoz", text, html, replyTo ?? undefined);
  // Ha az ügyfélnek még nincs értesítési címe, ez lesz az (így az első belépéskor már nem kell megadnia).
  await db.from("profiles").update({ notify_email: to }).eq("id", b.id).is("notify_email", null);
  return { ok: true };
}

// ───────────────────────── Törlések ─────────────────────────
// Sorrend MINDIG: előbb az adatbázis-sor (onnantól az RLS nem enged új feltöltést a mappába),
// utána a Storage-mappa teljes ürítése előtag alapján – így árva fájl sem marad (pl. félbeszakadt feltöltés).

async function purge(prefix: string) {
  let removed = 0;
  for (;;) {
    const { data, error } = await db.rpc("storage_paths", { p_prefix: prefix });
    if (error) fail(error.message);
    const paths = (data ?? []) as string[];
    if (!paths.length) return removed;
    const { error: sErr } = await db.storage.from("docs").remove(paths);
    if (sErr) fail(`A fájlok törlése nem sikerült: ${sErr.message}`);
    removed += paths.length;
  }
}

async function deleteClientUser(id: string) {
  await clientOnly(id);
  const { data: projects, error } = await db.from("projects").select("id").eq("client_id", id);
  if (error) fail(error.message);
  const { error: dErr } = await db.auth.admin.deleteUser(id);   // kaszkád: profil → projektek → pontok → sorok
  if (dErr) fail(dErr.message);
  let files_removed = 0;
  for (const p of projects ?? []) files_removed += await purge(`${p.id}/`);
  return { ok: true, files_removed };
}

async function deleteProject(id: string) {
  const { data, error } = await db.from("projects").delete().eq("id", id).select("id");
  if (error) fail(error.message);
  if (!data?.length) fail("Nincs ilyen projekt.");
  return { ok: true, files_removed: await purge(`${id}/`) };
}

async function deletePoint(id: string) {
  const { data, error } = await db.from("points").delete().eq("id", id).select("project_id");
  if (error) fail(error.message);
  if (!data?.length) fail("Nincs ilyen pont.");
  return { ok: true, files_removed: await purge(`${data![0].project_id}/${id}/`) };
}

// A sort a HÍVÓ nevében töröljük (az ő JWT-jével), így pontosan az RLS `files_delete` szabálya dönt:
// admin bármit, ügyfél csak a saját, még el nem fogadott ponthoz tartozó fájlját. A Storage-objektum csak ezután megy.
async function deleteFile(req: Request, id: string) {
  const asCaller = createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), {
    global: { headers: { Authorization: req.headers.get("Authorization")! } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await asCaller.from("files").delete().eq("id", id).select("path");
  if (error) fail(error.message);
  if (!data?.length) fail("Ezt a fájlt már nem lehet törölni.");
  const { error: sErr } = await db.storage.from("docs").remove([data![0].path]);
  if (sErr) fail(`A fájl törlése nem sikerült: ${sErr.message}`);
  return { ok: true };
}

// ───────────────────────── Értesítő e-mail ─────────────────────────

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const huDate = (d: string) => d.slice(0, 10).replaceAll("-", ". ") + ".";

type Point = {
  position: number; title: string; status: string; client_unread: boolean; admin_unread: boolean; updated_at: string;
  files: { name: string; from_admin: boolean; created_at: string }[];
  messages: { body: string; from_admin: boolean; created_at: string }[];
};

async function notify(projectId: string, side: "client" | "admin") {
  const toClient = side === "client";
  const stamp = new Date().toISOString();   // a lekérdezés ELŐTT: ami a küldés alatt érkezik, a következő levélbe kerül
  const { data: p, error } = await db.from("projects")
    .select(`id, title, reference, deadline, client_notified_at, admin_notified_at,
             client:profiles(name, notify_email, notify_email2),
             points(position, title, status, client_unread, admin_unread, updated_at,
                    files(name, from_admin, created_at), messages(body, from_admin, created_at))`)
    .eq("id", projectId).single();
  if (error) fail(error.message);
  const client = p!.client as unknown as { name: string; notify_email: string | null; notify_email2: string | null };
  const all = (p!.points as Point[]).sort((a, b) => a.position - b.position);
  all.forEach((x, i) => (x.position = i + 1));   // a levélben ugyanaz a sorszám, mint a portálon (1-től, hézag nélkül)

  // Csak az, amit a címzett még nem látott a portálon. Ha közben megnézte, nem megy levél.
  const sent = Date.parse((toClient ? p!.client_notified_at : p!.admin_notified_at) ?? "1970-01-01");
  // ügyfélnél: csak ami a legutóbbi kézi küldés óta változott (különben minden gombnyomás ugyanazt küldené újra)
  const points = all.filter((x) => (toClient ? x.client_unread && Date.parse(x.updated_at) > sent : x.admin_unread));
  if (!points.length) return { skipped: "nincs olvasatlan" };

  const { data: admins } = await db.from("profiles").select("notify_email").eq("role", "admin").not("notify_email", "is", null);
  const adminMails = (admins ?? []).map((a) => a.notify_email as string);
  const to = toClient ? [client.notify_email, client.notify_email2].filter((x): x is string => !!x) : adminMails;
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

  const color: Record<string, string> = { hianyzik: "#827e6e", feltoltve: "#2d5d8c", javitando: "#b3472a", elfogadva: "#1e6a49" };
  const html = `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#14251f;line-height:1.55">
<p style="white-space:pre-line">${esc(intro)}</p>
${deadline ? `<p style="margin:0 0 16px"><strong>${esc(deadline)}</strong></p>` : ""}
${items.map(({ pt, msgs, files }) => `<div style="border-left:3px solid ${color[pt.status]};padding:6px 0 6px 14px;margin:0 0 14px">
<div><strong>${pt.position}. ${esc(pt.title)}</strong> <span style="color:${color[pt.status]};font-size:13px;white-space:nowrap">· ${STATUS[pt.status]}</span></div>
${files.length ? `<div style="font-size:14px;color:#555">Új fájl: ${esc(files.map((f) => f.name).join(", "))}</div>` : ""}
${msgs.map((m) => `<div style="font-size:15px;margin-top:6px;white-space:pre-line">${esc(m.body)}</div>`).join("")}
</div>`).join("")}
<p style="margin:24px 0"><a href="${esc(link)}" style="background:#15382c;color:#f6f3ea;padding:12px 24px;text-decoration:none;border-radius:999px;font-family:Arial,sans-serif;font-size:15px;font-weight:bold">Megnyitás a portálon</a></p>
${toClient ? `<p style="font-size:13px;color:#777;font-family:Arial,sans-serif">A fájlokat és a választ a portálon tudja feltölteni, illetve megírni.</p>` : ""}
</div>`;

  try {
    await sendMail(p!.id, to, subject, text, html, toClient ? adminMails[0] : client.notify_email ?? undefined);
  } catch (e) {
    // Átmeneti hiba ne nyelje el az értesítést: 15 perc múlva újra, de legfeljebb 3 kudarcig 2 órán belül
    // (tartós hibánál – rossz cím, rossz SMTP-jelszó – ne pörögjön örökké; a hibát a mail_log mutatja az adminnak).
    const { count } = await db.from("mail_log").select("id", { count: "exact", head: true })
      .eq("project_id", p!.id).not("error", "is", null).gt("created_at", new Date(Date.now() - 2 * 3600e3).toISOString());
    if (!toClient && (count ?? 0) < 3) {   // ügyfél felé nincs automatikus újrapróbálás: az admin látja a hibát és újraküldi
      const retryAt = new Date(Date.now() + 15 * 60e3).toISOString();
      await db.from("projects").update(toClient ? { client_notify_at: retryAt } : { admin_notify_at: retryAt }).eq("id", p!.id);
    }
    throw e;
  }
  const { error: uErr } = await db.from("projects")
    .update(toClient ? { client_notified_at: stamp } : { admin_notified_at: stamp }).eq("id", p!.id);
  if (uErr) console.error("notified_at mentése nem sikerült:", uErr.message);
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
      requireTLS: true,   // nem-465-ös porton se menjen titkosítatlanul
      auth: { user: env("SMTP_USER"), pass: env("SMTP_PASS") },
    });
    await transport.sendMail({
      from: { name: s?.brand ?? "Pályázatsegítő", address: env("MAIL_FROM") },
      to, replyTo, subject, text, html,
    });
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  await db.from("mail_log").insert({ project_id: projectId, recipients: to.join(", "), subject, error });
  if (error) fail(`E-mail hiba: ${error}`);
}
