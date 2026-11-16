/**
 * The 3D view of one board tab (default export: lazy-loaded, so three.js is a
 * separate chunk the 2D path never fetches). Reads the tab's derived board and
 * selection from boardStore and writes clicks back through the ordinary
 * selection actions, so the 2D view, the sidebar and cross-probing follow.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { view3dStore } from '../store/view3d-store';
import { boardStore } from '../store/board-store';
import { useBoardStore } from '../hooks/useBoardStore';
import { uiZoom } from '../store/ui-zoom';
import { buildBoard3DModel, estimateParts, type Board3DModel } from './board3d-model';
import { contextMenuStore } from '../store/context-menu-store';
import { pinDisplayId } from '../parsers/types';
import { Board3DRenderer } from './Board3DRenderer';

const EVIDENCE: Record<string, string> = { package: 'from the package name', geometry: 'estimated from the pins', fallback: 'size unknown — body from the pins' };

export default function Board3DView({ tabId }: { tabId: number }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const rRef = useRef<Board3DRenderer | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const { tabs } = useBoardStore();
  const tab = tabs.find(t => t.id === tabId);
  const board = tab?.board ? boardStore.viewBoardFor(tabId) : null;
  const overrides = tab?.partOverrides; // a new Map on every hide / unhide
  const [model, setModel] = useState<Board3DModel | null>(null);
  const [progress, setProgress] = useState<{ stage: string; pct: number } | null>(null);
  const sel = tab?.selection;
  const [tip, setTip] = useState<{ x: number; y: number; title: string; body: string } | null>(null);
  useSyncExternalStore(c => view3dStore.subscribe(c), () => view3dStore.snapshot());
  const dragMode = view3dStore.uiOf(tabId).drag, settings = view3dStore.settings, netLineMode = tab?.netLineMode ?? 'off', ghostMode = tab?.ghostMode ?? 'off', dimMode = tab?.dimMode ?? 'dim';

  useEffect(() => {
    let r: Board3DRenderer;
    try { r = new Board3DRenderer(hostRef.current!); }
    catch (err) { setFailed(err instanceof Error ? err.message : String(err)); return; }
    rRef.current = r; setReady(true); view3dStore.register(tabId, r);
    if (import.meta.env.DEV) (window as unknown as { __board3d?: { renderer: Board3DRenderer; tabId: number } }).__board3d = { renderer: r, tabId };
    return () => { view3dStore.register(tabId, null); r.dispose(); rRef.current = null; setReady(false); };
  }, [tabId]);
  // settings before the model: a build reads them, and a persisted change must not rebuild the labels a second time
  useEffect(() => { if (ready) rRef.current!.applySettings(settings); }, [ready, settings]);
  // the build, in stages that yield so the progress overlay paints: estimates (chunked), then the scene stage by stage.
  // A hide / unhide rebuilds (the bodies are merged meshes); a tab switch or close cancels a build mid-way.
  useEffect(() => {
    if (!ready || !board) return; const r = rRef.current!; let live = true;
    const paint = () => new Promise<void>(res => requestAnimationFrame(() => setTimeout(res, 0)));
    const step = async (stage: string, pct: number) => { if (!live) throw new Error('cancelled'); setProgress({ stage, pct }); await paint(); };
    (async () => {
      try {
        await step('Estimating parts', 0);
        const hidden = new Set([...(overrides ?? new Map<string, { hidden?: boolean }>()).entries()].filter(([, o]) => o.hidden).map(([n]) => n));
        const estimates = await estimateParts(board, (d, t) => step('Estimating parts', 0.5 * d / t));
        const m = buildBoard3DModel(board, { hidden, estimates }); if (!live) return; setModel(m);
        await r.setModelStaged(m, (stage, i, n) => step(stage, 0.5 + 0.5 * i / n));
        if (!live) return; setProgress(null);
        const pr = view3dStore.uiOf(tabId).preset; if (pr !== 'iso') r.view(pr);
      } catch (err) { if (!(err instanceof Error && err.message === 'cancelled')) { setFailed(err instanceof Error ? err.message : String(err)); } }
    })();
    return () => { live = false; };
  }, [ready, board, tabId, overrides]);
  useEffect(() => { if (ready) rRef.current!.setLeftDrag(dragMode); }, [ready, dragMode]);
  // the Layers tab drives the stack: visibility and colour per layer, and the pinned / selected layer's emphasis
  const tabLayers = tab?.layerStates, isActive = boardStore.activeTabId === tabId;
  const emphasis = isActive ? (boardStore.fixatedLayerIndex ?? boardStore.selectedLayerIndex ?? null) : null;
  useEffect(() => { if (ready && model) rRef.current!.setLayerStates((tabLayers ?? []).map(l => ({ visible: l.visible, color: l.color })), emphasis); }, [ready, model, tabLayers, emphasis]);
  useEffect(() => { if (ready) rRef.current!.setNetLineMode(netLineMode); }, [ready, netLineMode]);
  useEffect(() => { if (ready) rRef.current!.setGhostMode(ghostMode); }, [ready, ghostMode]);
  useEffect(() => { if (ready) rRef.current!.setDimMode(dimMode); }, [ready, dimMode]);
  useEffect(() => { if (ready && model) rRef.current!.setSelection(sel?.partIndex ?? null, sel?.highlightedNet ?? null, sel?.pinIndex ?? null); }, [ready, model, sel?.partIndex, sel?.highlightedNet, sel?.pinIndex]);

  // a click is a press that did not travel; a drag orbits
  // a pinch is not a tap: iPadOS may cancel the first finger before the second lands, and the release of either must not
  // select whatever sits under it (the 2D view's rule, 2026-09-18) — `multi` is set the moment a second finger lands
  const down = useRef<[number, number] | null>(null); const fingers = useRef(0); const multi = useRef(false);
  const onPointerDown = (e: React.PointerEvent) => { if (e.pointerType === 'touch') { fingers.current++; if (fingers.current > 1) multi.current = true; } down.current = [e.clientX, e.clientY]; };
  const onPointerCancel = (e: React.PointerEvent) => { if (e.pointerType === 'touch') { fingers.current = Math.max(0, fingers.current - 1); if (!fingers.current) multi.current = false; } down.current = null; };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = down.current; down.current = null; const r = rRef.current;
    if (e.pointerType === 'touch') { fingers.current = Math.max(0, fingers.current - 1); const wasMulti = multi.current; if (!fingers.current) multi.current = false; if (wasMulti) return; }
    if (!d || !r || Math.hypot(e.clientX - d[0], e.clientY - d[1]) > (e.pointerType === 'touch' ? 12 : 5)) return;
    const hit = r.pickAt(e.clientX, e.clientY);
    if (boardStore.activeTabId !== tabId) boardStore.switchTab(tabId);
    if (e.button === 2) { // the same right-click menu as 2D: hide / send back / pin lookup / PDF search for the part under the pointer
      if (hit.part === null || !board) return;
      const part = board.parts[hit.part], pin = hit.pin !== null ? part.pins[hit.pin] : null;
      contextMenuStore.showBoard(e.clientX, e.clientY, part.name, pin ? pinDisplayId(pin, hit.pin!) : null, pin?.net || hit.net || null, [part.name]);
      return;
    }
    if (e.button !== 0) return;
    // the same three outcomes a 2D click has: a pin (its net lights), a part, a net from copper
    if (hit.part !== null && hit.pin !== null) boardStore.selectPin(hit.part, hit.pin);
    else if (hit.part !== null) boardStore.selectPart(hit.part);
    else if (hit.net) boardStore.highlightNet(hit.net);
    else boardStore.selectPart(null);
  };
  const onDoubleClick = (e: React.MouseEvent) => { const r = rRef.current; const idx = r?.pickAt(e.clientX, e.clientY).part; if (r && idx != null) r.focusPart(idx); };
  const hoverFrame = useRef(0);
  const onPointerMove = (e: React.PointerEvent) => {
    if (e.pointerType === 'touch' || e.buttons) { if (tip) setTip(null); return; }
    const { clientX, clientY } = e;
    cancelAnimationFrame(hoverFrame.current);
    hoverFrame.current = requestAnimationFrame(() => {
      const r = rRef.current, wrap = wrapRef.current; if (!r || !wrap) return;
      const hit = r.pickAt(clientX, clientY), part = hit.part != null ? r.part(hit.part) : undefined;
      const z0 = uiZoom(), rect0 = wrap.getBoundingClientRect();
      if (!part && hit.part != null && hit.pin != null) { // a land with no body: a test point, an exposed pad
        const pin = board?.parts[hit.part]?.pins[hit.pin];
        setTip({ x: (clientX - rect0.left) / z0 + 14, y: (clientY - rect0.top) / z0 + 14, title: `${board?.parts[hit.part]?.name ?? ''} · pin ${pin?.number ?? ''}`, body: `net ${pin?.net || '—'}` }); return;
      }
      if (!part && hit.net) { setTip({ x: (clientX - rect0.left) / z0 + 14, y: (clientY - rect0.top) / z0 + 14, title: `Trace · ${hit.net}`, body: 'click to light the net' }); return; }
      if (!part) { setTip(null); return; }
      const pinNote = hit.pin != null ? (() => { const pin = board?.parts[hit.part!]?.pins[hit.pin]; return ` · pin ${pin?.number ?? ''} → ${pin?.net || '—'}`; })() : '';
      const e2 = part.est, z = uiZoom(), rect = wrap.getBoundingClientRect();
      const what = `${e2.family}${e2.size ? ' ' + e2.size : ''}${e2.kind && e2.kind !== 'chip' && e2.family === 'chip' ? ' · ' + e2.kind : ''}`;
      setTip({ x: (clientX - rect.left) / z + 14, y: (clientY - rect.top) / z + 14, title: `${part.name} · ${what}${pinNote}`, body: `${e2.L.toFixed(2)} × ${e2.W.toFixed(2)} × ${e2.H.toFixed(2)} mm — ${EVIDENCE[e2.evidence]}: ${e2.why}` });
    });
  };
  const PAN = 120; // px per arrow press
  const zoom = (f: number) => rRef.current?.zoomBy(f);
  const pan = (dx: number, dy: number) => rRef.current?.panBy(dx, dy, true);
  // keys while the pointer is over the view (or it has focus): arrows pan, + / − zoom, 0 fits
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key, step = e.shiftKey ? PAN * 3 : PAN;
    const act = k === 'ArrowLeft' ? () => pan(step, 0) : k === 'ArrowRight' ? () => pan(-step, 0) : k === 'ArrowUp' ? () => pan(0, step) : k === 'ArrowDown' ? () => pan(0, -step)
      : k === '+' || k === '=' ? () => zoom(0.75) : k === '-' || k === '_' ? () => zoom(1 / 0.75) : k === '0' ? () => rRef.current?.fit() : null;
    if (act) { e.preventDefault(); e.stopPropagation(); act(); }
  };

  return (
    <div className="board-3d" ref={wrapRef} data-testid="board-3d" data-wheel-own="">
      <div
        ref={hostRef}
        className="board-3d-host"
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setTip(null)}
        onDoubleClick={onDoubleClick}
        onContextMenu={e => e.preventDefault()}
        onPointerEnter={e => (e.currentTarget as HTMLElement).focus({ preventScroll: true })}
        onKeyDown={onKeyDown}
        tabIndex={0}
      />
      {failed && (
        <div className="board-3d-loading" data-testid="board-3d-failed">The 3D view needs WebGL 2, which this browser could not provide.</div>
      )}
      {progress && !failed && (
        <div className="board-3d-loading board-3d-progress" data-testid="board-3d-progress" aria-live="polite">
          <div className="board-3d-progress-card">
            <div className="board-3d-progress-stage">{progress.stage}…</div>
            <div className="board-3d-progress-bar"><i style={{ width: `${Math.round(progress.pct * 100)}%` }} /></div>
          </div>
        </div>
      )}
      {tip && (
        <div className="board-3d-tip" style={{ left: tip.x, top: tip.y }}>
          <b>{tip.title}</b>
          <div>{tip.body}</div>
        </div>
      )}
    </div>
  );
}
