-- 2026-11-27: az ügyfél újra AUTOMATIKUSAN kap levelet – a projekt utolsó admin-módosítása után 5 perccel,
-- egy összefoglalóban (üzenet, státusz, új pont, admin-fájl, Teendő). A 2026-11-20-i „csak kézzel” szabályt váltja.

-- ── 1) queue_notify újra mindkét irányba ütemez (ugyanaz, mint az init-ben) ──
create or replace function private.queue_notify(p_project uuid, p_to_client boolean) returns void
language sql security definer set search_path = '' as $$
  update public.projects set
    client_notify_at = case when p_to_client then now() + interval '5 minutes' else client_notify_at end,
    admin_notify_at  = case when p_to_client then admin_notify_at else now() + interval '5 minutes' end
  where id = p_project
$$;

-- ── 2) A „Teendő” mentése is változás: a pont olvasatlan lesz az ügyfélnek, és megy róla levél ──
-- (Pontot csak admin írhat – points_admin policy –, ezért itt nem kell szerepet vizsgálni. A cím/leírás
-- javítása szándékosan NEM küld levelet: egy elírás kijavítása ne zavarja az ügyfelet.)
create function private.points_instruction_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.client_unread := true;
  new.updated_at := now();
  perform private.queue_notify(new.project_id, true);
  return new;
end $$;
create trigger points_instruction_changed before update of instruction on public.points
  for each row when (new.instruction is not null and new.instruction is distinct from old.instruction)
  execute function private.points_instruction_changed();
