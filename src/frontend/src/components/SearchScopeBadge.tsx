/**
 * Shared scope indicator used by the toolbar global search dropdown and
 * the component right-click menu. Single source of truth for the [B]/[P]/[L]
 * visual tag so color / label / shape can be evolved in one place.
 */

export type SearchScope = 'board' | 'pdf' | 'library';

const BADGES: Record<SearchScope, { label: string }> = {
  board:   { label: 'B' },
  pdf:     { label: 'P' },
  library: { label: 'L' },
};

export function SearchScopeBadge({ scope }: { scope: SearchScope }) {
  return (
    <span className={`toolbar-search-tag toolbar-search-tag-${scope}`}>
      {BADGES[scope].label}
    </span>
  );
}
