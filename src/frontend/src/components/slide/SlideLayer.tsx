/** Slide mode's drawing layer and toolbar for one board panel.
 *
 *  The layer is a Canvas2D sheet over the board (same CSS zoom as the board
 *  canvas, so its px are the renderer's px). It never takes pointer events
 *  itself: a capture-phase `pointerdown` on the panel root claims a primary
 *  press over the board when slide mode wants it — a press on an annotation
 *  (with any tool, to move it), or any press with a draw tool — and lets
 *  everything else (wheel, pinch, other buttons, a press on empty board with
 *  Select) reach the board.
 *
 *  Selected parts — the primary selection and the multi-selection
 *  (⌘/Ctrl+click, or taps with the toolbar's Several parts on; Shift+click
 *  stays the worklist's) — get a large caption. The part picked last also
 *  gets two inputs, Ω and ▷|, to draft readings; a filled reading prints on
 *  its caption (and the PNG) whether or not the part is the one in focus. */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  IconPointer, IconArrowUpRight, IconSquare, IconTypography, IconPhotoDown, IconCopy,
  IconArrowBackUp, IconTrash, IconX, IconPencil, IconSquaresSelected, IconHelp,
} from '@tabler/icons-react';
import type { BoardRenderer } from '../../renderer/BoardRenderer';
import { slideStore, SLIDE_COLORS, STROKE_SIZES, type Pt, type SlideTool } from '../../store/slide-store';
import { boardStore } from '../../store/board-store';
import { selectionSetStore } from '../../store/selection-set-store';
import { log } from '../../store/log-store';
import { isTouchPrimary } from '../../device-profile';
import {
  drawCaption, hitAnnotation, hitHandle, layoutCaptions, paintAnnotations, readingsLine,
  type CaptionItem, type CaptionPlaced, type Handle, type Rect, type ToScreen,
} from './annotation-draw';

interface Props {
  tabId: number;
  renderer: BoardRenderer | null;
  rootRef: React.RefObject<HTMLDivElement | null>;
  hostRef: React.RefObject<HTMLDivElement | null>;
  fileName: string;
}

type Drag =
  | { kind: 'create'; id: number }
  | { kind: 'ink'; id: number; points: Pt[]; last: Pt }
  | { kind: 'move'; id: number; lastBoard: Pt; moved: boolean; editOnClick: boolean }
  | { kind: 'handle'; id: number; handle: Handle; moved: boolean };

/** Room under each live caption for the two reading inputs. */
const INPUT_ROW_H = 30;
const INPUT_ROW_MIN_W = 196;
/** PNG header band, CSS px (scaled with the capture). */
const HEADER_H = 40;

function useSlide() {
  return useSyncExternalStore(c => slideStore.subscribe(c), () => slideStore.snapshot());
}

function accentColor(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#5aa0ff';
}

/** The minimap canvas, when it is showing. */
function minimapCanvas(root: HTMLElement | null): HTMLCanvasElement | null {
  return root?.querySelector<HTMLCanvasElement>('[data-testid="board-minimap"][data-visible="true"] canvas') ?? null;
}

/** A DOM element's rect in renderer px. The minimap and the guide live
 *  outside the board canvas's counter-zoom (UI scale), so their client rects
 *  are mapped through it. */
function minimapRect(mm: Element | null, host: HTMLElement | null): Rect | null {
  if (!mm || !host) return null;
  const hr = host.getBoundingClientRect(), r = mm.getBoundingClientRect();
  if (!r.width || !hr.width) return null;
  const k = host.clientWidth / hr.width;
  return { x: (r.left - hr.left) * k, y: (r.top - hr.top) * k, w: r.width * k, h: r.height * k };
}

/** Every selected part of this tab, primary first, as caption items. */
function captionItems(renderer: BoardRenderer, tabId: number): CaptionItem[] {
  if (boardStore.activeTabId !== tabId) return [];
  const primary = boardStore.selection.partIndex;
  const order = [...(primary !== null ? [primary] : []), ...selectionSetStore.current.ordered.filter(i => i !== primary)];
  const out: CaptionItem[] = [];
  for (const idx of order) {
    const b = renderer.partScreenBox(idx);
    if (!b) continue;
    out.push({
      key: b.name, name: b.name, box: { x: b.x, y: b.y, w: b.w, h: b.h },
      detail: readingsLine(slideStore.readings(tabId, b.name)), primary: idx === primary,
    });
  }
  return out;
}

/** Captions for the selected parts. Returns where they went. */
function paintCaptions(ctx: CanvasRenderingContext2D, renderer: BoardRenderer, tabId: number, avoid: readonly (Rect | null)[], live: boolean): CaptionPlaced[] {
  const items = captionItems(renderer, tabId);
  if (!items.length) return [];
  // Live, only the focused part's caption keeps room for its inputs.
  const focus = live ? slideStore.focusPart : null;
  const placed = layoutCaptions(ctx, items, renderer.viewSize(), avoid.filter((r): r is Rect => !!r),
    k => (k === focus ? INPUT_ROW_H : 0), k => (k === focus ? INPUT_ROW_MIN_W : 0));
  const accent = accentColor();
  for (const pl of placed) drawCaption(ctx, items.find(i => i.key === pl.key)!, pl, accent);
  return placed;
}

/** The minimap into the PNG, where it sits on screen. */
function paintMinimap(ctx: CanvasRenderingContext2D, mm: HTMLCanvasElement, rect: Rect) {
  const { x, y, w, h } = rect;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.4)';
  ctx.shadowBlur = 10;
  ctx.fillStyle = 'rgba(28,30,36,0.9)';
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 8);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.drawImage(mm, x, y, w, h);
  ctx.restore();
}

/** The view with a header band naming the board file, for the PNG. */
function withHeader(view: HTMLCanvasElement, cssWidth: number, fileName: string): HTMLCanvasElement {
  const k = view.width / Math.max(1, cssWidth);
  const hh = Math.round(HEADER_H * k);
  const out = document.createElement('canvas');
  out.width = view.width;
  out.height = view.height + hh;
  const ctx = out.getContext('2d');
  if (!ctx) return view;
  ctx.fillStyle = '#16181d';
  ctx.fillRect(0, 0, out.width, hh);
  ctx.fillStyle = accentColor();
  ctx.fillRect(0, hh - Math.max(1, Math.round(2 * k)), out.width, Math.max(1, Math.round(2 * k)));
  ctx.scale(k, k);
  ctx.textBaseline = 'middle';
  const font = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  const date = new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  ctx.font = `400 13px ${font}`;
  const dw = ctx.measureText(date).width;
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.fillText(date, cssWidth - 14 - dw, HEADER_H / 2);
  ctx.font = `600 17px ${font}`;
  ctx.fillStyle = '#ffffff';
  // Long names are cut with an ellipsis rather than running into the date.
  let name = fileName || 'board';
  const room = cssWidth - 14 - dw - 24 - 14;
  if (ctx.measureText(name).width > room) {
    while (name.length > 4 && ctx.measureText(name + '…').width > room) name = name.slice(0, -1);
    name += '…';
  }
  ctx.fillText(name, 14, HEADER_H / 2);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(view, 0, hh);
  return out;
}

const GUIDE_KEY = 'boardripper-slide-guide-hidden';

function loadGuideHidden(): boolean {
  try { return localStorage.getItem(GUIDE_KEY) === '1'; } catch { return false; }
}

/** What to do now, for the tool in hand and the device in use. DOM only —
 *  never in the PNG. */
function SlideGuide({ tool, multi, onClose }: { tool: SlideTool; multi: boolean; onClose: () => void }) {
  const touch = isTouchPrimary();
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const mod = mac ? '⌘' : 'Ctrl';
  const tap = touch ? 'Tap' : 'Click';
  const toolLine: Record<SlideTool, string> = {
    select: touch
      ? 'Drag an annotation to move it. Drag empty board to pan; tap a part to label it.'
      : 'Drag an annotation to move it, its handles to resize. Drag empty board to pan; click a part to label it.',
    arrow: 'Drag from the tail to the tip.',
    rect: 'Drag out a box. Drag its border later to move it.',
    text: `${tap} where the text goes, Enter to finish${touch ? '' : ' (Shift+Enter: new line)'}. ${tap} a text to edit it, drag it to move it.`,
    pen: touch
      ? 'Draw freehand. With a stylus, fingers keep panning and zooming.'
      : 'Draw freehand.',
  };
  const parts = multi
    ? `${tap} a part to add it. ${tap} a selected part once to type its readings, again to remove it.`
    : touch
      ? 'Several parts: turn on ▣ in the toolbar, then tap parts.'
      : `${mod}+click a part to add it to the labels. Shift+click still adds to the worklist.`;
  return (
    <div className="slide-guide" data-testid="slide-guide" onPointerDown={e => e.stopPropagation()}>
      <button className="slide-guide-close" title="Hide the guide (the ? in the toolbar brings it back)" aria-label="Hide the guide" onClick={onClose}>
        <IconX size={13} />
      </button>
      <div className="slide-guide-title">Slide mode</div>
      <p data-testid="slide-guide-tool">{toolLine[tool]}</p>
      <p data-testid="slide-guide-parts">{parts}</p>
      <p>Ω and ▷| under a label: readings for the part picked last. They print on its label.</p>
      <p className="slide-guide-keys">
        {touch
          ? 'The bin deletes the selected annotation. PNG saves the view with its labels.'
          : `⌫ delete · ${mod}Z undo · Esc leave · PNG saves the view with its labels`}
      </p>
    </div>
  );
}

export function SlideLayer({ tabId, renderer, rootRef, hostRef, fileName }: Props) {
  const slide = useSlide();
  const multiCount = useSyncExternalStore(c => selectionSetStore.subscribe(c), () => selectionSetStore.current.ordered.length);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [editing, setEditing] = useState<{ id: number | null; at: Pt; screen: Pt; text: string } | null>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  // Where the live captions went: the reading inputs sit under each.
  const [inputSlots, setInputSlots] = useState<Array<{ key: string; x: number; y: number; w: number }>>([]);
  const slotsSig = useRef('');
  // Once a stylus has been seen, fingers pan and zoom while the pen tool is
  // on — the convention of every drawing app on a tablet.
  const penSeen = useRef(false);
  const [guideHidden, setGuideHidden] = useState(loadGuideHidden);
  const setGuide = useCallback((hidden: boolean) => {
    setGuideHidden(hidden);
    try { localStorage.setItem(GUIDE_KEY, hidden ? '1' : '0'); } catch { /* per-viewer convenience only */ }
  }, []);

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
    // Live labels keep clear of the minimap and the guide card (DOM, on top).
    const guide = rootRef.current?.querySelector('[data-testid="slide-guide"]') ?? null;
    const placed = paintCaptions(ctx, renderer, tabId, [minimapRect(minimapCanvas(rootRef.current), host), minimapRect(guide, host)], true);
    paintAnnotations(ctx, list, renderer, slideStore.selectedId);
    const slots = placed.filter(p => p.key === slideStore.focusPart).map(p => ({ key: p.key, x: Math.round(p.block.x), y: Math.round(p.pill.y + p.pill.h + 4), w: Math.round(p.block.w) }));
    const sig = JSON.stringify(slots);
    if (sig !== slotsSig.current) { slotsSig.current = sig; setInputSlots(slots); }
  }, [renderer, tabId, hostRef, rootRef]);

  useEffect(() => { paint(); }, [paint, slide.rev, slide.selectedId, slide.enabled, slide.focusPart, editing, guideHidden, slide.tool, slide.multi]);
  useEffect(() => renderer?.onViewChange(() => paint()), [renderer, paint]);
  // Captions follow the selection and the multi-selection.
  // A new primary selection becomes the part in focus for readings.
  const lastPrimary = useRef<number | null>(null);
  useEffect(() => boardStore.subscribe(() => {
    if (boardStore.activeTabId === tabId) {
      const idx = boardStore.selection.partIndex;
      if (idx !== lastPrimary.current) {
        lastPrimary.current = idx;
        slideStore.setFocusPart(idx !== null ? renderer?.partScreenBox(idx)?.name ?? null : null);
      }
    }
    if (slideStore.enabled) paint();
  }), [paint, tabId, renderer]);
  useEffect(() => selectionSetStore.subscribe(() => { if (slideStore.enabled) paint(); }), [paint]);

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

  const startEdit = useCallback((id: number) => {
    const ann = slideStore.list(tabId).find(a => a.id === id);
    const s = ann ? toScreen(ann.a) : null;
    if (ann && s) setEditing({ id, at: ann.a, screen: s, text: ann.text ?? '' });
  }, [tabId, toScreen]);

  useEffect(() => {
    const root = rootRef.current, host = hostRef.current;
    if (!root || !host || !renderer) return;
    const onDown = (e: PointerEvent) => {
      if (!slideStore.enabled || boardStore.activeTabId !== tabId) return;
      if (e.button !== 0 || !e.isPrimary) return;
      if (!(e.target instanceof Node) || !host.contains(e.target)) return;
      if (editingRef.current) { commitEdit(); e.stopPropagation(); e.preventDefault(); return; }
      if (e.pointerType === 'pen') penSeen.current = true;
      const tool = slideStore.tool;
      if (tool === 'pen' && e.pointerType === 'touch' && penSeen.current) return;   // finger pans
      const p = localPoint(e);
      if (!p) return;
      const bp = renderer.screenToBoard(p.x, p.y);
      if (!bp) return;
      const list = slideStore.list(tabId);
      let drag: Drag | null = null;

      // A handle of the selected annotation, then any annotation: those move
      // with every tool except the pen, which always draws.
      const sel = slideStore.selectedId !== null ? list.find(a => a.id === slideStore.selectedId) : undefined;
      const h = sel && tool !== 'pen' ? hitHandle(sel, p, toScreen) : null;
      const hit = tool !== 'pen' && !h ? hitAnnotation(list, p, toScreen) : null;
      if (sel && h) {
        drag = { kind: 'handle', id: sel.id, handle: h, moved: false };
      } else if (hit) {
        slideStore.select(hit.id);
        if (e.detail >= 2 && hit.kind === 'text') {
          startEdit(hit.id);
          e.stopPropagation(); e.preventDefault();
          return;
        }
        // Text tool: a click on a text edits it, a drag moves it.
        drag = { kind: 'move', id: hit.id, lastBoard: bp, moved: false, editOnClick: tool === 'text' && hit.kind === 'text' };
      } else if (tool === 'select') {
        slideStore.select(null);
        return;                                   // empty board: let it pan / select parts
      } else if (tool === 'text') {
        setEditing({ id: null, at: bp, screen: p, text: '' });
        e.stopPropagation(); e.preventDefault();
        return;
      } else if (tool === 'pen') {
        slideStore.select(null);
        const id = slideStore.add(tabId, {
          kind: 'ink', a: bp, b: bp, points: [bp], color: slideStore.color, size: slideStore.strokeSize(),
        });
        drag = { kind: 'ink', id, points: [bp], last: p };
      } else {
        const id = slideStore.add(tabId, {
          kind: tool, a: bp, b: bp, color: slideStore.color, size: slideStore.strokeSize(),
        });
        drag = { kind: 'create', id };
      }

      e.stopPropagation();
      e.preventDefault();
      dragRef.current = drag;
      const pointerId = e.pointerId;
      const startScreen = p;
      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        const d = dragRef.current;
        if (!d) return;
        if (d.kind === 'ink') {
          // Coalesced samples: a pen reports far more than one per frame.
          const evs = typeof ev.getCoalescedEvents === 'function' ? ev.getCoalescedEvents() : [];
          for (const ce of evs.length ? evs : [ev]) {
            const q = localPoint(ce);
            if (!q || Math.hypot(q.x - d.last.x, q.y - d.last.y) < 1.5) continue;
            const b = renderer.screenToBoard(q.x, q.y);
            if (!b) continue;
            d.points.push(b);
            d.last = q;
          }
          slideStore.update(tabId, d.id, { points: d.points.slice() }, false);
          return;
        }
        const q = localPoint(ev);
        if (!q) return;
        const b = renderer.screenToBoard(q.x, q.y);
        if (!b) return;
        if (d.kind === 'create') {
          slideStore.update(tabId, d.id, { b }, false);
          return;
        }
        // A press that never moves records no undo step.
        if (!d.moved) {
          if (Math.hypot(q.x - startScreen.x, q.y - startScreen.y) < 3) return;
          d.moved = true;
          slideStore.checkpoint(tabId);
        }
        const ann = slideStore.list(tabId).find(a => a.id === d.id);
        if (!ann) return;
        if (d.kind === 'move') {
          const dx = b.x - d.lastBoard.x, dy = b.y - d.lastBoard.y;
          d.lastBoard = b;
          slideStore.update(tabId, d.id, {
            a: { x: ann.a.x + dx, y: ann.a.y + dy }, b: { x: ann.b.x + dx, y: ann.b.y + dy },
            ...(ann.points ? { points: ann.points.map(pt => ({ x: pt.x + dx, y: pt.y + dy })) } : {}),
          }, false);
        } else {
          const m = d.handle.moves;
          slideStore.update(tabId, d.id, {
            a: { x: m.ax ? b.x : ann.a.x, y: m.ay ? b.y : ann.a.y },
            b: { x: m.bx ? b.x : ann.b.x, y: m.by ? b.y : ann.b.y },
          }, false);
        }
      };
      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
        window.removeEventListener('pointercancel', onUp, true);
        const d = dragRef.current;
        dragRef.current = null;
        if (!d) return;
        if (d.kind === 'move' && !d.moved && d.editOnClick) { startEdit(d.id); return; }
        if (d.kind === 'ink') {
          // A cancelled stroke (a second finger landing) is not a drawing.
          if (ev.type === 'pointercancel') slideStore.abandon(tabId, d.id);
          return;
        }
        if (d.kind !== 'create') return;
        const q = localPoint(ev) ?? startScreen;
        // A click without a drag makes nothing — an empty arrow is noise.
        if (Math.hypot(q.x - startScreen.x, q.y - startScreen.y) < 6) slideStore.abandon(tabId, d.id);
        else slideStore.select(d.id);
      };
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
      window.addEventListener('pointercancel', onUp, true);
    };
    root.addEventListener('pointerdown', onDown, true);
    return () => root.removeEventListener('pointerdown', onDown, true);
  }, [renderer, rootRef, hostRef, tabId, localPoint, toScreen, commitEdit, startEdit]);

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
    const view = renderer.captureView(ctx => {
      const mm = minimapCanvas(rootRef.current);
      const mr = minimapRect(mm, hostRef.current);
      paintCaptions(ctx, renderer, tabId, [mr], false);
      paintAnnotations(ctx, slideStore.list(tabId), renderer, null);
      if (mm && mr) paintMinimap(ctx, mm, mr);
    });
    return view ? withHeader(view, renderer.viewSize().width, fileName) : null;
  }, [renderer, tabId, hostRef, rootRef, fileName]);

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
    { id: 'select', icon: IconPointer, title: 'Select · move and resize; on empty board, pan and pick parts' },
    { id: 'arrow', icon: IconArrowUpRight, title: 'Arrow · drag from tail to tip' },
    { id: 'rect', icon: IconSquare, title: 'Rectangle · drag a box' },
    { id: 'text', icon: IconTypography, title: 'Text · click where it goes; click a text to edit, drag it to move' },
    { id: 'pen', icon: IconPencil, title: 'Pen · draw freehand (with a stylus, fingers keep panning)' },
  ];

  return (
    <>
      <div className="slide-layer" data-testid="slide-layer">
        <canvas ref={canvasRef} className="slide-layer-canvas" />
        {inputSlots.map(slot => {
          const r = slideStore.readings(tabId, slot.key);
          return (
            <div
              key={slot.key}
              className="slide-readings"
              data-testid={`slide-readings-${slot.key}`}
              style={{ left: slot.x, top: slot.y, width: slot.w }}
            >
              <label title={`Resistance of ${slot.key}`}>
                <span>Ω</span>
                <input
                  data-testid={`slide-ohm-${slot.key}`}
                  value={r?.ohm ?? ''}
                  onChange={e => slideStore.setReading(tabId, slot.key, 'ohm', e.target.value)}
                  onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur(); }}
                />
              </label>
              <label title={`Diode-mode reading of ${slot.key}`}>
                <span>▷|</span>
                <input
                  data-testid={`slide-diode-${slot.key}`}
                  value={r?.diode ?? ''}
                  onChange={e => slideStore.setReading(tabId, slot.key, 'diode', e.target.value)}
                  onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur(); }}
                />
              </label>
            </div>
          );
        })}
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
      {!guideHidden && <SlideGuide tool={slide.tool} multi={slide.multi} onClose={() => setGuide(true)} />}
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
        <button
          className={`board-netlines-toggle ${slide.multi ? 'active' : ''}`}
          data-testid="slide-multi"
          aria-pressed={slide.multi}
          title={slide.multi
            ? `Several parts: on — ${isTouchPrimary() ? 'tap' : 'click'} a part to add it; on a selected part, once to type its readings, again to remove it`
            : isTouchPrimary()
              ? 'Several parts: tap parts to add them to the selection'
              : `Several parts: click parts to add them to the selection (${/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'}+click works anytime; Shift+click stays the worklist's)`}
          onClick={() => slideStore.setMulti(!slide.multi)}
        >
          <IconSquaresSelected size={16} />
        </button>
        {multiCount > 0 && (
          <button
            className="board-netlines-toggle slide-wide"
            data-testid="slide-multi-clear"
            title="Clear the multi-selection"
            onClick={() => selectionSetStore.clear(tabId)}
          >
            <span>{multiCount}</span><IconX size={13} />
          </button>
        )}
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
        <button
          className={`board-netlines-toggle ${guideHidden ? '' : 'active'}`}
          data-testid="slide-guide-toggle"
          aria-pressed={!guideHidden}
          title={guideHidden ? 'Show the guide' : 'Hide the guide'}
          onClick={() => setGuide(!guideHidden)}
        >
          <IconHelp size={16} />
        </button>
        <button className="board-netlines-toggle" title="Leave slide mode (Esc) — the annotations come back with it" onClick={() => slideStore.setEnabled(false)}>
          <IconX size={16} />
        </button>
      </div>
    </>
  );
}
