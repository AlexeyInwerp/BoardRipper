import { useSyncExternalStore, useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { logStore, LOG_SCOPES, type LogScope, log } from '../store/log-store';
import { boardCache } from '../store/board-cache';
import { boardStore } from '../store/board-store';
import { useUpdateStore } from '../hooks/useUpdateStore';
import { debugRenderTvwLayersToPng } from '../parsers/tvw-parser';
import { renderSettingsStore } from '../store/render-settings';
import { SCROLL_BINDINGS_KEY, loadScrollBindings, PDF_INERTIA_KEY } from './PdfViewerPanel';
import {
  WheelGestureClassifier,
  InertiaDetector,
  classifyPointerDrag,
  recommendSetting,
  recommendInertia,
  type InputSample,
  type GestureVerdict,
  type Recommendation,
  type InertiaState,
  type InertiaRecommendation,
  type Surface,
  type Action,
  type PointerSample,
} from '../store/input-recognizer';

const LS_SCOPES_KEY = 'boardripper-log-scopes';
const LS_PERSIST_KEY = 'boardripper-log-persist';

function loadPersistedScopes(): Partial<Record<LogScope, boolean>> {
  try {
    const raw = localStorage.getItem(LS_SCOPES_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function loadPersist(): boolean {
  const raw = localStorage.getItem(LS_PERSIST_KEY);
  return raw === null ? true : raw === 'true';
}

/** Render every parsed TVW layer to its own PNG and trigger a sequence of
 *  browser downloads. No ZIP — keeps the implementation dependency-free.
 *  Scoped to the active tab; warns if the active tab is not a TVW file. */
async function exportTvwLayerPngs(): Promise<void> {
  const file = boardStore.getActiveFile();
  if (!file) {
    log.parser.warn('Export Layer PNGs: no active board file');
    return;
  }
  if (!file.name.toLowerCase().endsWith('.tvw')) {
    log.parser.warn(`Export Layer PNGs: ${file.name} is not a TVW file (this debug only handles TVW)`);
    return;
  }
  log.parser.log(`Exporting per-layer PNGs for ${file.name}…`);
  const buffer = await file.arrayBuffer();
  const images = await debugRenderTvwLayersToPng(buffer);
  if (images.length === 0) {
    log.parser.warn('Export Layer PNGs: no layers with geometry to render');
    return;
  }
  const baseName = file.name.replace(/\.tvw$/i, '');
  for (const img of images) {
    const url = URL.createObjectURL(img.blob);
    const safeName = (img.name || `layer_${img.index}`).replace(/[^A-Za-z0-9_.-]+/g, '_');
    const a = document.createElement('a');
    a.href = url;
    a.download = `${baseName}__${img.index.toString().padStart(2, '0')}_${safeName}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Hold the URL briefly so Chrome actually fetches it before revoke
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    log.parser.log(`  [${img.index}] ${img.name} (${img.layerTypeName}) — pads=${img.padCount} lines=${img.lineCount} arcs=${img.arcCount} holes=${img.holeCount} slots=${img.slotCount}`);
  }
  log.parser.log(`Exported ${images.length} layer PNG(s).`);
}

const SCOPE_COLORS: Record<LogScope, string> = {
  parser: '#c084fc',
  render: '#60a5fa',
  pdf:    '#f97316',
  scan:   '#34d399',
  ui:     '#94a3b8',
  cache:  '#fbbf24',
  perf:   '#f472b6',
  update: '#22d3ee',
  obd:    '#86efac',
  cloud:  '#a5b4fc',
  twoWindow: '#fb923c',
  mcp:    '#e879f9',
};

interface SampleRow {
  id: number;
  sample: InputSample;
  verdict: GestureVerdict;
}

function flags(s: { ctrlKey: boolean; shiftKey: boolean; metaKey: boolean; altKey: boolean }): string {
  const f: string[] = [];
  if (s.ctrlKey) f.push('ctrl');
  if (s.shiftKey) f.push('shift');
  if (s.metaKey) f.push('meta');
  if (s.altKey) f.push('alt');
  return f.length ? f.join('+') : '—';
}

function describeSample(s: InputSample): string {
  if (s.kind === 'wheel') {
    return `wheel  dY=${s.deltaY.toFixed(1)} dX=${s.deltaX.toFixed(1)} mode=${s.deltaModeLabel} gap=${s.gapMs}ms  [${flags(s)}]`;
  }
  return `drag   ${s.pointerType} btn=${s.button} dist=${s.distance.toFixed(0)}px dt=${Math.round(s.durationMs)}ms moves=${s.moveCount}  [${flags(s)}]`;
}

/** Verbose first-run input-calibration prototype. Captures real wheel/pointer
 *  events, classifies the gesture, and applies the matching pan/zoom setting on
 *  confirm. Foundation for the polished first-start setup popup. */
function GestureRecognizer() {
  const [open, setOpen] = useState(true);
  const [surface, setSurface] = useState<Surface>('board');
  const [action, setAction] = useState<Action>('pan');
  const [rows, setRows] = useState<SampleRow[]>([]);
  const [recommendation, setRecommendation] = useState<Recommendation | null>(null);
  const [appliedSummary, setAppliedSummary] = useState<string | null>(null);
  const [inertia, setInertia] = useState<InertiaState | null>(null);
  const [inertiaApplied, setInertiaApplied] = useState<string | null>(null);

  const boxRef = useRef<HTMLDivElement>(null);
  const classifierRef = useRef(new WheelGestureClassifier());
  const inertiaRef = useRef(new InertiaDetector());
  const idRef = useRef(0);

  const record = useCallback((sample: InputSample, verdict: GestureVerdict) => {
    const rec = verdict.confident
      ? recommendSetting({ surface, action, verdict, currentPdf: loadScrollBindings() })
      : null;
    setRecommendation(rec);
    setAppliedSummary(null);
    setRows(prev => [{ id: ++idRef.current, sample, verdict }, ...prev].slice(0, 14));
  }, [surface, action]);

  // Wheel must be captured natively with passive:false so we can preventDefault
  // (otherwise Ctrl+wheel pinch zooms the whole page).
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { sample, verdict } = classifierRef.current.feed(e);
      record(sample, verdict);
      setInertia(inertiaRef.current.feed(e));
      setInertiaApplied(null);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [record]);

  // Pointer drag — listen on window so moves outside the box still count.
  // An AbortController tears down both listeners on pointerup.
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
      const dx = drag.lastX - drag.startX;
      const dy = drag.lastY - drag.startY;
      const sample: PointerSample = {
        kind: 'pointer',
        pointerType: drag.pointerType,
        button: drag.button,
        buttons: 0,
        totalDx: dx,
        totalDy: dy,
        distance: Math.hypot(dx, dy),
        durationMs: performance.now() - drag.startT,
        moveCount: drag.moveCount,
        shiftKey: drag.shiftKey,
        metaKey: drag.metaKey,
        ctrlKey: drag.ctrlKey,
        altKey: drag.altKey,
      };
      record(sample, classifyPointerDrag(sample));
    }, { signal });
  }, [record]);

  const apply = useCallback(() => {
    const rec = recommendation;
    if (!rec || !rec.ok) return;
    if (rec.board) {
      const cur = renderSettingsStore.globalSnapshot();
      renderSettingsStore.applyGlobal({ ...cur, ...rec.board });
    }
    if (rec.pdf) {
      localStorage.setItem(SCROLL_BINDINGS_KEY, JSON.stringify(rec.pdf));
      window.dispatchEvent(new CustomEvent('pdf-scroll-bindings-changed', { detail: rec.pdf }));
    }
    setAppliedSummary(rec.summary);
    log.ui.log(`[gesture-recognizer] applied (${surface}/${action}): ${rec.summary}`);
  }, [recommendation, surface, action]);

  const inertiaReco: InertiaRecommendation | null = inertia
    ? recommendInertia({ surface, hasInertia: inertia.hasInertia })
    : null;

  const applyInertia = useCallback(() => {
    const rec = inertiaReco;
    if (!rec || !rec.applicable) return;
    if (rec.board) {
      const cur = renderSettingsStore.globalSnapshot();
      renderSettingsStore.applyGlobal({ ...cur, ...rec.board });
    }
    if (rec.pdfInertia !== undefined) {
      localStorage.setItem(PDF_INERTIA_KEY, String(rec.pdfInertia));
    }
    setInertiaApplied(rec.summary);
    log.ui.log(`[gesture-recognizer] inertia applied (${surface}): ${rec.summary}`);
  }, [inertiaReco, surface]);

  const latest = rows[0];

  return (
    <div className="gesture-rec">
      <div className="gesture-rec-head" onClick={() => setOpen(o => !o)}>
        <span className="gesture-rec-caret">{open ? '▾' : '▸'}</span>
        <span className="gesture-rec-title">Input Gesture Recognizer</span>
        <span className="gesture-rec-sub">verbose calibration prototype</span>
      </div>

      {open && (
        <div className="gesture-rec-body">
          <div className="gesture-rec-controls">
            <div className="gesture-rec-seg">
              <span className="gesture-rec-seg-label">Surface</span>
              {(['board', 'pdf'] as Surface[]).map(s => (
                <button
                  key={s}
                  className={`gesture-rec-segbtn${surface === s ? ' is-active' : ''}`}
                  onClick={() => setSurface(s)}
                >{s === 'board' ? 'Board' : 'PDF'}</button>
              ))}
            </div>
            <div className="gesture-rec-seg">
              <span className="gesture-rec-seg-label">Action</span>
              {(['pan', 'zoom'] as Action[]).map(a => (
                <button
                  key={a}
                  className={`gesture-rec-segbtn${action === a ? ' is-active' : ''}`}
                  onClick={() => setAction(a)}
                >{a === 'pan' ? 'Pan' : 'Zoom'}</button>
              ))}
            </div>
          </div>

          <div
            ref={boxRef}
            className="gesture-rec-capture"
            onPointerDown={onPointerDown}
          >
            <div className="gesture-rec-capture-prompt">
              Demonstrate how you want to <b>{action.toUpperCase()}</b> the <b>{surface === 'board' ? 'BOARD' : 'PDF'}</b>
              <br />scroll · swipe · pinch · drag here
            </div>
            {latest && (
              <div className={`gesture-rec-verdict${latest.verdict.confident ? '' : ' is-weak'}`}>
                <span className="gesture-rec-verdict-label">{latest.verdict.label}</span>
                <span className="gesture-rec-verdict-meta">
                  device={latest.verdict.device} · modifier={latest.verdict.modifier}
                  {latest.verdict.confident ? '' : ' · low confidence'}
                </span>
              </div>
            )}
          </div>

          {recommendation && (
            <div className={`gesture-rec-reco${recommendation.ok ? '' : ' is-blocked'}`}>
              <div className="gesture-rec-reco-summary">{recommendation.summary}</div>
              <button
                className="gesture-rec-apply"
                disabled={!recommendation.ok || appliedSummary === recommendation.summary}
                onClick={apply}
              >
                {appliedSummary === recommendation.summary ? 'Applied ✓' : 'Confirm & Apply'}
              </button>
            </div>
          )}

          {latest && latest.verdict.reasons.length > 0 && (
            <ul className="gesture-rec-reasons">
              {latest.verdict.reasons.map((r, i) => <li key={i}>{r}</li>)}
            </ul>
          )}

          {inertia && (
            <div className={`gesture-rec-inertia${inertia.hasInertia ? ' is-on' : ''}`}>
              <div className="gesture-rec-inertia-head">
                <span className="gesture-rec-inertia-title">Inertia</span>
                <span className="gesture-rec-inertia-verdict">
                  {inertia.hasInertia ? 'MOMENTUM DETECTED · trackpad' : 'no momentum (discrete / mouse-like)'}
                </span>
              </div>
              <div className="gesture-rec-inertia-stats">
                events={inertia.eventCount} · peak={inertia.peakAbs.toFixed(1)} · cur={inertia.currentAbs.toFixed(1)} · decay-run={inertia.decayRun} · avg-gap={inertia.avgGapMs.toFixed(0)}ms
              </div>
              <ul className="gesture-rec-reasons">
                {inertia.reasons.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
              {inertiaReco?.applicable && (
                <div className="gesture-rec-reco">
                  <div className="gesture-rec-reco-summary">{inertiaReco.summary}</div>
                  <button
                    className="gesture-rec-apply"
                    disabled={inertiaApplied === inertiaReco.summary}
                    onClick={applyInertia}
                  >
                    {inertiaApplied === inertiaReco.summary ? 'Applied ✓' : 'Confirm & Apply'}
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="gesture-rec-log">
            {rows.length === 0
              ? <div className="gesture-rec-log-empty">No events captured yet.</div>
              : rows.map(r => (
                  <div key={r.id} className="gesture-rec-log-row">
                    <span className="gesture-rec-log-verdict">{r.verdict.label}</span>
                    <span className="gesture-rec-log-raw">{describeSample(r.sample)}</span>
                  </div>
                ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function DebugPanel() {
  const entries = useSyncExternalStore(
    cb => logStore.subscribe(cb),
    () => logStore.getSnapshot(),
  );

  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

  const [persist, setPersist] = useState(loadPersist);
  const [enabledScopes, setEnabledScopes] = useState<Partial<Record<LogScope, boolean>>>(
    () => persist ? loadPersistedScopes() : {},
  );
  const [loggingEnabled, setLoggingEnabled] = useState(() => logStore.enabled);

  useEffect(() => {
    if (persist) {
      localStorage.setItem(LS_SCOPES_KEY, JSON.stringify(enabledScopes));
    }
  }, [enabledScopes, persist]);

  useEffect(() => {
    localStorage.setItem(LS_PERSIST_KEY, String(persist));
    if (!persist) {
      localStorage.removeItem(LS_SCOPES_KEY);
    }
  }, [persist]);

  const toggleScope = useCallback((scope: LogScope) => {
    setEnabledScopes(prev => ({ ...prev, [scope]: !prev[scope] }));
  }, []);

  const toggleLogging = useCallback(() => {
    setLoggingEnabled(prev => { const next = !prev; logStore.setEnabled(next); return next; });
  }, []);

  // While an update is running, force-include `update`-scope entries so
  // operators who haven't enabled the scope still see the live progress
  // when the toolbar pivots them here. After the update completes the
  // user's normal scope preferences resume.
  const { updating } = useUpdateStore();
  const filtered = useMemo(
    () => entries.filter(e =>
      e.level === 'error'
      || enabledScopes[e.scope]
      || (updating && e.scope === 'update'),
    ),
    [entries, enabledScopes, updating],
  );

  const lastEntryId = entries[entries.length - 1]?.id;
  useEffect(() => {
    if (autoScrollRef.current) {
      bottomRef.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [lastEntryId]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    autoScrollRef.current = atBottom;
  };

  return (
    <div className="debug-panel-root">
      <div className="debug-panel-toolbar">
        <span className="debug-panel-count">
          {filtered.length === entries.length
            ? `${entries.length} entries`
            : `${filtered.length} of ${entries.length} entries`}
        </span>
        <button
          onClick={() => boardCache.clear().then(() => log.cache.log('Board cache cleared'))}
          className="debug-panel-btn debug-panel-btn-warn"
          title="Clear IndexedDB board cache — forces re-parse on next open"
        >
          Clear Cache
        </button>
        <button
          onClick={() => exportTvwLayerPngs()}
          className="debug-panel-btn debug-panel-btn-muted"
          title="TVW only: render every parsed layer as a separate PNG and download as ZIP"
        >
          Export Layer PNGs
        </button>
        <button
          onClick={() => logStore.clear()}
          className="debug-panel-btn debug-panel-btn-muted"
        >
          Clear Log
        </button>
      </div>

      <GestureRecognizer />

      <div className="debug-filter-bar">
        <label className="debug-filter-toggle" title="Global logging kill switch">
          <span
            className={`debug-filter-dot ${loggingEnabled ? 'debug-filter-dot-on' : 'debug-filter-dot-off'}`}
            onClick={toggleLogging}
          />
          <span className="debug-filter-label" onClick={toggleLogging}>Logging</span>
        </label>

        <div className={`debug-filter-scopes ${!loggingEnabled ? 'debug-filter-disabled' : ''}`}>
          {LOG_SCOPES.map(scope => (
            <label key={scope} className="debug-filter-scope">
              <input
                type="checkbox"
                checked={!!enabledScopes[scope]}
                onChange={() => toggleScope(scope)}
                disabled={!loggingEnabled}
              />
              <span style={{ color: SCOPE_COLORS[scope] }}>{scope}</span>
            </label>
          ))}
        </div>

        <label className="debug-filter-persist" title="Remember enabled scopes across sessions">
          <input
            type="checkbox"
            checked={persist}
            onChange={() => setPersist(p => !p)}
          />
          <span>persist filters</span>
        </label>
      </div>

      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="debug-panel-log"
      >
        {!loggingEnabled && (
          <div className="debug-panel-empty">Logging disabled — toggle the switch above to capture entries.</div>
        )}
        {loggingEnabled && filtered.length === 0 && (
          <div className="debug-panel-empty">No matching entries. Enable scopes above or open a board file.</div>
        )}
        {filtered.map(e => (
          <div
            key={e.id}
            className={`debug-log-entry${e.level === 'error' ? ' debug-log-entry-error' : ''} debug-log-text-${e.level}`}
          >
            <span className="debug-log-time">{e.time}</span>
            <span className={`debug-log-level debug-log-level-${e.level}`}>
              {e.level.toUpperCase()}
            </span>
            <span className="debug-log-scope" style={{ color: SCOPE_COLORS[e.scope] }}>
              [{e.scope}]
            </span>
            <span className="debug-log-message">{e.message}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
