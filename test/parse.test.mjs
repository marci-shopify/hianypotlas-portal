// A PDF-felismerő ellenőrzése egy valódi felszólításon. Használat: node test/parse.test.mjs <felszolitas.pdf> [várt pontszám]
// (Valódi ügyfél-PDF nem kerülhet a repóba, ezért az út paraméter.)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { pdfPages, extractPoints, extractMeta, splitTitle } from "../docs/hp-parse.js";

const [file, expected] = process.argv.slice(2);
if (!file) { console.log("Kihagyva: nincs megadva PDF."); process.exit(0); }
const pages = await pdfPages(pdfjs, new Uint8Array(readFileSync(file)));
const points = extractPoints(pages);
points.forEach((p, i) => console.log(`${i + 1}. ${splitTitle(p).title}\n   [${p.length} karakter] …${p.slice(-60)}`));
console.log(extractMeta(pages));
if (expected) assert.equal(points.length, Number(expected), "pontok száma");
assert.ok(points.every((p) => !/Államkincstár Nemzeti Kifizető|Soroksári út/.test(p)), "élőláb nem kerülhet pontba");
console.log(`OK – ${points.length} pont`);
