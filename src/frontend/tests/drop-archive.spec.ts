import { test, expect, type Page } from '@playwright/test';

// A dropped .zip / .7z / .rar is not opened: it is POSTed to /api/upload,
// whose server unpacks it into incoming/<name>/, and a toast says what came
// of it. The backend is mocked, so this runs on any checkout.

async function dropFiles(page: Page, names: string[]) {
  await page.evaluate((names) => {
    const dt = new DataTransfer();
    for (const n of names) dt.items.add(new File(['PK'], n, { type: 'application/octet-stream' }));
    const app = document.querySelector('[data-testid="app"]')!;
    for (const type of ['dragenter', 'dragover', 'drop']) {
      app.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 200, clientY: 200 }));
    }
  }, names);
}

test('an archive is sent to the server and the result is named', async ({ page }) => {
  const uploaded: string[] = [];
  await page.route('**/api/upload', async (route) => {
    const m = (route.request().postDataBuffer()?.toString('latin1') ?? '').match(/filename="([^"]+)"/);
    uploaded.push(m?.[1] ?? '');
    await route.fulfill({ json: {
      status: 'unpacked', archive: m?.[1], folder: 'incoming/X1190 Rev 1.0', skipped: 9,
      files: [
        { name: '820-01041.brd', path: 'incoming/X1190 Rev 1.0/820-01041.brd', status: 'ok', id: 11, file_type: 'board' },
        { name: 'orig.pdf', path: 'Apple/orig.pdf', status: 'exists', id: 3, file_type: 'pdf' },
      ],
    } });
  });
  await page.goto('/');
  await page.locator('[data-testid="app"]').waitFor();
  await dropFiles(page, ['X1190 Rev 1.0.zip']);

  await expect.poll(() => uploaded).toEqual(['X1190 Rev 1.0.zip']);
  await expect(page.getByText('X1190 Rev 1.0.zip: 1 file added to incoming/X1190 Rev 1.0; 1 already in the library; 9 other files left out')).toBeVisible();
  // Not reported as an unsupported file, and nothing was opened.
  await expect(page.getByText(/Ignored unsupported/)).toHaveCount(0);
  await page.waitForTimeout(300);
  await expect(page.locator('.board-panel-root')).toHaveCount(0);
});

test('an archive with no boards says so; a refused one shows the server reason', async ({ page }) => {
  await page.route('**/api/upload', async (route) => {
    const body = route.request().postDataBuffer()?.toString('latin1') ?? '';
    if (body.includes('locked.rar')) {
      await route.fulfill({ status: 400, body: 'locked.rar: the archive is password-protected' });
    } else {
      await route.fulfill({ json: { status: 'unpacked', archive: 'bios.7z', folder: 'incoming/bios', skipped: 1, left_out: ['dump/A1286 820-3330-B.bin'], files: [] } });
    }
  });
  await page.goto('/');
  await page.locator('[data-testid="app"]').waitFor();
  await dropFiles(page, ['bios.7z', 'locked.rar']);
  await expect(page.getByText('bios.7z holds no boardview or PDF files — nothing was added. It contains A1286 820-3330-B.bin.')).toBeVisible();
  await expect(page.getByText("Couldn't unpack locked.rar: the archive is password-protected")).toBeVisible();
});
