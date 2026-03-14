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
  category: 'file' | 'view' | 'navigation';
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

  // --- View ---
  {
    id: 'flipBoard',
    label: 'Flip Board',
    category: 'view',
    key: ' ',         // Space
    description: 'Toggle between top and bottom layer',
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
    altKey: 'ArrowDown',
    altMod: true,
    description: 'Go to the next PDF page',
  },
  {
    id: 'pageUp',
    label: 'PDF Previous Page',
    category: 'navigation',
    key: 'PageUp',
    altKey: 'ArrowUp',
    altMod: true,
    description: 'Go to the previous PDF page',
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
  parts.push(formatKeyName(s.key));

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
    default: return key.toUpperCase();
  }
}

/** Check if a keyboard event matches a shortcut */
export function matchesShortcut(e: KeyboardEvent, s: Shortcut): boolean {
  const modKey = isMac ? e.metaKey : e.ctrlKey;

  // Check primary binding
  if (matchesBinding(e, s.key, s.mod ? modKey : undefined, s.alt ? e.altKey : undefined, s.shift ? e.shiftKey : undefined, s.mod, s.alt, s.shift)) {
    return true;
  }

  // Check alt binding (e.g. Cmd+Down for PageDown on Mac)
  if (s.altKey) {
    if (matchesBinding(e, s.altKey, s.altMod ? modKey : undefined, false, undefined, s.altMod, false, false)) {
      return true;
    }
  }

  return false;
}

function matchesBinding(
  e: KeyboardEvent,
  key: string,
  _modPressed: boolean | undefined,
  _altPressed: boolean | undefined,
  _shiftPressed: boolean | undefined,
  requireMod?: boolean,
  requireAlt?: boolean,
  requireShift?: boolean,
): boolean {
  // Key match (case-insensitive)
  if (e.key.toLowerCase() !== key.toLowerCase() && e.key !== key) return false;

  const modKey = isMac ? e.metaKey : e.ctrlKey;

  // Modifier checks
  if (requireMod && !modKey) return false;
  if (!requireMod && modKey) return false;
  if (requireAlt && !e.altKey) return false;
  if (!requireAlt && e.altKey) return false;
  if (requireShift && !e.shiftKey) return false;

  return true;
}
