// Hiánypótlási felszólítás (PDF) → számozott pontok. Böngészőben (app.js) és Node-ban (scripts/import-pdf.mjs,
// test/parse.test.mjs) is fut; a pdf.js-t a hívó adja. Heurisztika, ezért a felület mindig megmutatja és
// szerkeszthetővé teszi az eredményt, mielőtt bármi mentődne.

// PDF → oldalanként sorok: { text, y, x1 } (y lefelé csökken, ahogy a PDF-ben).
export async function pdfPages(pdfjs, data) {
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const items = (await (await doc.getPage(n)).getTextContent()).items.filter((it) => it.str?.trim());
    const rows = [];
    for (const it of items) {
      const y = it.transform[5], x0 = it.transform[4];
      let row = rows.find((r) => Math.abs(r.y - y) < 2.5);
      if (!row) rows.push((row = { y, parts: [] }));
      row.parts.push({ x0, x1: x0 + it.width, s: it.str });
    }
    pages.push(rows.sort((a, b) => b.y - a.y).map((r) => {
      r.parts.sort((a, b) => a.x0 - b.x0);
      return { y: r.y, x1: Math.max(...r.parts.map((p) => p.x1)), text: r.parts.map((p) => p.s.trim()).join(" ").replace(/\s+/g, " ").trim() };
    }));
  }
  return pages;
}

const MARK = /^(\d{1,2})\s*[.)]\s+(?=\S)/;

// Sorok → bekezdések (nagyobb sorköz = új bekezdés). A bekezdés jelzi, ha az utolsó sora a jobb margóig ér:
// sorkizárt szövegnél ez azt jelenti, hogy a bekezdés a következő oldalon folytatódik.
function paragraphs(pages) {
  const out = [];
  for (const [pi, lines] of pages.entries()) {
    if (!lines.length) continue;
    const gaps = lines.slice(1).map((l, i) => lines[i].y - l.y).filter((g) => g > 0).sort((a, b) => a - b);
    const step = gaps[Math.floor(gaps.length / 2)] || 12;
    const right = Math.max(...lines.map((l) => l.x1));
    let cur = null;
    lines.forEach((l, i) => {
      if (!cur || lines[i - 1].y - l.y > step * 1.5) out.push((cur = { page: pi, lines: [] }));
      cur.lines.push(l);
      cur.full = l.x1 > right - 6;
    });
  }
  return out.filter((p) => !(p.lines.length === 1 && /^\d{1,3}$/.test(p.lines[0].text)));   // oldalszám
}

// A leghosszabb 1., 2., 3. … sorozat. Egy pont több soron, akár oldalhatáron át is tarthat.
export function extractPoints(pages) {
  const paras = paragraphs(pages);
  let best = [];
  paras.forEach((para, start) => {
    if (!para.lines.some((l) => MARK.exec(l.text)?.[1] === "1")) return;
    const items = [];
    let open = false, last = null;
    for (let pi = start; pi < paras.length; pi++) {
      let p = paras[pi];
      const startsNext = MARK.exec(p.lines[0].text)?.[1] === String(items.length + 1);
      if (pi > start && !startsNext) {
        // Nem a következő sorszám. Folytatás csak akkor lehet, ha a pont utolsó sora a jobb margóig ért:
        // ilyenkor az oldal maradékát (élőláb) átugorjuk, és a következő oldal első bekezdése a folytatás.
        if (!(open && last.full)) break;
        pi = paras.findIndex((q, k) => k >= pi && q.page > last.page);
        if (pi < 0) break;
        p = paras[pi];
      }
      last = p;
      for (const l of p.lines) {
        const m = MARK.exec(l.text);
        if (m && m[1] === String(items.length + 1) && (items.length || pi === start)) { items.push(l.text.slice(m[0].length)); open = true; }
        else if (open) items[items.length - 1] += (items[items.length - 1].endsWith("-") ? "" : " ") + l.text;
      }
    }
    if (items.length > best.length) best = items;
  });
  return best.map((t) => t.replace(/\s+/g, " ").trim());
}

// Projekt-adatok a fejlécből (ha megtalálhatók). Csak javaslat, a felületen átírható.
export function extractMeta(pages) {
  const all = pages.flat().map((l) => l.text).join("\n");
  const one = all.replace(/\s+/g, " ");
  const ref = /Iratazonosító:\s*(\d{6,})/.exec(one)?.[1] || null;
  const call = /a\(z\)\s+(.{5,160}?)\s+című/.exec(one)?.[1] || null;
  const days = /(\d{1,3})\s+napon belül/.exec(one)?.[1] || null;
  return { reference: ref, title: call ? `${call} – hiánypótlás` : null, days: days ? Number(days) : null };
}

// Hosszú pontszövegből rövid cím + teljes leírás.
export function splitTitle(text, max = 140) {
  if (text.length <= max) return { title: text, description: null };
  const cut = text.slice(0, max - 1);
  return { title: cut.slice(0, cut.lastIndexOf(" ") > 60 ? cut.lastIndexOf(" ") : cut.length).replace(/[,;:\s]+$/, "") + "…", description: text };
}
