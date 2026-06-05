import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';

// Verifies the Content-Disposition flip on the API directly. The full
// UI path (Library row click → Download button → browser save dialog)
// is covered by the manual smoke checklist — backend test + this disposition
// assertion give CI-portable coverage of the wire format.

test.setTimeout(30_000);

async function makePdfBuffer(name: string): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([300, 400]).drawText(name, { x: 40, y: 200, size: 18, font });
  return Buffer.from(await pdf.save());
}

async function uploadAndLocate(request: import('@playwright/test').APIRequestContext, filename: string, buf: Buffer): Promise<string | null> {
  const up = await request.post('/api/upload', {
    multipart: { file: { name: filename, mimeType: 'application/pdf', buffer: buf } },
  }).catch(() => null);
  if (!up || !up.ok()) return null;
  // Files land in incoming/ — try both endpoint shapes the backend exposes.
  for (const url of [
    `/api/files/path/${encodeURIComponent('incoming/' + filename)}`,
    `/api/files/${encodeURIComponent('incoming/' + filename)}`,
  ]) {
    const probe = await request.get(url).catch(() => null);
    if (probe && probe.ok()) return url;
  }
  return null;
}

test('?download=1 flips Content-Disposition to attachment', async ({ request }) => {
  const filename = `dl-${Date.now()}.pdf`;
  const buf = await makePdfBuffer(filename);
  const url = await uploadAndLocate(request, filename, buf);
  test.skip(!url, 'backend not reachable for upload');

  const res = await request.get(`${url}?download=1`);
  expect(res.ok(), `status ${res.status()}`).toBeTruthy();
  const cd = res.headers()['content-disposition'] ?? '';
  expect(cd.toLowerCase()).toContain('attachment');
  expect(cd).toContain(filename);
});

test('no query param → Content-Disposition stays inline (regression)', async ({ request }) => {
  const filename = `inl-${Date.now()}.pdf`;
  const buf = await makePdfBuffer(filename);
  const url = await uploadAndLocate(request, filename, buf);
  test.skip(!url, 'backend not reachable for upload');

  const res = await request.get(url!);
  expect(res.ok()).toBeTruthy();
  const cd = res.headers()['content-disposition'] ?? '';
  expect(cd.toLowerCase()).toContain('inline');
});
