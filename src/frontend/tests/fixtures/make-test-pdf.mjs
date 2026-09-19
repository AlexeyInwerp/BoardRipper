/**
 * Generates tests/fixtures/two-page-text.pdf.
 *
 * Every board PDF this project has is proprietary and gitignored, so every PDF
 * spec skipped on a clean checkout — including, until now, the touch ones. This
 * writes a minimal two-page PDF by hand (no library, no licence question): real
 * text in the standard Helvetica font, two pages so page-flip and adjacent-page
 * rendering have something to flip between, and the words are refdes-shaped so
 * click-to-search has something plausible to hit.
 *
 * Regenerate with: node tests/fixtures/make-test-pdf.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function page(lines) {
  const body = lines
    .map((t, i) => `BT /F1 18 Tf 60 ${740 - i * 28} Td (${t}) Tj ET`)
    .join('\n');
  return `q 0 0 0 rg\n${body}\nQ`;
}

/** Two files. The short one is what most specs want; the long one exists
 *  because paging bugs only show up after several pages — a viewer that keeps
 *  a window of rendered neighbours behaves differently on page 9 than on
 *  page 2, and a two-page document can never leave that window. */
const DOCS = {
  'two-page-text.pdf': [
    page(['BoardRipper test page 1', 'U1 PP3V3_S5 J4900', 'R120 C310 Q7', 'NET AP_SMC_RESET_L']),
    page(['BoardRipper test page 2', 'U8100 PPBUS_G3H', 'L7210 D2 F9000', 'NET PM_SLP_S4_L']),
  ],
  'many-page-text.pdf': Array.from({ length: 16 }, (_, i) => page([
    `BoardRipper test page ${i + 1}`,
    `U${(i + 1) * 100} PP${i + 1}V${i + 2}_S5 J${4900 + i}`,
    `R${120 + i} C${310 + i} Q${7 + i}`,
    `NET PAGE_${i + 1}_MARKER`,
  ])),
};

function build(streams) {
  // Object numbering: 1 catalog, 2 pages, then a (page, contents) pair per
  // page, and the font last so its number is known up front.
  const n = streams.length;
  const fontObj = 3 + n * 2;
  const kids = streams.map((_, i) => `${3 + i * 2} 0 R`).join(' ');
  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`;
  streams.forEach((body, i) => {
    objs[3 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] `
      + `/Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`;
    objs[4 + i * 2] = `<< /Length ${body.length} >>\nstream\n${body}\nendstream`;
  });
  objs[fontObj] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = pdf.length;
    pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}

for (const [name, streams] of Object.entries(DOCS)) {
  const pdf = build(streams);
  const out = path.join(here, name);
  fs.writeFileSync(out, pdf, 'latin1');
  console.log(`wrote ${out} (${streams.length} pages, ${pdf.length} bytes)`);
}
