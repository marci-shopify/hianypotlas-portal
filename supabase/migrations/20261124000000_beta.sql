-- 2026-11-24: BÉTA – pályázati pontozó (felhívás-kivonat + vállalkozás-értékelés AI-ügynökkel).
-- Csak ÚJ táblák és egy új oszlop; a meglévő (éles) táblák, policy-k és függvények változatlanok.
-- Minden csak adminnak látszik. Az AI-ügynök a `beta` Edge Functionön át, soronkénti kóddal (agent_token) ér el
-- egyetlen sort; a táblákhoz közvetlenül nem fér hozzá. Leírás: AGENTS.md 13. pont.

-- ── a béta kapcsoló: az admin a Beállításokban állítja ──
alter table public.settings add column if not exists beta boolean not null default false;
grant update (beta) on public.settings to authenticated;   -- az RLS (settings_admin) szerint csak admin

-- ── felhívás: a feltöltött PDF-ek szövege oldalanként + az AI kivonata ──
create table public.beta_calls (
  id         uuid primary key default gen_random_uuid(),
  title      text not null check (length(title) between 1 and 300),
  docs       jsonb not null default '[]',   -- [{ name, pages: [oldalszöveg, …] }]
  catalog    jsonb,                         -- az ügynök legutóbb beküldött kivonata
  review     jsonb,                         -- a szerver ellenőrzése a kivonatról (idézetek, lefedettség, hibák)
  notes      jsonb not null default '{}',   -- a tanácsadó megjegyzései az ügynöknek: { "_": általános, "<tétel id>": … }
  agent_token   text unique,
  agent_expires timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── értékelés: egy vállalkozás egy felhívásra ──
create table public.beta_evals (
  id         uuid primary key default gen_random_uuid(),
  call_id    uuid not null references public.beta_calls (id) on delete cascade,
  company    text not null check (length(company) between 1 and 300),
  tax_no     text,
  facts      text,                          -- amit a tanácsadó a vállalkozásról és a tervezett projektről megadott
  result     jsonb,                         -- az ügynök értékelése
  review     jsonb,                         -- a szerver ellenőrzése az értékelésről
  manual     jsonb not null default '{}',   -- a tanácsadó döntései és válaszai: { feltetelek: {id: {allapot, valasz}}, pontok: {id: {szint, valasz}} }
  agent_token   text unique,
  agent_expires timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.beta_evals (call_id);

alter table public.beta_calls enable row level security;
alter table public.beta_evals enable row level security;
revoke all on public.beta_calls, public.beta_evals from anon, authenticated;   -- az alapértelmezett jogok ellen (TRUNCATE stb.)
grant all on public.beta_calls, public.beta_evals to service_role;
grant select, insert, update, delete on public.beta_calls, public.beta_evals to authenticated;

create policy beta_calls_admin on public.beta_calls for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy beta_evals_admin on public.beta_evals for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
