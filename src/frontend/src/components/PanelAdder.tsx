import { useState, useEffect, useRef } from 'react';
import type { IDockviewHeaderActionsProps } from 'dockview-react';

/** All re-openable sidebar panels */
const SIDEBAR_PANELS = [
  { id: 'componentInfo', component: 'componentInfo', title: 'Info' },
  { id: 'netList', component: 'netList', title: 'Nets' },
  { id: 'searchResults', component: 'searchResults', title: 'Search' },
  { id: 'settings', component: 'settings', title: 'Settings' },
] as const;

export function PanelAdder({ containerApi, group }: IDockviewHeaderActionsProps) {
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState<typeof SIDEBAR_PANELS[number][]>([]);
  const ref = useRef<HTMLDivElement>(null);

  // Recompute hidden panels whenever dockview layout changes
  useEffect(() => {
    const update = () => {
      const missing = SIDEBAR_PANELS.filter(
        (p) => !containerApi.getPanel(p.id)
      );
      setHidden(prev => {
        // Use sorted JSON comparison to avoid false matches if a panel ID contains a comma
        const ids = JSON.stringify(missing.map(m => m.id).sort());
        const prevIds = JSON.stringify(prev.map(m => m.id).sort());
        return ids === prevIds ? prev : missing;
      });
    };

    update();
    const d1 = containerApi.onDidAddPanel(update);
    const d2 = containerApi.onDidRemovePanel(update);
    return () => { d1.dispose(); d2.dispose(); };
  }, [containerApi]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Don't render the button if there are no hidden panels
  if (hidden.length === 0) return null;

  const handleAdd = (panel: typeof SIDEBAR_PANELS[number]) => {
    setOpen(false);
    // Add the panel into the same group where the + button lives
    containerApi.addPanel({
      id: panel.id,
      component: panel.component,
      title: panel.title,
      position: { referenceGroup: group },
    });
  };

  return (
    <div className="panel-adder" ref={ref}>
      <button
        className="panel-adder-btn"
        onClick={() => setOpen(!open)}
        title="Add panel"
      >
        +
      </button>
      {open && (
        <div className="panel-adder-dropdown">
          {hidden.map((p) => (
            <button
              key={p.id}
              className="panel-adder-item"
              onClick={() => handleAdd(p)}
            >
              {p.title}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
