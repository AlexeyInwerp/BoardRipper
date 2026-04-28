import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useBoardStore } from '../../hooks/useBoardStore';
import { pdfStore } from '../../store/pdf-store';
import { updateStore } from '../../store/update-store';
import { renderSettingsStore } from '../../store/render-settings';
import {
  isAutoSwitchLinked,
  setAutoSwitchLinked,
  onAutoSwitchChange,
  getDockviewApi,
} from '../../store/dockview-api';
import { showSidebarTab } from '../Sidebar';
import { shortcuts, formatShortcut } from '../../store/keyboard-shortcuts';
import type { Shortcut } from '../../store/keyboard-shortcuts';
import {
  SCROLL_BINDINGS_KEY,
  SCROLL_ACTIONS,
  DEFAULT_SCROLL_BINDINGS,
  loadScrollBindings,
} from '../../panels/PdfViewerPanel';
import type { ScrollAction, ScrollBindings } from '../../panels/PdfViewerPanel';
import { sessionRant } from './rants';
import { renderMarkdown } from './markdown';
import instructionsMd from './instructions.md?raw';

// ─────────────────────────────────────────────────────────────
// Small store subscriptions (inline — only used here)
// ─────────────────────────────────────────────────────────────

function usePdfCount(): number {
  return useSyncExternalStore(
    (cb) => pdfStore.subscribe(cb),
    () => pdfStore.loadedFileNames.length,
  );
}

// Tracks total panel count in Dockview so the home backdrop can hide whenever
// any panel exists, not just board/pdf panels. Without this, opening a
// non-board/non-pdf panel (e.g. Database Editor) leaves the backdrop on top.
function useDockviewPanelCount(): number {
  const [count, setCount] = useState(() => getDockviewApi()?.panels.length ?? 0);
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      if (cancelled) return;
      setCount(getDockviewApi()?.panels.length ?? 0);
    };
    // The api may not be ready on first render; poll briefly until it is, then
    // subscribe to add/remove events.
    let pollDispose: (() => void) | undefined;
    let addDispose: (() => void) | undefined;
    let removeDispose: (() => void) | undefined;
    const wire = () => {
      const api = getDockviewApi();
      if (!api) {
        const t = window.setTimeout(wire, 100);
        pollDispose = () => window.clearTimeout(t);
        return;
      }
      refresh();
      const a = api.onDidAddPanel(refresh);
      const r = api.onDidRemovePanel(refresh);
      addDispose = () => a.dispose();
      removeDispose = () => r.dispose();
    };
    wire();
    return () => {
      cancelled = true;
      pollDispose?.();
      addDispose?.();
      removeDispose?.();
    };
  }, []);
  return count;
}

function useUpdateState() {
  return useSyncExternalStore(
    (cb) => updateStore.subscribe(cb),
    () => updateStore.state,
  );
}

function useDragToZoom(): boolean {
  return useSyncExternalStore(
    (cb) => renderSettingsStore.subscribe(cb),
    () => renderSettingsStore.globalSettings.dragToZoom,
  );
}

function useTwoFingerPan(): boolean {
  return useSyncExternalStore(
    (cb) => renderSettingsStore.subscribe(cb),
    () => renderSettingsStore.globalSettings.twoFingerPan,
  );
}

function useAutoSwitch(): boolean {
  return useSyncExternalStore(
    (cb) => onAutoSwitchChange(cb),
    () => isAutoSwitchLinked(),
  );
}

// ─────────────────────────────────────────────────────────────
// CollapsibleCard — dashboard section with a −/+ toggle. Collapse
// state is persisted to localStorage under a single JSON key.
// ─────────────────────────────────────────────────────────────

const CARD_STATE_KEY = 'boardripper-home-card-state';

type CardState = Record<string, boolean>; // true = collapsed

function loadCardState(): CardState {
  try {
    const raw = localStorage.getItem(CARD_STATE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as CardState) : {};
  } catch {
    return {};
  }
}

function saveCardState(state: CardState): void {
  try {
    localStorage.setItem(CARD_STATE_KEY, JSON.stringify(state));
  } catch {
    /* quota or private mode */
  }
}

function useCardCollapsed(id: string, defaultCollapsed = false): [boolean, (v: boolean) => void] {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    const s = loadCardState();
    return id in s ? s[id] : defaultCollapsed;
  });
  const update = useCallback(
    (next: boolean) => {
      setCollapsed(next);
      const s = loadCardState();
      s[id] = next;
      saveCardState(s);
    },
    [id],
  );
  return [collapsed, update];
}

interface CollapsibleCardProps {
  id: string;
  title: string;
  headerExtra?: React.ReactNode;
  className?: string;
  defaultCollapsed?: boolean;
  children: React.ReactNode;
}

function CollapsibleCard({
  id,
  title,
  headerExtra,
  className,
  defaultCollapsed,
  children,
}: CollapsibleCardProps) {
  const [collapsed, setCollapsed] = useCardCollapsed(id, defaultCollapsed);
  return (
    <section
      className={`home-card${collapsed ? ' collapsed' : ''}${className ? ' ' + className : ''}`}
    >
      <div className="home-card-header">
        <h2 className="home-card-title">{title}</h2>
        {headerExtra}
        <button
          type="button"
          className="home-card-toggle"
          onClick={() => setCollapsed(!collapsed)}
          title={collapsed ? 'Expand' : 'Collapse'}
          aria-label={collapsed ? 'Expand section' : 'Collapse section'}
          aria-expanded={!collapsed}
        >
          {collapsed ? '+' : '\u2212'}
        </button>
      </div>
      {!collapsed && children}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// Banner + rant
// ─────────────────────────────────────────────────────────────

function Banner() {
  return (
    <header className="home-banner">
      <h1 className="home-banner-title">***WELCOME YOU TO BOARDRIPPER***</h1>
      <p className="home-banner-rant">{sessionRant}</p>
    </header>
  );
}

// ─────────────────────────────────────────────────────────────
// Instructions — editable markdown at components/home/instructions.md
// The MD's first H1 is stripped (title lives on the card header).
// ─────────────────────────────────────────────────────────────

const INSTRUCTIONS_BODY = instructionsMd.replace(/^#\s+.*(?:\r?\n)?/, '');
const INSTRUCTIONS_TITLE = (() => {
  const m = instructionsMd.match(/^#\s+(.+)/);
  return m ? m[1].trim() : 'Getting started';
})();

function Instructions() {
  return (
    <CollapsibleCard id="instructions" title={INSTRUCTIONS_TITLE} className="home-instructions">
      {renderMarkdown(INSTRUCTIONS_BODY)}
    </CollapsibleCard>
  );
}

// ─────────────────────────────────────────────────────────────
// Latest update card
// ─────────────────────────────────────────────────────────────

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (isNaN(then)) return '';
  const diffMs = Date.now() - then;
  const s = Math.floor(diffMs / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

function LatestUpdate() {
  const state = useUpdateState();
  const info = state.release_info;

  return (
    <CollapsibleCard
      id="latest-update"
      title="Latest update"
      headerExtra={
        state.has_update ? <span className="home-update-badge">Update available</span> : undefined
      }
    >
      {info ? (
        <div className="home-update-body">
          <div className="home-update-meta">
            <a href={info.html_url} target="_blank" rel="noreferrer" className="home-update-tag">
              {info.tag_name}
            </a>
            {info.published_at && (
              <span className="home-update-date">· {formatRelativeTime(info.published_at)}</span>
            )}
          </div>
          <pre className="home-update-notes">{info.body || '(no release notes)'}</pre>
        </div>
      ) : (
        <p className="home-card-empty">No release info — check your connection.</p>
      )}
    </CollapsibleCard>
  );
}

// ─────────────────────────────────────────────────────────────
// Quick settings: drag bindings + auto-switch + settings link
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// Pan/zoom bindings (board drag + board scroll + PDF scroll)
//
// ⚠ Keep in sync with the Settings panel editors in
//   src/frontend/src/panels/SettingsPanel.tsx
// (BoardScrollBindingsEditor, BoardDragBindingsEditor, ScrollBindingsEditor
//  + their MODIFIER_LABELS / ACTION_LABELS / ACTION_COLORS constants).
// Pill labels, slot labels, and colors must match exactly — any change
// here needs the same change there, and vice versa.
// ─────────────────────────────────────────────────────────────

type PzAction = 'pan' | 'zoom';
// Mirrors BOARD_ACTION_LABELS / BOARD_ACTION_COLORS in SettingsPanel.tsx.
const PZ_ACTION_LABEL: Record<PzAction, string> = { zoom: 'Zoom', pan: 'Pan' };
const PZ_ACTION_COLOR: Record<PzAction, string> = { zoom: '#00d4ff', pan: '#ffd93d' };

type SlotKey = 'bare' | 'shift';

interface PillSwapProps {
  /** Current action assigned to the bare slot (the other slot gets the opposite). */
  bareAction: PzAction;
  /** Label shown for each slot. */
  slotLabels: Record<SlotKey, React.ReactNode>;
  /** Called when the user swaps pills; receives the new action that the bare slot should hold. */
  onSwap: (newBareAction: PzAction) => void;
}

/**
 * Generic two-slot pill-swap editor: user drags one pill onto the other slot
 * to swap them. Used for both scroll-wheel and mouse-drag bindings.
 */
function PillSwap({ bareAction, slotLabels, onSwap }: PillSwapProps) {
  const [dragging, setDragging] = useState<PzAction | null>(null);
  const [dragOver, setDragOver] = useState<SlotKey | null>(null);

  const bindings: Record<SlotKey, PzAction> = {
    bare: bareAction,
    shift: bareAction === 'zoom' ? 'pan' : 'zoom',
  };

  const onDragStart = useCallback((e: React.DragEvent, action: PzAction) => {
    setDragging(action);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', action);
  }, []);

  const onDragOverSlot = useCallback((e: React.DragEvent, slot: SlotKey) => {
    if (e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOver(slot);
  }, []);

  const onDropSlot = useCallback(
    (e: React.DragEvent, target: SlotKey) => {
      if (e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      setDragOver(null);
      setDragging(null);
      const action = e.dataTransfer.getData('text/plain') as PzAction;
      if (action !== 'pan' && action !== 'zoom') return;
      // If the dropped action lands on the bare slot, bare becomes that action.
      // If it lands on the shift slot, bare becomes the opposite.
      const newBare: PzAction = target === 'bare' ? action : action === 'zoom' ? 'pan' : 'zoom';
      if (newBare !== bareAction) onSwap(newBare);
    },
    [bareAction, onSwap],
  );

  const onDragEnd = useCallback(() => {
    setDragging(null);
    setDragOver(null);
  }, []);

  const slots: SlotKey[] = ['bare', 'shift'];
  return (
    <div className="scroll-bindings-editor">
      <div className="scroll-bindings-grid">
        {slots.map((key) => {
          const action = bindings[key];
          const isOver = dragOver === key;
          return (
            <div
              key={key}
              className={`scroll-binding-slot${isOver ? ' drag-over' : ''}`}
              onDragOver={(e) => onDragOverSlot(e, key)}
              onDragLeave={() => setDragOver(null)}
              onDrop={(e) => onDropSlot(e, key)}
            >
              <span className="scroll-binding-modifier">{slotLabels[key]}</span>
              <span
                className={`scroll-binding-pill${dragging === action ? ' dragging' : ''}`}
                style={{ '--pill-color': PZ_ACTION_COLOR[action] } as React.CSSProperties}
                draggable
                onDragStart={(e) => onDragStart(e, action)}
                onDragEnd={onDragEnd}
              >
                {PZ_ACTION_LABEL[action]}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function setGlobalSetting<K extends 'dragToZoom' | 'twoFingerPan'>(key: K, next: boolean) {
  const snap = renderSettingsStore.globalSnapshot();
  if (snap[key] === next) return;
  snap[key] = next;
  renderSettingsStore.applyGlobal(snap);
}

// Mirrors BOARD_DRAG_MODIFIER_LABELS in SettingsPanel.tsx.
const DRAG_SLOT_LABELS: Record<SlotKey, React.ReactNode> = {
  bare: 'Left-drag',
  shift: 'Shift + Left-drag',
};

// Mirrors BOARD_MODIFIER_LABELS in SettingsPanel.tsx.
const SCROLL_SLOT_LABELS: Record<SlotKey, React.ReactNode> = {
  bare: 'Scroll',
  shift: (
    <>
      Shift + Scroll
      <br />
      Ctrl + Scroll (fast)
    </>
  ),
};

function DragBindings() {
  const dragToZoom = useDragToZoom();
  // dragToZoom=true  →  bare left-drag zooms
  // dragToZoom=false →  bare left-drag pans
  return (
    <PillSwap
      bareAction={dragToZoom ? 'zoom' : 'pan'}
      slotLabels={DRAG_SLOT_LABELS}
      onSwap={(bare) => setGlobalSetting('dragToZoom', bare === 'zoom')}
    />
  );
}

function ScrollBindings() {
  const twoFingerPan = useTwoFingerPan();
  // twoFingerPan=true  →  bare scroll pans (shift/ctrl zoom)
  // twoFingerPan=false →  bare scroll zooms (shift/ctrl pan)
  return (
    <PillSwap
      bareAction={twoFingerPan ? 'pan' : 'zoom'}
      slotLabels={SCROLL_SLOT_LABELS}
      onSwap={(bare) => setGlobalSetting('twoFingerPan', bare === 'pan')}
    />
  );
}

// ─────────────────────────────────────────────────────────────
// PDF scroll bindings — 3-slot pill-swap (zoom / pan / page-switch)
// ─────────────────────────────────────────────────────────────

// PDF scroll bindings — mirror of ACTION_LABELS / ACTION_COLORS /
// MODIFIER_LABELS in SettingsPanel.tsx (ScrollBindingsEditor). Labels
// and colors must stay identical to the Settings panel so both views
// show the same thing. Any change here must also be made there.
const PDF_ACTION_LABEL: Record<ScrollAction, string> = {
  zoom: 'Zoom',
  pan: 'Pan',
  switch: 'Page',
};
const PDF_ACTION_COLOR: Record<ScrollAction, string> = {
  zoom: '#00d4ff',
  pan: '#ffd93d',
  switch: '#ff6b9d',
};

const PDF_SLOT_KEYS: (keyof ScrollBindings)[] = ['bare', 'shift', 'meta'];
const isMacPlatform =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform ?? '');
const PDF_SLOT_LABELS: Record<keyof ScrollBindings, React.ReactNode> = {
  bare: 'Scroll',
  shift: (
    <>
      Shift + Scroll
      <br />
      Ctrl + Scroll (fast)
    </>
  ),
  meta: isMacPlatform ? '⌘ + Scroll' : 'Ctrl + Scroll',
};

function savePdfBindings(next: ScrollBindings) {
  try {
    localStorage.setItem(SCROLL_BINDINGS_KEY, JSON.stringify(next));
  } catch {
    /* ignore quota */
  }
  window.dispatchEvent(new CustomEvent('pdf-scroll-bindings-changed', { detail: next }));
}

function PdfScrollBindings() {
  const [bindings, setBindings] = useState<ScrollBindings>(loadScrollBindings);
  const [dragging, setDragging] = useState<ScrollAction | null>(null);
  const [dragOver, setDragOver] = useState<keyof ScrollBindings | null>(null);

  // Stay in sync with the Settings panel — both listen on this event.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<ScrollBindings>).detail;
      if (detail) setBindings(detail);
    };
    window.addEventListener('pdf-scroll-bindings-changed', handler);
    return () => window.removeEventListener('pdf-scroll-bindings-changed', handler);
  }, []);

  const onDragStart = useCallback((e: React.DragEvent, action: ScrollAction) => {
    setDragging(action);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', action);
  }, []);

  const onDragOverSlot = useCallback((e: React.DragEvent, slot: keyof ScrollBindings) => {
    if (e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOver(slot);
  }, []);

  const onDropSlot = useCallback(
    (e: React.DragEvent, target: keyof ScrollBindings) => {
      if (e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      setDragOver(null);
      setDragging(null);
      const action = e.dataTransfer.getData('text/plain') as ScrollAction;
      if (!SCROLL_ACTIONS.includes(action)) return;
      const source = PDF_SLOT_KEYS.find((k) => bindings[k] === action);
      if (!source || source === target) return;
      const next: ScrollBindings = { ...bindings };
      next[source] = bindings[target];
      next[target] = action;
      setBindings(next);
      savePdfBindings(next);
    },
    [bindings],
  );

  const onDragEnd = useCallback(() => {
    setDragging(null);
    setDragOver(null);
  }, []);

  const isDefault =
    bindings.bare === DEFAULT_SCROLL_BINDINGS.bare &&
    bindings.shift === DEFAULT_SCROLL_BINDINGS.shift &&
    bindings.meta === DEFAULT_SCROLL_BINDINGS.meta;

  const handleReset = useCallback(() => {
    setBindings(DEFAULT_SCROLL_BINDINGS);
    savePdfBindings(DEFAULT_SCROLL_BINDINGS);
  }, []);

  return (
    <div className="scroll-bindings-editor">
      <div className="scroll-bindings-grid">
        {PDF_SLOT_KEYS.map((slot) => {
          const action = bindings[slot];
          const isOver = dragOver === slot;
          return (
            <div
              key={slot}
              className={`scroll-binding-slot${isOver ? ' drag-over' : ''}`}
              onDragOver={(e) => onDragOverSlot(e, slot)}
              onDragLeave={() => setDragOver(null)}
              onDrop={(e) => onDropSlot(e, slot)}
            >
              <span className="scroll-binding-modifier">{PDF_SLOT_LABELS[slot]}</span>
              <span
                className={`scroll-binding-pill${dragging === action ? ' dragging' : ''}`}
                style={{ '--pill-color': PDF_ACTION_COLOR[action] } as React.CSSProperties}
                draggable
                onDragStart={(e) => onDragStart(e, action)}
                onDragEnd={onDragEnd}
              >
                {PDF_ACTION_LABEL[action]}
              </span>
            </div>
          );
        })}
      </div>
      {!isDefault && (
        <button type="button" className="scroll-bindings-reset" onClick={handleReset}>
          Reset to default
        </button>
      )}
    </div>
  );
}

function AutoSwitchToggle() {
  const enabled = useAutoSwitch();
  return (
    <label
      className="home-toggle-row"
      title="When you activate a board tab, its linked PDF tab is also activated (and vice versa)."
    >
      <span>Auto-switch linked board ↔ PDF panel</span>
      <input
        type="checkbox"
        checked={enabled}
        onChange={(e) => setAutoSwitchLinked(e.target.checked)}
      />
    </label>
  );
}

function QuickSettings() {
  const openSettings = useCallback(() => showSidebarTab('settings'), []);
  return (
    <CollapsibleCard id="quick-settings" title="Quick settings">
      <div className="home-quick-settings">
        <div className="home-quick-group">
          <h3 className="home-quick-label">Board — mouse drag</h3>
          <DragBindings />
        </div>
        <div className="home-quick-group">
          <h3 className="home-quick-label">Board — scroll / two-finger scroll</h3>
          <ScrollBindings />
        </div>
        <div className="home-quick-group home-quick-group-wide">
          <h3 className="home-quick-label">PDF — scroll / two-finger scroll</h3>
          <PdfScrollBindings />
        </div>
        <div className="home-quick-group">
          <h3 className="home-quick-label">Behaviour</h3>
          <AutoSwitchToggle />
        </div>
      </div>
      <p className="home-quick-hint">
        On a trackpad, <strong>two-finger scroll</strong> fires the same event as a mouse wheel — the
        bindings above cover both. <strong>Pinch-to-zoom</strong> always zooms directly, regardless
        of these settings.
      </p>
      <button type="button" className="home-settings-link" onClick={openSettings}>
        Open full Settings →
      </button>
    </CollapsibleCard>
  );
}

// ─────────────────────────────────────────────────────────────
// Keyboard shortcuts (display-only, grouped by category)
// ─────────────────────────────────────────────────────────────

const CATEGORY_LABELS: Record<Shortcut['category'], string> = {
  file: 'File',
  view: 'Board',
  navigation: 'Navigation',
  pdf: 'PDF (when panel is active)',
};

const CATEGORY_ORDER: Shortcut['category'][] = ['file', 'view', 'navigation', 'pdf'];

function ShortcutList() {
  return (
    <CollapsibleCard id="shortcuts" title="Keyboard shortcuts">
      <div className="home-shortcut-grid">
        {CATEGORY_ORDER.map((cat) => {
          const items = shortcuts.filter((s) => s.category === cat);
          if (items.length === 0) return null;
          return (
            <div key={cat} className="home-shortcut-col">
              <h3 className="home-shortcut-category">{CATEGORY_LABELS[cat]}</h3>
              <ul className="home-shortcut-list">
                {items.map((s) => (
                  <li key={s.id} className="home-shortcut-row">
                    <span className="home-shortcut-label">{s.label}</span>
                    <kbd className="home-shortcut-key">{formatShortcut(s.id)}</kbd>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </CollapsibleCard>
  );
}

// ─────────────────────────────────────────────────────────────
// Footer
// ─────────────────────────────────────────────────────────────

function Footer() {
  const state = useUpdateState();
  return (
    <footer className="home-footer">
      BoardRipper {state.current_version} · AGPL-3.0 ·{' '}
      <a
        href="https://github.com/inwerp/Boardviewer"
        target="_blank"
        rel="noreferrer"
        className="home-footer-link"
      >
        GitHub
      </a>
    </footer>
  );
}

// ─────────────────────────────────────────────────────────────
// Top-level backdrop
// ─────────────────────────────────────────────────────────────

export function HomeBackdrop() {
  const { tabs } = useBoardStore();
  const pdfCount = usePdfCount();
  const dockPanelCount = useDockviewPanelCount();
  const visible = tabs.length === 0 && pdfCount === 0 && dockPanelCount === 0;

  return (
    <div className={`home-backdrop${visible ? '' : ' hidden'}`} aria-hidden={!visible}>
      <div className="home-backdrop-scroll">
        <div className="home-backdrop-inner">
          <Banner />
          <Instructions />
          <LatestUpdate />
          <QuickSettings />
          <ShortcutList />
          <Footer />
        </div>
      </div>
    </div>
  );
}
