-- Hiánypótlás portál – teljes adatbázis-séma (egy fájl, friss Supabase projektre fut).
-- Tesztelve: `npm test` (PGlite, test/rls.test.mjs). Minden jogosultság RLS-ben él,
-- a böngésző a publikus (anon) kulccsal közvetlenül a táblákat éri el.

create extension if not exists pg_net;
create extension if not exists pg_cron;

create schema if not exists private;  -- nincs kitéve a Data API-n

-- ───────────────────────── Táblák ─────────────────────────

create table public.settings (
  id    boolean primary key default true check (id),   -- egyetlen sor
  brand text not null default 'Hiánypótlás portál'     -- a cég neve: fejléc + e-mail feladónév
);
insert into public.settings default values;

create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  role         text not null default 'client' check (role in ('admin', 'client')),
  username     text not null unique check (username ~ '^[a-z0-9._-]{3,40}$'),
  name         text not null,
  notify_email text check (notify_email is null or notify_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  created_at   timestamptz not null default now()
);

create table public.projects (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references public.profiles (id) on delete cascade,
  title      text not null,
  reference  text,                 -- pályázati azonosító
  deadline   date,                 -- hiánypótlási határidő
  archived   boolean not null default false,
  -- értesítés-könyvelés (lásd private.flush_notifications)
  client_notify_at   timestamptz,  -- ekkor esedékes az ügyfélnek szóló összefoglaló e-mail
  admin_notify_at    timestamptz,
  client_notified_at timestamptz,  -- utoljára ekkor ment ki
  admin_notified_at  timestamptz,
  created_at timestamptz not null default now()
);
create index on public.projects (client_id);

create table public.points (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects (id) on delete cascade,
  position    int not null default 0,
  title       text not null,
  description text,
  status      text not null default 'hianyzik'
              check (status in ('hianyzik', 'feltoltve', 'javitando', 'elfogadva')),
  client_unread boolean not null default true,   -- az ügyfél még nem látta a változást
  admin_unread  boolean not null default false,  -- az admin még nem látta a változást
  updated_at  timestamptz not null default now()
);
create index on public.points (project_id);

create table public.files (
  id          uuid primary key default gen_random_uuid(),
  point_id    uuid not null references public.points (id) on delete cascade,
  path        text not null unique,  -- Storage kulcs: {project_id}/{point_id}/{uuid}-{ascii_nev}
  name        text not null,         -- eredeti fájlnév (ékezetekkel)
  size        bigint not null default 0,
  uploaded_by uuid references public.profiles (id) on delete set null,
  from_admin  boolean not null default false,
  created_at  timestamptz not null default now()
);
create index on public.files (point_id);

create table public.messages (
  id         uuid primary key default gen_random_uuid(),
  point_id   uuid not null references public.points (id) on delete cascade,
  author_id  uuid references public.profiles (id) on delete set null,
  from_admin boolean not null,
  body       text not null check (length(body) between 1 and 5000),
  created_at timestamptz not null default now()
);
create index on public.messages (point_id);

-- Kiküldött (vagy elbukott) értesítő e-mailek naplója; az admin a Beállításokban látja.
create table public.mail_log (
  id         bigint generated always as identity primary key,
  project_id uuid references public.projects (id) on delete cascade,
  recipients text not null,
  subject    text not null,
  error      text,                 -- null = sikeresen átadva az SMTP-szervernek
  created_at timestamptz not null default now()
);

create table private.config (key text primary key, value text not null);
-- kulcsok: notify_url, notify_secret, keepalive_url  (telepítéskor töltjük fel, lásd AGENTS.md)

-- ───────────────────────── Segédfüggvények ─────────────────────────
-- SECURITY DEFINER: az RLS-en belülről hívjuk őket, a tulajdonos jogával olvasnak.

create function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
$$;

create function public.owns_project(p_project uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.projects where id = p_project and client_id = auth.uid())
$$;

create function public.owns_point(p_point uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.points p join public.projects j on j.id = p.project_id
    where p.id = p_point and j.client_id = auth.uid())
$$;

-- Feltölthet/törölhet-e a hívó ehhez a ponthoz, ÉS a Storage-útvonal tényleg ehhez a ponthoz tartozik-e.
-- Ügyfél elfogadott pontot már nem módosíthat.
create function public.can_upload(p_point uuid, p_path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.points p join public.projects j on j.id = p.project_id
    where p.id = p_point
      and starts_with(p_path, j.id::text || '/' || p.id::text || '/')
      and (public.is_admin() or (j.client_id = auth.uid() and p.status <> 'elfogadva')))
$$;

create function public.try_uuid(t text) returns uuid
language plpgsql immutable set search_path = '' as $$
begin return t::uuid; exception when others then return null; end $$;

-- Összefoglaló e-mail ütemezése: minden esemény 5 perccel kitolja, így egy „munkamenet” = egy levél.
create function private.queue_notify(p_project uuid, p_to_client boolean) returns void
language sql security definer set search_path = '' as $$
  update public.projects set
    client_notify_at = case when p_to_client then now() + interval '5 minutes' else client_notify_at end,
    admin_notify_at  = case when p_to_client then admin_notify_at else now() + interval '5 minutes' end
  where id = p_project
$$;

-- ───────────────────────── RPC-k (a frontend hívja) ─────────────────────────

-- Megjegyzés írása; admin egyúttal státuszt is állíthat. Az egyetlen út új üzenethez.
create function public.post_message(p_point uuid, p_body text default null, p_status text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_admin   boolean := public.is_admin();
  v_project uuid;
  v_client  uuid;
  v_body    text := nullif(trim(coalesce(p_body, '')), '');
begin
  select j.id, j.client_id into v_project, v_client
    from public.points p join public.projects j on j.id = p.project_id where p.id = p_point;
  if v_project is null or auth.uid() is null or not (v_admin or v_client = auth.uid()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_status is not null and not v_admin then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_body is null and p_status is null then
    raise exception 'empty' using errcode = '22023';
  end if;
  if v_body is not null then
    insert into public.messages (point_id, author_id, from_admin, body)
      values (p_point, auth.uid(), v_admin, v_body);
  end if;
  update public.points set
    status        = coalesce(p_status, status),
    client_unread = client_unread or v_admin,
    admin_unread  = admin_unread or not v_admin,
    updated_at    = now()
  where id = p_point;
  perform private.queue_notify(v_project, v_admin);
end $$;

-- A projekt megnyitásakor a saját oldali „olvasatlan” jelzők törlése.
create function public.mark_seen(p_project uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if public.is_admin() then
    update public.points set admin_unread = false where project_id = p_project and admin_unread;
  elsif public.owns_project(p_project) then
    update public.points set client_unread = false where project_id = p_project and client_unread;
  end if;
end $$;

-- ───────────────────────── Triggerek ─────────────────────────

create function private.files_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.uploaded_by := auth.uid();           -- sosem a kliens mondja meg, ki töltötte fel
  new.from_admin  := public.is_admin();
  return new;
end $$;
create trigger files_before_insert before insert on public.files
  for each row execute function private.files_before_insert();

create function private.files_after_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_project uuid;
begin
  if tg_op = 'INSERT' then
    select project_id into v_project from public.points where id = new.point_id;
    if new.from_admin then
      update public.points set client_unread = true, updated_at = now() where id = new.point_id;
    else
      update public.points set admin_unread = true, updated_at = now(),
        status = case when status in ('hianyzik', 'javitando') then 'feltoltve' else status end
      where id = new.point_id;
    end if;
    perform private.queue_notify(v_project, new.from_admin);
    return new;
  end if;
  -- DELETE: ha az ügyfél minden fájlját törölte, a pont újra „hiányzik”
  update public.points p set status = 'hianyzik', updated_at = now()
   where p.id = old.point_id and p.status = 'feltoltve'
     and not exists (select 1 from public.files f where f.point_id = p.id and not f.from_admin);
  return old;
end $$;
create trigger files_after_change after insert or delete on public.files
  for each row execute function private.files_after_change();

create function private.points_after_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.queue_notify(new.project_id, true);  -- új pont → az ügyfél kap róla levelet
  return new;
end $$;
create trigger points_after_insert after insert on public.points
  for each row execute function private.points_after_insert();

-- ───────────────────────── Jogosultságok + RLS ─────────────────────────

alter table public.settings enable row level security;
alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.points   enable row level security;
alter table public.files    enable row level security;
alter table public.messages enable row level security;
alter table public.mail_log enable row level security;

revoke all on all tables in schema public from anon, authenticated;
grant usage on schema public to anon, authenticated, service_role;
grant all on all tables in schema public to service_role;

grant select on public.settings to anon, authenticated;
grant update (brand) on public.settings to authenticated;
grant select on public.profiles to authenticated;
grant update (notify_email) on public.profiles to authenticated;   -- role/username/név: csak az Edge Function
grant select, insert, update, delete on public.projects, public.points to authenticated;
grant select, insert, delete on public.files to authenticated;
grant select on public.mail_log to authenticated;                   -- RLS: csak admin
grant select on public.messages to authenticated;                   -- írás: csak post_message()

create policy settings_read  on public.settings for select to anon, authenticated using (true);
create policy settings_admin on public.settings for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy profiles_read on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());
create policy profiles_self on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy projects_read  on public.projects for select to authenticated
  using (client_id = auth.uid() or public.is_admin());
create policy projects_admin on public.projects for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy points_read  on public.points for select to authenticated
  using (public.is_admin() or public.owns_project(project_id));
create policy points_admin on public.points for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy files_read   on public.files for select to authenticated
  using (public.is_admin() or public.owns_point(point_id));
create policy files_insert on public.files for insert to authenticated
  with check (uploaded_by = auth.uid() and public.can_upload(point_id, path));
create policy files_delete on public.files for delete to authenticated
  using (public.is_admin() or (uploaded_by = auth.uid() and public.can_upload(point_id, path)));

create policy mail_log_admin on public.mail_log for select to authenticated using (public.is_admin());

create policy messages_read on public.messages for select to authenticated
  using (public.is_admin() or public.owns_point(point_id));

revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated, service_role;

-- ───────────────────────── Storage ─────────────────────────
-- Privát bucket; a kulcs első mappája a projekt, a második a pont azonosítója.

insert into storage.buckets (id, name, public, file_size_limit)
  values ('docs', 'docs', false, 52428800)
  on conflict (id) do nothing;

create policy docs_read on storage.objects for select to authenticated
  using (bucket_id = 'docs' and (public.is_admin()
         or public.owns_project(public.try_uuid((storage.foldername(name))[1]))));
create policy docs_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'docs'
         and public.can_upload(public.try_uuid((storage.foldername(name))[2]), name));
create policy docs_delete on storage.objects for delete to authenticated
  using (bucket_id = 'docs' and (public.is_admin()
         or (owner_id = auth.uid()::text
             and public.can_upload(public.try_uuid((storage.foldername(name))[2]), name))));

-- ───────────────────────── Értesítések kiküldése (pg_cron → Edge Function) ─────────────────────────

create function private.flush_notifications() returns void
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
      body := jsonb_build_object('action', 'notify', 'project_id', r.id, 'side', r.side));
  end loop;
  for r in
    update public.projects set admin_notify_at = null
     where admin_notify_at <= now() returning id, 'admin' as side
  loop
    perform net.http_post(url := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-notify-secret', v_secret),
      body := jsonb_build_object('action', 'notify', 'project_id', r.id, 'side', r.side));
  end loop;
end $$;

-- Napi ön-ping a saját REST API-ra, hogy az ingyenes projekt ne álljon le 7 nap tétlenség után.
create function private.keepalive() returns void
language plpgsql security definer set search_path = '' as $$
declare v_url text := (select value from private.config where key = 'keepalive_url');
begin
  if v_url is not null then perform net.http_get(url := v_url); end if;
end $$;

select cron.schedule('portal-notify', '* * * * *', 'select private.flush_notifications()');
select cron.schedule('portal-keepalive', '17 5 * * *', 'select private.keepalive()');
