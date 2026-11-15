/**
 * The 3D view of one board tab (default export: lazy-loaded, so three.js is a
 * separate chunk the 2D path never fetches). Reads the tab's derived board and
 * selection from boardStore and writes clicks back through the ordinary
 * selection actions, so the 2D view, the sidebar and cross-probing follow.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { view3dStore } from '../store/view3d-store';
import { boardStore } from '../store/board-store';
import { useBoardStore } from '../hooks/useBoardStore';
import { uiZoom } from '../store/ui-zoom';
import { buildBoard3DModel } from './board3d-model';
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
  const model = useMemo(() => (board ? buildBoard3DModel(board) : null), [board]);
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
  useEffect(() => { if (ready && model) { rRef.current!.setModel(model); const pr = view3dStore.uiOf(tabId).preset; if (pr !== 'iso') rRef.current!.view(pr); } }, [ready, model, tabId]);
  useEffect(() => { if (ready) rRef.current!.setLeftDrag(dragMode); }, [ready, dragMode]);
  useEffect(() => { if (ready) rRef.current!.setNetLineMode(netLineMode); }, [ready, netLineMode]);
  useEffect(() => { if (ready) rRef.current!.setGhostMode(ghostMode); }, [ready, ghostMode]);
  useEffect(() => { if (ready) rRef.current!.setDimMode(dimMode); }, [ready, dimMode]);
  useEffect(() => { if (ready && model) rRef.current!.setSelection(sel?.partIndex ?? null, sel?.highlightedNet ?? null, sel?.pinIndex ?? null); }, [ready, model, sel?.partIndex, sel?.highlightedNet, sel?.pinIndex]);

  // a click is a press that did not travel; a drag orbits
  const down = useRef<[number, number] | null>(null);
  const onPointerDown = (e: React.PointerEvent) => { down.current = [e.clientX, e.clientY]; };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = down.current; down.current = null; const r = rRef.current;
    if (!d || !r || e.button !== 0 || Math.hypot(e.clientX - d[0], e.clientY - d[1]) > (e.pointerType === 'touch' ? 12 : 5)) return;
    const hit = r.pickAt(e.clientX, e.clientY);
    if (boardStore.activeTabId !== tabId) boardStore.switchTab(tabId);
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
        onPointerMove={onPointerMove}
        onPointerLeave={() => setTip(null)}
        onDoubleClick={onDoubleClick}
        onPointerEnter={e => (e.currentTarget as HTMLElement).focus({ preventScroll: true })}
        onKeyDown={onKeyDown}
        tabIndex={0}
      />
      {failed && (
        <div className="board-3d-loading" data-testid="board-3d-failed">The 3D view needs WebGL 2, which this browser could not provide.</div>
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
