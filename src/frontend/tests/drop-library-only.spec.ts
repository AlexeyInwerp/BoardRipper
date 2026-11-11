import { test, expect, type Page } from '@playwright/test';

// A drop of more than four files offers "Add to library only": the files are
// POSTed to /api/upload and nothing is opened or parsed. The backend is
// mocked, so this runs on any checkout.

async function drag(page: Page, type: string, count: number, at: { x: number; y: number }) {
  await page.evaluate(({ type, count, at }) => {
    const w = window as unknown as { __dt?: DataTransfer };
    if (!w.__dt) {
      const dt = new DataTransfer();
      const text = '<?xml version="1.0"?>\n';
      for (let i = 0; i < count; i++) {
        dt.items.add(new File([text], `board-${i}.kicad_pcb`, { type: 'application/octet-stream' }));
      }
      w.__dt = dt;
    }
    const ev = new DragEvent(type, {
      bubbles: true, cancelable: true, dataTransfer: w.__dt, clientX: at.x, clientY: at.y,
    });
    document.querySelector('[data-testid="app"]')!.dispatchEvent(ev);
    if (type === 'drop') delete w.__dt;
  }, { type, count, at });
}

test('more than four files: dropping on "Add to library only" uploads without opening', async ({ page }) => {
  const uploaded: string[] = [];
  await page.route('**/api/upload', async (route) => {
    const body = route.request().postDataBuffer()?.toString('latin1') ?? '';
    const m = body.match(/filename="([^"]+)"/);
    if (m) uploaded.push(m[1]);
    await route.fulfill({ json: { status: 'saved', name: m?.[1], path: `incoming/${m?.[1]}` } });
  });
  await page.goto('/');
  await page.locator('[data-testid="app"]').waitFor();

  await drag(page, 'dragenter', 5, { x: 10, y: 10 });
  const lib = page.getByTestId('drop-zone-library');
  await expect(lib).toBeVisible();
  await expect(page.getByTestId('drop-zone-open')).toBeVisible();

  const box = (await lib.boundingBox())!;
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await drag(page, 'dragover', 5, at);
  await expect(lib).toHaveClass(/active/);
  await drag(page, 'drop', 5, at);

  await expect.poll(() => uploaded.length).toBe(5);
  await expect(page.locator('[data-testid="drop-overlay"]')).toHaveCount(0);
  // Nothing was opened: no board panel appeared.
  await page.waitForTimeout(500);
  await expect(page.locator('.board-panel-root')).toHaveCount(0);
});

test('four files or fewer: the single overlay, no library target', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-testid="app"]').waitFor();
  await drag(page, 'dragenter', 4, { x: 10, y: 10 });
  await expect(page.locator('[data-testid="drop-overlay"]')).toBeVisible();
  await expect(page.getByTestId('drop-zone-library')).toHaveCount(0);
});
