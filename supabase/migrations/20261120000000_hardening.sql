-- Szigorítás a független átnézés (2026-11-20) megállapításai alapján. Csak a különbség az init-hez képest.
--  1) fájlsor csak létező Storage-objektumra, kliens által nem hamisítható mezőkkel
--  2) Storage-ból törölni csak az Edge Function tud (service role) → nincs csendes tartalomcsere, nincs árva fájl
--  3) pontonkénti fájlszám-korlát ügyfélnek (tárhely-kimerítés ellen)
--  4) mark_seen csak azt jelöli látottnak, amit a felhasználó tényleg betöltött
--  5) jelszócsere után a régi munkamenetek visszavonása
--  6) hosszabb időkorlát az értesítő hívásra

-- ── 1) files: a kliens csak ezt a négy mezőt adhatja meg; a többit a trigger/alapérték tölti ──
revoke insert on public.files from authenticated;
grant insert (point_id, path, name, size) on public.files to authenticated;

create or replace function private.files_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_size bigint;
begin
  new.uploaded_by := auth.uid();
  new.from_admin  := public.is_admin();
  -- A sor mögött valódi feltöltésnek kell állnia; a méretet is onnan vesszük, nem a klienstől.
  select coalesce((o.metadata ->> 'size')::bigint, new.size) into v_size
    from storage.objects o where o.bucket_id = 'docs' and o.name = new.path;
  if not found then
    raise exception 'no such object' using errcode = '42501';
  end if;
  new.size := v_size;
  return new;
end $$;

-- ── 2) + 3) Storage: nincs kliensoldali törlés; ügyfélnek pontonként legfeljebb 50 objektum ──
drop policy docs_delete on storage.objects;

create function public.point_has_room(p_point uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_admin() or (
    select count(*) < 50 from storage.objects o
     where o.bucket_id = 'docs'
       and o.name like (select p.project_id::text || '/' || p.id::text || '/%' from public.points p where p.id = p_point))
$$;

drop policy docs_insert on storage.objects;
create policy docs_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'docs'
         and public.can_upload(public.try_uuid((storage.foldername(name))[2]), name)
         and public.point_has_room(public.try_uuid((storage.foldername(name))[2])));

-- A function ezzel listázza egy projekt / pont összes objektumát (árvákat is), mielőtt törli őket.
create function public.storage_paths(p_prefix text) returns setof text
language sql stable security definer set search_path = '' as $$
  select name from storage.objects
   where bucket_id = 'docs' and length(p_prefix) >= 37 and starts_with(name, p_prefix)
   limit 1000
$$;

-- ── 4) mark_seen: csak a p_before időpontig módosult pontokat jelöli látottnak ──
drop function public.mark_seen(uuid);
create function public.mark_seen(p_project uuid, p_before timestamptz default now()) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if public.is_admin() then
    update public.points set admin_unread = false
     where project_id = p_project and admin_unread and updated_at <= p_before;
  elsif public.owns_project(p_project) then
    update public.points set client_unread = false
     where project_id = p_project and client_unread and updated_at <= p_before;
  end if;
end $$;

-- ── 5) jelszócsere / törlés után a meglévő munkamenetek megszüntetése ──
create function public.revoke_sessions(p_user uuid) returns void
language sql security definer set search_path = '' as $$
  delete from auth.sessions where user_id = p_user
$$;

-- ── 6) értesítő hívás 30 mp időkorláttal (hidegindítás + SMTP belefér) ──
create or replace function private.flush_notifications() returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_url    text := (select value from private.config where key = 'notify_url');
  v_secret text := (select value from private.config where key = 'notify_secret');
  r record;
begin
  if v_url is null or v_secret is null then return; end if;
  for r in
    update public.projects set client_notify_at = null
     where client_notify_at <= now() returning id, 'client' as side
  loop
    perform net.http_post(url := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-notify-secret', v_secret),
      body := jsonb_build_object('action', 'notify', 'project_id', r.id, 'side', r.side),
      timeout_milliseconds := 30000);
  end loop;
  for r in
    update public.projects set admin_notify_at = null
     where admin_notify_at <= now() returning id, 'admin' as side
  loop
    perform net.http_post(url := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-notify-secret', v_secret),
      body := jsonb_build_object('action', 'notify', 'project_id', r.id, 'side', r.side),
      timeout_milliseconds := 30000);
  end loop;
end $$;

-- ── jogosultságok az új függvényekre (új függvény alapból BÁRKI által hívható – ezt vissza kell venni) ──
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated, service_role;
revoke execute on function public.storage_paths(text), public.revoke_sessions(uuid) from authenticated;
