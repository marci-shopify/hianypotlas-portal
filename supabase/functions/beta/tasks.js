// BÉTA pontozó – az AI-ügynöknek kiadott feladat szövege. A portálon kimásolható rövid prompt csak ide mutat;
// a teljes útmutató innen jön, így javítható anélkül, hogy a tanácsadónak bármit újra be kellene másolnia.
// Ami itt szabály, azt a check.js ki is kényszeríti – a kettőnek együtt kell változnia.

const docsText = (docs) => docs.map((d, di) =>
  d.pages.map((p, pi) => `\n\n===== ${di + 1}. dokumentum (${d.name}), ${pi + 1}. oldal =====\n${p}`).join("")).join("");

const SUBMIT = (url) => `## Beküldés

Az eredményt egyetlen JSON fájlként (UTF-8) küldd be:

    curl -s -X POST "${url}" -H "Content-Type: application/json" --data-binary @eredmeny.json

(Windows PowerShellben \`curl.exe\`.) A válasz JSON: \`"kesz": true\` esetén végeztél. Különben a \`hibak\` listát
javítsd ki mind (amíg van hiba, a beküldés nincs elmentve), és küldd be újra a TELJES JSON-t (nem csak a változást). Annyiszor ismételd, ahányszor kell.`;

export function callTask(call, url) {
  const prev = call.catalog ? `## Van már korábbi kivonat – ezt javítod

Az alábbi a legutóbb beküldött kivonat. Ebből dolgozz tovább: a meglévő "id"-kat tartsd meg, és a pontozási szempontok "szintek" listájának sorrendjét se változtasd (a kész értékelések az azonosítóra és a szint sorszámára
hivatkoznak; új szintet csak a lista végére vegyél fel), a hibákat javítsd, a hiányokat pótold.

\`\`\`json
${JSON.stringify(call.catalog, null, 1)}
\`\`\`
` : "";
  const notes = Object.entries(call.notes || {}).filter(([, v]) => String(v).trim());
  const notesTxt = notes.length ? `## A tanácsadó megjegyzései – ezek kötelezőek

A tanácsadó átnézte a korábbi kivonatot, és ezt kéri. Mindegyiket hajtsd végre:

${notes.map(([k, v]) => `- ${k === "_" ? "Általános" : `A(z) ${k} tételhez`}: ${String(v).trim()}`).join("\n")}
` : "";

  return `# Feladat: pályázati felhívás teljes kivonata

Egy pályázatíró tanácsadónak dolgozol. Lent megkapod egy pályázati felhívás (és mellékletei) teljes szövegét oldalanként.
A feladatod egy géppel ellenőrzött kivonat: minden jogosultsági feltétel, kizáró ok, kötelező vállalás, költségszabály
és a teljes pontozótábla. Ebből a kivonatból fogják eldönteni vállalkozásokról, hogy jogosultak-e, és hány pontot kapnak.

**Ami a kivonatból kimarad, azt később senki nem ellenőrzi. Egy kimaradt vagy elbagatellizált kizáró feltétel = elutasított
pályázat.** Ezért itt a teljesség a cél, nem a rövidség.

## Amit legutóbb egy AI elrontott (ne ismételd meg)

Egy felhívás ezt írta: „A támogatást igénylő vállalja, hogy … legalább 1 fő női munkavállalót foglalkoztat minimum heti
20 órás munkaidőben”, a pontozótáblában pedig az esélyegyenlőségi szempont egyik sora pont helyett azt adta:
„Jogosulatlan”. Az AI ezt egy ellenőrzőlista aljára tette sima „vállalásként”, a pontozóban pedig 0/5 pontos sorként
kezelte. Pedig enélkül a kérelem jogosulatlan. A helyes kivonatban ez (1) külön feltétel "kizaro": true jelöléssel, és
(2) a pontozási szempontnál külön szint "jogosulatlan": true jelöléssel.

## Hogyan dolgozz

1. Olvasd végig a teljes szöveget az első oldaltól az utolsóig, sorban. Ne kulcsszavakra keress olvasás helyett.
2. A lábjegyzeteket is olvasd: ott vannak a pontosítások és a kivételek (számok, határidők, „abban az esetben is
   elfogadható, ha…”). Ezek a tétel leírásába tartoznak.
3. A táblázatok szövege a PDF-ből összekeveredve jön (az oszlopok egymásba csúsznak). Rakd össze értelemszerűen.
4. Semmit ne írj a saját tudásodból a felhívás tartalmaként. Csak az szerepelhet, ami a lenti szövegben benne van.
5. Ne vonj össze több feltételt egy tételbe („pénzügyi feltételek”). Egy feltétel = egy tétel, a saját számaival.
6. Ha a felhívás szakaszonként, cégméretenként vagy régiónként mást ír elő, minden változat kerüljön a leírásba.

## Mit vegyél fel

### "feltetelek" – minden, aminek meg kell felelni

"tipus":
- "jogosultsag": ki nyújthat be kérelmet (cégforma, méret, lezárt üzleti év, létszám, székhely, beadás előtti kötelező
  lépések, értékelési előfeltételek, nem hiánypótoltatható kritériumok).
- "kizaro_ok": ki NEM nyújthat be, mire NEM adható támogatás (minden pont külön tétel).
- "vallalas": amit a támogatást igénylő vállal (foglalkoztatás, mutatók, fenntartás, határidők, indikátorok).
- "koltseg": elszámolhatósági és arány-szabályok (összeghatárok, önerő, költségtípusok korlátai, egyedi értékhatárok).
- "egyeb": minden más kötelező előírás (csatolandó dokumentumok, benyújtás módja, közbeszerzés, nyilvánosság).

"kizaro": true, ha a nem teljesülés a kérelem elutasításához, jogosulatlansághoz vagy a támogatás visszafizetéséhez
vezet. A "jogosultsag" és a "kizaro_ok" típus mindig true. Vállalásnál és költségszabálynál te döntöd el a szöveg
alapján – ha a felhívás bárhol „jogosulatlan”-t, elutasítást vagy visszafizetést köt hozzá, akkor true.

Mezők tételenként:
- "id": rövid, egyedi azonosító (F01, F02 …).
- "cim": a feltétel egy sorban, a lényegi számmal („Legalább 3 fő átlagos statisztikai létszám az utolsó lezárt évben”).
- "leiras": a teljes feltétel közérthetően, MINDEN számmal, határidővel, kivétellel és lábjegyzet-pontosítással.
- "idezet": szó szerinti részlet a szövegből (szabályai lent). Több helyről is lehet: akkor lista.
- "kerdes": egy konkrét kérdés, amit a vállalkozásról vagy a tervezett projektről meg kell tudni ahhoz, hogy ez
  eldönthető legyen („Mennyi volt a 2025-ös éves átlagos statisztikai létszám?”).
- "igazolas": mivel igazolható, illetve miből ellenőrzi a hatóság (ha a szöveg megmondja; különben hagyd el).

### "pontozas" – a tartalmi értékelés teljes táblája

Ha a felhívásban nincs pontozás, "pontozas": null. Különben:
- "max": az összes szerezhető pont, "min": a minimálisan elérendő összpontszám (vagy null).
- "csoportok": a szempontcsoportok, mindegyik "id", "cim", "max", és ha a csoportra külön küszöb van: "min".
- "szempontok": csoportonként az értékelési szempontok: "id", "cim", "max", "idezet", "kerdes", "szintek".
- "szintek": a szempont MINDEN lehetséges kimenete, mindegyik {"ha": "feltétel szövege számokkal", "pont": szám}.
  Egy szempontnál pontosan egy szint teljesül. Ha egy sor pont helyett kizárást ad („Jogosulatlan”, elutasítás):
  {"ha": "…", "jogosulatlan": true} – és ugyanezt vedd fel "feltetelek"-be is "kizaro": true jelöléssel.
- Ha egy szemponton belül több rész külön-külön is megszerezhető és összeadódik (pl. 10 + 10 pont), bontsd külön
  szempontokra (II.3/a, II.3/b), mindegyiknek saját szintekkel.
- A számoknak egyezniük kell: a szintek legnagyobb pontja = a szempont "max"-a; a szempontok összege = a csoport
  "max"-a; a csoportok összege = a "pontozas.max". Ha a felhívás számai maguk nem egyeznek, írd le a
  "pontozas.elteres" mezőben, hogy mi és hol tér el.
- Az Igen/Nem „értékelési előfeltételek” nem pontok: azok a "feltetelek"-be mennek "kizaro": true jelöléssel.

### "tenyek" – a felhívás legfontosabb adatai

Rövid címke–érték párok idézettel. Ami a szövegben megvan, mind kell: a felhívás kódja és címe, benyújtási időszak és
szakaszok, ki pályázhat (egy sorban), igényelhető támogatás alsó és felső határa, támogatási intenzitás / önerő,
támogatási kategória (pl. de minimis), megvalósítás helye (területi korlát), megvalósítási határidő, fenntartási
időszak, előleg, pontküszöb, hiánypótlás lehetősége és határideje.

### "hivatkozott" – dokumentumok, amik nincsenek itt

Ha a szöveg olyan dokumentumra utal, aminek a tartalma feltételt vagy kizáró okot hordoz, de nincs a lenti
dokumentumok között (pl. „ÁÚF – Kizáró okok listája”, „a Felhívás 1. számú melléklete”), vedd fel: "nev", "miert"
(mi van benne, ami kellene), "idezet" (ahol a szöveg hivatkozik rá). A tartalmát NE találd ki. A tanácsadó ebből
látja, mit kell még feltöltenie.

## Az idézet szabályai (géppel ellenőrizzük)

- Az idézetet a lenti szövegből másold, betűre pontosan. A szóközök, sortörések, kötőjelek és írásjelek nem számítanak,
  a betűk és a számok igen.
- Az oldalszámot nem kell megadnod: a szerver az idézet alapján keresi meg.
- A PDF-szövegbe lábjegyzetszámok és oldaltörések ékelődnek. Ilyen helyen szakítsd meg az idézetet […] jellel; a
  darabok legalább 10 betűsek legyenek, és egymás közelében álljanak.
- Az idézet a feltétel LÉNYEGÉT tartalmazza (a kötelezést és a számot), ne a bevezető mondatot.

## Lefedettség (géppel ellenőrizzük)

A szerver kigyűjti a felhívás minden „kötelező hangú” mondatát (pl. legalább, legfeljebb, kizárólag, vállalja, köteles,
nem haladhatja meg, nem nyújtható, jogosulatlan, elutasítjuk). Beküldés után a válasz "lefedetlen" listájában
megkapod azokat, amelyekre egyetlen tételed idézete sem hivatkozik. Mindegyikkel két dolgot tehetsz:
- felveszed (új tétel, vagy egy meglévő tétel "idezet" listájának bővítése, ha ugyanarról szól), vagy
- elveted az "elvetett" objektumban, a mondat "id"-jával és egy rövid, valódi indokkal:
  "elvetett": {"1-12-3": "tartalomjegyzék", "1-40-2": "ugyanaz, mint F07; ott idézve"}.

Kizáró hangú mondatot (jogosulatlan, elutasít, nem nyújtható, nem jogosult) csak "kizaro": true tétel vagy
"jogosulatlan": true szint fedhet le. Az elvetett mondatokat a tanácsadó az indokkal együtt látja, tehát ne vess el
semmit kényelemből: csak azt, ami tényleg nem feltétel (tájékoztatás, fogalommagyarázat, ismétlés, jogszabálylista).

Az első beküldésnél számíts hosszú "lefedetlen" listára – ez normális, ezért van a kör.

## A beküldendő JSON alakja

\`\`\`json
{
  "tenyek": [
    {"cimke": "Igényelhető támogatás", "ertek": "30–100 millió Ft", "idezet": "…"}
  ],
  "feltetelek": [
    {"id": "F01", "tipus": "jogosultsag", "kizaro": true,
     "cim": "…", "leiras": "…", "idezet": "…", "kerdes": "…", "igazolas": "…"},
    {"id": "F02", "tipus": "vallalas", "kizaro": true,
     "cim": "…", "leiras": "…", "idezet": ["…", "… […] …"], "kerdes": "…"}
  ],
  "pontozas": {
    "max": 100, "min": 60,
    "csoportok": [
      {"id": "I", "cim": "…", "max": 15, "min": null, "szempontok": [
        {"id": "I.1", "cim": "…", "max": 5, "idezet": "…", "kerdes": "…",
         "szintek": [{"ha": "…", "pont": 0}, {"ha": "…", "pont": 5}, {"ha": "…", "jogosulatlan": true}]}
      ]}
    ]
  },
  "hivatkozott": [{"nev": "…", "miert": "…", "idezet": "…"}],
  "elvetett": {}
}
\`\`\`

${SUBMIT(url)}
A "lefedetlen" lista minden elemét is rendezd (felvétel vagy elvetés), mielőtt újra beküldöd.

Ha végeztél, a tanácsadónak csak ennyit írj: hány feltétel, ebből hány kizáró, hány pontozási szempont, hány mondatot
vetettél el, és mely hivatkozott dokumentumokat kellene még feltöltenie.

${notesTxt}${prev}## A dokumentumok szövege
${docsText(call.docs)}
`;
}

export function evalTask(ev, call, url, withText) {
  const manual = ev.manual && Object.keys(ev.manual).length ? `## A tanácsadó válaszai és döntései – ezek elsőbbséget élveznek

"valasz": a tanácsadó válasza a korábbi kérdésedre – ezt tényként használd ("forras": "tanacsado").
"allapot" / "szint": a tanácsadó saját döntése az adott tételről – ezt vedd át változatlanul ("forras": "tanacsado"),
az indokban jelezd, ha szerinted az adatok mást mutatnak.

\`\`\`json
${JSON.stringify(ev.manual, null, 1)}
\`\`\`
` : "";
  const prev = ev.result ? `## A korábbi értékelésed – ezt frissíted

\`\`\`json
${JSON.stringify(ev.result, null, 1)}
\`\`\`
` : "";

  return `# Feladat: vállalkozás előminősítése egy pályázati felhívásra

Egy pályázatíró tanácsadónak dolgozol. Lent megkapod egy felhívás ellenőrzött kivonatát (minden feltétel és a teljes
pontozótábla) és egy vállalkozás adatait. Tételenként döntsd el, megfelel-e a vállalkozás, és melyik pontozási szint
teljesül. Az összesítést, a küszöböket és a végső minősítést a portál számolja – te csak a tételekről döntesz.

## A legfontosabb szabály: nincs találgatás

Egy tételről csak akkor dönthetsz, ha van rá adatod. Adat ebből a négy forrásból jöhet:
- "megadott": a tanácsadó által megadott adatokból (lent, „A vállalkozás” alatt).
- "tanacsado": a tanácsadó korábbi kérdésedre adott válaszából vagy saját döntéséből.
- "nyilvanos": közhiteles, nyilvános forrásból, ha van internet-hozzáférésed. Ilyenkor a "hivatkozas" mezőbe írd az
  URL-t és azt, amit ott láttál (melyik év, melyik sor). Érdemes megnézni: e-beszamolo.im.gov.hu (beszámoló: nettó
  árbevétel, saját tőke, létszám, export), a cégjegyzék adatai (alapítás, cégforma, székhely, telephelyek,
  cégjegyzésre jogosultak, folyamatban lévő eljárások), a NAV adatbázisai (köztartozásmentes adózók, végrehajtás),
  a palyazat.gov.hu támogatott projektkeresője (korábbi támogatások).
- "szamitas": a fenti adatokból végzett számítás. Az indokban mutasd meg számokkal.

Ha nincs adat: "forras": "nincs_adat", az állapot "kerdes" (pontozásnál a "szint": null), és a "kerdes" mezőbe egy
konkrét, a tanácsadónak szóló kérdés kerül, amelyre a válasz eldönti a tételt. Ne feltételezz, ne becsülj, és ne írd
azt, hogy „valószínűleg megfelel”. A vállalkozás nevéből, tevékenységéből semmire ne következtess.

## Állapotok ("feltetelek")

- "megfelel": az adatok alapján teljesül.
- "nem_felel_meg": az adatok alapján nem teljesül. Az indokban mondd meg pontosan, mi és mennyivel.
- "kerdes": adat hiányában nem dönthető el (lásd fent).
- "nem_relevans": a feltétel erre az esetre szerkezetileg nem vonatkozik (pl. másik benyújtási szakaszra szól).
  Az indokban mondd meg, miért nem.

Vállalásoknál (jövőbeli kötelezettség): "megfelel" csak akkor, ha a megadott adatok szerint a vállalkozás ezt vállalja,
és a helyzete alapján teljesíteni tudja. Különben kérdés: „Vállalja-e, hogy …?”. Költségszabálynál a tervezett
projekt számaival számolj; ha nincs költségterv, kérdés.

## Pontozás ("pontok")

Szempontonként a "szint" a teljesülő szint sorszáma a kivonat "szintek" listájában (0-tól számozva), vagy null, ha
adat hiányában nem dönthető el. Számításos szempontnál (arány, növekedés) az indokban ott a számítás. Ha egy szint
"jogosulatlan": true, és az teljesül, azt válaszd – a portál ezt jogosulatlanságként kezeli.

## Egyéb mezők

- "adatok": a vállalkozás és a projekt minden felhasznált tényadata egy táblában: {"cimke", "ertek", "forras"}, ahol a
  "forras" itt szabad szöveg (pl. „megadott”, „e-beszámoló, 2025. évi mérleg”).
- "osszegzes": 2–4 mondat a tanácsadónak: mi a helyzet, és min múlik.
- "teendok": konkrét lépések listája – előbb ami a jogosultsághoz kell, aztán amivel több pont szerezhető
  (pl. „Női cégjegyzésre jogosult projektvezető kijelölése: +5 pont”). Lehet üres.

## A beküldendő JSON alakja

\`\`\`json
{
  "adatok": [{"cimke": "Nettó árbevétel 2025", "ertek": "154 664 eFt", "forras": "megadott"}],
  "feltetelek": {
    "F01": {"allapot": "megfelel", "indok": "…", "forras": "megadott"},
    "F02": {"allapot": "kerdes", "indok": "…", "forras": "nincs_adat", "kerdes": "…?"},
    "F03": {"allapot": "megfelel", "indok": "…", "forras": "nyilvanos", "hivatkozas": "https://… – 2025. évi beszámoló"}
  },
  "pontok": {
    "I.1": {"szint": 0, "indok": "…", "forras": "megadott"},
    "I.2": {"szint": null, "indok": "…", "forras": "nincs_adat", "kerdes": "…?"}
  },
  "osszegzes": "…",
  "teendok": ["…"]
}
\`\`\`

A kivonat MINDEN feltételére és MINDEN szempontjára kell válasz, pontosan a kivonat azonosítóival.

${SUBMIT(url)}

Ha végeztél, a tanácsadónak csak ennyit írj: hány feltétel teljesül, hány nem, hány kérdés maradt nyitva, és hogy a
kérdésekre a portálon tud válaszolni – utána ugyanezzel a feladattal újra lefuttathat téged.

## A vállalkozás

- Név: ${ev.company}
- Adószám: ${ev.tax_no || "nincs megadva"}

A tanácsadó által megadott adatok (a vállalkozásról és a tervezett projektről):

${(ev.facts || "").trim() || "(a tanácsadó még semmit nem adott meg)"}

${manual}${prev}## A felhívás kivonata: ${call.title}

\`\`\`json
${JSON.stringify(call.catalog, null, 1)}
\`\`\`
${withText ? `\n## A felhívás teljes szövege (ha egy tétel értelmezéséhez kell)\n${docsText(call.docs)}\n` : `
Ha egy tétel értelmezéséhez a felhívás teljes szövege kell, kérd le ugyanerről a címről a végére írt \`&szoveg=1\`
paraméterrel.`}
`;
}
