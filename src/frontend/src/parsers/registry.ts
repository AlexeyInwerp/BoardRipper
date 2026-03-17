import type { BoardData } from './types';

export type FormatId = string;

/**
 * A self-describing format module. To add a new format:
 *   1. Create a new *-format.ts file implementing this interface.
 *   2. Call registerFormat() in parsers/index.ts.
 *   3. Add the file extension to the backend allowlist (files.go).
 *
 * That's it — no other code needs to change.
 */
export interface FormatDescriptor {
  /** Short identifier used in BoardData.format (e.g. 'BVR1', 'BRD'). */
  id: FormatId;
  /** Human-readable display name (e.g. 'BV Raw Format 1'). */
  name: string;
  /** File extensions handled by this format, lowercase with dot (e.g. ['.bvr', '.bv']). */
  extensions: string[];
  /** One-line description shown in the UI and format list. */
  description: string;
  /** Optional link to the format spec in docs/formats/. */
  docUrl?: string;

  /** Whether the Y axis needs flipping for correct screen display. Default: false. */
  flipY?: boolean;

  /** Whether top/bottom sides are swapped relative to the standard convention. Default: false.
   *  When true, the initial view shows Bottom instead of Top. */
  swapSides?: boolean;

  /**
   * Content-based format detection.
   * Receives the first 512 bytes (or fewer if the file is smaller).
   * Return true if this format recognises the content.
   * Preferred over extension-based detection to handle renamed files.
   */
  detect: (header: Uint8Array) => boolean;

  /**
   * Parse the full file.
   * Receives the complete file as an ArrayBuffer — handles both text and binary formats.
   */
  parse: (buffer: ArrayBuffer) => BoardData | Promise<BoardData>;
}

const _formats: FormatDescriptor[] = [];

export function registerFormat(fmt: FormatDescriptor): void {
  _formats.push(fmt);
}

/* ── Runtime format overrides (persisted in localStorage) ── */

const FORMAT_OVERRIDES_KEY = 'boardviewer-format-overrides';

export interface FormatOverrides {
  flipY?: boolean;
  swapSides?: boolean;
}

type OverridesMap = Record<FormatId, FormatOverrides>;

let _overrides: OverridesMap = {};
try {
  const raw = localStorage.getItem(FORMAT_OVERRIDES_KEY);
  if (raw) _overrides = JSON.parse(raw);
} catch { /* ignore */ }

/** Apply user overrides to a format descriptor (returns a new object). */
function applyOverrides(fmt: FormatDescriptor): FormatDescriptor {
  const ov = _overrides[fmt.id];
  if (!ov) return fmt;
  return {
    ...fmt,
    flipY: ov.flipY ?? fmt.flipY,
    swapSides: ov.swapSides ?? fmt.swapSides,
  };
}

export function getFormatOverrides(): OverridesMap {
  return _overrides;
}

export function setFormatOverride(id: FormatId, key: keyof FormatOverrides, value: boolean): void {
  if (!_overrides[id]) _overrides[id] = {};
  const fmt = _formats.find(f => f.id === id);
  const builtinValue = fmt ? fmt[key] ?? false : false;
  if (value === builtinValue) {
    // Matches built-in default — remove override
    delete _overrides[id][key];
    if (Object.keys(_overrides[id]).length === 0) delete _overrides[id];
  } else {
    _overrides[id][key] = value;
  }
  try { localStorage.setItem(FORMAT_OVERRIDES_KEY, JSON.stringify(_overrides)); } catch { /* ignore */ }
}

/**
 * Try each registered format's detect() in registration order.
 * Returns the first match, or null if none recognised.
 */
export function detectFormat(header: Uint8Array): FormatDescriptor | null {
  for (const fmt of _formats) {
    if (fmt.detect(header)) return applyOverrides(fmt);
  }
  return null;
}

export function getFormat(id: FormatId): FormatDescriptor | undefined {
  const fmt = _formats.find(f => f.id === id);
  return fmt ? applyOverrides(fmt) : undefined;
}

export function getAllFormats(): FormatDescriptor[] {
  return _formats.map(applyOverrides);
}

/** All file extensions accepted across all registered formats. */
export function getAllExtensions(): string[] {
  return [...new Set(_formats.flatMap(f => f.extensions))];
}

/** Extract the lowercased file extension including the dot (e.g. '.bvr'). */
export function getFileExtension(fileName: string): string {
  return ('.' + (fileName.split('.').pop() ?? '')).toLowerCase();
}

/** Fallback: match a format by file extension when content detection fails. */
export function detectByExtension(fileName: string): FormatDescriptor | null {
  const ext = getFileExtension(fileName);
  for (const fmt of _formats) {
    if (fmt.extensions.includes(ext)) return fmt;
  }
  return null;
}
