-- 2026-11-20: eredeti hiánypótlási felszólítás a projekten, két értesítési cím, ügyfél-értesítés csak kézzel.

-- ── 1) Az eredeti felszólítás (PDF) a projekt mappájában: {projekt}/forras/{uuid}-{név} ──
alter table public.projects add column if not exists source_path text, add column if not exists source_name text;

-- Csak admin tölthet a forras/ mappába, és csak létező projekthez. (A pont-mappák szabálya ezt nem engedné,
-- mert a 2. mappanév ott pont-azonosító.) Olvasni a meglévő docs_read engedi: admin + a projekt ügyfele.
create policy docs_insert_source on storage.objects for insert to authenticated
  with check (bucket_id = 'docs' and public.is_admin()
         and (storage.foldername(name))[2] = 'forras'
         and exists (select 1 from public.projects p where p.id = public.try_uuid((storage.foldername(name))[1])));

-- ── 2) Második értesítési e-mail-cím (pl. az ügyfél cégénél két kapcsolattartó) ──
alter table public.profiles add column if not exists notify_email2 text
  check (notify_email2 is null or notify_email2 ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$');
grant update (notify_email2) on public.profiles to authenticated;

-- ── 3) Az ügyfél CSAK akkor kap levelet, ha az admin a projekt oldalán kifejezetten elküldi ──
-- (Edge Function `notify_client`). Az admin felé menő automatikus összefoglaló marad.
create or replace function private.queue_notify(p_project uuid, p_to_client boolean) returns void
language sql security definer set search_path = '' as $$
  update public.projects set admin_notify_at = now() + interval '5 minutes'
   where id = p_project and not p_to_client
$$;
update public.projects set client_notify_at = null where client_notify_at is not null;
