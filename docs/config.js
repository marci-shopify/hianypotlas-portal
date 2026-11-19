// A portál egyetlen konfigurációs fájlja. Mindkét érték NYILVÁNOS (a böngészőbe kerül);
// a védelem az adatbázis RLS-szabályaiban van, nem ezek titkosságában.
// A service_role / secret kulcs SOHA nem kerülhet ebbe a fájlba vagy a repóba.
window.PORTAL_CONFIG = {
  supabaseUrl: "https://PROJECT_REF.supabase.co",
  supabaseKey: "PUBLISHABLE_OR_ANON_KEY",
  // Felhasználónév → szintetikus e-mail a Supabase Auth-hoz. Ugyanez áll a
  // supabase/functions/portal/index.ts AUTH_DOMAIN konstansában – együtt kell változniuk.
  authDomain: "portal.local",
};
