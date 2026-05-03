/**
 * Theme registry. Adding a theme = (1) append an entry to `themes` below
 * and (2) define matching `:root[data-theme="<id>"] { ... }` CSS overrides
 * in src/frontend/src/index.css. Every consumer (the home dashboard
 * theme selector, future settings panel switcher, etc.) reads from this
 * list, so new themes show up automatically — no UI edits required.
 */

export interface Theme {
  /** localStorage key + value of the [data-theme] attribute on <html>. */
  id: string;
  /** Human label shown in the picker. */
  label: string;
  /** Optional one-line description shown as a tooltip on the option. */
  description?: string;
}

export const themes: Theme[] = [
  {
    id: 'dark',
    label: 'Dark',
    description: 'Default — cyber-dark with cyan accents.',
  },
  {
    id: 'noir',
    label: 'Noir',
    description: 'Pure-black background with amber accents — least eye-light at night.',
  },
  {
    id: 'dimmed',
    label: 'Dimmed',
    description: 'Lower contrast, softer accents — comfortable for long sessions.',
  },
];

export const DEFAULT_THEME_ID = 'dark';

export function isValidTheme(id: string): boolean {
  return themes.some((t) => t.id === id);
}
