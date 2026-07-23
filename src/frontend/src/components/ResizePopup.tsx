/** Resize Mode popup — appears at the click point with the handles relevant to
 *  what was clicked (a pin shows pin/number/net sizes; a component shows label
 *  + outline; empty board shows board opacity). Each row edits one global
 *  RenderSettings key and the whole board previews live.
 *
 *  Per row: −/+ buttons, a slider (double-click = reset to default), and
 *  wheel-over-the-row to nudge. Popup closes on Escape or outside click. */
import { useRef, useEffect, useSyncExternalStore, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { resizeModeStore, CONTROLS } from '../store/resize-mode-store';
import type { RenderSettings } from '../store/render-settings';

function subscribe(cb: () => void) {
  return resizeModeStore.subscribe(cb);
}

function ControlRow({ k }: { k: keyof RenderSettings }) {
  const def = CONTROLS[k as string];
  const value = resizeModeStore.valueOf(k);
  const onWheel = useCallback((e: React.WheelEvent) => {
    e.stopPropagation();
    resizeModeStore.nudge(k, e.deltaY < 0 ? 1 : -1);
  }, [k]);

  return (
    <div onWheel={onWheel} style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontSize: 12 }}>{def.label}</span>
        <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)', fontSize: 12 }}>
          {value}{def.unit && <span style={{ opacity: 0.6, marginLeft: 3 }}>{def.unit}</span>}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 }}>
        <button onClick={() => resizeModeStore.nudge(k, -1)} style={btnStyle} title={`− ${def.step}`}>−</button>
        <input
          type="range"
          min={def.min} max={def.max} step={def.step} value={value}
          onChange={(e) => resizeModeStore.commit(k, Number(e.target.value))}
          onDoubleClick={() => resizeModeStore.reset(k)}
          title="Double-click to reset to default"
          style={{ flex: 1, accentColor: 'var(--accent)' }}
        />
        <button onClick={() => resizeModeStore.nudge(k, 1)} style={btnStyle} title={`+ ${def.step}`}>+</button>
      </div>
    </div>
  );
}

export function ResizePopup() {
  const snap = useSyncExternalStore(subscribe, () => resizeModeStore.snapshot());
  const ref = useRef<HTMLDivElement>(null);
  const popup = snap.popup;

  useEffect(() => {
    if (!popup) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') resizeModeStore.close(); };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) resizeModeStore.close();
    };
    document.addEventListener('keydown', onKey);
    const t = setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
      clearTimeout(t);
    };
  }, [popup]);

  if (!popup) return null;

  const W = 250;
  const H = 60 + popup.keys.length * 52;
  const left = Math.min(Math.max(8, popup.pageX + 12), window.innerWidth - W - 8);
  const top = Math.min(Math.max(8, popup.pageY + 12), window.innerHeight - H - 8);

  return createPortal(
    <div
      ref={ref}
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
        <strong style={{ fontSize: 13, color: 'var(--accent)' }}>{popup.title}</strong>
        {popup.context && (
          <span style={{ color: 'var(--text-secondary)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 150 }}>
            {popup.context}
          </span>
        )}
      </div>

      {popup.keys.map((k) => <ControlRow key={k as string} k={k} />)}

      <div style={{ marginTop: 8, color: 'var(--text-secondary)', opacity: 0.7, fontSize: 11 }}>
        scroll a row to adjust · double-click to reset
      </div>
    </div>,
    document.body,
  );
}

const btnStyle: React.CSSProperties = {
  width: 24, height: 24, flex: '0 0 auto',
  border: '1px solid var(--border)', borderRadius: 5,
  background: 'var(--bg-tertiary)', color: 'var(--text-primary)',
  fontSize: 15, lineHeight: '1', cursor: 'pointer',
};
