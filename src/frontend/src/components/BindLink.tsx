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
  /** Optional second section, rendered after a separator (e.g. "link another PDF"). */
  secondary?: {
    label: string;
    boundNames: string[];
    options: string[];
    onToggle: (name: string | null) => void;
  };
}

/**
 * Link icon that opens a dropdown to manage board↔PDF associations.
 * Multi-select: boards can link multiple PDFs.
 */
export function BindLink({ boundNames, options, onToggle, title, headerItem, secondary }: BindLinkProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const linked = boundNames.length > 0 || (secondary?.boundNames.length ?? 0) > 0;
  const showPrimary = options.length > 0 || !!headerItem;

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
          {showPrimary && (
          <>
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
          </>
          )}
          {secondary && secondary.options.length > 0 && (
          <>
            {showPrimary && <div className="bind-link-separator" />}
            <div className="bind-link-section-label">{secondary.label}</div>
            <div
              className="bind-link-option bind-link-clear"
              data-testid="bind-link-pdf-clear"
              onClick={(e) => { e.stopPropagation(); secondary.onToggle(null); resetTimer(); }}
            >
              (none)
            </div>
            {secondary.options.map(name => {
              const isBound = secondary.boundNames.includes(name);
              return (
                <div
                  key={`sec-${name}`}
                  className={`bind-link-option ${isBound ? 'active' : ''}`}
                  data-testid="bind-link-pdf-option"
                  onClick={(e) => { e.stopPropagation(); secondary.onToggle(name); resetTimer(); }}
                >
                  <span className="bind-link-check">{isBound ? '✓' : ' '}</span>
                  {name}
                </div>
              );
            })}
          </>
          )}
        </div>
      )}
    </div>
  );
}
