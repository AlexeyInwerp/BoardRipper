/** Resize Mode popup — appears at the click point with the handles relevant to
 *  what was clicked (a pin shows pin/number/net sizes; a component shows label
 *  + outline; empty board shows board opacity). Each row edits one global
 *  RenderSettings key and the whole board previews live.
 *
 *  Per row: −/+ buttons, a slider (double-click = reset to default), and
 *  wheel-over-the-row to nudge. Popup closes on Escape or outside click.
 *
 *  These handles write GLOBAL, PERSISTED settings — every board, every
 *  session. That is the feature, but it made a stray drag indistinguishable
 *  from a rendering bug: nothing afterwards said a value had been changed, and
 *  the only undo (double-click) was invisible. So a changed row is marked and
 *  carries its own ⟲, and the footer says where the change lands and offers
 *  one click to put the whole group back.
 *
 *  MOUNT ONCE, app-level (App.tsx). Both the popup state and the settings it
 *  edits are global, so a per-board-panel mount produced one instance per open
 *  board tab: identical popups stacked on document.body, each with its own
 *  "mousedown outside → close" listener. Pressing a handle in the topmost one
 *  is *outside* every other instance, so they closed the shared store and the
 *  popup vanished the moment you touched it. */
import { useRef, useEffect, useSyncExternalStore, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { resizeModeStore, CONTROLS } from '../store/resize-mode-store';
import { DEFAULTS, type RenderSettings } from '../store/render-settings';

function subscribe(cb: () => void) {
  return resizeModeStore.subscribe(cb);
}

const toHex = (v: number) => '#' + (v & 0xffffff).toString(16).padStart(6, '0');

function ControlRow({ k }: { k: keyof RenderSettings }) {
  const def = CONTROLS[k as string];
  const value = resizeModeStore.valueOf(k);
  const isColor = def.type === 'color';
  const modified = resizeModeStore.isModified(k);
  const onWheel = useCallback((e: React.WheelEvent) => {
    if (isColor) return;
    e.stopPropagation();
    resizeModeStore.nudge(k, e.deltaY < 0 ? 1 : -1);
  }, [k, isColor]);

  return (
    <div onWheel={onWheel} style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontSize: 12 }}>
          {def.label}
          {modified && (
            <span
              data-testid="resize-modified-dot"
              title="Changed from the default"
              style={{ color: 'var(--accent-text)', marginLeft: 4 }}
            >
              •
            </span>
          )}
        </span>
        <span style={{
          fontVariantNumeric: 'tabular-nums',
          color: modified ? 'var(--accent-text)' : 'var(--text-secondary)',
          fontSize: 12,
        }}>
          {isColor ? toHex(value) : value}{!isColor && def.unit && <span style={{ opacity: 0.6, marginLeft: 3 }}>{def.unit}</span>}
        </span>
      </div>
      {isColor ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 }}>
          <input
            type="color"
            value={toHex(value)}
            onChange={(e) => resizeModeStore.commit(k, parseInt(e.target.value.slice(1), 16))}
            style={{ flex: 1, height: 26, padding: 0, border: '1px solid var(--border)', borderRadius: 5, background: 'transparent', cursor: 'pointer' }}
          />
          <button onClick={() => resizeModeStore.reset(k)} style={btnStyle} title="Reset to default">⟲</button>
        </div>
      ) : (
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
          {modified && (
            <button
              data-testid="resize-row-reset"
              onClick={() => resizeModeStore.reset(k)}
              style={btnStyle}
              title={`Reset ${def.label} to its default (${DEFAULTS[k] as number})`}
            >
              ⟲
            </button>
          )}
        </div>
      )}
      <div style={{ fontSize: 10.5, opacity: 0.6, marginTop: 2, lineHeight: 1.3 }}>{def.hint}</div>
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

  if (!snap.enabled || !popup) return null;

  const groupModified = popup.keys.some(k => resizeModeStore.isModified(k));

  const W = 250;
  const maxH = window.innerHeight - 24;
  const H = Math.min(maxH, 60 + popup.keys.length * 68);
  const left = Math.min(Math.max(8, popup.pageX + 12), window.innerWidth - W - 8);
  const top = Math.min(Math.max(8, popup.pageY + 12), window.innerHeight - H - 8);

  return createPortal(
    <div
      ref={ref}
      data-testid="resize-popup"
      style={{
        position: 'fixed', left, top, width: W, zIndex: 4000,
        maxHeight: maxH, overflowY: 'auto',
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

      <div style={{
        marginTop: 8, paddingTop: 6, borderTop: '1px solid var(--border)',
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8,
        color: 'var(--text-secondary)', fontSize: 11,
      }}>
        <span style={{ opacity: 0.8 }}>
          {groupModified ? 'Changed — saved for every board' : 'Saved for every board'}
        </span>
        <button
          data-testid="resize-reset-all"
          onClick={() => resizeModeStore.resetKeys(popup.keys)}
          disabled={!groupModified}
          style={{
            background: 'none', border: 'none', padding: 0, font: 'inherit',
            color: groupModified ? 'var(--accent-text)' : 'var(--text-secondary)',
            opacity: groupModified ? 1 : 0.45,
            cursor: groupModified ? 'pointer' : 'default',
            textDecoration: groupModified ? 'underline' : 'none',
            whiteSpace: 'nowrap', flex: 'none',
          }}
          title={groupModified ? 'Put every handle here back to its default' : 'Nothing here has been changed'}
        >
          Reset all
        </button>
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
