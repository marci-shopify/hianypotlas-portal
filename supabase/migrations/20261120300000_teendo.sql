-- 2026-11-20: pontonkénti állandó utasítás az ügyfélnek („Teendő”), az üzenetektől külön. Csak admin írja
-- (points_admin policy), az ügyfél olvassa (points_read). A tábla-szintű grant már megvan.
alter table public.points add column if not exists instruction text check (instruction is null or length(instruction) <= 5000);
