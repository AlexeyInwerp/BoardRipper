/** Resize Mode popup — the in-canvas control that appears at the click point
 *  when a board element is clicked in Resize Mode. Edits the one global
 *  RenderSettings key that governs the clicked element class; the whole board
 *  previews live as the value changes.
 *
 *  Interaction: −/+ buttons, a slider, direct number entry, and wheel-to-nudge
 *  while the pointer is over the popup. Closes on Escape or outside click. */
import { useRef, useEffect, useSyncExternalStore, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { resizeModeStore, RESIZE_TARGETS } from '../store/resize-mode-store';

function subscribe(cb: () => void) {
  return resizeModeStore.subscribe(cb);
}

export function ResizePopup() {
  const snap = useSyncExternalStore(subscribe, () => resizeModeStore.snapshot());
  const ref = useRef<HTMLDivElement>(null);
  const popup = snap.popup;

  // Close on Escape / outside click while a popup is open.
  useEffect(() => {
    if (!popup) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') resizeModeStore.close(); };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) resizeModeStore.close();
    };
    document.addEventListener('keydown', onKey);
    // Defer outside-click wiring so the opening click doesn't immediately close it.
    const t = setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
      clearTimeout(t);
    };
  }, [popup]);

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    resizeModeStore.nudge(e.deltaY < 0 ? 1 : -1);
  }, []);

  if (!popup) return null;
  const def = RESIZE_TARGETS[popup.kind];

  // Clamp to viewport so the popup never opens off-screen.
  const W = 240, H = 132;
  const left = Math.min(Math.max(8, popup.pageX + 12), window.innerWidth - W - 8);
  const top = Math.min(Math.max(8, popup.pageY + 12), window.innerHeight - H - 8);

  return createPortal(
    <div
      ref={ref}
      onWheel={onWheel}
      style={{
        position: 'fixed', left, top, width: W, zIndex: 4000,
        background: 'var(--bg-secondary)', color: 'var(--text-primary)',
        border: '1px solid var(--border)', borderRadius: 8,
        boxShadow: '0 6px 24px var(--scrim-strong, rgba(0,0,0,0.4))',
        padding: '10px 12px', font: '12px/1.4 system-ui, sans-serif',
        userSelect: 'none',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <strong style={{ fontSize: 13, color: 'var(--accent)' }}>{def.label}</strong>
        <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' }}>
          {popup.value}<span style={{ opacity: 0.6, marginLeft: 3 }}>{def.unit}</span>
        </span>
      </div>
      {popup.context && (
        <div style={{ color: 'var(--text-secondary)', opacity: 0.85, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {popup.context}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
        <button onClick={() => resizeModeStore.nudge(-1)} style={btnStyle} title={`− ${def.step}`}>−</button>
        <input
          type="range"
          min={def.min} max={def.max} step={def.step} value={popup.value}
          onChange={(e) => resizeModeStore.commit(Number(e.target.value))}
          style={{ flex: 1, accentColor: 'var(--accent)' }}
        />
        <button onClick={() => resizeModeStore.nudge(1)} style={btnStyle} title={`+ ${def.step}`}>+</button>
      </div>

      <div style={{ marginTop: 6, color: 'var(--text-secondary)', opacity: 0.7, fontSize: 11 }}>
        {def.hint} · scroll to adjust
      </div>
    </div>,
    document.body,
  );
}

const btnStyle: React.CSSProperties = {
  width: 26, height: 26, flex: '0 0 auto',
  border: '1px solid var(--border)', borderRadius: 5,
  background: 'var(--bg-tertiary)', color: 'var(--text-primary)',
  fontSize: 16, lineHeight: '1', cursor: 'pointer',
};
