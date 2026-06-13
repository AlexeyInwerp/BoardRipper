import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';

interface BindLinkProps {
  /** Currently bound target names */
  boundNames: string[];
  /** List of available targets to bind to */
  options: string[];
  /** Called when user toggles a binding (name to add/remove, or null to clear all) */
  onToggle: (name: string | null) => void;
  /** Tooltip for the link icon */
  title?: string;
  /** Section header rendered above the primary options list (e.g. "Boardview"). */
  primaryLabel?: string;
  /** Text rendered inside the button while nothing is linked — turns the bare
   *  glyph into a discoverable affordance (e.g. "Link board…"). */
  unlinkedLabel?: string;
  /** Render the dropdown in a portal to <body> with position:fixed. Required
   *  when the button lives inside a clipped / transformed container (e.g. a
   *  dockview tab header) — an in-flow absolute dropdown there is clipped, and
   *  position:fixed alone resolves against the transformed ancestor, not the
   *  viewport, so it lands in the wrong place. */
  fixedDropdown?: boolean;
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
 *
 * The menu stays open until the user clicks outside or presses Escape —
 * the old 5s auto-close timer kept closing it mid-decision.
 */
export function BindLink({ boundNames, options, onToggle, title, primaryLabel, unlinkedLabel, fixedDropdown, headerItem, secondary }: BindLinkProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [dropPos, setDropPos] = useState<{ top: number; left: number } | null>(null);
  const linked = boundNames.length > 0 || (secondary?.boundNames.length ?? 0) > 0;
  const showPrimary = options.length > 0 || !!headerItem;

  useEffect(() => {
    if (!open) return;
    if (fixedDropdown && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setDropPos({ top: r.bottom + 4, left: r.left });
    }
    const onMouse = (e: MouseEvent) => {
      const t = e.target as Node;
      // The dropdown may be portaled outside `ref`, so check it explicitly —
      // otherwise clicking an option counts as an outside click and closes it.
      if (ref.current?.contains(t) || dropdownRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onMouse);
    document.addEventListener('keydown', onKey);
    // A position:fixed dropdown's coords are captured once; close it on any
    // scroll/resize rather than render it detached from its button.
    const onReflow = fixedDropdown ? () => setOpen(false) : null;
    if (onReflow) {
      window.addEventListener('scroll', onReflow, true);
      window.addEventListener('resize', onReflow);
    }
    return () => {
      document.removeEventListener('mousedown', onMouse);
      document.removeEventListener('keydown', onKey);
      if (onReflow) {
        window.removeEventListener('scroll', onReflow, true);
        window.removeEventListener('resize', onReflow);
      }
    };
  }, [open, fixedDropdown]);

  const handleSelect = (name: string) => {
    onToggle(name);
  };

  const handleClear = () => {
    onToggle(null);
  };

  // Don't render the portaled (fixed) dropdown until its coords are measured,
  // so it never flashes at 0,0 before positioning.
  const dropdownReady = !fixedDropdown || dropPos != null;

  const dropdown = open && dropdownReady ? (
    <div
      ref={dropdownRef}
      className="bind-link-dropdown"
      style={fixedDropdown && dropPos ? { position: 'fixed', top: dropPos.top, left: dropPos.left, marginTop: 0, zIndex: 10050 } : undefined}
    >
      {showPrimary && (
      <>
      {primaryLabel && <div className="bind-link-section-label">{primaryLabel}</div>}
      {headerItem && (
        <div
          className="bind-link-option bind-link-header"
          onClick={(e) => { e.stopPropagation(); headerItem.onChange(!headerItem.checked); }}
        >
          <span className="bind-link-check">{headerItem.checked ? '✓' : ' '}</span>
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
            <span className="bind-link-check">{isBound ? '✓' : ' '}</span>
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
          onClick={(e) => { e.stopPropagation(); secondary.onToggle(null); }}
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
              onClick={(e) => { e.stopPropagation(); secondary.onToggle(name); }}
            >
              <span className="bind-link-check">{isBound ? '✓' : ' '}</span>
              {name}
            </div>
          );
        })}
      </>
      )}
    </div>
  ) : null;

  return (
    <div className="bind-link" ref={ref}>
      <button
        ref={btnRef}
        className={`bind-link-btn ${linked ? 'bound' : ''}`}
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        title={title ?? (linked ? `Linked: ${boundNames.join(', ')}` : 'Not linked')}
      >
        {linked ? '∞' : '○○'}
        {!linked && unlinkedLabel && (
          <span className="bind-link-unlinked-label">{unlinkedLabel}</span>
        )}
      </button>
      {/* Portal the fixed-position dropdown to <body> so it escapes the
          dockview tab header's clipping/transform; the in-flow variant
          (PDF toolbar) renders inline as before. */}
      {fixedDropdown ? (dropdown && createPortal(dropdown, document.body)) : dropdown}
    </div>
  );
}
