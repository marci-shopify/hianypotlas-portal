// Közös minta a béta pontozó próbáihoz (beta.test.mjs, beta-live.test.mjs). A valódi hibát utánozza: a „női
// munkavállaló” feltétel, amit egy AI sima vállalásként kezelt, miközben a pontozótábla „Jogosulatlan”-t ír rá.
// A szövegben szándékosan ott vannak a PDF-kinyerés hibái (beékelődő lábjegyzetszám, szóközök).
export const docs = [{ name: "felhivas.pdf", pages: [
  "1.1. Ki nyújthat be kérelmet?\nii. amelyek éves átlagos statisztikai állományi létszáma a megelőző lezárt üzleti évben minimum 3 fő volt ;",
  "9) A támogatást igénylő vállalja, hogy a projekt keretében minimum 6 hónapig, legalább 1 fő női munkavállalót foglalkoztat minimum heti 20 órás\n20\nmunkaidőben .",
  "III.2. Esélyegyenlőség érvényesítése 5\nA támogatást igénylő a projekt keretében nem foglalkoztat\nJogosulatlan\n46\nnői innovátort .\nA támogatást igénylő férfi projektvezetőt foglalkoztat 0\nA támogatást igénylő női projektvezetőt foglalkoztat 5\nÖsszes pont: 5 pont. Az elérendő minimális pontszám 3 pont .",
] }];

export const base = () => ({
  tenyek: [{ cimke: "Pontküszöb", ertek: "3 pont", idezet: "Az elérendő minimális pontszám 3 pont" }],
  feltetelek: [
    { id: "F01", tipus: "jogosultsag", kizaro: true, cim: "Min. 3 fő", leiras: "…", kerdes: "Létszám?", idezet: "üzleti évben minimum 3 fő volt" },
    { id: "F02", tipus: "vallalas", kizaro: false, cim: "Női munkavállaló", leiras: "…", kerdes: "Vállalja?", idezet: "legalább 1 fő női munkavállalót foglalkoztat minimum heti 20 órás […] munkaidőben" },
  ],
  pontozas: { max: 5, min: 3, csoportok: [{ id: "III", cim: "Horizontális", max: 5, szempontok: [
    { id: "III.2", cim: "Esélyegyenlőség", max: 5, kerdes: "Női projektvezető?", idezet: "nem foglalkoztat Jogosulatlan […] női innovátort",
      szintek: [{ ha: "férfi projektvezető", pont: 0 }, { ha: "női projektvezető", pont: 5 }] }] }] },
  hivatkozott: [], elvetett: {},
});

// A javított kivonat: a vállalás kizáró, és a szempontnak van „jogosulatlan” szintje.
export const good = () => {
  const c = base();
  c.feltetelek[1].kizaro = true;
  c.pontozas.csoportok[0].szempontok[0].szintek.unshift({ ha: "nem foglalkoztat női munkavállalót", jogosulatlan: true });
  return c;
};

export const res = () => ({
  adatok: [{ cimke: "Létszám", ertek: "7 fő", forras: "megadott" }],
  feltetelek: { F01: { allapot: "megfelel", indok: "7 fő ≥ 3", forras: "megadott" }, F02: { allapot: "kerdes", indok: "nincs adat", forras: "nincs_adat", kerdes: "Vállalja-e?" } },
  pontok: { "III.2": { szint: 2, indok: "női ügyvezető", forras: "nyilvanos", hivatkozas: "https://e-cegjegyzek.hu – cégkivonat" } },
  osszegzes: "Egy kérdés nyitva.", teendok: [],
});
