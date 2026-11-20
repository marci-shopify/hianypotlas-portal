# Hiánypótlás portál – tudnivalók az agentnek

Ez a fájl mindent tartalmaz, ami a rendszer megértéséhez, módosításához és üzemeltetéséhez kell.
Olvasd végig, mielőtt bármihez hozzányúlsz. Ha valamit kimérsz vagy megváltoztatsz, **ugyanabban a
lépésben frissítsd ezt a fájlt** – az elavult leírás rosszabb, mint a hiányzó.

## 1. Mi ez

Egy pályázatíró vállalkozás ügyfélportálja. A pályázatíró (**admin**) felveszi az ügyfeleit, és
projektenként megadja a hiánypótlási felszólítás pontjait. Az **ügyfél** saját felhasználónévvel és
jelszóval belép, pontonként feltölti a dokumentumokat, megjegyzést ír, és látja az egyes pontok
állapotát. Az admin átnézi, elfogad vagy javítást kér; az ügyfél erről e-mailt kap.

| | |
|---|---|
| Élő oldal | https://marci-shopify.github.io/hianypotlas-portal/ |
| Kód | https://github.com/marci-shopify/hianypotlas-portal (nyilvános repó, `main` ág) |
| Backend | Supabase projekt `ubuslaqntdnqscsaisqr` (régió: eu-west-1, ingyenes csomag) |
| Irányítópult | https://supabase.com/dashboard/project/ubuslaqntdnqscsaisqr |

A felület nyelve magyar, az ügyfeleket magázza. Új szöveget is így írj.

## 2. Felépítés

```
Böngésző ── docs/ (statikus fájlok, GitHub Pages)
   │  supabase-js, NYILVÁNOS kulccsal
   ├─► Supabase Auth      belépés (felhasználónév → <név>@portal.local szintetikus e-mail)
   ├─► Postgres (REST)    táblák közvetlenül; MINDEN jogosultság RLS + oszlopszintű grant
   ├─► Storage            privát `docs` bucket, policy-k az útvonal alapján
   └─► Edge Function `portal`
          ├─ ügyfél-fiók létrehozás / módosítás / törlés  (service role kell hozzá)
          ├─ MINDEN törlés, ami fájlt érint (fájl, pont, projekt, ügyfél): sor + Storage együtt
          └─ értesítő e-mail küldése SMTP-n                (csak a pg_cron hívhatja)

Postgres: pg_cron percenként ──► private.flush_notifications() ──pg_net──► Edge Function `notify`
```

Nincs build-lépés, nincs keretrendszer, nincs saját szerver. Ez szándékos: a rendszer kicsi, és így
egy fájl szerkesztése + `git push` a teljes frontend-telepítés.

**A legfontosabb elv:** a böngészőben futó kód nem megbízható. A `docs/app.js` csak kényelmi réteg;
hogy ki mit láthat és írhat, azt kizárólag az adatbázis dönti el (`supabase/migrations/`). Ha új
funkciót építesz, először a szabályt írd meg SQL-ben és tedd tesztbe, csak utána a felületet.

## 3. Fájltérkép

| Fájl | Mi van benne |
|---|---|
| `docs/index.html`, `style.css` | Váz és kinézet. Csak rendszerbetűk, külső kérés nincs. |
| `docs/app.js` | A teljes felület (belépés, projektlista, projekt nézet, ügyfelek, beállítások). |
| `docs/config.js` | Supabase URL + nyilvános kulcs + `authDomain`. A `scripts/setup.mjs` tölti ki. |
| `docs/vendor/` | `supabase.js` és `jszip.min.js` bemásolva az npm-csomagból (nincs CDN-függés). |
| `supabase/migrations/*.sql` | A teljes séma: táblák, RLS, triggerek, RPC-k, Storage policy-k, cron. |
| `supabase/functions/portal/index.ts` | Az egyetlen Edge Function (Deno). |
| `supabase/config.toml` | Csak annyi, hogy a function `verify_jwt = false` (saját maga ellenőriz). |
| `scripts/sql.mjs` | SQL futtatása az éles adatbázison a Management API-n át. |
| `scripts/setup.mjs` | Secretek, értesítés-bekötés, auth-beállítás, `config.js`; admin fiók. |
| `test/rls.test.mjs` | Biztonsági önteszt beágyazott Postgresen (PGlite). Hálózat nem kell hozzá. |
| `test/live.test.mjs` | Végponttól végpontig teszt az éles backenden, eldobható tesztfiókokkal. |
| `.github/workflows/keepalive.yml` | Napi ping, hogy az ingyenes Supabase projekt ne álljon le. |
| `.env` | Helyi titkok. **Nincs a repóban**, lásd 7. pont. |

A `docs/` mappa neve megtévesztő: ez a weboldal gyökere (a GitHub Pages csak a `/` vagy a `/docs`
mappát tudja ágról kiszolgálni), nem dokumentáció.

## 4. Adatmodell

```
profiles  (id = auth.users.id, role: admin|client, username, name, notify_email)
   └─ projects  (client_id, title, reference, deadline, archived, *_notify_at, *_notified_at)
         └─ points  (position, title, description, status, client_unread, admin_unread)
               ├─ files     (path, name, size, uploaded_by, from_admin)
               └─ messages  (author_id, from_admin, body)
settings  (egyetlen sor: brand = a cég neve a fejlécben és az e-mail feladójaként)
mail_log  (minden kiküldött vagy elbukott értesítés; csak admin látja)
private.config  (notify_url, notify_secret, keepalive_url – nem érhető el az API-n)
```

**Pont állapota** (`points.status`) – a felületen megjelenő név zárójelben:

| Érték | Mikor áll be |
|---|---|
| `hianyzik` (Hiányzik) | Alapállapot. Akkor is, ha az ügyfél minden fájlját törölte. |
| `feltoltve` (Ellenőrzésre vár) | Automatikusan, amikor az ügyfél fájlt tölt fel (trigger). |
| `javitando` (Javítandó) | Az admin állítja, kötelező szöveges indoklással. |
| `elfogadva` (Rendben) | Az admin állítja. Innentől az ügyfél nem tölthet fel és nem törölhet. |

**Ki mit tehet** (ezt kényszeríti ki az RLS; a `test/rls.test.mjs` minden sorát ellenőrzi):

| | Ügyfél | Admin |
|---|---|---|
| Projektek, pontok | csak a sajátját **látja** | mindent lát, létrehoz, szerkeszt, töröl |
| Státusz | nem állíthatja | `post_message(pont, szöveg, státusz)` |
| Fájl | saját pontjához feltölt (pontonként max. 50 objektum); a saját fájlját törli, amíg a pont nincs elfogadva | bármit |
| Megjegyzés | `post_message(pont, szöveg)` a saját pontjához | bárhova |
| Profil | csak a saját `notify_email` mezőjét írhatja | ügyfeleket csak az Edge Functionön át |
| Ügyfél-fiókok | – | Edge Function: `create_client`, `update_client`, `delete_client` |

Üzenetet **csak** a `post_message` RPC tud beszúrni, fájlnál az `uploaded_by` és `from_admin` mezőt
trigger tölti ki – a kliens sosem mondhatja meg, kinek a nevében ír.

**Storage-útvonal:** `{project_id}/{point_id}/{véletlen-uuid}-{ascii_fájlnév}`. A policy-k az első két
mappából döntenek (`can_upload`, `owns_project`), ezért ezt a formát nem szabad megváltoztatni a
policy-k nélkül. Az eredeti (ékezetes) fájlnevet a `files.name` őrzi. Letöltés mindig rövid életű
aláírt URL-lel történik.

**Fájlok életciklusa – három szabály, amit a séma kikényszerít:**

1. *Fájlsor csak valódi feltöltésre.* A `files` sor beszúrásakor trigger ellenőrzi, hogy a `path`-on
   létezik Storage-objektum; a méretet onnan veszi, a feltöltőt a munkamenetből. A kliens csak a
   `point_id, path, name, size` mezőket küldheti.
2. *A Storage-ban a böngésző csak beszúrni és olvasni tud.* Nincs `update` és nincs `delete` policy,
   ezért feltöltött fájlt nem lehet felülírni, átnevezni vagy csendben kicserélni.
3. *Törölni csak az Edge Function töröl* (`delete_file`, `delete_point`, `delete_project`,
   `delete_client`), mindig ebben a sorrendben: előbb az adatbázis-sor (onnantól az RLS nem enged új
   feltöltést abba a mappába), utána a mappa ürítése **előtag alapján** (`storage_paths`), így a
   félbeszakadt feltöltések árva objektumai is eltűnnek. A `delete_file` a hívó saját JWT-jével törli a
   sort, tehát ugyanaz az RLS-szabály dönt, mint bárhol máshol.

**Munkamenet:** a belépési token `sessionStorage`-ben él (fülhöz kötött). Oldalfrissítést túlél, új
fülön vagy a fül bezárása után újra be kell lépni. Ennek oka a 10. pont első tétele; ne írd át
`localStorage`-re. Az admin által adott új jelszó a felhasználó minden korábbi munkamenetét megszünteti
(`revoke_sessions`); a már kiadott hozzáférési token legfeljebb 1 óráig még érvényes.

## 5. Értesítések

1. Bármi történik (új pont, ügyfél-feltöltés, megjegyzés, admin-válasz), a `private.queue_notify`
   beállítja a projekten a `client_notify_at` vagy `admin_notify_at` mezőt **most + 5 percre**, és a
   ponton az `*_unread` jelzőt. Minden újabb esemény kitolja az időpontot.
2. A pg_cron percenként futtatja a `private.flush_notifications()`-t, ami az esedékes projektekre
   meghívja az Edge Function `notify` akcióját (titkos `x-notify-secret` fejléccel).
3. A function **egy összefoglaló levelet** ír az olvasatlan pontokról. Ha a címzett közben megnyitotta
   a projektet (`mark_seen` törli az `*_unread` jelzőket), nem megy levél.
4. Minden kiküldés és minden hiba bekerül a `mail_log` táblába; az admin a Beállításokban látja, a
   projektlistán pedig piros sáv figyelmeztet, ha a legutóbbi küldés elbukott.

Így egy átnézés (pl. 6 pont elfogadva, 2 javítandó) egyetlen levél, nem nyolc. Az ügyfél a
`profiles.notify_email` címre kap levelet (első belépéskor kötelező megadnia), az admin oldali
összefoglaló minden admin `notify_email` címére megy.

**SMTP beállítása** – a function ezeket a secreteket olvassa: `SMTP_HOST`, `SMTP_PORT` (alap: 465),
`SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`. Írd be őket a `.env`-be, majd `node scripts/setup.mjs`.
Bármilyen SMTP-fiók jó (a vállalkozás saját postafiókja, Gmail alkalmazásjelszóval, Resend, Brevo).
A Supabase Edge Function a 25-ös és 587-es portot tiltja: **465-öt** (vagy a szolgáltató alternatív
portját, pl. 2465) kell használni. Ellenőrzés: Beállítások → „Próbalevél küldése magamnak”.

**Jelenlegi állapot (kimérve 2026-11-20):** a küldés a Resend SMTP-jén megy (`smtp.resend.com:465`,
feladó `onboarding@resend.dev`), és végponttól végpontig működik – a `test:live` valódi levelet küld,
a Resend naplója szerint kézbesítve. **De:** amíg a Resend-fiókhoz nincs saját, hitelesített domain,
a Resend **csak a fiók tulajdonosának címére** kézbesít; más címzettnél a küldés hibával tér vissza
(ez megjelenik a `mail_log`-ban és a piros sávban). Valódi ügyfeleknek tehát akkor megy levél, ha
(a) a Resendben felvesznek egy domaint (Domains → Add domain, DNS-rekordok a domain szolgáltatójánál),
és a `MAIL_FROM` erre a domainre mutat (pl. `ertesites@sajatdomain.hu`), vagy (b) a `.env` SMTP-adatait
a vállalkozás saját postafiókjára cserélik. Utána `node scripts/setup.mjs` és egy próbalevél.

**Hibakezelés:** ha a küldés elbukik, a function 15 perc múlva újrapróbálja, de projektenként legfeljebb
3 kudarcig 2 órán belül (tartós hibánál – rossz cím, rossz jelszó – ne pörögjön). Ha nincs címzett
(az ügyfél még nem adott meg e-mailt), nem történik küldés és naplóbejegyzés sem; az admin ezt a projekt
oldalán látja figyelmeztetésként, a saját hiányzó címére pedig a projektlista tetején kap sávot.

## 6. Parancsok

```bash
npm install                 # egyszer
npm test                    # biztonsági önteszt (helyi, ~3 mp) – MINDEN séma-változtatás után
npm run test:live           # éles végponttól végpontig teszt (~1,5 perc, maga után takarít)
npm run serve               # a docs/ kiszolgálása http://localhost:5173 címen

node scripts/sql.mjs supabase/migrations/<fájl>.sql      # migráció futtatása élesben
node scripts/sql.mjs "select count(*) from projects"     # egy lekérdezés
node scripts/setup.mjs                                    # secretek + bekötés + config.js (idempotens)
node scripts/setup.mjs admin <felhasználónév> "<Név>"     # admin létrehozása / elfelejtett jelszó cseréje

# Edge Function telepítése (Docker nem kell):
SUPABASE_ACCESS_TOKEN=… npx supabase functions deploy portal --remote=ubuslaqntdnqscsaisqr --use-api --yes
# Típusellenőrzés telepítés előtt (a --no-config kell, különben a gyökér package.json megzavarja):
cd supabase/functions/portal && deno check --no-config index.ts
```

**Frontend telepítése:** `git push` a `main` ágra; a GitHub Pages 1–2 perc alatt frissül.

## 7. Titkok és hozzáférés

A `.env` fájl (a repó gyökerében, gitignore-olva) tartalma:

```
SUPABASE_ACCESS_TOKEN=sbp_…     # Supabase irányítópult → Account → Access Tokens
SUPABASE_PROJECT_REF=ubuslaqntdnqscsaisqr
PORTAL_URL=https://marci-shopify.github.io/hianypotlas-portal
NOTIFY_SECRET=…                 # a setup.mjs generálja az első futáskor
SMTP_HOST= SMTP_PORT= SMTP_USER= SMTP_PASS= MAIL_FROM=     # lásd 5. pont
TEST_EMAIL=                     # nem kötelező: ide megy a test:live valódi próbalevele
```

- A hozzáférési token **lejár** (a 2026-11-19-én készült 7 napig él). Ha a scriptek 401-et adnak,
  a tulajdonos generáljon újat az irányítópulton (Project scope → ez az egy projekt), és írja a `.env`-be.
- A `service_role` / `sb_secret_…` kulcsot sehol nem tároljuk: a scriptek a Management API-ról kérik
  le futásidőben. **Soha ne írd fájlba, főleg ne a `docs/` alá.**
- A `docs/config.js`-ben lévő `sb_publishable_…` kulcs nyilvános, az rendben van.
- Az admin belépési adatai: `.admin-login.txt` (helyi, gitignore-olva) – a kezdeti jelszót az admin
  az első belépés után cserélje le a Beállításokban.

## 8. Gyakori feladatok

**Séma-változtatás.** Új fájl a `supabase/migrations/` alá (időbélyeges név, csak a különbség) →
egészítsd ki a `test/rls.test.mjs`-t az új szabállyal → `npm test` → `node scripts/sql.mjs <fájl>` →
`npm run test:live`. Új tábla **csak akkor érhető el** a böngészőből, ha expliciten adsz rá `grant`-ot
és RLS policy-t: ebben a projektben az automatikus API-hozzáférés ki van kapcsolva.

**Új állapot vagy felirat.** A státuszok három helyen élnek, együtt kell változniuk: a `points.status`
check constraint (SQL), a `STATUS` objektum a `docs/app.js` és a `functions/portal/index.ts` elején,
valamint a színek a `docs/style.css`-ben (`--hianyzik` stb.) és az e-mail `color` táblájában.

**Saját domain.** (1) A domain DNS-ében `CNAME` rekord a `marci-shopify.github.io` címre (aldomainnél),
(2) a repó Settings → Pages → Custom domain mezőjébe a domain, HTTPS bekapcsolva, (3) a `.env`-ben
`PORTAL_URL` átírása és `node scripts/setup.mjs` (ettől lesz jó a link az e-mailekben). Ha ugyanarról
a domainről megy az e-mail is, a levélküldő szolgáltató SPF/DKIM rekordjait is fel kell venni.

**Új admin vagy elfelejtett admin-jelszó.** `node scripts/setup.mjs admin <felhasználónév> "<Név>"`.

**Ügyfél elfelejtette a jelszavát.** Az admin az Ügyfelek oldalon „Új jelszó”-t ad; nincs önkiszolgáló
jelszó-visszaállítás (szándékosan: a fiókokhoz nem tartozik ellenőrzött e-mail-cím).

**Átköltöztetés másik Supabase-fiókba** (pl. a vállalkozás saját nevére). Vagy a projekt átadása az
irányítópulton (Project Settings → Transfer project), vagy új projekt: `.env` új tokennel és ref-fel →
`node scripts/sql.mjs supabase/migrations/20261119000000_init.sql` → function telepítése →
`node scripts/setup.mjs` → `node scripts/setup.mjs admin …` → `git push`. Az adatok (sorok és fájlok)
az új projektbe nem kerülnek át maguktól.

## 9. Kimért buktatók (ne kövesd el újra)

| Helyzet | Mi történik | Mit csinálj |
|---|---|---|
| `supabase functions deploy` agentként | A CLI 3.x megtagadja: „Confirmation required… ask the user” | Kérdezd meg a tulajdonost, utána `--yes`. Soha ne tedd reflexből. |
| `--project-ref` kapcsoló | Elavult a CLI 3.x-ben | `--remote=<ref>` |
| Function telepítés Docker nélkül | Alapból Dockert keres | `--use-api` |
| `deno check index.ts` a repóból | „Could not find a matching package… nodemailer” | `--no-config` |
| `grep -oP` Windows Git Bash-ben | „supports only unibyte and UTF-8 locales” | `sed -n 's/…/\1/p'` (a GitHub Actions Linuxán a `-P` működik) |
| RPC „megtagadás” tesztelése | Sikeres `rpc()` is `data: null`-t ad | Megtagadásnak csak a hiba vagy az üres tömb számít |
| Új tábla az API-n | 42501 „permission denied” RLS policy mellett is | Kell explicit `grant … to authenticated` |
| `confirm()` / `alert()` a felületen | Automatizált böngészőt megakasztja | A `confirmBox()` / `modal()` segédet használd |
| Új SQL-függvény a `public` sémában | Alapból **bárki** (névtelen is) hívhatja `/rpc`-n | A migráció végén: `revoke execute … from public, anon` + célzott `grant` |
| Hibaüzenet nyitott `<dialog>` mellett | A modál a „top layer”-ben van, a `body`-ba tett toastot eltakarja | A `toast()` a nyitott dialogba szúr be – ezt a logikát tartsd meg |
| Toast láthatóságának tesztelése | `elementFromPoint` átugorja (`pointer-events: none`) | Azt ellenőrizd, hogy a nyitott dialog gyereke és a képernyőn van |
| `deno check` hibával tér vissza | A `functions deploy` ettől még feltölti a kódot | A típusellenőrzést külön futtasd és nézd meg, mielőtt telepítesz |
| Storage `remove()` jogosultság nélkül | 200-at ad üres listával, hibát nem | Törlés után ellenőrizd, hogy az objektum tényleg eltűnt-e |
| Resend API-kulcs listázásra | 401 „restricted to only send emails” (a kulcs csak küldésre jó) | A kézbesítést a Resend felületén (Emails) nézd meg |

## 10. Ismert korlátok

- **Közös webes eredet – ÉLES HASZNÁLAT ELŐTT MEGOLDANDÓ.** A portál a `marci-shopify.github.io`
  eredeten fut, amin ugyanennek a GitHub-fióknak más Pages-oldalai is osztoznak (2026-11-20-án három
  ilyen volt). A böngésző tárolói eredetenként közösek, tehát ha azok bármelyikén
  hibás vagy rosszindulatú script fut, az megnyithatja a portált és a belépett felhasználó nevében
  dolgozhat. Enyhítés már van (a token fülhöz kötött `sessionStorage`-ben él, lásd 4. pont), de a
  tényleges megoldás a **saját domain** (8. pont, „Saját domain”) – attól a portál külön eredetet kap.
- **E-mail csak a Resend-fiók tulajdonosának megy**, amíg nincs hitelesített domain (5. pont).
- **Ingyenes Supabase csomag:** fájlonként 50 MB, összesen 1 GB tárhely, 500 MB adatbázis. Ha betelik,
  a feltöltés hibát ad; megoldás az archivált projektek törlése vagy a fizetős csomag.
- **Leállás tétlenség miatt:** az ingyenes projekt 7 nap API-forgalom nélkül szünetel. Két védvonal van:
  a `keepalive.yml` napi kérése és az adatbázis `portal-keepalive` cron-feladata. **Nem kimért**, hogy
  bármelyik önmagában elég-e (ehhez 7+ napot kellene várni); a GitHub ráadásul 60 nap repó-tétlenség
  után kikapcsolja az ütemezett workflow-kat nyilvános repóban. Ha a Supabase „project will be paused”
  levelet küld, az irányítópulton egy kattintással visszaállítható, és ezt a szakaszt frissíteni kell.
- **Nincs élő frissítés:** a másik fél változása oldalfrissítés után látszik.
- **Egy ügyfél = egy belépés.** Ha egy cégnél többen töltenének fel, ugyanazt a fiókot használják.
- **A repó nyilvános** (az ingyenes GitHub Pages feltétele). Titok, ügyféladat, valódi név vagy
  e-mail-cím soha ne kerüljön commitba.

## 11. Független átnézés (2026-11-20) – mi lett vele

Egy friss kontextusú átnéző végigpróbálta a rendszert. Ügyfelek közötti adatszivárgást, jogosultság-
emelést vagy szerző-hamisítást nem talált. Amit talált, és ami lett vele:

| Megállapítás | Állapot |
|---|---|
| Közös webes eredet más Pages-oldalakkal | Enyhítve (`sessionStorage`); végleges megoldás: saját domain – **nyitott** |
| Elveszthető / csendben kimaradó értesítés | Javítva: korlátos újrapróbálás, admin-sáv hiányzó címnél, őszinte visszajelzés |
| Törlés után bennmaradó fájlok | Javítva: szerveroldali törlés előtag alapján; élő teszt ellenőrzi |
| Feltöltés nélküli fájlsor, hamis méret/dátum, csendes tartalomcsere | Javítva (trigger + oszlopszintű grant + nincs Storage update/delete policy) |
| Tárhely kimerítése egy ügyfél által | Enyhítve: pontonként 50 objektum. Egy rosszhiszemű ügyfél így is megtöltheti az 1 GB-ot – **elfogadott kockázat** |
| Gyenge tesztek (bármilyen hiba „megtagadásnak” számított) | Javítva: csak jogosultsági hiba vagy üres találat számít; új esetek |
| Előnézet a feltöltő által megadott tartalomtípussal | Javítva: a típust a kiterjesztésből mi adjuk, blob-URL, `opener = null` |
| Jelszócsere után élő régi munkamenet | Javítva és élőben kimérve (`revoke_sessions`) |
| Hibaüzenet a modál mögött, Esc a jelszó-ablakon, dupla projekt | Javítva |
| A portálon már olvasott üzenet újra megjelenhet a következő összefoglalóban | **Nyitott**, alacsony súlyú |
| Nincs kétlépcsős belépés, a jelszó minimum 8 karakter | **Nyitott**: az admin válasszon hosszú jelszót; a Supabase Auth korlátozza a próbálkozások számát |

## 12. Amit soha

- Ne kapcsold ki az RLS-t, és ne adj `anon`-nak jogot a `settings` tábla olvasásán kívül semmire.
- Ne írj a felületre `innerHTML`-t felhasználói szöveggel; a `h()` segéd szövegként szúr be mindent.
- Ne futtass éles adatbázison `delete`/`drop`/`truncate` parancsot a tulajdonos kifejezett kérése nélkül;
  az ügyfelek dokumentumairól nincs mentés az ingyenes csomagban.
- Ne küldj valódi ügyfélnek tesztlevelet: a tesztek „teszt-” előtagú fiókokkal és a `TEST_EMAIL` címmel
  dolgoznak, ezt tartsd meg.
