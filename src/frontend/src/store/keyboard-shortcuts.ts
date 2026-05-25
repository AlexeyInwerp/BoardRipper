/**
 * Keyboard shortcuts registry — defines all shortcuts, platform detection, and label formatting.
 */

export const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform ?? navigator.userAgent);

/** Modifier key that acts as the "command" key on each platform */
export const MOD = isMac ? 'Meta' : 'Control';
const MOD_LABEL = isMac ? '\u2318' : 'Ctrl';
const ALT_LABEL = isMac ? '\u2325' : 'Alt';
const SHIFT_LABEL = isMac ? '\u21E7' : 'Shift';

export interface Shortcut {
  id: string;
  /** Human label shown in settings */
  label: string;
  /** Category for grouping */
  category: 'file' | 'view' | 'navigation' | 'pdf' | 'wsad';
  /** Key code (e.event.key) — case-insensitive match */
  key: string;
  /** Alternative key (for Mac PageUp/Down → Cmd+Up/Down) */
  altKey?: string;
  /** Required modifier flags */
  mod?: boolean;   // Cmd on Mac, Ctrl on Win/Linux
  alt?: boolean;   // Option on Mac, Alt on Win/Linux
  shift?: boolean;
  /** For alt binding: use mod instead of nothing */
  altMod?: boolean;
  /** Short description for tooltip */
  description: string;
  /** When set, match KeyboardEvent.code instead of e.key. Accepts a single
   *  code (e.g. 'Backquote') or an array of codes (e.g.
   *  ['Backquote', 'IntlBackslash']) — the latter is useful for keys whose
   *  physical position varies across layouts (German Mac reports the
   *  ^/° key as IntlBackslash, US reports Backquote, etc.). */
  code?: string | string[];
  /** Explicit label override for formatShortcut(). Used when matching by
   *  `code` but wanting a friendly printed character (e.g. show '~' for
   *  Backquote). When set, overrides the formatKeyName() result. */
  displayLabel?: string;
  /** When true, the matcher accepts the event regardless of whether shift is
   *  held. Use sparingly — only for shortcuts where the physical key carries
   *  the meaning and the shift state is incidental (e.g. `~` on US is
   *  Shift+Backquote, `°` on DE is also Shift+Backquote — both should
   *  toggle the library). */
  ignoreShift?: boolean;
}

export const shortcuts: Shortcut[] = [
  // --- File ---
  {
    id: 'openBoard',
    label: 'Open Board',
    category: 'file',
    key: 'o',
    mod: true,
    description: 'Open a board file',
  },
  {
    id: 'openPdf',
    label: 'Open PDF',
    category: 'file',
    key: 'p',
    mod: true,
    description: 'Open a PDF schematic',
  },
  {
    id: 'focusSearch',
    label: 'Find',
    category: 'file',
    key: 'f',
    mod: true,
    description: 'Prefill PDF search with selection (or focus it). Repeat Cmd/Ctrl+F = next, Shift+Cmd/Ctrl+F = previous. Enter = next, Shift+Enter = previous. Up/Down = next/previous.',
  },
  {
    id: 'copySelection',
    label: 'Copy Selection',
    category: 'file',
    key: 'c',
    mod: true,
    description: 'Copy the selected component, pin, or net name to the clipboard (board panel). Highlighted text still copies normally.',
  },

  // --- View ---
  {
    id: 'flipBoard',
    label: 'Flip Board',
    category: 'view',
    key: ' ',         // Space
    description: 'Toggle between top and bottom layer',
  },
  {
    id: 'rotateCW',
    label: 'Rotate CW',
    category: 'view',
    key: 'ArrowRight',
    mod: true,
    description: 'Rotate the board 90° clockwise',
  },
  {
    id: 'rotateCCW',
    label: 'Rotate CCW',
    category: 'view',
    key: 'ArrowLeft',
    mod: true,
    description: 'Rotate the board 90° counter-clockwise',
  },
  {
    id: 'mirrorBoard',
    label: 'Mirror Board',
    category: 'view',
    key: 'ArrowUp',
    mod: true,
    description: 'Mirror the board horizontally',
  },
  {
    id: 'panLeft',
    label: 'Pan Left',
    category: 'view',
    key: 'ArrowLeft',
    alt: true,
    description: 'Move the view left',
  },
  {
    id: 'panRight',
    label: 'Pan Right',
    category: 'view',
    key: 'ArrowRight',
    alt: true,
    description: 'Move the view right',
  },
  {
    id: 'panUp',
    label: 'Pan Up',
    category: 'view',
    key: 'ArrowUp',
    alt: true,
    description: 'Move the view up',
  },
  {
    id: 'panDown',
    label: 'Pan Down',
    category: 'view',
    key: 'ArrowDown',
    alt: true,
    description: 'Move the view down',
  },

  // --- Navigation ---
  {
    id: 'pageDown',
    label: 'PDF Next Page',
    category: 'navigation',
    key: 'PageDown',
    description: 'Go to the next PDF page',
  },
  {
    id: 'pageUp',
    label: 'PDF Previous Page',
    category: 'navigation',
    key: 'PageUp',
    description: 'Go to the previous PDF page',
  },

  // --- PDF Viewer ---
  {
    id: 'pdfFitWidth',
    label: 'Fit to Width',
    category: 'pdf',
    key: ' ',         // Space
    description: 'Reset zoom to fit page width (when PDF panel is active)',
  },
  {
    id: 'pdfNextPage',
    label: 'Next Page',
    category: 'pdf',
    key: 'ArrowDown',
    description: 'Go to next PDF page (when PDF panel is active)',
  },
  {
    id: 'pdfPrevPage',
    label: 'Previous Page',
    category: 'pdf',
    key: 'ArrowUp',
    description: 'Go to previous PDF page (when PDF panel is active)',
  },

  // --- WSAD Navigation ---
  {
    id: 'panBoardLeft',
    label: 'Pan Left',
    category: 'wsad',
    key: 'a',
    description: 'Move the view left (board or PDF)',
  },
  {
    id: 'panBoardRight',
    label: 'Pan Right',
    category: 'wsad',
    key: 'd',
    description: 'Move the view right (board or PDF)',
  },
  {
    id: 'panBoardUp',
    label: 'Pan Up',
    category: 'wsad',
    key: 'w',
    description: 'Move the view up (board or PDF)',
  },
  {
    id: 'panBoardDown',
    label: 'Pan Down',
    category: 'wsad',
    key: 's',
    description: 'Move the view down (board or PDF)',
  },
  {
    id: 'rotateBoardCCW',
    label: 'Rotate CCW',
    category: 'wsad',
    key: 'q',
    description: 'Rotate the board 90° counter-clockwise',
  },
  {
    id: 'rotateBoardCW',
    label: 'Rotate CW',
    category: 'wsad',
    key: 'e',
    description: 'Rotate the board 90° clockwise',
  },
  {
    id: 'zoomBoardIn',
    label: 'Zoom In',
    category: 'wsad',
    key: 'w',
    shift: true,
    description: 'Zoom in at the canvas center (board or PDF)',
  },
  {
    id: 'zoomBoardOut',
    label: 'Zoom Out',
    category: 'wsad',
    key: 's',
    shift: true,
    description: 'Zoom out at the canvas center (board or PDF)',
  },

  // --- File (extended) ---
  {
    id: 'toggleLibrary',
    label: 'Toggle Library',
    category: 'file',
    key: '',
    code: ['Backquote', 'IntlBackslash'],
    displayLabel: '~',
    description: 'Open or close the Library sidebar (key left of `1`, layout-independent — works as `~` on US, `°` on DE, etc.)',
    ignoreShift: true,
  },
];

/** Find a shortcut by id */
export function getShortcut(id: string): Shortcut | undefined {
  return shortcuts.find(s => s.id === id);
}

/** Format a shortcut as a human-readable string for tooltips */
export function formatShortcut(id: string): string {
  const s = getShortcut(id);
  if (!s) return '';
  return formatShortcutDef(s);
}

function formatShortcutDef(s: Shortcut): string {
  const parts: string[] = [];
  if (s.mod) parts.push(MOD_LABEL);
  if (s.alt) parts.push(ALT_LABEL);
  if (s.shift) parts.push(SHIFT_LABEL);
  parts.push(s.displayLabel ?? formatKeyName(s.key));

  const primary = parts.join(isMac ? '' : '+');

  // If there's an alt binding (Mac only: Cmd+Arrow for PageUp/Down)
  if (s.altKey && isMac) {
    const altParts: string[] = [];
    if (s.altMod) altParts.push(MOD_LABEL);
    altParts.push(formatKeyName(s.altKey));
    return `${primary} / ${altParts.join('')}`;
  }

  return primary;
}

function formatKeyName(key: string): string {
  switch (key) {
    case ' ': return 'Space';
    case 'ArrowLeft': return isMac ? '\u2190' : 'Left';
    case 'ArrowRight': return isMac ? '\u2192' : 'Right';
    case 'ArrowUp': return isMac ? '\u2191' : 'Up';
    case 'ArrowDown': return isMac ? '\u2193' : 'Down';
    case 'PageUp': return isMac ? 'PgUp' : 'PgUp';
    case 'PageDown': return isMac ? 'PgDn' : 'PgDn';
    case 'Backquote': return '~';
    default: return key.toUpperCase();
  }
}

/** Check if a keyboard event matches a shortcut */
export function matchesShortcut(e: KeyboardEvent, s: Shortcut): boolean {
  const modKey = isMac ? e.metaKey : e.ctrlKey;

  // Check primary binding
  if (matchesBinding(e, s.key, s.code, s.mod ? modKey : undefined, s.alt ? e.altKey : undefined, s.shift ? e.shiftKey : undefined, s.mod, s.alt, s.shift, s.ignoreShift)) {
    return true;
  }

  // Check alt binding (e.g. Cmd+Down for PageDown on Mac)
  if (s.altKey) {
    // Alt bindings reject shift (ignoreShift=false → shift events rejected by the symmetric guard).
    if (matchesBinding(e, s.altKey, undefined, s.altMod ? modKey : undefined, false, undefined, s.altMod, false, false, false)) {
      return true;
    }
  }

  return false;
}

function matchesBinding(
  e: KeyboardEvent,
  key: string,
  code: string | string[] | undefined,
  _modPressed: boolean | undefined,
  _altPressed: boolean | undefined,
  _shiftPressed: boolean | undefined,
  requireMod?: boolean,
  requireAlt?: boolean,
  requireShift?: boolean,
  ignoreShift?: boolean,
): boolean {
  // Key match: when `code` is set, match KeyboardEvent.code (layout-independent)
  // and ignore `key` entirely. Otherwise match e.key case-insensitively.
  if (code !== undefined) {
    const codes = Array.isArray(code) ? code : [code];
    if (!codes.includes(e.code)) return false;
  } else {
    if (e.key.toLowerCase() !== key.toLowerCase() && e.key !== key) return false;
  }

  const modKey = isMac ? e.metaKey : e.ctrlKey;

  // Modifier checks
  if (requireMod && !modKey) return false;
  if (!requireMod && modKey) return false;
  if (requireAlt && !e.altKey) return false;
  if (!requireAlt && e.altKey) return false;
  if (requireShift && !e.shiftKey) return false;
  if (!requireShift && e.shiftKey && !ignoreShift) return false;

  return true;
}
