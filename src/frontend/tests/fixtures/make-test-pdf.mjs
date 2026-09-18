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

const streams = [
  page(['BoardRipper test page 1', 'U1 PP3V3_S5 J4900', 'R120 C310 Q7', 'NET AP_SMC_RESET_L']),
  page(['BoardRipper test page 2', 'U8100 PPBUS_G3H', 'L7210 D2 F9000', 'NET PM_SLP_S4_L']),
];

const objs = [];
objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
objs[2] = '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>';
objs[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>';
objs[4] = `<< /Length ${streams[0].length} >>\nstream\n${streams[0]}\nendstream`;
objs[5] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>';
objs[6] = `<< /Length ${streams[1].length} >>\nstream\n${streams[1]}\nendstream`;
objs[7] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

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

const out = path.join(here, 'two-page-text.pdf');
fs.writeFileSync(out, pdf, 'latin1');
console.log(`wrote ${out} (${pdf.length} bytes)`);
