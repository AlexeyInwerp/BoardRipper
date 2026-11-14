/**
 * The 3D view of one board tab (default export: lazy-loaded, so three.js is a
 * separate chunk the 2D path never fetches). Reads the tab's derived board and
 * selection from boardStore and writes clicks back through the ordinary
 * selection actions, so the 2D view, the sidebar and cross-probing follow.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { IconArrowDown, IconArrowLeft, IconArrowRight, IconArrowUp, IconFocusCentered, IconHandStop, IconRotate360, IconZoomIn, IconZoomOut } from '@tabler/icons-react';
import { boardStore } from '../store/board-store';
import { useBoardStore } from '../hooks/useBoardStore';
import { uiZoom } from '../store/ui-zoom';
import { buildBoard3DModel } from './board3d-model';
import { Board3DRenderer, type View3DPreset } from './Board3DRenderer';

const EVIDENCE: Record<string, string> = { package: 'from the package name', geometry: 'estimated from the pins', fallback: 'size unknown — body from the pins' };

/** `bareScroll`: the app's binding for a plain wheel / two-finger scroll — the 3D view follows it. */
export default function Board3DView({ tabId, bareScroll = 'zoom' }: { tabId: number; bareScroll?: 'pan' | 'zoom' }) {
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
  const [dragMode, setDragMode] = useState<'orbit' | 'pan'>('orbit');

  useEffect(() => {
    let r: Board3DRenderer;
    try { r = new Board3DRenderer(hostRef.current!); }
    catch (err) { setFailed(err instanceof Error ? err.message : String(err)); return; }
    rRef.current = r; setReady(true);
    if (import.meta.env.DEV) (window as unknown as { __board3d?: { renderer: Board3DRenderer; tabId: number } }).__board3d = { renderer: r, tabId };
    return () => { r.dispose(); rRef.current = null; setReady(false); };
  }, [tabId]);
  useEffect(() => { if (ready && model) rRef.current!.setModel(model); }, [ready, model]);
  useEffect(() => { if (ready) rRef.current!.setLeftDrag(dragMode); }, [ready, dragMode]);
  useEffect(() => { if (ready) rRef.current!.setWheelPans(bareScroll === 'pan'); }, [ready, bareScroll]);
  useEffect(() => { if (ready && model) rRef.current!.setSelection(sel?.partIndex ?? null, sel?.highlightedNet ?? null); }, [ready, model, sel?.partIndex, sel?.highlightedNet]);

  // a click is a press that did not travel; a drag orbits
  const down = useRef<[number, number] | null>(null);
  const onPointerDown = (e: React.PointerEvent) => { down.current = [e.clientX, e.clientY]; };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = down.current; down.current = null; const r = rRef.current;
    if (!d || !r || e.button !== 0 || Math.hypot(e.clientX - d[0], e.clientY - d[1]) > (e.pointerType === 'touch' ? 12 : 5)) return;
    const idx = r.pick(e.clientX, e.clientY);
    if (boardStore.activeTabId !== tabId) boardStore.switchTab(tabId);
    boardStore.selectPart(idx);
  };
  const onDoubleClick = (e: React.MouseEvent) => { const r = rRef.current; const idx = r?.pick(e.clientX, e.clientY); if (r && idx != null) r.focusPart(idx); };
  const hoverFrame = useRef(0);
  const onPointerMove = (e: React.PointerEvent) => {
    if (e.pointerType === 'touch' || e.buttons) { if (tip) setTip(null); return; }
    const { clientX, clientY } = e;
    cancelAnimationFrame(hoverFrame.current);
    hoverFrame.current = requestAnimationFrame(() => {
      const r = rRef.current, wrap = wrapRef.current; if (!r || !wrap) return;
      const idx = r.pick(clientX, clientY), part = idx != null ? r.part(idx) : undefined;
      if (!part) { setTip(null); return; }
      const e2 = part.est, z = uiZoom(), rect = wrap.getBoundingClientRect();
      const what = `${e2.family}${e2.size ? ' ' + e2.size : ''}${e2.kind && e2.kind !== 'chip' && e2.family === 'chip' ? ' · ' + e2.kind : ''}`;
      setTip({ x: (clientX - rect.left) / z + 14, y: (clientY - rect.top) / z + 14, title: `${part.name} · ${what}`, body: `${e2.L.toFixed(2)} × ${e2.W.toFixed(2)} × ${e2.H.toFixed(2)} mm — ${EVIDENCE[e2.evidence]}: ${e2.why}` });
    });
  };
  const view = (p: View3DPreset) => rRef.current?.view(p);
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
    <div className="board-3d" ref={wrapRef} data-testid="board-3d">
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
      <div className="board-3d-toolbar">
        <button className="board-netlines-toggle" data-testid="board-3d-iso" onClick={() => view('iso')} title="Angled view">Iso</button>
        <button className="board-netlines-toggle" data-testid="board-3d-top" onClick={() => view('top')} title="Look at the top side">Top</button>
        <button className="board-netlines-toggle" data-testid="board-3d-bottom" onClick={() => view('bottom')} title="Look at the bottom side">Bottom</button>
        <span className="board-3d-sep" />
        <button className="board-netlines-toggle" data-testid="board-3d-zoom-out" onClick={() => zoom(1 / 0.75)} title="Zoom out (−)"><IconZoomOut size={16} /></button>
        <button className="board-netlines-toggle" data-testid="board-3d-zoom-in" onClick={() => zoom(0.75)} title="Zoom in (+)"><IconZoomIn size={16} /></button>
        <button className="board-netlines-toggle" data-testid="board-3d-fit" onClick={() => rRef.current?.fit()} title="Fit the board (0)"><IconFocusCentered size={16} /></button>
        <span className="board-3d-sep" />
        <button className="board-netlines-toggle" data-testid="board-3d-pan-left" onClick={() => pan(PAN, 0)} title="Pan left (←)"><IconArrowLeft size={16} /></button>
        <button className="board-netlines-toggle" data-testid="board-3d-pan-up" onClick={() => pan(0, PAN)} title="Pan up (↑)"><IconArrowUp size={16} /></button>
        <button className="board-netlines-toggle" data-testid="board-3d-pan-down" onClick={() => pan(0, -PAN)} title="Pan down (↓)"><IconArrowDown size={16} /></button>
        <button className="board-netlines-toggle" data-testid="board-3d-pan-right" onClick={() => pan(-PAN, 0)} title="Pan right (→)"><IconArrowRight size={16} /></button>
        <span className="board-3d-sep" />
        <button
          className={`board-netlines-toggle ${dragMode === 'pan' ? 'active' : ''}`}
          data-testid="board-3d-drag-mode"
          aria-pressed={dragMode === 'pan'}
          onClick={() => setDragMode(m => (m === 'orbit' ? 'pan' : 'orbit'))}
          title={dragMode === 'orbit' ? 'Drag turns the board · right-drag pans — click: drag pans' : 'Drag pans · right-drag turns the board — click: drag turns'}
        >
          {dragMode === 'orbit' ? <IconRotate360 size={16} /> : <IconHandStop size={16} />}
        </button>
        <span className="board-3d-note">{dragMode === 'orbit' ? 'Drag to turn · right-drag to pan' : 'Drag to pan · right-drag to turn'} · {bareScroll === 'pan' ? 'scroll pans, pinch zooms' : 'scroll zooms at the pointer'} · double-click a part to centre it · parts are estimated from the file</span>
      </div>
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
