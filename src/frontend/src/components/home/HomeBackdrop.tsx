import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useBoardStore } from '../../hooks/useBoardStore';
import { useDatabank } from '../../hooks/useDatabank';
import { databankStore } from '../../store/databank-store';
import { isLiteBuild } from '../../store/build-mode';
import { fileInputRefs } from '../../store/file-inputs';
import { boardStore } from '../../store/board-store';
import { IconUpload } from '@tabler/icons-react';
import { pdfStore } from '../../store/pdf-store';
import { updateStore } from '../../store/update-store';
import { renderSettingsStore, type RenderSettings } from '../../store/render-settings';
import { themeStore, ACCENT_PRESETS } from '../../store/themes';
import { isHdrCapable, onHdrCapabilityChange, rungForIntensity } from '../../renderer/hdr-selection-outline';
import { InterfaceScaleSlider } from '../InterfaceScaleSlider';
import { FolderLibraryOpenButton } from '../FolderLibraryControls';
import { ReleaseNotes } from '../ReleaseNotes';
import {
  isAutoSwitchLinked,
  setAutoSwitchLinked,
  onAutoSwitchChange,
  getDockviewApi,
} from '../../store/dockview-api';
import { showSidebarTab } from '../Sidebar.utils';
import { welcomeStore } from '../../store/welcome-store';
import { firstRunStore } from '../../store/first-run-store';
import { shortcuts, formatShortcut, CATEGORY_LABELS, CATEGORY_ORDER } from '../../store/keyboard-shortcuts';
import {
  ACTION_COLOR, ACTION_LABEL, SLOT_LABEL, SHIFT_SCROLL_NOTE, SCROLL_ACTIONS, SCROLL_SLOTS, SCROLL_BINDINGS_EVENT,
  DEFAULT_SCROLL_BINDINGS, BOARD_SCROLL_ACTIONS, isMacPlatform,
  loadScrollBindings, saveScrollBindings, sameScrollBindings, nextAction, boardScrollBindings, boardScrollSettings,
  type ScrollBindings, type ScrollSlot, type BoardScrollSettings,
} from '../../store/scroll-bindings';
import { sessionRant } from './rants';
import { renderMarkdown } from './markdown';
import instructionsMd from './instructions.md?raw';
import { hdrTileUrl } from '../../renderer/hdr-selection-outline';

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

function useInstalledRelease() {
  return useSyncExternalStore(
    (cb) => updateStore.subscribe(cb),
    () => updateStore.installedRelease,
  );
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

/** The three board scroll keys as one stable snapshot (useSyncExternalStore
 *  needs a reference that only changes when a value does). */
let boardScrollSnap: BoardScrollSettings | null = null;
function readBoardScrollSettings(): BoardScrollSettings {
  const g = renderSettingsStore.globalSettings;
  if (!boardScrollSnap || boardScrollSnap.twoFingerPan !== g.twoFingerPan
    || boardScrollSnap.wheelShiftAction !== g.wheelShiftAction || boardScrollSnap.wheelMetaAction !== g.wheelMetaAction) {
    boardScrollSnap = { twoFingerPan: g.twoFingerPan, wheelShiftAction: g.wheelShiftAction, wheelMetaAction: g.wheelMetaAction };
  }
  return boardScrollSnap;
}
function useBoardScrollSettings(): BoardScrollSettings {
  return useSyncExternalStore((cb) => renderSettingsStore.subscribe(cb), readBoardScrollSettings);
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

// `<!-- docker-only -->` … `<!-- /docker-only -->` fences mark sections that
// only make sense with a backend (Docker setup, the Library). The lite build
// drops them — it was opening on "Run it in Docker (recommended)" with no
// Docker to run — and every other build just drops the fence lines.
const INSTRUCTIONS_BODY = instructionsMd
  .replace(/^#\s+.*(?:\r?\n)?/, '')
  .replace(/<!-- docker-only -->[\s\S]*?<!-- \/docker-only -->\r?\n?/g, m => (isLiteBuild() ? '' : m))
  .replace(/^<!-- \/?docker-only -->\r?\n?/gm, '');
const INSTRUCTIONS_TITLE = (() => {
  const m = instructionsMd.match(/^#\s+(.+)/);
  return m ? m[1].trim() : 'Getting started';
})();

// ─────────────────────────────────────────────────────────────
// Lite build: the open-a-file card. There is no Library and, on a tablet, no
// drag-and-drop, so the toolbar's small Upload button was the only way in —
// and the page below it opened on Docker instructions. This is the front door.
// ─────────────────────────────────────────────────────────────

const SAMPLE_BOARD = {
  // CC-BY-SA 4.0 — "Tomu, I'm" by Sean 'xobs' Cross, https://tomu.im (see THIRD_PARTY.md).
  url: './samples/tomu-fpga.kicad_pcb',
  name: 'tomu-fpga.kicad_pcb',
  label: 'Tomu FPGA (KiCad, CC-BY-SA 4.0)',
};

function LiteOpenCard() {
  const [busy, setBusy] = useState(false);
  const openPicker = () => fileInputRefs.board?.click();
  const openSample = async () => {
    setBusy(true);
    try {
      const res = await fetch(SAMPLE_BOARD.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      const dt = new DataTransfer();
      dt.items.add(new File([buf], SAMPLE_BOARD.name, { type: 'application/octet-stream' }));
      await boardStore.loadFiles(dt.files);
    } catch (err) {
      boardStore.addToast(`Could not load the sample board: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="home-card home-open-card" data-testid="home-open-card">
      <div className="home-open-actions">
        <button type="button" className="home-open-btn home-open-btn-primary" onClick={openPicker} data-testid="home-open-btn">
          <IconUpload size={18} stroke={1.75} /> Open a board or PDF
        </button>
        <FolderLibraryOpenButton className="home-open-btn" />
        <button type="button" className="home-open-btn" onClick={openSample} disabled={busy} data-testid="home-sample-btn" title={SAMPLE_BOARD.label}>
          {busy ? 'Loading…' : 'Try a sample board'}
        </button>
      </div>
      <p className="home-open-note">
        Everything runs in this browser tab. Nothing is uploaded. Pick a board and its schematic
        PDF together and both open side by side.
      </p>
    </section>
  );
}

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
  const installed = useInstalledRelease();
  const info = state.manifest;
  const isImportant = state.has_update && info?.important === true;

  return (
    <CollapsibleCard
      id="latest-update"
      title="Latest update"
      headerExtra={
        state.has_update ? (
          <span className={`home-update-badge${isImportant ? ' home-update-badge-important' : ''}`}>
            {isImportant ? 'Important update' : 'Update available'}
          </span>
        ) : undefined
      }
    >
      {info ? (
        <div className="home-update-body">
          {isImportant && info.important_reason && (
            <p className="home-update-important-reason">{info.important_reason}</p>
          )}
          <div className="home-update-meta">
            {info.notes_url ? (
              <a href={info.notes_url} target="_blank" rel="noreferrer" className="home-update-tag">
                {info.version}
              </a>
            ) : (
              <span className="home-update-tag">{info.version}</span>
            )}
            {info.released_at && (
              <span className="home-update-date">· {formatRelativeTime(info.released_at)}</span>
            )}
            {info.notes_url && !isImportant && (
              <a href={info.notes_url} target="_blank" rel="noreferrer" className="home-update-date">
                · Release notes ↗
              </a>
            )}
          </div>
          {installed && <InstalledNotes installed={installed} showHeading={state.has_update} />}
        </div>
      ) : installed ? (
        // No manifest reachable (offline), but we know what the running
        // version brought — still worth showing.
        <div className="home-update-body">
          <InstalledNotes installed={installed} showHeading={false} />
        </div>
      ) : (
        <p className="home-card-empty">No release info — check your connection.</p>
      )}
    </CollapsibleCard>
  );
}

/** What the running version brought. Clipped to a few lines on the start page
 *  so a long changelog can't swallow the card; "Show all" expands it in place.
 *  `showHeading` labels it explicitly when an update is also on offer above,
 *  so the two versions are never confused. */
function InstalledNotes({ installed, showHeading }: {
  installed: { version: string; notes: string; notes_url?: string };
  showHeading: boolean;
}) {
  return (
    <div className="home-update-notes" data-testid="home-installed-notes">
      {showHeading && (
        <div className="home-update-notes-heading">
          What&apos;s new in {installed.version} · yours
        </div>
      )}
      <ReleaseNotes notes={installed.notes} maxLines={6} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Quick settings: drag bindings + auto-switch + settings link
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// Pan/zoom bindings (board drag + board scroll + PDF scroll)
//
// Mirrors the Settings panel editors (SettingsPanel.tsx: SlotBindingsEditor
// and BoardDragBindingsEditor). Labels and colours come from
// store/scroll-bindings.ts so the two surfaces cannot drift; only the
// compact matrix layout is this file's own. A click on an action cycles it.
// ─────────────────────────────────────────────────────────────

type PzAction = 'pan' | 'zoom';

// ─────────────────────────────────────────────────────────────
// Console-matrix primitives. Each editor renders a single row in
// a shared <div className="home-bindings-matrix"> container.
// ─────────────────────────────────────────────────────────────

interface MatrixSlotProps {
  modifier: React.ReactNode;
  actionLabel: string;
  color: string;
  testId?: string;
  action: string;
  onClick: () => void;
}

/** A single split-cell: muted modifier on the left, coloured action on the
 *  right. The action half is a button; a click cycles the slot's action. */
function MatrixSlot({ modifier, actionLabel, color, testId, action, onClick }: MatrixSlotProps) {
  return (
    <div className="home-bindings-cell">
      <span className="home-bindings-cell-mod">{modifier}</span>
      <button
        type="button"
        className="home-bindings-cell-action"
        style={{ '--pill-color': color } as React.CSSProperties}
        data-testid={testId}
        data-action={action}
        title="Click to change"
        onClick={onClick}
      >
        {actionLabel}
      </button>
    </div>
  );
}

interface MatrixRowProps {
  label: string;
  hint?: string;
  children: React.ReactNode;
}

function MatrixRow({ label, hint, children }: MatrixRowProps) {
  return (
    <div className="home-bindings-row">
      <span className="home-bindings-row-label" title={hint}>{label}</span>
      <div className="home-bindings-row-slots">{children}</div>
    </div>
  );
}

function setGlobalSetting<K extends 'dragToZoom' | 'twoFingerPan'>(key: K, next: boolean) {
  const snap = renderSettingsStore.globalSnapshot();
  if (snap[key] === next) return;
  snap[key] = next;
  renderSettingsStore.applyGlobal(snap);
}

const DRAG_SLOT_LABELS: Record<'bare' | 'shift', string> = {
  bare: 'Left-drag',
  shift: 'Shift + Left-drag',
};

const SCROLL_HINT = 'Click an action to change it. Pinch and Ctrl+Scroll always zoom, dragging always pans.';
const DRAG_HINT = 'Click to swap left-drag and Shift+left-drag actions.';

/** Board drag: still a two-way swap (`dragToZoom`), so a click on either
 *  cell flips both. */
function DragBindings() {
  const dragToZoom = useDragToZoom();
  const bindings: Record<'bare' | 'shift', PzAction> = {
    bare: dragToZoom ? 'zoom' : 'pan',
    shift: dragToZoom ? 'pan' : 'zoom',
  };
  return (
    <MatrixRow label="Board: Drag" hint={DRAG_HINT}>
      {(['bare', 'shift'] as const).map((key) => {
        const action = bindings[key];
        return (
          <MatrixSlot
            key={key}
            modifier={DRAG_SLOT_LABELS[key]}
            actionLabel={ACTION_LABEL[action]}
            color={ACTION_COLOR[action]}
            action={action}
            testId={`home-drag-${key}`}
            onClick={() => setGlobalSetting('dragToZoom', !dragToZoom)}
          />
        );
      })}
    </MatrixRow>
  );
}

const BOARD_SLOTS: readonly ScrollSlot[] = isMacPlatform ? ['bare', 'shift', 'meta'] : ['bare', 'shift'];

function ScrollBindings() {
  const settings = useBoardScrollSettings();
  const bindings = boardScrollBindings(settings);
  const setSlot = (slot: ScrollSlot, action: PzAction) => {
    const snap = renderSettingsStore.globalSnapshot();
    renderSettingsStore.applyGlobal({ ...snap, ...boardScrollSettings({ ...bindings, [slot]: action }) });
  };
  return (
    <MatrixRow label="Board: Scroll" hint={bindings.shift === 'pan' ? SCROLL_HINT : SHIFT_SCROLL_NOTE}>
      {BOARD_SLOTS.map((slot) => {
        const action = bindings[slot];
        return (
          <MatrixSlot
            key={slot}
            modifier={SLOT_LABEL[slot]}
            actionLabel={ACTION_LABEL[action]}
            color={ACTION_COLOR[action]}
            action={action}
            testId={`home-scroll-board-${slot}`}
            onClick={() => setSlot(slot, nextAction(BOARD_SCROLL_ACTIONS, action))}
          />
        );
      })}
    </MatrixRow>
  );
}

// ─────────────────────────────────────────────────────────────
// PDF scroll bindings — three independent slots (zoom / pan / page)
// ─────────────────────────────────────────────────────────────

function PdfScrollBindings() {
  const [bindings, setBindings] = useState<ScrollBindings>(loadScrollBindings);

  // Stay in sync with the Settings panel — both listen on this event.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<ScrollBindings>).detail;
      if (detail) setBindings(detail);
    };
    window.addEventListener(SCROLL_BINDINGS_EVENT, handler);
    return () => window.removeEventListener(SCROLL_BINDINGS_EVENT, handler);
  }, []);

  const save = useCallback((next: ScrollBindings) => {
    setBindings(next);
    saveScrollBindings(next);
  }, []);

  const isDefault = sameScrollBindings(bindings, DEFAULT_SCROLL_BINDINGS);

  return (
    <MatrixRow label="PDF: Scroll" hint={bindings.shift === 'pan' ? SCROLL_HINT : SHIFT_SCROLL_NOTE}>
      {SCROLL_SLOTS.map((slot) => {
        const action = bindings[slot];
        return (
          <MatrixSlot
            key={slot}
            modifier={SLOT_LABEL[slot]}
            actionLabel={ACTION_LABEL[action]}
            color={ACTION_COLOR[action]}
            action={action}
            testId={`home-scroll-pdf-${slot}`}
            onClick={() => save({ ...bindings, [slot]: nextAction(SCROLL_ACTIONS, action) })}
          />
        );
      })}
      {!isDefault && (
        <button type="button" className="home-bindings-reset" onClick={() => save(DEFAULT_SCROLL_BINDINGS)} title="Reset PDF bindings to default">
          ↺
        </button>
      )}
    </MatrixRow>
  );
}

/**
 * Shown while either surface has Shift + Scroll bound to something other
 * than Pan (issue #40): the browser turns Shift+wheel into its horizontal
 * scroll, and an existing install keeps the old Shift = Zoom layout after
 * the update. One click puts both surfaces on Pan; nothing else moves.
 */
function ShiftScrollNote() {
  const board = boardScrollBindings(useBoardScrollSettings());
  const [pdf, setPdf] = useState<ScrollBindings>(loadScrollBindings);
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<ScrollBindings>).detail;
      if (detail) setPdf(detail);
    };
    window.addEventListener(SCROLL_BINDINGS_EVENT, handler);
    return () => window.removeEventListener(SCROLL_BINDINGS_EVENT, handler);
  }, []);

  if (board.shift === 'pan' && pdf.shift === 'pan') return null;

  const fix = () => {
    if (board.shift !== 'pan') {
      const snap = renderSettingsStore.globalSnapshot();
      renderSettingsStore.applyGlobal({ ...snap, ...boardScrollSettings({ ...board, shift: 'pan' }) });
    }
    if (pdf.shift !== 'pan') {
      const next = { ...pdf, shift: 'pan' as const };
      setPdf(next);
      saveScrollBindings(next);
    }
  };
  return (
    <div className="home-bindings-note" data-testid="home-shift-scroll-note">
      <span>{SHIFT_SCROLL_NOTE}</span>
      <button type="button" className="home-bindings-note-btn" onClick={fix} data-testid="home-shift-scroll-fix">
        Set Shift + Scroll to Pan
      </button>
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

function AutoOpenPdfToggle() {
  const { autoPdf } = useDatabank();
  return (
    <label
      className="home-toggle-row"
      title="Open any PDF schematic that's been bound to a board automatically when the board opens."
    >
      <span>Auto-open bound PDFs with their boards</span>
      <input
        type="checkbox"
        checked={autoPdf}
        onChange={(e) => databankStore.setAutoPdf(e.target.checked)}
      />
    </label>
  );
}

function useHdrGlow(): boolean {
  return useSyncExternalStore(
    (cb) => renderSettingsStore.subscribe(cb),
    () => renderSettingsStore.globalSettings.hdrFocusGlow,
  );
}

function useHdrIntensity(): number {
  return useSyncExternalStore(
    (cb) => renderSettingsStore.subscribe(cb),
    () => renderSettingsStore.globalSettings.hdrGlowIntensity,
  );
}

function setGlobal<K extends 'hdrFocusGlow' | 'hdrGlowIntensity'>(
  key: K, value: RenderSettings[K],
): void {
  const snap = renderSettingsStore.globalSnapshot();
  snap[key] = value;
  renderSettingsStore.applyGlobal(snap);
}

/** Start-page card for the HDR selection outline. Sits directly under the
 *  Interface scale card and shares its shell, so the two read as one pair of
 *  display settings.
 *
 *  Always rendered: the readout on the right is the detection result, and a
 *  user on an SDR screen should see "not detected" rather than nothing. The
 *  mockup shows what the setting changes — the same miniature board twice, the
 *  selected part outlined the normal way on the left and with the HDR tiles on
 *  the right. On an HDR display the right outline is visibly brighter than
 *  white; on an SDR display both look the same, which is also the honest
 *  answer to "does this do anything here". `(dynamic-range: high)` is a
 *  boolean and cannot tell a marginal HDR panel from an XDR one, so the mockup
 *  is the real test, not the readout.
 *
 *  The HDR outline can only be tiles, never live text or a shader — the
 *  renderer works the same way (see hdr-selection-outline.ts). */
function HdrGlowCard() {
  const enabled = useHdrGlow();
  const intensity = useHdrIntensity();
  const [capable, setCapable] = useState(isHdrCapable);
  useEffect(() => onHdrCapabilityChange(setCapable), []);
  const rung = rungForIntensity(intensity);

  return (
    <div className="ui-scale-full home-hdr-card" data-testid="home-hdr-card">
      <div className="ui-scale-full-label">
        <span>HDR selection outline</span>
        <span className={`ui-scale-full-readout${capable ? '' : ' home-hdr-readout-off'}`}>
          {capable ? 'HDR detected' : 'no HDR detected'}
        </span>
      </div>
      <div className="home-hdr-row">
        <div className="home-hdr-mockups" aria-hidden="true">
          <HdrMockBoard label="now" hdr={false} rung={rung} />
          <HdrMockBoard label="HDR" hdr={true} rung={rung} />
        </div>
        <div className="home-hdr-controls">
          <label className="home-hdr-toggle">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setGlobal('hdrFocusGlow', e.target.checked)}
            />
            <span>Turn on</span>
          </label>
          <label className="home-hdr-slider">
            <input
              type="range" min={1} max={10} step={1} value={intensity}
              disabled={!enabled}
              onChange={(e) => setGlobal('hdrGlowIntensity', Number(e.target.value))}
              aria-label="HDR outline intensity"
            />
            <span className="home-hdr-value">{intensity}</span>
          </label>
        </div>
      </div>
      <div className="ui-scale-full-hint">
        The selected part's outline is drawn brighter than white. If both boards look the
        same, this screen has no HDR and the setting does nothing.
      </div>
    </div>
  );
}

/** A miniature board with one selected part. The HDR variant outlines it the
 *  way the renderer does: one stretched PQ tile per edge, at the rung the
 *  intensity slider selects, so the slider previews live. The SDR variant is a
 *  plain border in the theme's selection yellow. */
function HdrMockBoard({ label, hdr, rung }: { label: string; hdr: boolean; rung: number }) {
  const tile = { backgroundImage: `url(${hdrTileUrl(rung)})` };
  const parts: Array<[number, number, number, number]> = [
    [6, 6, 20, 9], [6, 19, 20, 9], [30, 6, 9, 22], [80, 6, 16, 8], [80, 18, 16, 8], [6, 32, 33, 8], [80, 30, 16, 12],
  ];
  return (
    <div className="home-hdr-mock">
      <span className="home-hdr-mock-label">{label}</span>
      {parts.map(([l, t, w, h], i) => (
        <div key={i} className="home-hdr-mock-part" style={{ left: l, top: t, width: w, height: h }} />
      ))}
      <div className="home-hdr-mock-part home-hdr-mock-bga" style={{ left: 46, top: 10, width: 28, height: 28 }} />
      <div className={`home-hdr-mock-sel${hdr ? ' is-hdr' : ''}`} style={{ left: 46, top: 10, width: 28, height: 28 }}>
        {hdr && (
          <>
            <div className="home-hdr-mock-edge home-hdr-mock-edge-h" style={{ ...tile, top: -1.5 }} />
            <div className="home-hdr-mock-edge home-hdr-mock-edge-h" style={{ ...tile, bottom: -1.5 }} />
            <div className="home-hdr-mock-edge home-hdr-mock-edge-v" style={{ ...tile, left: -1.5 }} />
            <div className="home-hdr-mock-edge home-hdr-mock-edge-v" style={{ ...tile, right: -1.5 }} />
          </>
        )}
      </div>
    </div>
  );
}

function useThemeId(): string {
  return useSyncExternalStore(
    (cb) => themeStore.subscribe(cb),
    () => themeStore.activeId,
  );
}

/**
 * Theme switcher. Reads the canonical theme registry from store/themes.ts
 * (THEMES + themeStore.list()). Adding a theme there — UI, board canvas,
 * and any boardOverrides — makes it appear here automatically; this file
 * needs no edits.
 */
function ThemeSelect() {
  const activeId = useThemeId();
  const list = themeStore.list();
  return (
    <label
      className="home-toggle-row"
      title="Board-side colour set: canvas background, board fill, outline / selection accent, plus any per-theme settings overrides. Interface chrome lives in the Accent / Background / Chrome pickers below."
    >
      <span>Board theme</span>
      <select
        className="home-theme-select"
        value={activeId}
        onChange={(e) => themeStore.setTheme(e.target.value)}
      >
        {list.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Compact UI-token picker. Used three times in the Behaviour stack:
 * accent, background (canvas tier), chrome (strips/border tier). Each
 * cascades into its sibling token via the themeStore (see themes.ts).
 */
interface UiPickerProps {
  label: string;
  effective: string;
  override: string | null;
  onChange: (hex: string) => void;
  onReset: () => void;
  presets?: ReadonlyArray<{ hex: string; label: string }>;
  resetTooltip: string;
  rowTooltip: string;
}

function UiPickerRow({
  label,
  effective,
  override,
  onChange,
  onReset,
  presets,
  resetTooltip,
  rowTooltip,
}: UiPickerProps) {
  const eff = effective.toLowerCase();
  return (
    <div className="home-accent-row" title={rowTooltip}>
      <span className="home-accent-label">{label}</span>
      <input
        type="color"
        className="home-accent-input"
        value={eff}
        onChange={(e) => onChange(e.target.value.toLowerCase())}
        aria-label={`${label} colour`}
      />
      {presets && (
        <div className="home-accent-swatches" role="listbox" aria-label={`${label} presets`}>
          {presets.map((p) => {
            const active = p.hex.toLowerCase() === eff;
            return (
              <button
                key={p.hex}
                type="button"
                className={`home-accent-swatch${active ? ' active' : ''}`}
                style={{ background: p.hex }}
                onClick={() => onChange(p.hex)}
                title={`${p.label} · ${p.hex.toUpperCase()}`}
                aria-label={p.label}
                aria-pressed={active}
              />
            );
          })}
        </div>
      )}
      {override && (
        <button
          type="button"
          className="home-accent-reset"
          onClick={onReset}
          title={resetTooltip}
        >
          ↺
        </button>
      )}
    </div>
  );
}

// Module-level cache so the snapshot reference is stable across calls within
// the same render pass (useSyncExternalStore requires this).
let _themeOverridesCache: { accent: string | null; background: string | null; chrome: string | null } | null = null;
themeStore.subscribe(() => { _themeOverridesCache = null; });
function _getThemeOverridesSnapshot() {
  if (!_themeOverridesCache) {
    _themeOverridesCache = {
      accent: themeStore.accentOverride,
      background: themeStore.backgroundOverride,
      chrome: themeStore.chromeOverride,
    };
  }
  return _themeOverridesCache;
}

function useThemeOverrides() {
  return useSyncExternalStore(
    (cb) => themeStore.subscribe(cb),
    _getThemeOverridesSnapshot,
  );
}

function InterfaceColorPickers() {
  const activeId = useThemeId();
  const overrides = useThemeOverrides();
  const theme = themeStore.list().find((t) => t.id === activeId);
  const themeAccent = theme?.ui.accent ?? '#4a9eff';
  const themeBg = theme?.ui.bgPrimary ?? '#08080c';
  const themeChrome = theme?.ui.bgTertiary ?? '#0c1424';

  return (
    <>
      <UiPickerRow
        label="Accent"
        effective={overrides.accent ?? themeAccent}
        override={overrides.accent}
        onChange={(h) => themeStore.setAccent(h)}
        onReset={() => themeStore.setAccent(null)}
        presets={ACCENT_PRESETS}
        resetTooltip="Revert accent to the active board theme's default"
        rowTooltip="Signal indicators: focus, active states, links. Pill colours and selection (yellow) are independent."
      />
      <UiPickerRow
        label="Background"
        effective={overrides.background ?? themeBg}
        override={overrides.background}
        onChange={(h) => themeStore.setBackground(h)}
        onReset={() => themeStore.setBackground(null)}
        resetTooltip="Revert background to the active board theme's default"
        rowTooltip="Canvas + interactive surface tier. Drives --bg-primary; --bg-secondary cascades 6% lighter."
      />
      <UiPickerRow
        label="Chrome"
        effective={overrides.chrome ?? themeChrome}
        override={overrides.chrome}
        onChange={(h) => themeStore.setChrome(h)}
        onReset={() => themeStore.setChrome(null)}
        resetTooltip="Revert chrome to the active board theme's default"
        rowTooltip="Toolbar / status / tab strips. Drives --bg-tertiary; --border cascades 12% lighter."
      />
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// Library stats — read from databankStore.stats (populated by /api/databank/stats)
// ─────────────────────────────────────────────────────────────

function compactNumber(n: number): string {
  return n.toLocaleString();
}

function LibraryStats() {
  const { stats, scanStatus, libraryPath, backendAvailable, pdfIndexStats, folderState } = useDatabank();

  // Backend-free builds: the library is a folder this browser was pointed at.
  if (databankStore.folderLibrarySupported || folderState.kind !== 'none') {
    if (folderState.kind === 'none') {
      return (
        <p className="home-card-empty">
          No library folder yet.{' '}
          <FolderLibraryOpenButton className="home-settings-link">
            Choose a folder →
          </FolderLibraryOpenButton>
        </p>
      );
    }
    return (
      <div className="home-stats">
        <div className="home-stats-row">
          <span><strong>{compactNumber(stats?.boards ?? 0)}</strong> boards</span>
          <span><strong>{compactNumber(stats?.pdfs ?? 0)}</strong> PDFs</span>
        </div>
        <div className="home-stats-path" title={folderState.rootName}>
          folder <code>{folderState.rootName}</code>
          {folderState.kind === 'detached' && (
            folderState.reason === 'permission'
              ? ' — needs permission again'
              : ' — index only until the folder is picked again'
          )}
        </div>
        {scanStatus?.running && <div className="home-stats-scanning">Reading folder…</div>}
      </div>
    );
  }

  if (!backendAvailable) {
    return (
      <p className="home-card-empty">
        Backend unreachable — library stats will appear once the BoardRipper server is back.
      </p>
    );
  }
  const scanning = scanStatus?.running;
  // `stats` is non-null on a fresh install (the endpoint returns zeros), so
  // the empty case has to be recognised by its counts, not by a null.
  if (!stats || (stats.boards + stats.pdfs === 0 && !scanning)) {
    return (
      <p className="home-card-empty">
        Library not indexed yet. Mount your boards under <code>/library</code>, then{' '}
        <button type="button" className="home-settings-link" onClick={() => firstRunStore.show()}>
          run the library setup →
        </button>
      </p>
    );
  }
  return (
    <div className="home-stats">
      <div className="home-stats-row">
        <span><strong>{compactNumber(stats.boards)}</strong> boards</span>
        <span><strong>{compactNumber(stats.pdfs)}</strong> PDFs</span>
        <span><strong>{compactNumber(stats.bindings)}</strong> bindings</span>
        <span><strong>{compactNumber(pdfIndexStats?.pages ?? 0)}</strong> PDF pages indexed</span>
      </div>
      {libraryPath && (
        <div className="home-stats-path" title={libraryPath}>
          mounted at <code>{libraryPath}</code>
        </div>
      )}
      {scanning && <div className="home-stats-scanning">Scan in progress…</div>}
    </div>
  );
}

function QuickSettings() {
  const openSettings = useCallback(() => showSidebarTab('settings'), []);
  return (
    <CollapsibleCard id="quick-settings" title="Quick settings">
      <div className="home-quick-section">
        <h3 className="home-quick-section-title">
          Pan / zoom bindings
          <span className="home-quick-section-hint">click a pill to change what it does</span>
        </h3>
        <div className="home-bindings-matrix" role="group" aria-label="Pan and zoom bindings">
          <DragBindings />
          <ScrollBindings />
          <PdfScrollBindings />
          <ShiftScrollNote />
          <div className="home-bindings-foot">
            <span className="home-bindings-foot-glyph" aria-hidden="true">↳</span>
            Trackpad: two-finger scroll = mouse wheel · <strong>pinch always zooms</strong>
          </div>
        </div>
        <button
          type="button"
          className="home-settings-link"
          onClick={() => welcomeStore.show()}
          title="Open the interactive setup — demonstrate the gesture you want for each action and it sets the binding."
        >
          Set up by gesture (interactive) →
        </button>
      </div>

      <div className="home-quick-section">
        <h3 className="home-quick-section-title">Behaviour</h3>
        <div className="home-toggle-stack">
          <AutoSwitchToggle />
          {!isLiteBuild() && <AutoOpenPdfToggle />}
          <ThemeSelect />
          <InterfaceColorPickers />
        </div>
      </div>

      <div className="home-quick-section">
        <h3 className="home-quick-section-title">Library</h3>
        <LibraryStats />
      </div>

      <button type="button" className="home-settings-link" onClick={openSettings}>
        Open full Settings →
      </button>
    </CollapsibleCard>
  );
}

// ─────────────────────────────────────────────────────────────
// Keyboard shortcuts (display-only, grouped by category)
// ─────────────────────────────────────────────────────────────

function ShortcutList() {
  return (
    <CollapsibleCard id="shortcuts" title="Keyboard shortcuts">
      <p className="home-shortcut-hint">Press <kbd>?</kbd> anytime to bring this list up over your work.</p>
      <div className="home-shortcut-grid">
        {CATEGORY_ORDER.map((cat) => {
          const items = shortcuts.filter((s) => s.category === cat && !s.hideInList);
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
        href="https://github.com/alexeyinwerp/boardripper"
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
          <div className="home-ui-scale-row">
            <InterfaceScaleSlider />
            <HdrGlowCard />
          </div>
          {isLiteBuild() && <LiteOpenCard />}
          <Instructions />
          <QuickSettings />
          <LatestUpdate />
          <ShortcutList />
          <Footer />
        </div>
      </div>
    </div>
  );
}
