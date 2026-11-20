-- Átnevezés: a portál neve „Pályázatsegítő”. (A Beállításokban az admin bármikor átírhatja.)
alter table public.settings alter column brand set default 'Pályázatsegítő';
update public.settings set brand = 'Pályázatsegítő' where brand = 'Hiánypótlás portál';
