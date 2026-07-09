import type { PDFDocumentProxy } from 'pdfjs-dist/types/src/pdf';

/** Render one PDF page to a PNG data payload (base64, no data: prefix) via
 *  pdf.js. Honors user rotation and horizontal mirror; caps the longest side. */
export async function renderPdfPageToPng(
  doc: PDFDocumentProxy,
  pageNum: number,
  opts: { rotation?: number; mirror?: boolean; maxPx?: number } = {},
): Promise<{ base64: string; w: number; h: number }> {
  const page = await doc.getPage(pageNum);
  const rotation = (page.rotate + (opts.rotation ?? 0)) % 360;
  let viewport = page.getViewport({ scale: 1, rotation });
  const maxPx = opts.maxPx ?? 2000;
  const scale = Math.min(1, maxPx / Math.max(viewport.width, viewport.height));
  viewport = page.getViewport({ scale, rotation });

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d')!;
  if (opts.mirror) { ctx.translate(canvas.width, 0); ctx.scale(-1, 1); }
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;

  const dataUrl = canvas.toDataURL('image/png');
  return { base64: dataUrl.split(',')[1], w: canvas.width, h: canvas.height };
}
