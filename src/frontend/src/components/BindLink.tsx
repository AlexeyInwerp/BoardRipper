import { useState, useRef, useEffect } from 'react';

interface BindLinkProps {
  /** Currently bound target names */
  boundNames: string[];
  /** List of available targets to bind to */
  options: string[];
  /** Called when user toggles a binding (name to add/remove, or null to clear all) */
  onToggle: (name: string | null) => void;
  /** Tooltip for the link icon */
  title?: string;
  /** Optional header item shown above the bindings list (e.g. "auto-open boardview" toggle) */
  headerItem?: {
    label: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
  };
}

/**
 * Link icon that opens a dropdown to manage board↔PDF associations.
 * Multi-select: boards can link multiple PDFs.
 */
export function BindLink({ boundNames, options, onToggle, title, headerItem }: BindLinkProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const linked = boundNames.length > 0;

  const resetTimer = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setOpen(false), 5000);
  };

  useEffect(() => {
    if (!open) {
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
      return;
    }
    resetTimer();
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    };
  }, [open]);

  const handleSelect = (name: string) => {
    onToggle(name);
    resetTimer();
  };

  const handleClear = () => {
    onToggle(null);
    resetTimer();
  };

  return (
    <div className="bind-link" ref={ref}>
      <button
        className={`bind-link-btn ${linked ? 'bound' : ''}`}
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        title={title ?? (linked ? `Linked: ${boundNames.join(', ')}` : 'Not linked')}
      >
        {linked ? '\u221E' : '\u25CB\u25CB'}
      </button>
      {open && (
        <div className="bind-link-dropdown">
          {headerItem && (
            <div
              className="bind-link-option bind-link-header"
              onClick={(e) => { e.stopPropagation(); headerItem.onChange(!headerItem.checked); resetTimer(); }}
            >
              <span className="bind-link-check">{headerItem.checked ? '✓' : '\u00A0'}</span>
              {headerItem.label}
            </div>
          )}
          <div
            className="bind-link-option bind-link-clear"
            onClick={handleClear}
          >
            (none)
          </div>
          {options.map(name => {
            const isBound = boundNames.includes(name);
            return (
              <div
                key={name}
                className={`bind-link-option ${isBound ? 'active' : ''}`}
                onClick={() => handleSelect(name)}
              >
                <span className="bind-link-check">{isBound ? '✓' : '\u00A0'}</span>
                {name}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
