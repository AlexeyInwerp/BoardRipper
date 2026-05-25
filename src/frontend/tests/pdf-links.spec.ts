import { test, expect } from '@playwright/test';

// Pure module — imported and exercised in the Node test runner (no browser),
// same pattern as tests/bvr1-parser.spec.ts. Uses an in-memory fake storage.
test.describe('PdfLinks', () => {
  function makeFakeStorage() {
    const m = new Map<string, string>();
    return {
      store: m,
      get: (k: string) => m.get(k) ?? null,
      set: (k: string, v: string) => { m.set(k, v); },
      remove: (k: string) => { m.delete(k); },
    };
  }

  test('link is symmetric and bidirectional', async () => {
    const { PdfLinks } = await import('../src/store/pdf-links');
    const fs = makeFakeStorage();
    const links = new PdfLinks(fs);
    links.link('a.pdf', 'b.pdf');
    expect(links.get('a.pdf')).toBe('b.pdf');
    expect(links.get('b.pdf')).toBe('a.pdf');
  });

  test('self-link is ignored', async () => {
    const { PdfLinks } = await import('../src/store/pdf-links');
    const links = new PdfLinks(makeFakeStorage());
    links.link('a.pdf', 'a.pdf');
    expect(links.get('a.pdf')).toBeNull();
  });

  test('relinking replaces the previous pair on both ends (1:1)', async () => {
    const { PdfLinks } = await import('../src/store/pdf-links');
    const links = new PdfLinks(makeFakeStorage());
    links.link('a.pdf', 'b.pdf');
    links.link('a.pdf', 'c.pdf');     // a re-links to c; b must be freed
    expect(links.get('a.pdf')).toBe('c.pdf');
    expect(links.get('c.pdf')).toBe('a.pdf');
    expect(links.get('b.pdf')).toBeNull();
  });

  test('unlink clears both directions', async () => {
    const { PdfLinks } = await import('../src/store/pdf-links');
    const links = new PdfLinks(makeFakeStorage());
    links.link('a.pdf', 'b.pdf');
    links.unlink('a.pdf');
    expect(links.get('a.pdf')).toBeNull();
    expect(links.get('b.pdf')).toBeNull();
  });

  test('persists to storage and restores into a fresh instance', async () => {
    const { PdfLinks } = await import('../src/store/pdf-links');
    const fs = makeFakeStorage();
    new PdfLinks(fs).link('a.pdf', 'b.pdf');
    expect(fs.store.get('pdf-link:a.pdf')).toBe('b.pdf');
    expect(fs.store.get('pdf-link:b.pdf')).toBe('a.pdf');
    const fresh = new PdfLinks(fs);
    expect(fresh.get('a.pdf')).toBeNull();        // not restored yet
    fresh.restore('a.pdf');
    expect(fresh.get('a.pdf')).toBe('b.pdf');
    expect(fresh.get('b.pdf')).toBe('a.pdf'); // restore mirrors both directions
  });

  test('getLive returns the partner only when it is open', async () => {
    const { PdfLinks } = await import('../src/store/pdf-links');
    const links = new PdfLinks(makeFakeStorage());
    links.link('a.pdf', 'b.pdf');
    expect(links.getLive('a.pdf', () => false)).toBeNull();
    expect(links.getLive('a.pdf', (f) => f === 'b.pdf')).toBe('b.pdf');
  });
});
