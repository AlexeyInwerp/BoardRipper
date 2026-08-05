/**
 * FZ decryption key store.
 *
 * BoardRipper no longer bundles the RC6 key required to decrypt encrypted .fz
 * files. The key is third-party material we do not own and do not redistribute.
 * Users obtain it themselves — either by clicking the in-app "Fetch from
 * GitHub" button (which pulls the public `cryptonek/illegal-numbers` mirror)
 * or by pasting bytes from any other public source. The key is validated
 * against the 44-bit parity fingerprint from OpenBoardView before being
 * persisted to localStorage.
 *
 * This module is the single source of truth for the key plus a promise-based
 * gate (`ensureFzKey`) used by board-store when an FZ file load throws
 * `FZKeyError`.
 */

import { Emitter } from './emitter';
import { validateFZKey } from '../parsers/fz-parser';
import { log } from './log-store';

const STORAGE_KEY = 'boardripper-fz-key';
const STORAGE_KEY_CAE = 'boardripper-cae-key';

/** Which product's key is meant. ASUS `.fz` and ASRock `.cae` share the
 *  container and the cipher; only the key differs (issue #25). */
export type FzKeyKind = 'fz' | 'cae';

export const KEY_KIND_LABEL: Record<FzKeyKind, string> = {
  fz: 'ASUS .fz',
  cae: 'ASRock .cae',
};

/**
 * Public GitHub sources for the FZ key, tried in order. The fetch falls
 * through to the next mirror on network failure or if the response doesn't
 * contain a key that passes parity validation.
 *
 * The cyrozap/pcbrepair-rs mirror is intentionally excluded — its last word
 * (`0x0945692e`) is corrupted and fails the FZ parity fingerprint, so it
 * cannot decrypt files even though it appears in GitHub code search.
 */
export const FZ_KEY_SOURCES: Array<{ url: string; label: string }> = [
  {
    url: 'https://raw.githubusercontent.com/cryptonek/illegal-numbers/main/FZkey.md',
    label: 'github.com/cryptonek/illegal-numbers',
  },
  {
    url: 'https://raw.githubusercontent.com/yliu-d/illegal-numbers/main/FZkey.md',
    label: 'github.com/yliu-d/illegal-numbers (mirror)',
  },
];

/**
 * Parse a free-form text blob into a 44 × uint32 array.
 *
 * Accepts any hex tokens of the form `0xNNNNNNNN` (or bare 8-hex tokens)
 * separated by whitespace, commas, semicolons, or newlines. Tolerates
 * leading/trailing decoration like markdown code fences.
 *
 * Returns null if fewer than 44 valid hex tokens are found.
 */
export function parseFzKeyText(text: string): Uint32Array | null {
  const tokens = text.match(/0x[0-9a-fA-F]{1,8}|[0-9a-fA-F]{8}/g) ?? [];
  if (tokens.length < 44) return null;
  // Take the first 44 — if the source has stray hex elsewhere we still get
  // the canonical block (which is the first 44 in every known mirror).
  const out = new Uint32Array(44);
  for (let i = 0; i < 44; i++) {
    const t = tokens[i].toLowerCase().startsWith('0x') ? tokens[i].slice(2) : tokens[i];
    out[i] = parseInt(t, 16) >>> 0;
  }
  return out;
}

/** Format a key back to hex (4 words per line) for display/export. */
export function formatFzKey(key: Uint32Array): string {
  const lines: string[] = [];
  for (let i = 0; i < key.length; i += 4) {
    const row: string[] = [];
    for (let j = 0; j < 4 && i + j < key.length; j++) {
      row.push('0x' + key[i + j].toString(16).padStart(8, '0'));
    }
    lines.push(row.join('  '));
  }
  return lines.join('\n');
}

function loadFromStorage(): Uint32Array | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const key = parseFzKeyText(raw);
    if (!key) return null;
    if (!validateFZKey(key)) {
      // Corrupted entry — clear it so we don't keep rejecting.
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return key;
  } catch {
    return null;
  }
}

/**
 * Dev-only convenience: a gitignored `src/frontend/.env.local` may define
 * `VITE_FZ_KEY` (44 hex words) so encrypted `.fz` fixtures decrypt without the
 * key dialog during `vite` dev. Never reaches production — Vite statically
 * replaces `import.meta.env.DEV` with `false` (this branch tree-shakes away) and
 * the file is absent from the Docker build context, so `VITE_FZ_KEY` resolves
 * to `undefined` regardless. The key still passes the parity gate below.
 */
function loadDevKey(): Uint32Array | null {
  try {
    if (!import.meta.env?.DEV) return null;
    const raw = import.meta.env.VITE_FZ_KEY as string | undefined;
    if (!raw) return null;
    const key = parseFzKeyText(raw);
    return key && validateFZKey(key) ? key : null;
  } catch {
    return null;
  }
}

function saveToStorage(key: Uint32Array): void {
  try {
    localStorage.setItem(STORAGE_KEY, formatFzKey(key));
  } catch {
    // quota / disabled storage — keep in-memory only
  }
}

/** Load the CAE key. Unlike the FZ key there is no published parity
 *  fingerprint to check it against, so validation is structural (44 words)
 *  and the real proof is functional: the parser accepts whichever stored key
 *  decrypts a given file to valid zlib. */
function loadCaeFromStorage(): Uint32Array | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_CAE);
    return raw ? parseFzKeyText(raw) : null;
  } catch {
    return null;
  }
}

class FZKeyStore extends Emitter {
  /** Cached key (null if unset). Treat as immutable from outside. */
  key: Uint32Array | null = loadFromStorage() ?? loadDevKey();

  /** Cached ASRock .cae key (null if unset). Same container and cipher as
   *  `key`, different constant — see FzKeyKind. */
  caeKey: Uint32Array | null = loadCaeFromStorage();

  /** True while the FZKeyDialog should be visible. */
  dialogOpen = false;

  /** Which key the open dialog is asking for. Set by `ensureFzKey`. */
  dialogKind: FzKeyKind = 'fz';

  /**
   * Resolvers awaiting `ensureFzKey`. When the dialog closes (with or without
   * a key being saved), every resolver fires with the current `key !== null`.
   */
  private _pending: Array<(ok: boolean) => void> = [];

  /** True if a valid key is currently configured for `kind`. */
  hasKey(kind: FzKeyKind = 'fz'): boolean {
    return (kind === 'cae' ? this.caeKey : this.key) !== null;
  }

  /** Every configured key, in the order the parser should try them. The
   *  parser probes each against the file rather than trusting the extension,
   *  so a mislabelled file still opens. */
  allKeys(): Uint32Array[] {
    return [this.key, this.caeKey].filter((k): k is Uint32Array => k !== null);
  }

  /**
   * Try to set a new key from a hex text blob. Returns an error message on
   * failure, or null on success. Notifies subscribers and resolves any
   * pending `ensureFzKey` promises when successful.
   */
  setKeyFromText(text: string, kind: FzKeyKind = 'fz'): string | null {
    const parsed = parseFzKeyText(text);
    if (!parsed) return 'Could not find 44 hex words in the input.';
    if (kind === 'fz') {
      // The FZ key has a published parity fingerprint, so a wrong paste can be
      // rejected up front rather than at the next file open.
      if (!validateFZKey(parsed)) return 'Parity check failed — the bytes are not a valid FZ key.';
      this.key = parsed;
      saveToStorage(parsed);
    } else {
      // No published fingerprint for the CAE key — structure is all we can
      // check here; the parser proves it functionally on the next .cae.
      this.caeKey = parsed;
      try { localStorage.setItem(STORAGE_KEY_CAE, formatFzKey(parsed)); } catch { /* quota */ }
    }
    this.notify();
    this._resolvePending(true);
    return null;
  }

  /** Erase a stored key. Notifies subscribers. */
  clearKey(kind: FzKeyKind = 'fz'): void {
    if (kind === 'cae') {
      this.caeKey = null;
      try { localStorage.removeItem(STORAGE_KEY_CAE); } catch { /* ignore */ }
    } else {
      this.key = null;
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    }
    this.notify();
  }

  /**
   * Try each public mirror in order until one yields a parity-valid key.
   * Returns an error message describing the last failure, or null on success.
   */
  async fetchAndApply(): Promise<string | null> {
    const errors: string[] = [];
    for (const src of FZ_KEY_SOURCES) {
      let body: string;
      try {
        const res = await fetch(src.url, { credentials: 'omit' });
        if (!res.ok) { errors.push(`${src.label}: HTTP ${res.status}`); continue; }
        body = await res.text();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.parser.warn('FZ key fetch failed:', src.label, msg);
        errors.push(`${src.label}: ${msg}`);
        continue;
      }
      const err = this.setKeyFromText(body);
      if (!err) return null; // success
      errors.push(`${src.label}: ${err}`);
    }
    return `All mirrors failed:\n${errors.join('\n')}`;
  }

  /** Open the dialog. Idempotent. */
  openDialog(): void {
    if (this.dialogOpen) return;
    this.dialogOpen = true;
    this.notify();
  }

  /**
   * Close the dialog. Resolves any pending `ensureFzKey` promises with the
   * current key state.
   */
  closeDialog(): void {
    if (!this.dialogOpen) return;
    this.dialogOpen = false;
    this.notify();
    this._resolvePending(this.hasKey(this.dialogKind));
  }

  /**
   * Promise-based gate. Resolves true once a valid key is configured (either
   * immediately, or after the user provides one through the dialog). Resolves
   * false if the user dismisses the dialog without saving.
   */
  ensureFzKey(kind: FzKeyKind = 'fz'): Promise<boolean> {
    if (this.hasKey(kind)) return Promise.resolve(true);
    this.dialogKind = kind;
    return new Promise<boolean>((resolve) => {
      this._pending.push(resolve);
      this.openDialog();
    });
  }

  private _resolvePending(ok: boolean): void {
    const pending = this._pending;
    this._pending = [];
    for (const r of pending) r(ok);
  }
}

export const fzKeyStore = new FZKeyStore();

// Convenience accessor for the parser/registry layer — kept as a free function
// so callers don't have to import the singleton class identity.
export function getFzKey(): Uint32Array | null {
  return fzKeyStore.key;
}

/** Every configured key, for parsers that probe rather than assume. */
export function getFzKeys(): Uint32Array[] {
  return fzKeyStore.allKeys();
}
