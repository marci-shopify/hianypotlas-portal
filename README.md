# Hiánypótlás portál

Ügyfélportál pályázatíróknak: az ügyfél pontonként tölti fel a hiánypótlási dokumentumokat, a
pályázatíró átnézi, elfogad vagy javítást kér, a változásokról mindkét fél e-mailt kap.

**Élő oldal:** https://marci-shopify.github.io/hianypotlas-portal/

## Hogyan működik

1. Az admin az **Új projekt** gombbal felveszi az ügyfelet és bemásolja a hiánypótlási pontokat
   (soronként egyet). A portál kész, kimásolható levelet ad a belépési adatokkal.
2. Az ügyfél belép, megadja az értesítési e-mail-címét, és minden ponthoz feltölti a fájlokat;
   megjegyzést is írhat.
3. Az admin pontonként **elfogad** vagy **javítást kér** – az ügyfél néhány percen belül egy
   összefoglaló e-mailt kap.
4. A sáv a projekt tetején mutatja, hol tart: üres = hiányzik, kék = ellenőrzésre vár,
   narancs = javítandó, zöld = rendben.

## Fejlesztés

Minden technikai tudnivaló az [AGENTS.md](AGENTS.md) fájlban van (felépítés, parancsok, buktatók).

```bash
npm install
npm test          # biztonsági önteszt
npm run serve     # http://localhost:5173
```
