/** Slide mode's drawing layer and toolbar for one board panel.
 *
 *  The layer is a Canvas2D sheet over the board (same CSS zoom as the board
 *  canvas, so its px are the renderer's px). It never takes pointer events
 *  itself: a capture-phase `pointerdown` on the panel root claims a primary
 *  press over the board when the current tool wants it — a draw tool always,
 *  the select tool only on an annotation — and lets everything else (wheel,
 *  pinch, other buttons, a press on empty board in select) reach the board. */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  IconPointer, IconArrowUpRight, IconSquare, IconTypography, IconPhotoDown, IconCopy,
  IconArrowBackUp, IconTrash, IconX,
} from '@tabler/icons-react';
import type { BoardRenderer } from '../../renderer/BoardRenderer';
import { slideStore, SLIDE_COLORS, STROKE_SIZES, type Pt, type SlideTool } from '../../store/slide-store';
import { boardStore } from '../../store/board-store';
import { log } from '../../store/log-store';
import { hitAnnotation, hitHandle, paintAnnotations, type Handle, type ToScreen } from './annotation-draw';

interface Props {
  tabId: number;
  renderer: BoardRenderer | null;
  rootRef: React.RefObject<HTMLDivElement | null>;
  hostRef: React.RefObject<HTMLDivElement | null>;
  fileName: string;
}

type Drag =
  | { kind: 'create'; id: number; startBoard: Pt }
  | { kind: 'move'; id: number; lastBoard: Pt; moved: boolean }
  | { kind: 'handle'; id: number; handle: Handle; moved: boolean };

function useSlide() {
  return useSyncExternalStore(c => slideStore.subscribe(c), () => slideStore.snapshot());
}

export function SlideLayer({ tabId, renderer, rootRef, hostRef, fileName }: Props) {
  const slide = useSlide();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [editing, setEditing] = useState<{ id: number | null; at: Pt; screen: Pt; text: string } | null>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;

  const toScreen = useCallback<ToScreen>(p => renderer?.boardToScreen(p.x, p.y) ?? null, [renderer]);

  // ---- paint ----
  const paint = useCallback(() => {
    const cv = canvasRef.current, host = hostRef.current;
    if (!cv || !host || !renderer) return;
    const w = host.clientWidth, h = host.clientHeight;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const bw = Math.max(1, Math.round(w * dpr)), bh = Math.max(1, Math.round(h * dpr));
    if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; }
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    // The text being edited is drawn by the input, not twice.
    const ed = editingRef.current;
    const list = slideStore.list(tabId).filter(a => !(ed && a.id === ed.id));
    paintAnnotations(ctx, list, renderer, slideStore.selectedId);
  }, [renderer, tabId, hostRef]);

  useEffect(() => { paint(); }, [paint, slide.rev, slide.selectedId, editing]);
  useEffect(() => renderer?.onViewChange(() => paint()), [renderer, paint]);

  // ---- pointer ----
  const localPoint = useCallback((e: PointerEvent): Pt | null => {
    const host = hostRef.current;
    if (!host) return null;
    const r = host.getBoundingClientRect();
    // The board canvas carries a CSS zoom (UI scale); renderer px = rect px × this.
    const k = host.clientWidth / (r.width || 1);
    return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k };
  }, [hostRef]);

  const commitEdit = useCallback(() => {
    const ed = editingRef.current;
    if (!ed) return;
    setEditing(null);
    const text = ed.text.replace(/\s+$/, '');
    if (ed.id === null) {
      if (text) {
        const id = slideStore.add(tabId, { kind: 'text', a: ed.at, b: ed.at, color: slideStore.color, size: slideStore.textSize(), text });
        slideStore.select(id);
      }
    } else if (!text) {
      slideStore.remove(tabId, ed.id);
    } else {
      slideStore.update(tabId, ed.id, { text });
    }
  }, [tabId]);

  useEffect(() => {
    const root = rootRef.current, host = hostRef.current;
    if (!root || !host || !renderer) return;
    const onDown = (e: PointerEvent) => {
      if (!slideStore.enabled || boardStore.activeTabId !== tabId) return;
      if (e.button !== 0 || !e.isPrimary) return;
      if (!(e.target instanceof Node) || !host.contains(e.target)) return;
      if (editingRef.current) { commitEdit(); e.stopPropagation(); e.preventDefault(); return; }
      const p = localPoint(e);
      if (!p) return;
      const bp = renderer.screenToBoard(p.x, p.y);
      if (!bp) return;
      const tool = slideStore.tool;
      const list = slideStore.list(tabId);
      let drag: Drag | null = null;

      if (tool === 'select') {
        const sel = slideStore.selectedId !== null ? list.find(a => a.id === slideStore.selectedId) : undefined;
        const h = sel ? hitHandle(sel, p, toScreen) : null;
        if (sel && h) {
          drag = { kind: 'handle', id: sel.id, handle: h, moved: false };
        } else {
          const hit = hitAnnotation(list, p, toScreen);
          if (!hit) { slideStore.select(null); return; }   // empty board: let it pan
          slideStore.select(hit.id);
          if (e.detail >= 2 && hit.kind === 'text') {
            const s = toScreen(hit.a);
            if (s) setEditing({ id: hit.id, at: hit.a, screen: s, text: hit.text ?? '' });
            e.stopPropagation(); e.preventDefault();
            return;
          }
          drag = { kind: 'move', id: hit.id, lastBoard: bp, moved: false };
        }
      } else if (tool === 'text') {
        const hit = hitAnnotation(list, p, toScreen);
        if (hit?.kind === 'text') {
          const s = toScreen(hit.a);
          slideStore.select(hit.id);
          if (s) setEditing({ id: hit.id, at: hit.a, screen: s, text: hit.text ?? '' });
        } else {
          setEditing({ id: null, at: bp, screen: p, text: '' });
        }
        e.stopPropagation(); e.preventDefault();
        return;
      } else {
        const id = slideStore.add(tabId, {
          kind: tool, a: bp, b: bp, color: slideStore.color, size: slideStore.strokeSize(),
        });
        drag = { kind: 'create', id, startBoard: bp };
      }

      e.stopPropagation();
      e.preventDefault();
      dragRef.current = drag;
      const startScreen = p;
      const onMove = (ev: PointerEvent) => {
        const d = dragRef.current;
        const q = localPoint(ev);
        if (!d || !q) return;
        const b = renderer.screenToBoard(q.x, q.y);
        if (!b) return;
        // A press that never moves records no undo step.
        if (d.kind !== 'create' && !d.moved) { d.moved = true; slideStore.checkpoint(tabId); }
        if (d.kind === 'create') {
          slideStore.update(tabId, d.id, { b }, false);
        } else if (d.kind === 'move') {
          const ann = slideStore.list(tabId).find(a => a.id === d.id);
          if (!ann) return;
          const dx = b.x - d.lastBoard.x, dy = b.y - d.lastBoard.y;
          d.lastBoard = b;
          slideStore.update(tabId, d.id, {
            a: { x: ann.a.x + dx, y: ann.a.y + dy }, b: { x: ann.b.x + dx, y: ann.b.y + dy },
          }, false);
        } else {
          const ann = slideStore.list(tabId).find(a => a.id === d.id);
          if (!ann) return;
          const m = d.handle.moves;
          slideStore.update(tabId, d.id, {
            a: { x: m.ax ? b.x : ann.a.x, y: m.ay ? b.y : ann.a.y },
            b: { x: m.bx ? b.x : ann.b.x, y: m.by ? b.y : ann.b.y },
          }, false);
        }
      };
      const onUp = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
        window.removeEventListener('pointercancel', onUp, true);
        const d = dragRef.current;
        dragRef.current = null;
        if (d?.kind !== 'create') return;
        const q = localPoint(ev) ?? startScreen;
        // A click without a drag makes nothing — an empty arrow is noise.
        if (Math.hypot(q.x - startScreen.x, q.y - startScreen.y) < 6) {
          slideStore.abandon(tabId, d.id);
        } else {
          slideStore.select(d.id);
        }
      };
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
      window.addEventListener('pointercancel', onUp, true);
    };
    root.addEventListener('pointerdown', onDown, true);
    return () => root.removeEventListener('pointerdown', onDown, true);
  }, [renderer, rootRef, hostRef, tabId, localPoint, toScreen, commitEdit]);

  // ---- keys: delete / undo / escape, only for the active board ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!slideStore.enabled || boardStore.activeTabId !== tabId || editingRef.current) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const sel = slideStore.selectedId;
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel !== null) {
        slideStore.remove(tabId, sel);
      } else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && slideStore.canUndo(tabId)) {
        slideStore.undo(tabId);
      } else if (e.key === 'Escape') {
        if (sel !== null) slideStore.select(null);
        else slideStore.setEnabled(false);
      } else {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [tabId]);

  // ---- export ----
  const capture = useCallback((): HTMLCanvasElement | null => {
    if (!renderer) return null;
    return renderer.captureView(ctx => paintAnnotations(ctx, slideStore.list(tabId), renderer, null));
  }, [renderer, tabId]);

  const savePng = useCallback(() => {
    const cv = capture();
    if (!cv) { boardStore.addToast('Could not capture the board view.'); return; }
    cv.toBlob(blob => {
      if (!blob) { boardStore.addToast('Could not encode the PNG.'); return; }
      const stem = fileName.replace(/\.[^.]+$/, '') || 'board';
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${stem}-${stamp}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      log.ui.log(`slide: saved ${a.download} (${cv.width}×${cv.height})`);
    }, 'image/png');
  }, [capture, fileName]);

  const copyPng = useCallback(async () => {
    const cv = capture();
    if (!cv) { boardStore.addToast('Could not capture the board view.'); return; }
    try {
      // Safari wants the ClipboardItem built synchronously from a promise.
      const blob = new Promise<Blob>((res, rej) => cv.toBlob(b => (b ? res(b) : rej(new Error('encode failed'))), 'image/png'));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      boardStore.addToast('Board view copied to the clipboard.', 'info', undefined, 2500);
    } catch (err) {
      log.ui.warn('slide: clipboard write failed', err);
      boardStore.addToast('This browser would not put an image on the clipboard — use Save PNG.');
    }
  }, [capture]);

  if (!slide.enabled) return null;

  const tools: Array<{ id: SlideTool; icon: typeof IconPointer; title: string }> = [
    { id: 'select', icon: IconPointer, title: 'Select · move, resize, double-click text to edit' },
    { id: 'arrow', icon: IconArrowUpRight, title: 'Arrow · drag from tail to tip' },
    { id: 'rect', icon: IconSquare, title: 'Rectangle · drag a box' },
    { id: 'text', icon: IconTypography, title: 'Text · click where it goes' },
  ];

  return (
    <>
      <div className="slide-layer" data-testid="slide-layer">
        <canvas ref={canvasRef} className="slide-layer-canvas" />
        {editing && (
          <textarea
            className="slide-text-editor"
            data-testid="slide-text-editor"
            autoFocus
            rows={Math.max(1, editing.text.split('\n').length)}
            value={editing.text}
            placeholder="Text"
            style={{
              left: editing.screen.x, top: editing.screen.y,
              color: editing.id === null ? slideStore.color : slideStore.list(tabId).find(a => a.id === editing.id)?.color,
              fontSize: editing.id === null ? slideStore.textSize() : slideStore.list(tabId).find(a => a.id === editing.id)?.size,
            }}
            onChange={e => setEditing({ ...editing, text: e.target.value })}
            onKeyDown={e => {
              e.stopPropagation();
              if (e.key === 'Escape') { setEditing(null); }
              else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitEdit(); }
            }}
            onBlur={commitEdit}
          />
        )}
      </div>
      <div className="slide-toolbar" data-testid="slide-toolbar" onPointerDown={e => e.stopPropagation()}>
        {tools.map(t => (
          <button
            key={t.id}
            className={`board-netlines-toggle ${slide.tool === t.id ? 'active' : ''}`}
            data-testid={`slide-tool-${t.id}`}
            title={t.title}
            aria-pressed={slide.tool === t.id}
            onClick={() => slideStore.setTool(t.id)}
          >
            <t.icon size={16} />
          </button>
        ))}
        <span className="slide-toolbar-sep" />
        {SLIDE_COLORS.map(c => (
          <button
            key={c}
            className={`slide-swatch ${slide.color === c ? 'active' : ''}`}
            style={{ background: c }}
            title={`Colour ${c}`}
            aria-pressed={slide.color === c}
            onClick={() => slideStore.setColor(c)}
          />
        ))}
        <span className="slide-toolbar-sep" />
        {STROKE_SIZES.map((w, i) => (
          <button
            key={w}
            className={`board-netlines-toggle ${slide.weight === i ? 'active' : ''}`}
            title={['Thin', 'Medium', 'Bold'][i]}
            aria-pressed={slide.weight === i}
            onClick={() => slideStore.setWeight(i)}
          >
            <span className="slide-weight-dot" style={{ width: 4 + i * 4, height: 4 + i * 4 }} />
          </button>
        ))}
        <span className="slide-toolbar-sep" />
        <button className="board-netlines-toggle" title="Undo (⌘Z)" disabled={!slideStore.canUndo(tabId)} onClick={() => slideStore.undo(tabId)}>
          <IconArrowBackUp size={16} />
        </button>
        <button
          className="board-netlines-toggle"
          title={slide.selectedId !== null ? 'Delete selected (⌫)' : 'Clear all annotations'}
          data-testid="slide-delete"
          disabled={!slideStore.list(tabId).length}
          onClick={() => (slide.selectedId !== null ? slideStore.remove(tabId, slide.selectedId) : slideStore.clear(tabId))}
        >
          <IconTrash size={16} />
        </button>
        <span className="slide-toolbar-sep" />
        <button className="board-netlines-toggle slide-wide" data-testid="slide-save-png" title="Save the current view as a PNG" onClick={savePng}>
          <IconPhotoDown size={16} /><span>PNG</span>
        </button>
        <button className="board-netlines-toggle" data-testid="slide-copy-png" title="Copy the current view to the clipboard" onClick={copyPng}>
          <IconCopy size={16} />
        </button>
        <button className="board-netlines-toggle" title="Leave slide mode (Esc) — the annotations come back with it" onClick={() => slideStore.setEnabled(false)}>
          <IconX size={16} />
        </button>
      </div>
    </>
  );
}
