/**
 * RangeControl — the one slider type.
 *
 * A div-drawn slider (track · fill · thumb) so the plain slider and the
 * on/off slider look identical. With `onToggle` the control is also a
 * switch: clicking the thumb turns the thing on or off, dragging sets the
 * value (and turns it on), and the parent may make its label a second
 * toggle. Off = empty fill and a hollow thumb; the value is kept. No icon,
 * no word — decided 2026-09-16 (docs/specs/2026-09-15-view-settings-review.md).
 *
 * Keyboard: ← → ↑ ↓ one step (Shift ×5), Page ×10, Home/End; Space/Enter
 * toggle when a toggle handler is given. Double-click on the track resets to
 * `defaultValue` (never on the thumb in toggle mode — that would be two
 * toggles). Tap-vs-drag on the thumb uses a 4 px threshold.
 */
import { useCallback, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { ratioToValue, valueToRatio, keyboardDelta } from './range-math';

export interface RangeControlProps {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  /** On/off mode. `on === false` draws the control empty; the thumb click
   *  calls `onToggle`. Any value change while off turns it on first. */
  on?: boolean;
  onToggle?: (next: boolean) => void;
  /** Double-click on the track resets to this. */
  defaultValue?: number;
  ariaLabel?: string;
  /** Emitted on drag start/end so a parent can show a hint tooltip. */
  onDragChange?: (dragging: boolean) => void;
  className?: string;
  testId?: string;
}

const DRAG_THRESHOLD_PX = 4;

export function RangeControl({
  value, min, max, step, onChange, on, onToggle, defaultValue, ariaLabel, onDragChange, className, testId,
}: RangeControlProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ onThumb: boolean; moved: number; downX: number; active: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const toggleMode = typeof onToggle === 'function';
  const isOff = toggleMode && on === false;
  const ratio = valueToRatio(value, min, max);

  const setFromClientX = useCallback((clientX: number) => {
    const el = rootRef.current; if (!el) return;
    const r = el.getBoundingClientRect();
    const next = ratioToValue((clientX - r.left) / Math.max(1, r.width), min, max, step);
    if (isOff) onToggle!(true);
    if (next !== value) onChange(next);
  }, [min, max, step, value, onChange, isOff, onToggle]);

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const el = rootRef.current; if (!el) return;
    el.setPointerCapture(e.pointerId);
    const onThumb = (e.target as HTMLElement).classList.contains('rc-thumb');
    drag.current = { onThumb, moved: 0, downX: e.clientX, active: true };
    setDragging(true); onDragChange?.(true);
    // In toggle mode a press on the thumb is decided on release: tap = toggle,
    // drag = adjust. Everywhere else the press already sets the value.
    if (toggleMode && onThumb) return;
    setFromClientX(e.clientX);
  }, [toggleMode, setFromClientX, onDragChange]);

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current; if (!d || !d.active) return;
    d.moved = Math.max(d.moved, Math.abs(e.clientX - d.downX));
    if (toggleMode && d.onThumb && d.moved < DRAG_THRESHOLD_PX) return;
    setFromClientX(e.clientX);
  }, [toggleMode, setFromClientX]);

  const endDrag = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current; if (!d || !d.active) return;
    d.active = false; setDragging(false); onDragChange?.(false);
    try { rootRef.current?.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (toggleMode && d.onThumb && d.moved < DRAG_THRESHOLD_PX) onToggle!(!(on ?? true));
  }, [toggleMode, onToggle, on, onDragChange]);

  const onDoubleClick = useCallback((e: ReactPointerEvent<HTMLDivElement> | React.MouseEvent<HTMLDivElement>) => {
    if (defaultValue === undefined) return;
    if (toggleMode && (e.target as HTMLElement).classList.contains('rc-thumb')) return;
    onChange(defaultValue);
  }, [defaultValue, toggleMode, onChange]);

  const onKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if (toggleMode && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); onToggle!(!(on ?? true)); return; }
    let next: number | null = null;
    if (e.key === 'Home') next = min;
    else if (e.key === 'End') next = max;
    else {
      const d = keyboardDelta(e.key, step, e.shiftKey);
      if (d !== null) next = ratioToValue(valueToRatio(value + d, min, max), min, max, step);
    }
    if (next === null) return;
    e.preventDefault();
    if (isOff) onToggle!(true);
    if (next !== value) onChange(next);
  }, [toggleMode, onToggle, on, min, max, step, value, onChange, isOff]);

  const cls = ['rc', toggleMode ? 'rc-toggle' : '', isOff ? 'rc-off' : '', dragging ? 'rc-dragging' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <div
      ref={rootRef}
      className={cls}
      role="slider"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={isOff ? `off, ${value}` : String(value)}
      data-testid={testId}
      data-on={toggleMode ? String(!isOff) : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
    >
      <div className="rc-track" />
      <div className="rc-fill" style={{ width: `${ratio * 100}%` }} />
      <div className="rc-thumb" style={{ left: `${ratio * 100}%` }} title={toggleMode ? (isOff ? 'Click to turn on · drag to set' : 'Click to turn off · drag to set') : undefined} />
    </div>
  );
}
