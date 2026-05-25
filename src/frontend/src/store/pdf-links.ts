/**
 * Pure link-state machine for PDF↔PDF cross-lookup.
 *
 * Holds a symmetric 1:1 mapping fileName ↔ partnerFileName, persisted through
 * an injectable LinkStorage (localStorage in the app, an in-memory fake in
 * tests). No pdf.js / React deps so it is unit-testable in the Node test
 * runner. Liveness (is the partner currently open?) is decided by the caller
 * via an injected predicate — this module does not know about open documents.
 */

const PDF_LINK_KEY_PREFIX = 'pdf-link:';

export interface LinkStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

const browserStorage: LinkStorage = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* quota */ } },
  remove: (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

export class PdfLinks {
  private links = new Map<string, string>();
  private storage: LinkStorage;

  constructor(storage: LinkStorage = browserStorage) {
    this.storage = storage;
  }

  /** Pull a persisted link for fileName into the in-memory map (call on open).
   *  Storage holds both directions, so mirror both to keep the map symmetric
   *  even if the partner has not opened yet. */
  restore(fileName: string): void {
    const partner = this.storage.get(PDF_LINK_KEY_PREFIX + fileName);
    if (partner) {
      this.links.set(fileName, partner);
      this.links.set(partner, fileName);
    }
  }

  /** The linked partner regardless of whether it is currently open, or null. */
  get(fileName: string): string | null {
    return this.links.get(fileName) ?? null;
  }

  /** The linked partner only if isOpen(partner) is true, else null. */
  getLive(fileName: string, isOpen: (f: string) => boolean): string | null {
    const partner = this.links.get(fileName);
    return partner && isOpen(partner) ? partner : null;
  }

  /** Link a↔b. Enforces 1:1 by freeing any prior link on either file first. */
  link(a: string, b: string): void {
    if (!a || !b || a === b) return;
    this.unlink(a);
    this.unlink(b);
    this.links.set(a, b);
    this.links.set(b, a);
    this.storage.set(PDF_LINK_KEY_PREFIX + a, b);
    this.storage.set(PDF_LINK_KEY_PREFIX + b, a);
  }

  /** Remove the link on a and on its partner (both directions). */
  unlink(a: string): void {
    const partner = this.links.get(a);
    this.links.delete(a);
    this.storage.remove(PDF_LINK_KEY_PREFIX + a);
    if (partner) {
      this.links.delete(partner);
      this.storage.remove(PDF_LINK_KEY_PREFIX + partner);
    }
  }
}
