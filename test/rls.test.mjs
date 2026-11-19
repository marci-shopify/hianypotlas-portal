// Biztonsági önteszt: a migrációt beágyazott Postgresen (PGlite) futtatja, és ellenőrzi,
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
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated;
  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner_id text);
  alter table storage.objects enable row level security;
  create function storage.foldername(name text) returns text[] language sql immutable as
    $$ select (string_to_array(name, '/'))[1 : array_length(string_to_array(name, '/'), 1) - 1] $$;
  grant usage on schema storage to authenticated;
  grant all on storage.objects to authenticated;
  create schema net;
  create table net.calls (url text, headers jsonb, body jsonb);
  create function net.http_post(url text, headers jsonb, body jsonb) returns bigint language sql as
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
const denied = async (label, sql, params) => {
  tests++;
  let res;
  try { res = await db.query(sql, params); } catch { return; }   // hiba = megtagadva
  assert.equal(res.affectedRows ?? 0, 0, `TILOS lett volna, de sikerült: ${label}`);
  assert.equal(res.rows.length, 0, `TILOS lett volna, de adatot adott: ${label}`);
};
const ok = (cond, label) => { tests++; assert.ok(cond, label); };

// ── admin létrehoz két projektet ──
const [pa, pb, ptA, ptB] = await as(ADMIN, async () => {
  const [{ id: pa }] = await rows(`insert into projects (client_id, title, deadline) values ($1, 'Alfa GINOP', '2026-12-10') returning id`, [A]);
  const [{ id: pb }] = await rows(`insert into projects (client_id, title) values ($1, 'Béta VP') returning id`, [B]);
  const [{ id: ptA }] = await rows(`insert into points (project_id, position, title) values ($1, 1, 'Cégkivonat') returning id`, [pa]);
  const [{ id: ptB }] = await rows(`insert into points (project_id, position, title) values ($1, 1, 'Aláírási címpéldány') returning id`, [pb]);
  return [pa, pb, ptA, ptB];
});
ok((await rows(`select client_notify_at from projects where id = $1`, [pa]))[0].client_notify_at, "új pont → ügyfél-értesítés ütemezve");

// ── névtelen látogató: csak a cégnév ──
await as(null, async () => {
  ok((await rows(`select brand from settings`)).length === 1, "anon látja a cégnevet");
  await denied("anon profiles", `select * from profiles`);
  await denied("anon projects", `select * from projects`);
  await denied("anon post_message", `select post_message($1, 'x')`, [ptA]);
  await denied("anon settings update", `update settings set brand = 'x'`);
});

// ── A ügyfél ──
await as(A, async () => {
  ok((await rows(`select id from projects`)).length === 1, "A csak a saját projektjét látja");
  ok((await rows(`select id from points`)).length === 1, "A csak a saját pontját látja");
  ok((await rows(`select id from profiles`)).length === 1, "A csak a saját profilját látja");
  await denied("A olvassa B projektjét", `select * from projects where id = $1`, [pb]);
  await denied("A olvassa B pontját", `select * from points where id = $1`, [ptB]);
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

  await db.query(`update profiles set notify_email = 'a@alfa.hu' where id = $1`, [A]);
  ok((await rows(`select notify_email from profiles`))[0].notify_email === "a@alfa.hu", "A beállítja a saját e-mailjét");
  await denied("A érvénytelen e-mail", `update profiles set notify_email = 'nem-email' where id = $1`, [A]);

  // fájl: saját pontra megy, máséra / rossz útvonalra nem
  await db.query(`insert into storage.objects (bucket_id, name, owner_id) values ('docs', $1, $2)`, [`${pa}/${ptA}/f1-ceg.pdf`, A]);
  await db.query(`insert into files (point_id, path, name, size) values ($1, $2, 'cég.pdf', 10)`, [ptA, `${pa}/${ptA}/f1-ceg.pdf`]);
  await denied("A storage: B mappájába", `insert into storage.objects (bucket_id, name, owner_id) values ('docs', $1, $2)`, [`${pb}/${ptB}/x.pdf`, A]);
  await denied("A storage: saját projekt, B pontja", `insert into storage.objects (bucket_id, name, owner_id) values ('docs', $1, $2)`, [`${pa}/${ptB}/x.pdf`, A]);
  await denied("A storage: szemét útvonal", `insert into storage.objects (bucket_id, name, owner_id) values ('docs', 'x.pdf', $1)`, [A]);
  await denied("A storage: másik bucket", `insert into storage.objects (bucket_id, name, owner_id) values ('other', $1, $2)`, [`${pa}/${ptA}/y.pdf`, A]);
  await denied("A files: B pontjára", `insert into files (point_id, path, name) values ($1, $2, 'x')`, [ptB, `${pb}/${ptB}/x.pdf`]);
  await denied("A files: útvonal ≠ pont", `insert into files (point_id, path, name) values ($1, $2, 'x')`, [ptA, `${pb}/${ptB}/x.pdf`]);

  await db.query(`select post_message($1, 'Feltöltöttem.')`, [ptA]);
  await db.query(`select mark_seen($1)`, [pa]);
});

const afterUpload = (await rows(`select p.status, p.admin_unread, p.client_unread, j.admin_notify_at
  from points p join projects j on j.id = p.project_id where p.id = $1`, [ptA]))[0];
ok(afterUpload.status === "feltoltve", "feltöltés → 'feltoltve' státusz");
ok(afterUpload.admin_unread === true, "feltöltés → admin olvasatlan");
ok(afterUpload.client_unread === false, "mark_seen törli az ügyfél jelzőjét, az adminét nem");
ok(afterUpload.admin_notify_at, "feltöltés → admin-értesítés ütemezve");
const f = (await rows(`select uploaded_by, from_admin from files`))[0];
ok(f.uploaded_by === A && f.from_admin === false, "uploaded_by/from_admin a szerveren dől el");
const m = (await rows(`select from_admin, author_id from messages`))[0];
ok(m.from_admin === false && m.author_id === A, "üzenet szerzője a szerveren dől el");

// ── B ügyfél semmit nem lát A-ból ──
await as(B, async () => {
  await denied("B olvassa A fájljait", `select * from files`);
  await denied("B olvassa A üzeneteit", `select * from messages`);
  await denied("B olvassa A storage-objektumát", `select * from storage.objects`);
  await denied("B törli A fájlját", `delete from files where point_id = $1`, [ptA]);
  await denied("B törli A storage-objektumát", `delete from storage.objects where name like $1`, [`${pa}/%`]);
  await denied("B mark_seen A projektjén", `select 1 from (select mark_seen($1)) x where false`, [pa]);
});
ok((await rows(`select admin_unread from points where id = $1`, [ptA]))[0].admin_unread === true, "B mark_seen-je nem hatott A projektjére");

// ── admin javítást kér, majd elfogad ──
await as(ADMIN, async () => {
  ok((await rows(`select id from projects`)).length === 2, "admin minden projektet lát");
  ok((await rows(`select id from files`)).length === 1, "admin látja a fájlokat");
  ok((await rows(`select id from storage.objects`)).length === 1, "admin látja a storage-objektumot");
  await db.query(`select post_message($1, 'Kérem 30 napnál nem régebbit.', 'javitando')`, [ptA]);
});
const afterReview = (await rows(`select p.status, p.client_unread, j.client_notify_at
  from points p join projects j on j.id = p.project_id where p.id = $1`, [ptA]))[0];
ok(afterReview.status === "javitando" && afterReview.client_unread, "admin válasz → javítandó + ügyfél olvasatlan");
ok(afterReview.client_notify_at, "admin válasz → ügyfél-értesítés ütemezve");

await as(A, async () => {
  ok((await rows(`select body from messages where from_admin`)).length === 1, "A látja az admin üzenetét");
  await db.query(`delete from files where point_id = $1`, [ptA]);
});
ok((await rows(`select status from points where id = $1`, [ptA]))[0].status === "javitando", "törlés javítandó állapotban nem állít státuszt");

await as(ADMIN, () => db.query(`select post_message($1, null, 'elfogadva')`, [ptA]));
await as(A, async () => {
  await denied("A elfogadott pontra tölt (storage)", `insert into storage.objects (bucket_id, name, owner_id) values ('docs', $1, $2)`, [`${pa}/${ptA}/late.pdf`, A]);
  await denied("A elfogadott pontra tölt (files)", `insert into files (point_id, path, name) values ($1, $2, 'x')`, [ptA, `${pa}/${ptA}/late.pdf`]);
});

// ── értesítések kiküldése: csak az esedékes megy ki, és pontosan egyszer ──
await db.exec(`insert into private.config values ('notify_url', 'https://x/functions/v1/portal'), ('notify_secret', 's3cret');`);
await db.exec(`select private.flush_notifications()`);
ok((await rows(`select * from net.calls`)).length === 0, "5 percen belül még nem megy ki levél");
await db.exec(`update projects set client_notify_at = now() - interval '1 second' where id = '${pa}'; select private.flush_notifications(); select private.flush_notifications();`);
const calls = await rows(`select * from net.calls`);
ok(calls.length === 1 && calls[0].body.side === "client" && calls[0].body.project_id === pa
  && calls[0].headers["x-notify-secret"] === "s3cret", "esedékes értesítés pontosan egyszer megy ki");

// ── az ügyfél nem éri el a private sémát ──
await db.exec(`insert into mail_log (project_id, recipients, subject) values ('${pa}', 'a@alfa.hu', 'teszt')`);
await as(A, async () => {
  await denied("A olvassa a private.config-ot", `select * from private.config`);
  await denied("A olvassa a levélnaplót", `select * from mail_log`);
});
ok((await as(ADMIN, () => rows(`select id from mail_log`))).length === 1, "admin látja a levélnaplót");

console.log(`OK – ${tests} ellenőrzés sikeres`);
