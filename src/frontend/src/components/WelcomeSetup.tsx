/**
 * First-run welcome / input setup modal.
 *
 * "Demonstrate to set": the user picks one of four actions (Board Pan/Zoom,
 * PDF Pan/Zoom) and performs the gesture they want for it in a shared test
 * window. We detect the gesture, bind it, auto-fill its opposite, tick the
 * chip, and auto-advance to the next surface. OS momentum is detected live and
 * leaves BoardRipper's own glide OFF so the two don't compound. Everything is
 * applied on Save; the verbose Debug-panel recognizer remains for inspection.
 *
 * Styling reuses the .library-modal-* shell plus .welcome-* additions.
 */

import { useSyncExternalStore, useState, useRef, useEffect, useCallback } from 'react';
import { welcomeStore } from '../store/welcome-store';
import { renderSettingsStore } from '../store/render-settings';
import {
  SCROLL_BINDINGS_KEY,
  PDF_INERTIA_KEY,
  loadScrollBindings,
  type ScrollBindings,
} from '../panels/PdfViewerPanel';
import {
  WheelGestureClassifier,
  InertiaDetector,
  classifyPointerDrag,
  recommendSetting,
  type GestureVerdict,
  type PointerSample,
  type Surface,
  type Action,
  type BoardSettingPatch,
} from '../store/input-recognizer';
import { log } from '../store/log-store';

type ActionKey = 'board-pan' | 'board-zoom' | 'pdf-pan' | 'pdf-zoom';
const QUIET_GAP_MS = 250;

function parse(key: ActionKey): { surface: Surface; action: Action } {
  const [surface, action] = key.split('-') as [Surface, Action];
  return { surface, action };
}

function boardGesture(action: Action, twoFingerPan: boolean, dragToZoom: boolean): string {
  if (action === 'pan') {
    const parts = [twoFingerPan ? 'scroll' : 'Shift+scroll'];
    if (!dragToZoom) parts.push('drag');
    return parts.join(' · ');
  }
  const parts = [twoFingerPan ? 'Shift+scroll' : 'scroll', 'pinch'];
  if (dragToZoom) parts.push('drag');
  return parts.join(' · ');
}

function pdfGesture(action: Action, b: ScrollBindings): string {
  const slot = (['bare', 'shift', 'meta'] as const).find(s => b[s] === action);
  const base = slot === 'bare' ? 'scroll'
    : slot === 'shift' ? 'Shift+scroll'
    : slot === 'meta' ? 'Cmd/Ctrl+scroll'
    : '—';
  // The PDF always pans by dragging and zooms by pinch (built in).
  return action === 'zoom' ? `${base} · pinch` : `${base} · drag`;
}

export function WelcomeSetup() {
  const open = useSyncExternalStore(welcomeStore.subscribe, welcomeStore.getSnapshot);
  if (!open) return null;
  return <WelcomeSetupBody />;
}

function WelcomeSetupBody() {
  const initialTfp = renderSettingsStore.globalSettings.twoFingerPan;

  const [boardPatch, setBoardPatch] = useState<BoardSettingPatch>({});
  const [pdf, setPdf] = useState<ScrollBindings>(() => loadScrollBindings());
  const [momentum, setMomentum] = useState(() => !renderSettingsStore.globalSettings.disableInertia);
  const [osMomentum, setOsMomentum] = useState(false);
  const [target, setTarget] = useState<ActionKey>('board-pan');
  const [boardTouched, setBoardTouched] = useState(false);
  const [pdfTouched, setPdfTouched] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  const initialDtz = renderSettingsStore.globalSettings.dragToZoom;
  const tfp = boardPatch.twoFingerPan ?? initialTfp;
  const dtz = boardPatch.dragToZoom ?? initialDtz;

  const boxRef = useRef<HTMLDivElement>(null);
  const classifierRef = useRef(new WheelGestureClassifier());
  const inertiaRef = useRef(new InertiaDetector());
  const lastWheelRef = useRef(0);

  const gestureFor = (key: ActionKey): string => {
    const { surface, action } = parse(key);
    return surface === 'board' ? boardGesture(action, tfp, dtz) : pdfGesture(action, pdf);
  };

  const capture = useCallback((verdict: GestureVerdict) => {
    const { surface, action } = parse(target);
    const rec = recommendSetting({ surface, action, verdict, currentPdf: pdf });
    if (!rec.ok) {
      setFeedback({ ok: false, text: rec.summary });
      return;
    }
    if (rec.board) setBoardPatch(prev => ({ ...prev, ...rec.board }));
    if (rec.pdf) setPdf(rec.pdf);

    const nextBoardTouched = boardTouched || surface === 'board';
    const nextPdfTouched = pdfTouched || surface === 'pdf';
    setBoardTouched(nextBoardTouched);
    setPdfTouched(nextPdfTouched);
    setFeedback({ ok: true, text: `detected: ${verdict.label}` });

    // Auto-advance to the first surface that hasn't been set yet.
    if (!nextBoardTouched) setTarget('board-pan');
    else if (!nextPdfTouched) setTarget('pdf-pan');
  }, [target, pdf, boardTouched, pdfTouched]);

  // Live capture: native wheel (passive:false) so we can preventDefault and
  // Ctrl+wheel pinch doesn't zoom the page. Inertia is fed every event (the
  // momentum tail needs the whole burst); the gesture is captured once per
  // burst, on the first event after a quiet gap.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { verdict } = classifierRef.current.feed(e);
      const inertia = inertiaRef.current.feed(e);
      if (inertia.hasInertia) {
        setMomentum(false);
        setOsMomentum(true);
      }
      const now = performance.now();
      const gap = lastWheelRef.current > 0 ? now - lastWheelRef.current : Infinity;
      lastWheelRef.current = now;
      if (gap > QUIET_GAP_MS) capture(verdict);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [capture]);

  // Click-drag capture. Listen on window so a drag that leaves the box still
  // completes; an AbortController tears both listeners down on pointerup.
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    const drag = {
      startX: e.clientX, startY: e.clientY, startT: performance.now(),
      button: e.button, pointerType: e.pointerType,
      lastX: e.clientX, lastY: e.clientY, moveCount: 0,
      shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey,
    };
    const ctrl = new AbortController();
    const { signal } = ctrl;
    window.addEventListener('pointermove', (ev: PointerEvent) => {
      drag.moveCount++;
      drag.lastX = ev.clientX;
      drag.lastY = ev.clientY;
    }, { signal });
    window.addEventListener('pointerup', () => {
      ctrl.abort();
      const sample: PointerSample = {
        kind: 'pointer',
        pointerType: drag.pointerType,
        button: drag.button,
        buttons: 0,
        totalDx: drag.lastX - drag.startX,
        totalDy: drag.lastY - drag.startY,
        distance: Math.hypot(drag.lastX - drag.startX, drag.lastY - drag.startY),
        durationMs: performance.now() - drag.startT,
        moveCount: drag.moveCount,
        shiftKey: drag.shiftKey, metaKey: drag.metaKey, ctrlKey: drag.ctrlKey, altKey: drag.altKey,
      };
      const verdict = classifyPointerDrag(sample);
      if (verdict.confident) capture(verdict);
    }, { signal });
  }, [capture]);

  const onSave = () => {
    const cur = renderSettingsStore.globalSnapshot();
    renderSettingsStore.applyGlobal({ ...cur, ...boardPatch, disableInertia: !momentum });
    localStorage.setItem(SCROLL_BINDINGS_KEY, JSON.stringify(pdf));
    window.dispatchEvent(new CustomEvent('pdf-scroll-bindings-changed', { detail: pdf }));
    localStorage.setItem(PDF_INERTIA_KEY, String(momentum));
    log.ui.log(`[welcome] saved: twoFingerPan=${tfp}, pdf=${JSON.stringify(pdf)}, momentum=${momentum}`);
    welcomeStore.finish();
  };

  const { surface: tSurface, action: tAction } = parse(target);
  const touchedFor = (key: ActionKey) => (parse(key).surface === 'board' ? boardTouched : pdfTouched);

  const renderChip = (key: ActionKey) => {
    const { action } = parse(key);
    return (
      <button
        key={key}
        className={`welcome-chip${target === key ? ' is-active' : ''}${touchedFor(key) ? ' is-set' : ''}`}
        onClick={() => { setTarget(key); setFeedback(null); }}
      >
        <span className="welcome-chip-name">{action === 'pan' ? 'Pan' : 'Zoom'}{touchedFor(key) ? ' ✓' : ''}</span>
        <span className="welcome-chip-gesture">{gestureFor(key)}</span>
      </button>
    );
  };

  return (
    <div className="library-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="welcome-title">
      <div className="library-modal library-modal-wide welcome-modal">
        <div className="library-modal-title" id="welcome-title">Welcome to BoardRipper</div>
        <div className="library-modal-filename">
          Most important step is navigation set up.Pick an action, then do the gesture you want for it in the box. 
          You can change everything later in Settings.
        </div>

        <div className="welcome-chiprow">
          <span className="welcome-chiprow-label">Board</span>
          {renderChip('board-pan')}
          {renderChip('board-zoom')}
        </div>
        <div className="welcome-chiprow">
          <span className="welcome-chiprow-label">PDF</span>
          {renderChip('pdf-pan')}
          {renderChip('pdf-zoom')}
        </div>

        <div className="welcome-test" ref={boxRef} onPointerDown={onPointerDown}>
          <div className="welcome-test-prompt">
            Show how you want to <b>{tAction === 'pan' ? 'PAN' : 'ZOOM'}</b> the <b>{tSurface === 'board' ? 'board' : 'PDF'}</b>
            <br />scroll · swipe · pinch · drag here
          </div>
          {feedback && (
            <div className={`welcome-test-detected is-set${feedback.ok ? '' : ' is-err'}`}>
              {feedback.ok ? `→ ${feedback.text}` : feedback.text}
            </div>
          )}
        </div>

        <label className="welcome-check">
          <input type="checkbox" checked={momentum} onChange={e => { setMomentum(e.target.checked); }} />
          <span className="welcome-check-text">
            <b>BoardRipper momentum</b> — adds glide after a flick. Leave off if your device already scrolls with momentum.
            {osMomentum && <span className="welcome-check-note"> Your device already does — left off.</span>}
          </span>
        </label>

        <div className="library-modal-actions">
          <button type="button" onClick={() => welcomeStore.finish()}>Skip for now</button>
          <button type="button" className="library-modal-save" onClick={onSave}>Save</button>
        </div>
      </div>
    </div>
  );
}
