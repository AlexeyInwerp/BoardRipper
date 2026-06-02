import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { searchSettings, hasIndexEntryFor, getSectionForField, type MatchResult, type SearchSectionId } from './search-index';

interface SearchContextValue {
  query: string;
  active: boolean;
  matches: MatchResult;
  setQuery: (q: string) => void;
  clear: () => void;
}

const EMPTY_MATCHES: MatchResult = {
  fieldMatches: new Set(),
  sectionMatches: new Set(),
  wholeSectionMatches: new Set(),
  perTabCount: new Map(),
  total: 0,
};

const SettingsSearchContext = createContext<SearchContextValue>({
  query: '',
  active: false,
  matches: EMPTY_MATCHES,
  setQuery: () => {},
  clear: () => {},
});

export function useSettingsSearch(): SearchContextValue {
  return useContext(SettingsSearchContext);
}

/** Helper: returns the per-row state a Slider/Toggle should respect.
 *  Looks up its own section from the index. */
export function useFieldSearchState(field: string): { hidden: boolean; matched: boolean } {
  const { active, matches } = useSettingsSearch();
  if (!active) return { hidden: false, matched: false };
  const matched = matches.fieldMatches.has(field);
  if (matched) return { hidden: false, matched: true };
  // Whole-section override: when the user searches for the section name
  // itself (e.g. "navigation"), we want every control in that section to
  // stay visible, even if no individual label matched.
  const section = getSectionForField(field);
  if (section && matches.wholeSectionMatches.has(section)) {
    return { hidden: false, matched: false };
  }
  return { hidden: true, matched: false };
}

/** Helper: returns whether a section should render at all (visibility) and
 *  whether it should be forced open (when search is active). */
export function useSectionSearchState(section: SearchSectionId): { hidden: boolean; forceOpen: boolean; wholeSection: boolean } {
  const { active, matches } = useSettingsSearch();
  if (!active) return { hidden: false, forceOpen: false, wholeSection: false };
  const visible = matches.sectionMatches.has(section);
  return {
    hidden: !visible,
    forceOpen: visible,
    wholeSection: matches.wholeSectionMatches.has(section),
  };
}

export function SettingsSearchProvider({ children }: { children: React.ReactNode }) {
  const [query, setQueryRaw] = useState('');
  const matches = useMemo(() => searchSettings(query), [query]);
  const setQuery = useCallback((q: string) => setQueryRaw(q), []);
  const clear = useCallback(() => setQueryRaw(''), []);
  const value = useMemo(() => ({
    query, active: query.trim().length > 0, matches, setQuery, clear,
  }), [query, matches, setQuery, clear]);
  return (
    <SettingsSearchContext.Provider value={value}>
      {children}
    </SettingsSearchContext.Provider>
  );
}

/** The search box itself. Owns its own input element so global `/` shortcut
 *  can focus it from anywhere inside the Settings panel. */
export function SettingsSearchBar() {
  const { query, active, matches, setQuery, clear } = useSettingsSearch();
  const inputRef = useRef<HTMLInputElement>(null);

  // `/` keyboard shortcut focuses the field. Only active when the Settings
  // panel is mounted; the bar's parent (SettingsPanel) controls mounting.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Don't hijack `/` when the user is typing in an input/textarea.
      const target = e.target as HTMLElement | null;
      const inEditable = !!target && (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      );
      if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !inEditable) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      if (query) {
        e.preventDefault();
        clear();
      } else {
        inputRef.current?.blur();
      }
    }
  };

  return (
    <div className={`settings-search-row${active ? ' settings-search-active' : ''}`}>
      <span className="settings-search-icon" aria-hidden="true">⌕</span>
      <input
        ref={inputRef}
        type="text"
        className="settings-search-input"
        placeholder="Search settings  ( / to focus )"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKey}
        aria-label="Search settings"
      />
      {active && (
        <>
          <span className="settings-search-count" aria-live="polite">
            {matches.total === 0 ? 'no match' : matches.total === 1 ? '1 match' : `${matches.total} matches`}
          </span>
          <button
            type="button"
            className="settings-search-clear"
            onClick={() => { clear(); inputRef.current?.focus(); }}
            title="Clear search (Esc)"
            aria-label="Clear search"
          >
            ✕
          </button>
        </>
      )}
    </div>
  );
}

// ── Dev-time index validation ──────────────────────────────────────────────
//
// Each Slider/Toggle calls `recordRenderedField(field)` on mount. In dev
// mode (import.meta.env.DEV) we warn once if a rendered field isn't in the
// static SETTINGS_INDEX, so the index drifts out of sync are noisy fast
// instead of silent.

const warnedFields = new Set<string>();

export function recordRenderedField(field: string): void {
  if (!import.meta.env.DEV) return;
  if (warnedFields.has(field)) return;
  if (!hasIndexEntryFor(field)) {
    warnedFields.add(field);
    // eslint-disable-next-line no-console
    console.warn(
      `[SettingsSearch] no index entry for field "${field}". ` +
      `Add an entry to panels/settings/search-index.ts so this control is searchable.`
    );
  }
}
