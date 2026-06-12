import { useState } from 'react';
import { useSectionSearchState } from './SettingsSearch';
import type { SearchSectionId } from './search-index';

/**
 * Self-managed collapsible section — same visual structure as the main
 * `CollapsibleSection` inside SettingsPanel.tsx, but the open/close state
 * is owned locally and persisted to localStorage under its own key. Use
 * for sections that are not deep-linkable from the mockup (no SectionId
 * routing needed).
 */
export function StandaloneCollapsibleSection({
  title, defaultOpen = true, storageKey, searchSectionId, summary, children,
}: {
  title: string;
  defaultOpen?: boolean;
  storageKey: string;
  /** Match against the static search index. When the active query targets
   *  this section (or a control within it), the section auto-opens and
   *  non-target sections hide. Omit to opt out of search integration. */
  searchSectionId?: SearchSectionId;
  /** Optional status summary rendered in the header next to the chevron —
   *  visible while the section is collapsed (e.g. "on · daily"). */
  summary?: React.ReactNode;
  children: React.ReactNode;
}) {
  const fullKey = `boardripper-settings-standalone-open-${storageKey}`;
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(fullKey);
      if (raw === '0') return false;
      if (raw === '1') return true;
    } catch { /* ignore */ }
    return defaultOpen;
  });
  const search = useSectionSearchState(searchSectionId ?? ('__none__' as SearchSectionId));
  // When no searchSectionId given, opt out: never hidden by search, never
  // force-opened.
  const hidden = searchSectionId ? search.hidden : false;
  const forceOpen = searchSectionId ? search.forceOpen : false;
  if (hidden) return null;
  const effectiveOpen = forceOpen || open;
  const toggle = () => {
    setOpen(prev => {
      const next = !prev;
      try { localStorage.setItem(fullKey, next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  };
  return (
    <div className="settings-section">
      <button className="settings-section-header" onClick={toggle}>
        <span className="settings-section-title">{title}</span>
        {summary != null && <span className="settings-section-summary">{summary}</span>}
        <span className="settings-section-chevron">{effectiveOpen ? '▾' : '▸'}</span>
      </button>
      {effectiveOpen && <div className="settings-section-body">{children}</div>}
    </div>
  );
}
