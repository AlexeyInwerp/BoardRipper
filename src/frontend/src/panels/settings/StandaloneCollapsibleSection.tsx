import { useState } from 'react';

/**
 * Self-managed collapsible section — same visual structure as the main
 * `CollapsibleSection` inside SettingsPanel.tsx, but the open/close state
 * is owned locally and persisted to localStorage under its own key. Use
 * for sections that are not deep-linkable from the mockup (no SectionId
 * routing needed).
 */
export function StandaloneCollapsibleSection({
  title, defaultOpen = true, storageKey, children,
}: {
  title: string;
  defaultOpen?: boolean;
  storageKey: string;
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
        <span className="settings-section-chevron">{open ? '▾' : '▸'}</span>
      </button>
      {open && <div className="settings-section-body">{children}</div>}
    </div>
  );
}
