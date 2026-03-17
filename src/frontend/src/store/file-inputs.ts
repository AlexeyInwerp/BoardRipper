/**
 * Shared refs to hidden file input elements.
 * Set by Toolbar, read by useKeyboardShortcuts.
 */
export const fileInputRefs = {
  board: null as HTMLInputElement | null,
  pdf: null as HTMLInputElement | null,
  search: null as HTMLInputElement | null,
};
