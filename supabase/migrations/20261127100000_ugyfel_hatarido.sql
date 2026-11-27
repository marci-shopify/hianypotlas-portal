-- Ügyfél leadási határideje: eddig adjon le mindent (a projekt `deadline` a pályázat / hiánypótlás határideje).
-- Csak új, üres oszlop: a meglévő sorokat és jogokat nem érinti (projects: táblaszintű grant, írni csak admin tud – RLS).
alter table public.projects add column if not exists client_deadline date;
