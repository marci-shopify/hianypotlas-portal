// Biztonsági önteszt: a migrációkat beágyazott Postgresen (PGlite) futtatja, és ellenőrzi,
// hogy az ügyfelek csak a saját projektjükhöz férnek hozzá. Futtatás: `npm test`
// A Supabase-specifikus részeket (auth, storage, pg_net, pg_cron) minimális csonk helyettesíti.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";

const db = new PGlite();

await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key);
  create table auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated;
  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner_id text, metadata jsonb);
  alter table storage.objects enable row level security;
  create function storage.foldername(name text) returns text[] language sql immutable as
    $$ select (string_to_array(name, '/'))[1 : array_length(string_to_array(name, '/'), 1) - 1] $$;
  grant usage on schema storage to authenticated;
  grant all on storage.objects to authenticated;
  create schema net;
  create table net.calls (url text, headers jsonb, body jsonb);
  create function net.http_post(url text, headers jsonb, body jsonb, timeout_milliseconds int default 5000) returns bigint language sql as
    $$ insert into net.calls values (url, headers, body); select 1::bigint $$;
  create function net.http_get(url text) returns bigint language sql as
    $$ insert into net.calls values (url, null, null); select 1::bigint $$;
  create schema cron;
  create function cron.schedule(text, text, text) returns bigint language sql as $$ select 1::bigint $$;
`);

for (const f of readdirSync("supabase/migrations").sort()) {
  const sql = readFileSync(`supabase/migrations/${f}`, "utf8").replace(/^create extension.*$/gm, "");
  await db.exec(sql);
}

// ── tesztadat (tulajdonosként, RLS nélkül) ──
const ADMIN = "00000000-0000-0000-0000-00000000000a";
const A = "00000000-0000-0000-0000-0000000000a1";
const B = "00000000-0000-0000-0000-0000000000b1";
await db.exec(`
  insert into auth.users values ('${ADMIN}'), ('${A}'), ('${B}');
  insert into public.profiles (id, role, username, name) values
    ('${ADMIN}', 'admin', 'admin', 'Admin'), ('${A}', 'client', 'alfa', 'Alfa Kft.'), ('${B}', 'client', 'beta', 'Béta Bt.');
`);

let tests = 0;
const as = async (uid, fn) => {
  await db.exec(`set role ${uid ? "authenticated" : "anon"}; select set_config('request.jwt.claim.sub', '${uid ?? ""}', false);`);
  try { return await fn(); } finally { await db.exec("reset role"); }
};
const rows = async (sql, params) => (await db.query(sql, params)).rows;
// Megtagadás = nulla sor, VAGY kifejezetten jogosultsági / szabály-hiba. Bármi más hiba (elírás, hiányzó oszlop) a teszt hibája.
const REFUSAL = /permission denied|row-level security|^forbidden$|^empty$|^no such object$|violates check constraint/;
const denied = async (label, sql, params) => {
  tests++;
  let res;
  try { res = await db.query(sql, params); }
  catch (e) { assert.match(e.message, REFUSAL, `váratlan hiba („${label}”): ${e.message}`); return; }
  assert.equal(res.affectedRows ?? 0, 0, `TILOS lett volna, de sikerült: ${label}`);
  assert.equal(res.rows.length, 0, `TILOS lett volna, de adatot adott: ${label}`);
};
const ok = (cond, label) => { tests++; assert.ok(cond, label); };
const putObject = (path, owner, size = 10) =>
  db.query(`insert into storage.objects (bucket_id, name, owner_id, metadata) values ('docs', $1, $2, $3)`, [path, owner, { size }]);
const point = async (id) => (await rows(`select p.*, j.admin_notify_at, j.client_notify_at
  from points p join projects j on j.id = p.project_id where p.id = $1`, [id]))[0];

// ── admin létrehoz két projektet ──
const [pa, pb, ptA, ptA2, ptB] = await as(ADMIN, async () => {
  const [{ id: pa }] = await rows(`insert into projects (client_id, title, deadline) values ($1, 'Alfa GINOP', '2026-12-10') returning id`, [A]);
  const [{ id: pb }] = await rows(`insert into projects (client_id, title) values ($1, 'Béta VP') returning id`, [B]);
  const [{ id: ptA }] = await rows(`insert into points (project_id, position, title) values ($1, 1, 'Cégkivonat') returning id`, [pa]);
  const [{ id: ptA2 }] = await rows(`insert into points (project_id, position, title) values ($1, 2, 'Árajánlatok') returning id`, [pa]);
  const [{ id: ptB }] = await rows(`insert into points (project_id, position, title) values ($1, 1, 'Aláírási címpéldány') returning id`, [pb]);
  return [pa, pb, ptA, ptA2, ptB];
});
ok(!(await point(ptA)).client_notify_at, "új pont → ügyfélnek NEM megy automatikus levél");
// eredeti felszólítás: csak admin tölthet a {projekt}/forras/ mappába, olvasni a projekt ügyfele is tudja
await as(ADMIN, () => db.query(`insert into storage.objects (bucket_id, name, owner_id) values ('docs', $1, $2)`, [`${pa}/forras/x-felhivas.pdf`, ADMIN]));
await as(A, async () => {
  await denied("A tölt a forras mappába", `insert into storage.objects (bucket_id, name, owner_id) values ('docs', $1, $2)`, [`${pa}/forras/hamis.pdf`, A]);
  ok((await rows(`select name from storage.objects where name = $1`, [`${pa}/forras/x-felhivas.pdf`])).length === 1, "A látja a saját projektje felszólítását");
  ok((await db.query(`update profiles set notify_email2 = 'masodik@alfa.hu' where id = $1`, [A])).affectedRows === 1, "A megadhat második értesítési címet");
});
await as(B, () => denied("B olvassa A felszólítását", `select * from storage.objects where name like $1`, [`${pa}/forras/%`]));
await as(ADMIN, () => denied("admin forras mappa nem létező projekthez", `insert into storage.objects (bucket_id, name, owner_id) values ('docs', $1, $2)`, [`00000000-0000-0000-0000-000000000123/forras/x.pdf`, ADMIN]));
// B-nek is legyen fájlja, hogy legyen mit (nem) elérni
await putObject(`${pb}/${ptB}/b1-titok.pdf`, B);
await as(B, () => db.query(`insert into files (point_id, path, name, size) values ($1, $2, 'titok.pdf', 1)`, [ptB, `${pb}/${ptB}/b1-titok.pdf`]));

// ── névtelen látogató: csak a cégnév ──
await as(null, async () => {
  ok((await rows(`select brand from settings`)).length === 1, "anon látja a cégnevet");
  await denied("anon profiles", `select * from profiles`);
  await denied("anon projects", `select * from projects`);
  await denied("anon post_message", `select post_message($1, 'x')`, [ptA]);
  await denied("anon mark_seen", `select mark_seen($1)`, [pa]);
  await denied("anon storage_paths", `select storage_paths($1)`, [`${pa}/`]);
  await denied("anon settings update", `update settings set brand = 'x'`);
});

// ── A ügyfél ──
const pathA = `${pa}/${ptA}/f1-ceg.pdf`;
await as(A, async () => {
  ok((await rows(`select id from projects`)).length === 1, "A csak a saját projektjét látja");
  ok((await rows(`select id from points`)).length === 2, "A csak a saját pontjait látja");
  ok((await rows(`select id from profiles`)).length === 1, "A csak a saját profilját látja");
  await denied("A olvassa B projektjét", `select * from projects where id = $1`, [pb]);
  await denied("A olvassa B pontját", `select * from points where id = $1`, [ptB]);
  await denied("A olvassa B fájlsorát", `select * from files where point_id = $1`, [ptB]);
  await denied("A olvassa B storage-objektumát", `select * from storage.objects where name like $1`, [`${pb}/%`]);
  await denied("A projektet hoz létre", `insert into projects (client_id, title) values ($1, 'x')`, [A]);
  await denied("A pontot hoz létre", `insert into points (project_id, title) values ($1, 'x')`, [pa]);
  await denied("A státuszt ír át", `update points set status = 'elfogadva' where id = $1`, [ptA]);
  await denied("A adminná teszi magát", `update profiles set role = 'admin' where id = $1`, [A]);
  await denied("A átírja a nevét", `update profiles set name = 'x' where id = $1`, [A]);
  await denied("A átírja B e-mailjét", `update profiles set notify_email = 'x@x.hu' where id = $1 returning id`, [B]);
  await denied("A átírja a cégnevet", `update settings set brand = 'x' returning id`);
  await denied("A közvetlenül üzenetet szúr be", `insert into messages (point_id, from_admin, body) values ($1, true, 'x')`, [ptA]);
  await denied("A üzen B pontjához", `select post_message($1, 'x')`, [ptB]);
  await denied("A státuszt állít RPC-vel", `select post_message($1, 'x', 'elfogadva')`, [ptA]);
  await denied("A üres üzenet", `select post_message($1, '  ')`, [ptA]);
  await denied("A projektet töröl", `delete from projects where id = $1`, [pa]);
  await denied("A listázza a storage-útvonalakat", `select storage_paths($1)`, [`${pb}/`]);
  await denied("A visszavonja más munkamenetét", `select revoke_sessions($1)`, [B]);

  await db.query(`update profiles set notify_email = 'a@alfa.hu' where id = $1`, [A]);
  ok((await rows(`select notify_email from profiles`))[0].notify_email === "a@alfa.hu", "A beállítja a saját e-mailjét");
  await denied("A érvénytelen e-mail", `update profiles set notify_email = 'nem-email' where id = $1`, [A]);

  // fájl: saját pontra megy, máséra / rossz útvonalra nem
  await denied("A fájlsor feltöltés nélkül (fantomfájl)", `insert into files (point_id, path, name, size) values ($1, $2, 'x.pdf', 1)`, [ptA, `${pa}/${ptA}/nincs-ilyen.pdf`]);
  await putObject(pathA, A, 4321);
  await denied("A hamisítja a feltöltőt", `insert into files (point_id, path, name, size, uploaded_by) values ($1, $2, 'x', 1, $3)`, [ptA, pathA, B]);
  await denied("A adminnak álcázza a fájlt", `insert into files (point_id, path, name, size, from_admin) values ($1, $2, 'x', 1, true)`, [ptA, pathA]);
  await denied("A hamisítja a dátumot", `insert into files (point_id, path, name, size, created_at) values ($1, $2, 'x', 1, '2099-01-01')`, [ptA, pathA]);
  await db.query(`insert into files (point_id, path, name, size) values ($1, $2, 'cég.pdf', 999999999)`, [ptA, pathA]);
  await denied("A storage: B mappájába", `insert into storage.objects (bucket_id, name, owner_id) values ('docs', $1, $2)`, [`${pb}/${ptB}/x.pdf`, A]);
  await denied("A storage: saját projekt, B pontja", `insert into storage.objects (bucket_id, name, owner_id) values ('docs', $1, $2)`, [`${pa}/${ptB}/x.pdf`, A]);
  await denied("A storage: B projektje, saját pont", `insert into storage.objects (bucket_id, name, owner_id) values ('docs', $1, $2)`, [`${pb}/${ptA}/x.pdf`, A]);
  await denied("A storage: szemét útvonal", `insert into storage.objects (bucket_id, name, owner_id) values ('docs', 'x.pdf', $1)`, [A]);
  await denied("A storage: másik bucket", `insert into storage.objects (bucket_id, name, owner_id) values ('other', $1, $2)`, [`${pa}/${ptA}/y.pdf`, A]);
  await denied("A storage: saját objektum törlése közvetlenül (csak a function törölhet)", `delete from storage.objects where name = $1`, [pathA]);
  await denied("A storage: saját objektum átnevezése/felülírása", `update storage.objects set name = $1 where name = $2`, [`${pa}/${ptA}/masik.pdf`, pathA]);
  await denied("A files: B pontjára", `insert into files (point_id, path, name) values ($1, $2, 'x')`, [ptB, `${pb}/${ptB}/b1-titok.pdf`]);
  await denied("A files: saját pont, B útvonala", `insert into files (point_id, path, name) values ($1, $2, 'x')`, [ptA, `${pb}/${ptB}/b1-titok.pdf`]);

  await db.query(`select post_message($1, 'Feltöltöttem.')`, [ptA]);
});

const afterUpload = await point(ptA);
ok(afterUpload.status === "feltoltve", "feltöltés → 'feltoltve' státusz");
ok(afterUpload.admin_unread === true, "feltöltés → admin olvasatlan");
ok(afterUpload.admin_notify_at, "feltöltés → admin-értesítés ütemezve");
const f = (await rows(`select uploaded_by, from_admin, size from files where point_id = $1`, [ptA]))[0];
ok(f.uploaded_by === A && f.from_admin === false, "uploaded_by/from_admin a szerveren dől el");
ok(Number(f.size) === 4321, "a méret a Storage-ból jön, nem a klienstől");
const m = (await rows(`select from_admin, author_id from messages`))[0];
ok(m.from_admin === false && m.author_id === A, "üzenet szerzője a szerveren dől el");

// ── mark_seen: tényleg lefut, a saját oldalon hat, máséra nem ──
await as(B, () => db.query(`select mark_seen($1)`, [pa]));
ok((await point(ptA)).client_unread === true && (await point(ptA)).admin_unread === true, "B mark_seen-je nem hat A projektjére");
await as(A, () => db.query(`select mark_seen($1, now() - interval '1 hour')`, [pa]));
ok((await point(ptA)).client_unread === true, "mark_seen nem jelöli látottnak, ami a betöltés után változott");
await as(A, () => db.query(`select mark_seen($1)`, [pa]));
ok((await point(ptA)).client_unread === false && (await point(ptA2)).client_unread === false, "A mark_seen-je törli a saját jelzőit");
ok((await point(ptA)).admin_unread === true, "…de az admin jelzőjét nem");
ok((await point(ptB)).client_unread === true, "…és B projektjét sem érinti");

// ── B ügyfél semmit nem lát A-ból ──
await as(B, async () => {
  ok((await rows(`select id from files`)).length === 1, "B csak a saját fájlsorát látja");
  await denied("B olvassa A üzeneteit", `select * from messages`);
  await denied("B olvassa A storage-objektumát", `select * from storage.objects where name like $1`, [`${pa}/%`]);
  await denied("B törli A fájlsorát", `delete from files where point_id = $1`, [ptA]);
  await denied("B törli A storage-objektumát", `delete from storage.objects where name like $1`, [`${pa}/%`]);
});
ok((await rows(`select 1 from files where point_id = $1`, [ptA])).length === 1, "A fájlsora megvan B próbálkozása után");

// ── pontonkénti korlát: ügyfél legfeljebb 50 objektumot tehet egy pontra ──
await db.exec(`insert into storage.objects (bucket_id, name, owner_id) select 'docs', '${pa}/${ptA2}/tomeg-' || g, '${A}' from generate_series(1, 49) g`);
await as(A, async () => {
  await putObject(`${pa}/${ptA2}/az-50.pdf`, A);
  await denied("A az 51. objektumot tölti egy pontra", `insert into storage.objects (bucket_id, name, owner_id) values ('docs', $1, $2)`, [`${pa}/${ptA2}/az-51.pdf`, A]);
});
ok((await rows(`select storage_paths($1)`, [`${pa}/${ptA2}/`])).length === 50, "storage_paths előtag szerint listáz (árvákat is)");
ok((await rows(`select storage_paths('')`)).length === 0, "storage_paths rövid előtagra semmit nem ad");

// ── admin javítást kér, majd elfogad ──
await as(ADMIN, async () => {
  ok((await rows(`select id from projects`)).length === 2, "admin minden projektet lát");
  ok((await rows(`select id from files`)).length === 2, "admin látja a fájlokat");
  await putObject(`${pa}/${ptA2}/admin-minta.pdf`, ADMIN);   // adminra nem vonatkozik a korlát
  await db.query(`select post_message($1, 'Kérem 30 napnál nem régebbit.', 'javitando')`, [ptA]);
});
const afterReview = await point(ptA);
ok(afterReview.status === "javitando" && afterReview.client_unread, "admin válasz → javítandó + ügyfél olvasatlan");
ok(!afterReview.client_notify_at, "admin válasz → ügyfélnek NEM megy automatikus levél (csak kézi küldés)");

await as(A, async () => {
  ok((await rows(`select body from messages where from_admin`)).length === 1, "A látja az admin üzenetét");
  ok((await db.query(`delete from files where point_id = $1`, [ptA])).affectedRows === 1, "A törölheti a saját fájlsorát, amíg nincs elfogadva");
});
ok((await point(ptA)).status === "javitando", "törlés javítandó állapotban nem állít státuszt");

await putObject(`${pa}/${ptA}/f2-uj.pdf`, A);
await as(A, () => db.query(`insert into files (point_id, path, name) values ($1, $2, 'új.pdf')`, [ptA, `${pa}/${ptA}/f2-uj.pdf`]));
ok((await point(ptA)).status === "feltoltve", "javítás utáni új feltöltés → újra 'feltoltve'");
await as(ADMIN, () => db.query(`select post_message($1, null, 'elfogadva')`, [ptA]));
await as(A, async () => {
  await denied("A elfogadott pontra tölt (storage)", `insert into storage.objects (bucket_id, name, owner_id) values ('docs', $1, $2)`, [`${pa}/${ptA}/late.pdf`, A]);
  await denied("A elfogadott pontról töröl", `delete from files where point_id = $1`, [ptA]);
});

// ── értesítések kiküldése: csak az esedékes megy ki, és pontosan egyszer ──
await db.exec(`insert into private.config values ('notify_url', 'https://x/functions/v1/portal'), ('notify_secret', 's3cret');`);
await db.exec(`update projects set client_notify_at = now() + interval '5 minutes', admin_notify_at = null; select private.flush_notifications()`);
ok((await rows(`select * from net.calls`)).length === 0, "5 percen belül még nem megy ki levél");
await db.exec(`update projects set client_notify_at = now() - interval '1 second' where id = '${pa}'; select private.flush_notifications(); select private.flush_notifications();`);
const calls = await rows(`select * from net.calls`);
ok(calls.length === 1 && calls[0].body.side === "client" && calls[0].body.project_id === pa
  && calls[0].headers["x-notify-secret"] === "s3cret", "esedékes értesítés pontosan egyszer megy ki");

// ── munkamenet-visszavonás csak a service kulccsal megy ──
await db.exec(`insert into auth.sessions (user_id) values ('${A}'), ('${B}'); set role service_role; select public.revoke_sessions('${A}'); reset role;`);
ok((await rows(`select user_id from auth.sessions`)).map((r) => r.user_id).join() === B, "revoke_sessions csak az adott felhasználó munkameneteit törli");

// ── az ügyfél nem éri el a private sémát és a levélnaplót ──
await db.exec(`insert into mail_log (project_id, recipients, subject) values ('${pa}', 'a@alfa.hu', 'teszt')`);
await as(A, async () => {
  await denied("A olvassa a private.config-ot", `select * from private.config`);
  await denied("A olvassa a levélnaplót", `select * from mail_log`);
  await denied("A ír a levélnaplóba", `insert into mail_log (recipients, subject) values ('x', 'y')`);
});
ok((await as(ADMIN, () => rows(`select id from mail_log`))).length === 1, "admin látja a levélnaplót");

console.log(`OK – ${tests} ellenőrzés sikeres`);

// ── Teendő (points.instruction): admin írja, ügyfél csak olvassa ──
await as(A, () => denied("A átírja a Teendőt", `update points set instruction = 'x' where id = $1`, [ptA2]));
await as(ADMIN, () => db.query(`update points set instruction = 'Szállítólevél kell' where id = $1`, [ptA2]));
await as(A, async () => ok((await rows(`select instruction from points where id = $1`, [ptA2]))[0].instruction === "Szállítólevél kell", "A látja a Teendőt"));
console.log(`OK – Teendő ellenőrzések`);
