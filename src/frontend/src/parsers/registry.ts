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

/**
 * Try each registered format's detect() in registration order.
 * Returns the first match, or null if none recognised.
 */
export function detectFormat(header: Uint8Array): FormatDescriptor | null {
  for (const fmt of _formats) {
    if (fmt.detect(header)) return fmt;
  }
  return null;
}

export function getFormat(id: FormatId): FormatDescriptor | undefined {
  return _formats.find(f => f.id === id);
}

export function getAllFormats(): FormatDescriptor[] {
  return [..._formats];
}

/** All file extensions accepted across all registered formats. */
export function getAllExtensions(): string[] {
  return [...new Set(_formats.flatMap(f => f.extensions))];
}

/** Fallback: match a format by file extension when content detection fails. */
export function detectByExtension(fileName: string): FormatDescriptor | null {
  const ext = ('.' + fileName.split('.').pop()!).toLowerCase();
  for (const fmt of _formats) {
    if (fmt.extensions.includes(ext)) return fmt;
  }
  return null;
}
