import { Emitter } from './emitter';
import { useSyncExternalStore } from 'react';

/**
 * Tracks the Library file-list load so the LibraryPanel header can render a
 * progress strip ("Streaming 12 480 / 81 700 files…") instead of looking
 * frozen while the network/IDB pipeline runs.
 *
 * Distinct from `loadProgressStore` (which tracks per-file board fetches +
 * scene build) — that one shows a full-screen overlay; this one is an inline
 * strip the panel embeds in its existing statsbar.
 *
 * Lifecycle:
 *   begin(note?)              → opens with phase='connecting'
 *   setPhase(phase, note?)    → connecting → cache → streaming → finalizing
 *   advance(done, total?)     → updates counter (called per stream batch)
 *   finish()                  → phase='done', strip auto-hides
 *   error(message)            → phase='error', strip stays with retry CTA
 */

export type LibraryLoadPhase =
  | 'idle'
  | 'connecting'
  | 'cache'
  | 'streaming'
  | 'finalizing'
  | 'done'
  | 'error';

export interface LibraryLoadSnapshot {
  phase: LibraryLoadPhase;
  /** Files delivered to the store so far. */
  done: number;
  /** Best-known total. Zero while unknown. */
  total: number;
  /** Free-form label rendered next to the phase chip. */
  note: string;
  /** Set when phase === 'error'. */
  error: string | null;
}

const initialSnapshot: LibraryLoadSnapshot = {
  phase: 'idle',
  done: 0,
  total: 0,
  note: '',
  error: null,
};

class LibraryLoadStore extends Emitter {
  private _snap: LibraryLoadSnapshot = initialSnapshot;

  getSnapshot(): LibraryLoadSnapshot { return this._snap; }

  private _patch(p: Partial<LibraryLoadSnapshot>) {
    this._snap = { ...this._snap, ...p };
    this.notify();
  }

  begin(note = '') {
    this._snap = { ...initialSnapshot, phase: 'connecting', note };
    this.notify();
  }

  setPhase(phase: LibraryLoadPhase, note?: string) {
    this._patch({ phase, ...(note !== undefined ? { note } : {}) });
  }

  /** Update the counter. `total === undefined` keeps the previous value. */
  advance(done: number, total?: number) {
    if (total !== undefined && total !== this._snap.total) {
      this._patch({ done, total });
    } else {
      this._patch({ done });
    }
  }

  finish() {
    this._patch({ phase: 'done', error: null });
  }

  error(message: string) {
    this._patch({ phase: 'error', error: message });
  }

  /** Reset to idle. */
  reset() {
    this._snap = initialSnapshot;
    this.notify();
  }
}

export const libraryLoadStore = new LibraryLoadStore();

export function useLibraryLoad(): LibraryLoadSnapshot {
  return useSyncExternalStore(
    (l) => libraryLoadStore.subscribe(l),
    () => libraryLoadStore.getSnapshot(),
    () => libraryLoadStore.getSnapshot(),
  );
}
