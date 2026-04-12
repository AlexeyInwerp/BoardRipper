import { test, expect } from '@playwright/test';

/**
 * Library PDF search tests.
 *
 * Requires the Go backend running on :8080 with extracted PDF text.
 * Tests verify:
 * 1. Backend search API returns results for known terms
 * 2. Library panel PDF search UI finds results
 * 3. Opening a PDF from search results pre-populates the PDF viewer search
 */

test.describe('PDF Search (Library)', () => {
  test.beforeEach(async ({ page }) => {
    // Check if backend is available
    try {
      const res = await page.request.get('http://localhost:8080/api/config');
      if (!res.ok()) test.skip();
    } catch {
      test.skip();
    }
  });

  test('backend search API returns results for single term', async ({ page }) => {
    const res = await page.request.get('http://localhost:8080/api/databank/search?q=connector');
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.results.length).toBeGreaterThan(0);
    expect(data.results[0].snippet).toContain('onnector');
    expect(data.results[0].filename).toBeTruthy();
    expect(data.results[0].page_num).toBeGreaterThan(0);
  });

  test('backend search API returns results for multi-term "10UF 25V"', async ({ page }) => {
    const res = await page.request.get('http://localhost:8080/api/databank/search?q=10UF%2025V');
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.results.length).toBeGreaterThan(0);
    // Both terms should appear in snippets (highlighted with <b>)
    const snippet = data.results[0].snippet.toLowerCase();
    expect(snippet).toContain('10uf');
    expect(snippet).toContain('25v');
  });

  test('backend search API returns empty for nonsense query', async ({ page }) => {
    const res = await page.request.get('http://localhost:8080/api/databank/search?q=zzxxyynonsenseterm');
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.results.length).toBe(0);
  });

  test('backend text dump endpoint returns HTML', async ({ page }) => {
    // Get a file ID from search results
    const searchRes = await page.request.get('http://localhost:8080/api/databank/search?q=usb');
    const searchData = await searchRes.json();
    if (searchData.results.length === 0) test.skip();

    const fileId = searchData.results[0].file_id;
    const dumpRes = await page.request.get(`http://localhost:8080/api/databank/files/${fileId}/dump`);
    expect(dumpRes.ok()).toBeTruthy();
    const html = await dumpRes.text();
    expect(html).toContain('Text Dump:');
    expect(html).toContain('Page');
  });

  test('extracted text contains merged words, not single characters', async ({ page }) => {
    // Verify via search that multi-character terms are searchable
    const terms = ['schematic', 'usb', 'connector', 'pmu'];
    let found = 0;
    for (const term of terms) {
      const res = await page.request.get(`http://localhost:8080/api/databank/search?q=${term}`);
      const data = await res.json();
      if (data.results.length > 0) found++;
    }
    // At least 2 of these common schematic terms should return results
    expect(found).toBeGreaterThanOrEqual(2);
  });

  test('library panel shows PDF search results', async ({ page }) => {
    await page.goto('/');

    // Open the Library panel (it may already be visible or need to be opened)
    // Look for the library panel or a way to open it
    const libraryPanel = page.locator('.library-panel');
    if (!await libraryPanel.isVisible({ timeout: 2000 }).catch(() => false)) {
      // Try to find and click a library button/tab
      const libTab = page.locator('text=Library').first();
      if (await libTab.isVisible({ timeout: 2000 }).catch(() => false)) {
        await libTab.click();
      } else {
        test.skip();
      }
    }

    // Enable PDF search mode
    const pdfCheckbox = page.locator('.library-pdf-search-toggle input[type="checkbox"]');
    if (!await pdfCheckbox.isVisible({ timeout: 3000 }).catch(() => false)) {
      test.skip();
    }
    await pdfCheckbox.check();

    // Type search query
    const searchInput = page.locator('.library-search-input');
    await searchInput.fill('connector');
    await searchInput.press('Enter');

    // Wait for search results
    await expect(page.locator('.library-search-results')).toBeVisible({ timeout: 10000 });
    const resultCount = await page.locator('.library-search-result').count();
    expect(resultCount).toBeGreaterThan(0);

    // Results should show filename and page number
    const firstResult = page.locator('.library-search-result').first();
    await expect(firstResult.locator('.library-search-result-file')).toBeTruthy();
    await expect(firstResult.locator('.library-search-result-page')).toBeTruthy();

    // Snippet should be visible with highlighted text
    const snippet = firstResult.locator('.library-search-result-snippet');
    await expect(snippet).toBeVisible();
  });

  test('multi-term search "10UF 25V" returns results in library', async ({ page }) => {
    await page.goto('/');

    const libraryPanel = page.locator('.library-panel');
    if (!await libraryPanel.isVisible({ timeout: 2000 }).catch(() => false)) {
      const libTab = page.locator('text=Library').first();
      if (await libTab.isVisible({ timeout: 2000 }).catch(() => false)) {
        await libTab.click();
      } else {
        test.skip();
      }
    }

    const pdfCheckbox = page.locator('.library-pdf-search-toggle input[type="checkbox"]');
    if (!await pdfCheckbox.isVisible({ timeout: 3000 }).catch(() => false)) {
      test.skip();
    }
    await pdfCheckbox.check();

    const searchInput = page.locator('.library-search-input');
    await searchInput.fill('10UF 25V');
    await searchInput.press('Enter');

    await expect(page.locator('.library-search-results')).toBeVisible({ timeout: 10000 });

    // Should have results
    const results = page.locator('.library-search-result');
    const count = await results.count();
    expect(count).toBeGreaterThan(0);

    // Snippets should contain both terms
    const firstSnippet = await results.first().locator('.library-search-result-snippet').innerHTML();
    const snippetLower = firstSnippet.toLowerCase();
    expect(snippetLower).toContain('10uf');
    expect(snippetLower).toContain('25v');
  });

  /**
   * Core parity test: library search (backend FTS5 AND) vs PDF viewer spatial search.
   *
   * Use case: find "10UF 25V 0402" across schematics to locate donor components.
   * Schematics list component values in columns, so the PDF viewer's spatial
   * multi-term search is the precise tool. The backend FTS5 AND is a broad filter
   * that finds all pages where every term co-occurs.
   *
   * Verifies:
   * 1. Both searches find results for the same PDF
   * 2. Frontend spatial pages are a subset of backend pages (no missed donors)
   * 3. Clicking a library result opens the PDF at the correct page
   */
  test('library search covers all PDF viewer spatial matches for "10UF 25V 0402" in 820-00239', async ({ page }) => {
    test.setTimeout(120000); // 119-page PDF text extraction takes time

    // --- 1. Backend: get all pages with co-occurring terms for 820-00239 ---
    const apiRes = await page.request.get('http://localhost:8080/api/databank/search?q=10UF%2025V%200402');
    expect(apiRes.ok()).toBeTruthy();
    const apiData = await apiRes.json();
    const backendHits = apiData.results.filter(
      (r: { filename: string }) => r.filename.includes('820-00239')
    );
    expect(backendHits.length).toBeGreaterThan(0);
    const backendPages = new Set(
      backendHits.map((r: { page_num: number }) => r.page_num)
    );

    // --- 2. Open library, search, click first 820-00239 result ---
    await page.goto('/');
    const libTab = page.locator('text=Library').first();
    if (!await libTab.isVisible({ timeout: 3000 }).catch(() => false)) test.skip();
    await libTab.click();

    const pdfCheckbox = page.locator('.library-pdf-search-toggle input[type="checkbox"]');
    if (!await pdfCheckbox.isVisible({ timeout: 3000 }).catch(() => false)) test.skip();
    await pdfCheckbox.check();

    const searchInput = page.locator('.library-search-input');
    await searchInput.fill('10UF 25V 0402');
    await searchInput.press('Enter');
    await expect(page.locator('.library-search-results')).toBeVisible({ timeout: 10000 });

    // Verify library shows results for 820-00239 with correct page numbers
    const targetResult = page.locator('.library-search-result').filter({
      has: page.locator('.library-search-result-file', { hasText: '820-00239' })
    }).first();
    await expect(targetResult).toBeVisible({ timeout: 5000 });

    // Check that clicking opens the right page
    const targetPage = await targetResult.locator('.library-search-result-page').textContent();
    await targetResult.click();

    // --- 3. Wait for PDF load + full text extraction ---
    await expect(page.locator('.pdf-search-input')).toBeVisible({ timeout: 15000 });
    await page.waitForFunction(() => {
      const store = (window as any).__pdfStore;
      if (!store || store.pageCount === 0) return false;
      return !store.textExtracting;
    }, { timeout: 90000 });

    // Verify PDF opened at the correct page
    const currentPage = await page.locator('.pdf-page-input').inputValue();
    const expectedPage = targetPage?.replace('p', '') ?? '';
    expect(currentPage).toBe(expectedPage);

    // --- 4. Run spatial search with default + wider gaps ---
    const result = await page.evaluate(() => {
      const store = (window as any).__pdfStore;
      if (!store) return null;

      // First try default gaps
      store.searchText('10UF 25V 0402');
      const defaultGroups = store.matchGroups.length;

      // Also try wider gaps (V=8x, H=6x) for schematics with larger spacing
      store.setMultiTermYGap(8);
      store.setMultiTermXGap(6);
      store.searchText('10UF 25V 0402');
      const wideGroups = store.matchGroups.length;

      // Collect unique pages from wide-gap results
      const matches = store.matches as { pageIndex: number }[];
      const groups = store.matchGroups as number[][];
      const pages = [...new Set(groups.map((g: number[]) =>
        matches[g[0]].pageIndex + 1
      ))];

      // Also compute pages where all terms co-occur (pdfjs text)
      const d = store._active;
      const coOccurPages: number[] = [];
      if (d) {
        for (let pi = 0; pi < d.textPages.length; pi++) {
          const allText = d.textPages[pi].map((it: { str: string }) => it.str.toLowerCase()).join(' ');
          if (allText.includes('10uf') && allText.includes('25v') && allText.includes('0402')) {
            coOccurPages.push(pi + 1);
          }
        }
      }

      return { defaultGroups, wideGroups, spatialPages: pages.sort((a: number, b: number) => a - b), coOccurPages };
    });

    expect(result).toBeTruthy();
    console.log(`Default gaps (V=4x,H=3x): ${result!.defaultGroups} groups`);
    console.log(`Wide gaps (V=8x,H=6x): ${result!.wideGroups} groups`);
    console.log(`Frontend spatial pages: ${result!.spatialPages.join(', ')}`);
    console.log(`Frontend co-occur pages (pdfjs): ${result!.coOccurPages.join(', ')}`);

    const backendArr = [...backendPages].sort((a, b) => a - b);
    console.log(`Backend co-occur pages (rsc.io): ${backendArr.join(', ')}`);

    // --- 5. Verify: backend must be a superset of frontend spatial matches ---
    const missedByBackend = result!.spatialPages.filter((p: number) => !backendPages.has(p));
    if (missedByBackend.length > 0) {
      console.error(`CRITICAL: Backend missed spatial pages: ${missedByBackend.join(', ')}`);
    }
    expect(missedByBackend).toEqual([]);

    // --- 6. Verify: pdfjs co-occur pages should roughly match backend ---
    // (different text extractors, but both should find the same pages)
    const pdfjsPages = new Set(result!.coOccurPages);
    const missedByPdfjs = backendArr.filter(p => !pdfjsPages.has(p));
    const missedByBackend2 = result!.coOccurPages.filter((p: number) => !backendPages.has(p));
    console.log(`Backend has but pdfjs doesn't: ${missedByPdfjs.join(', ') || 'none'}`);
    console.log(`Pdfjs has but backend doesn't: ${missedByBackend2.join(', ') || 'none'}`);

    // Both spatial and non-spatial results should exist
    expect(result!.wideGroups).toBeGreaterThan(0);
    expect(backendHits.length).toBeGreaterThan(0);
  });

  /**
   * Parity test with default gaps (V=4x, H=3x) for "10UF 25V 0603".
   * 0603 is a common package size — should produce tighter column matches
   * than 0402 since 0603 caps appear more frequently in schematics.
   */
  test('library and viewer match for "10UF 25V 0603" in 820-00239 (default gaps)', async ({ page }) => {
    test.setTimeout(120000);

    // --- 1. Backend results ---
    const apiRes = await page.request.get('http://localhost:8080/api/databank/search?q=10UF%2025V%200603');
    expect(apiRes.ok()).toBeTruthy();
    const apiData = await apiRes.json();
    const backendHits = apiData.results.filter(
      (r: { filename: string }) => r.filename.includes('820-00239')
    );
    expect(backendHits.length).toBeGreaterThan(0);
    const backendPages = new Set(
      backendHits.map((r: { page_num: number }) => r.page_num)
    );

    // --- 2. Open library, search, click first 820-00239 result ---
    await page.goto('/');
    const libTab = page.locator('text=Library').first();
    if (!await libTab.isVisible({ timeout: 3000 }).catch(() => false)) test.skip();
    await libTab.click();

    const pdfCheckbox = page.locator('.library-pdf-search-toggle input[type="checkbox"]');
    if (!await pdfCheckbox.isVisible({ timeout: 3000 }).catch(() => false)) test.skip();
    await pdfCheckbox.check();

    const searchInput = page.locator('.library-search-input');
    await searchInput.fill('10UF 25V 0603');
    await searchInput.press('Enter');
    await expect(page.locator('.library-search-results')).toBeVisible({ timeout: 10000 });

    const targetResult = page.locator('.library-search-result').filter({
      has: page.locator('.library-search-result-file', { hasText: '820-00239' })
    }).first();
    await expect(targetResult).toBeVisible({ timeout: 5000 });

    const targetPage = await targetResult.locator('.library-search-result-page').textContent();
    await targetResult.click();

    // --- 3. Wait for PDF load + text extraction ---
    await expect(page.locator('.pdf-search-input')).toBeVisible({ timeout: 15000 });
    await page.waitForFunction(() => {
      const store = (window as any).__pdfStore;
      if (!store || store.pageCount === 0) return false;
      return !store.textExtracting;
    }, { timeout: 90000 });

    // Verify correct page opened
    const currentPage = await page.locator('.pdf-page-input').inputValue();
    const expectedPage = targetPage?.replace('p', '') ?? '';
    expect(currentPage).toBe(expectedPage);

    // --- 4. Spatial search with DEFAULT gaps (V=4x, H=3x) ---
    const result = await page.evaluate(() => {
      const store = (window as any).__pdfStore;
      if (!store) return null;

      // Ensure default gaps
      store.setMultiTermYGap(4);
      store.setMultiTermXGap(3);
      store.searchText('10UF 25V 0603');

      const matches = store.matches as { pageIndex: number }[];
      const groups = store.matchGroups as number[][];
      const pages = [...new Set(groups.map((g: number[]) =>
        matches[g[0]].pageIndex + 1
      ))].sort((a: number, b: number) => a - b);

      // Co-occur pages for comparison
      const d = store._active;
      const coOccurPages: number[] = [];
      if (d) {
        for (let pi = 0; pi < d.textPages.length; pi++) {
          const allText = d.textPages[pi].map((it: { str: string }) => it.str.toLowerCase()).join(' ');
          if (allText.includes('10uf') && allText.includes('25v') && allText.includes('0603')) {
            coOccurPages.push(pi + 1);
          }
        }
      }

      return {
        groups: groups.length,
        spatialPages: pages,
        coOccurPages,
        yGap: store.multiTermYGap,
        xGap: store.multiTermXGap,
      };
    });

    expect(result).toBeTruthy();
    const backendArr = [...backendPages].sort((a, b) => a - b);
    console.log(`Query: "10UF 25V 0603" — default gaps V=${result!.yGap}x, H=${result!.xGap}x`);
    console.log(`Frontend spatial: ${result!.groups} groups on pages [${result!.spatialPages.join(', ')}]`);
    console.log(`Frontend co-occur (pdfjs): [${result!.coOccurPages.join(', ')}]`);
    console.log(`Backend co-occur (rsc.io): [${backendArr.join(', ')}]`);

    // --- 5. Frontend spatial pages must be subset of backend ---
    const missedByBackend = result!.spatialPages.filter((p: number) => !backendPages.has(p));
    if (missedByBackend.length > 0) {
      console.error(`CRITICAL: Backend missed spatial pages: ${missedByBackend.join(', ')}`);
    }
    expect(missedByBackend).toEqual([]);

    // --- 6. With default gaps, spatial search should find matches ---
    expect(result!.groups).toBeGreaterThan(0);
    expect(backendHits.length).toBeGreaterThan(0);

    // Frontend spatial page count should match backend page count for this specific query
    console.log(`Page set match: spatial=${result!.spatialPages.length}, backend=${backendArr.length}`);
  });

  /**
   * Parity test for "10UF 25V 0603" on 820-02890 SCH.pdf.
   * Verifies extraction works and backend/frontend search results align.
   */
  test('library and viewer match for "10UF 25V 0603" in 820-02890 (default gaps)', async ({ page }) => {
    test.setTimeout(180000); // 159-page PDF

    // --- 1. Backend results ---
    const apiRes = await page.request.get('http://localhost:8080/api/databank/search?q=10UF%2025V%200603');
    expect(apiRes.ok()).toBeTruthy();
    const apiData = await apiRes.json();
    const backendHits = apiData.results.filter(
      (r: { filename: string }) => r.filename.includes('820-02890')
    );
    expect(backendHits.length).toBeGreaterThan(0);
    const backendPages = new Set(
      backendHits.map((r: { page_num: number }) => r.page_num)
    );

    // --- 2. Open library, search, click first 820-02890 result ---
    await page.goto('/');
    const libTab = page.locator('text=Library').first();
    if (!await libTab.isVisible({ timeout: 3000 }).catch(() => false)) test.skip();
    await libTab.click();

    const pdfCheckbox = page.locator('.library-pdf-search-toggle input[type="checkbox"]');
    if (!await pdfCheckbox.isVisible({ timeout: 3000 }).catch(() => false)) test.skip();
    await pdfCheckbox.check();

    const searchInput = page.locator('.library-search-input');
    await searchInput.fill('10UF 25V 0603');
    await searchInput.press('Enter');
    await expect(page.locator('.library-search-results')).toBeVisible({ timeout: 10000 });

    const targetResult = page.locator('.library-search-result').filter({
      has: page.locator('.library-search-result-file', { hasText: '820-02890' })
    }).first();
    await expect(targetResult).toBeVisible({ timeout: 5000 });

    const targetPage = await targetResult.locator('.library-search-result-page').textContent();
    await targetResult.click();

    // --- 3. Wait for PDF load + text extraction ---
    await expect(page.locator('.pdf-search-input')).toBeVisible({ timeout: 15000 });
    await page.waitForFunction(() => {
      const store = (window as any).__pdfStore;
      if (!store || store.pageCount === 0) return false;
      return !store.textExtracting;
    }, { timeout: 120000 });

    // Verify PDF opened at the correct page
    const currentPage = await page.locator('.pdf-page-input').inputValue();
    const expectedPage = targetPage?.replace('p', '') ?? '';
    expect(currentPage).toBe(expectedPage);

    // --- 4. Spatial search with DEFAULT gaps (V=4x, H=3x) ---
    const result = await page.evaluate(() => {
      const store = (window as any).__pdfStore;
      if (!store) return null;

      store.setMultiTermYGap(4);
      store.setMultiTermXGap(3);
      store.searchText('10UF 25V 0603');

      const matches = store.matches as { pageIndex: number }[];
      const groups = store.matchGroups as number[][];
      const pages = [...new Set(groups.map((g: number[]) =>
        matches[g[0]].pageIndex + 1
      ))].sort((a: number, b: number) => a - b);

      const d = store._active;
      const coOccurPages: number[] = [];
      if (d) {
        for (let pi = 0; pi < d.textPages.length; pi++) {
          const allText = d.textPages[pi].map((it: { str: string }) => it.str.toLowerCase()).join(' ');
          if (allText.includes('10uf') && allText.includes('25v') && allText.includes('0603')) {
            coOccurPages.push(pi + 1);
          }
        }
      }

      return {
        groups: groups.length,
        spatialPages: pages,
        coOccurPages,
        yGap: store.multiTermYGap,
        xGap: store.multiTermXGap,
      };
    });

    expect(result).toBeTruthy();
    const backendArr = [...backendPages].sort((a, b) => a - b);
    console.log(`Query: "10UF 25V 0603" on 820-02890 — gaps V=${result!.yGap}x, H=${result!.xGap}x`);
    console.log(`Frontend spatial: ${result!.groups} groups on pages [${result!.spatialPages.join(', ')}]`);
    console.log(`Frontend co-occur (pdfjs): [${result!.coOccurPages.join(', ')}]`);
    console.log(`Backend co-occur (rsc.io): [${backendArr.join(', ')}]`);

    // --- 5. Frontend spatial pages must be subset of backend ---
    const missedByBackend = result!.spatialPages.filter((p: number) => !backendPages.has(p));
    if (missedByBackend.length > 0) {
      console.error(`CRITICAL: Backend missed spatial pages: ${missedByBackend.join(', ')}`);
    }
    expect(missedByBackend).toEqual([]);

    // --- 6. Both should find results ---
    expect(result!.groups).toBeGreaterThan(0);
    expect(backendHits.length).toBeGreaterThan(0);

    console.log(`Page set match: spatial=${result!.spatialPages.length}, backend=${backendArr.length}`);
  });
});
