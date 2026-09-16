/**
 * Worklist panel — the list a repair actually runs on.
 *
 * The ROW is deliberately unchanged from the version this replaced: mark
 * cycle, condition flag (water on parts, surge on nets), reference designator,
 * note with its peek, remove — every control kept, in that order, in the same
 * colours. What changed is everything around it, which had drifted from the
 * rest of the app:
 *
 *   - real stylesheet classes (`.wl-*` in index.css) instead of 73 inline
 *     style objects written against variable names that do not exist, so the
 *     panel follows the theme like every other panel;
 *   - one row component instead of two near-identical ones;
 *   - the wrapping row of worklist pills becomes a single line that opens a
 *     SEARCH: recents first, filter as you type, across boards;
 *   - no browser dialogs — naming happens in the panel, and wipe/delete ask
 *     in a strip where the thing being destroyed is;
 *   - readings appear only where there are readings. A net shows the values it
 *     holds; the three empty slots belong to the SELECTED row, which is where
 *     you are about to measure something.
 *
 * Design: docs/specs/2026-09-09-worklist-tab-mockup.html
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ComponentType } from 'react';
import {
  IconReplace, IconSparkles, IconDroplet, IconBolt, IconAlertTriangle, IconCheck,
  IconUnlink, IconCircuitDiode, IconSearch, IconChevronRight, IconChevronDown,
  IconX, IconPlus, IconClipboardText, IconList, IconDots,
} from '@tabler/icons-react';
import { IconSolderingIron } from '../icons/IconSolderingIron';
import { worklistStore, MARK_COLOR_CSS, NET_MARK_COLOR_CSS, MEAS_KINDS } from '../store/worklist-store';
import type {
  WorklistEntry, WorklistMark, NetWorklistEntry, NetWorklistMark, Worklist,
  NetMeasurement, BoardWorklistes,
} from '../store/worklist-store';
import { NoteBody } from '../components/DiagnosisNotes';
import { QuickMenu } from '../components/QuickMenu';
import { selectionSetStore } from '../store/selection-set-store';
import { boardStore } from '../store/board-store';
import { isLiteBuild } from '../store/build-mode';
import { showSidebarTab } from '../components/Sidebar.utils';
import { setActiveTool } from './tools/tools-nav';
import { useWorklist } from '../hooks/useWorklist';
import { useSelectionSet } from '../hooks/useSelectionSet';
import { useBoardStore } from '../hooks/useBoardStore';
import { copyText } from '../clipboard';

// ── Mark tables. Cycling order: none → replaced → reworked → cleaned → none.
//    The same colours the canvas highlight uses (MARK_COLOR_HEX in the store).
const MARK_ICON: Record<WorklistMark, ComponentType<{ size?: number; stroke?: number }> | null> = {
  none: null,
  replaced: IconReplace,
  reworked: IconSolderingIron as typeof IconReplace, // hand-composed (MDI + game-icons), fill-based
  cleaned: IconSparkles,
};
const MARK_SHORT_LABEL: Record<WorklistMark, string> = {
  none: 'No mark', replaced: 'Replaced', reworked: 'Reworked', cleaned: 'Cleaned',
};
const MARK_TITLE: Record<WorklistMark, string> = {
  none: 'No mark. Click to set Replaced. Cycle: Replaced → Reworked → Cleaned → no mark. Shift-click cycles backwards.',
  replaced: 'Replaced. Click to advance to Reworked. Shift-click to clear.',
  reworked: 'Reworked. Click to advance to Cleaned. Shift-click to go back to Replaced.',
  cleaned: 'Cleaned. Click to clear. Shift-click to go back to Reworked.',
};
// 'none' stays muted so an unmarked row reads as "not yet touched" instead of
// glowing in the canvas-side amber.
const MARK_BTN_COLOR: Record<WorklistMark, string> = {
  none: 'var(--text-secondary)',
  replaced: MARK_COLOR_CSS.replaced,
  reworked: MARK_COLOR_CSS.reworked,
  cleaned: MARK_COLOR_CSS.cleaned,
};

const NET_MARK_ICON: Record<NetWorklistMark, ComponentType<{ size?: number; stroke?: number }> | null> = {
  none: null, short: IconAlertTriangle, solved: IconCheck, absent: IconUnlink,
};
const NET_MARK_SHORT_LABEL: Record<NetWorklistMark, string> = {
  none: 'No mark', short: 'Short', solved: 'Solved', absent: 'Absent',
};
const NET_MARK_TITLE: Record<NetWorklistMark, string> = {
  none: 'No mark. Click to set Short. Cycle: Short → Solved → Absent → no mark. Shift-click cycles backwards.',
  short: 'Short. Click to advance to Solved. Shift-click to clear.',
  solved: 'Solved. Click to advance to Absent. Shift-click to go back to Short.',
  absent: 'Absent (net not present / not reaching). Click to clear. Shift-click to go back to Solved.',
};
const NET_MARK_BTN_COLOR: Record<NetWorklistMark, string> = {
  none: 'var(--text-secondary)',
  short: NET_MARK_COLOR_CSS.short,
  solved: NET_MARK_COLOR_CSS.solved,
  absent: NET_MARK_COLOR_CSS.absent,
};

async function copyToClipboard(text: string, summary: string): Promise<void> {
  try {
    await copyText(text);
    boardStore.addToast(summary, 'info');
  } catch (e) {
    boardStore.addToast(`Copy failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
  }
}

/** Read the clipboard, validate the `-[name]-` header, import as a new active
 *  worklist. Entries whose refdes is not on this board are still imported but
 *  flagged unresolved — useful when the sender's board version is slightly off
 *  but you want their notes. */
async function importFromClipboard(): Promise<void> {
  let text = '';
  try {
    text = await navigator.clipboard.readText();
  } catch (e) {
    boardStore.addToast(`Clipboard read failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
    return;
  }
  if (!text.trim()) { boardStore.addToast('Clipboard is empty.', 'error'); return; }
  const r = worklistStore.importFromText(text);
  if (!r) {
    boardStore.addToast('Clipboard does not look like a worklist. First line must be -[name]-.', 'error');
    return;
  }
  const missing = r.parts - r.resolved;
  const netSuffix = r.nets > 0 ? `, ${r.nets} net${r.nets === 1 ? '' : 's'}` : '';
  boardStore.addToast(
    missing > 0
      ? `Imported "${r.created}": ${r.resolved}/${r.parts} parts found on this board (${missing} missing)${netSuffix}.`
      : `Imported "${r.created}" (${r.parts} part${r.parts === 1 ? '' : 's'}${netSuffix}).`,
    'info',
  );
}

export function WorklistPanel() {
  const { current, activeWorklist, hasBoard } = useWorklist();
  const sel = useSelectionSet();
  const { activeTabId } = useBoardStore();
  // Set when a worklist is created without a name, so the header opens in edit
  // instead of asking through a browser prompt.
  const [renameOnMount, setRenameOnMount] = useState<string | null>(null);

  useEffect(() => { void worklistStore.syncToActiveTab(); }, [activeTabId]);

  if (!hasBoard) {
    return <div className="wl-empty">Open a board to begin worklisting.</div>;
  }

  return (
    <div className="wl-root" data-testid="worklist-panel">
      {/* Cyan selection band. Reports a canvas state that has nothing to do
          with the worklist's contents; left exactly as it was pending its own
          review. */}
      {sel.count > 0 && (
        <section className="wl-band">
          <div className="wl-band-head">
            <span style={{ fontWeight: 600 }}>Cyan selection</span>
            <span className="wl-pill">{sel.count}</span>
            <button
              className="wl-hl"
              style={{ marginLeft: 'auto' }}
              onClick={() => { if (activeTabId != null) selectionSetStore.clear(activeTabId); }}
              title="Clear the cyan canvas highlight + connection glow (parts stay on the board, worklist untouched)"
            >Clear</button>
          </div>
          <div className="wl-band-sub">
            Loaded by multi-select on the canvas. Visual only — has no effect on the worklist contents.
          </div>
        </section>
      )}

      <WorklistFinder
        current={current}
        onCreated={id => setRenameOnMount(id)}
      />

      {!activeWorklist
        ? <div className="wl-empty">No worklist yet. Use the line above to make one.</div>
        : (
          <ActiveWorklistView
            key={activeWorklist.id}
            renameOnMount={renameOnMount === activeWorklist.id}
            onRenameHandled={() => setRenameOnMount(null)}
          />
        )}
    </div>
  );
}

// ── The finder: one line that becomes a search ────────────────────────────

interface Hit { id: string; name: string; count: number; board?: string; current: boolean }

function WorklistFinder({ current, onCreated }: {
  current: BoardWorklistes | null;
  onCreated: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [others, setOthers] = useState<BoardWorklistes[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const mine = useMemo(() => current?.worklistes ?? [], [current?.worklistes]);
  const active = mine.find(w => w.id === current?.activeWorklistId) ?? null;

  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  // Other boards' worklists are only needed once the finder is open, and only
  // to search across them — load them then, not on every panel mount.
  useEffect(() => {
    if (!open) return;
    let live = true;
    void worklistStore.listAllStored().then(all => {
      if (live) setOthers(all.filter(b => b.key !== current?.key));
    });
    return () => { live = false; };
  }, [open, current?.key]);

  // Dismiss on an outside pointer press, like the other popovers in the app.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) { setOpen(false); setQ(''); }
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  const hits: Hit[] = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const size = (w: Worklist) => w.entries.length + (w.netEntries?.length ?? 0);
    const own: Hit[] = [...mine]
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .filter(w => !needle || w.name.toLowerCase().includes(needle))
      .map(w => ({ id: w.id, name: w.name, count: size(w), current: w.id === current?.activeWorklistId }));
    if (!needle) return own;
    // Typing searches every board; a hit elsewhere says which board it is on.
    const far: Hit[] = others.flatMap(b =>
      (b.worklistes ?? [])
        .filter(w => w.name.toLowerCase().includes(needle))
        .map(w => ({ id: `${b.key}::${w.id}`, name: w.name, count: size(w), board: b.fileName, current: false })),
    );
    return [...own, ...far];
  }, [q, mine, others, current?.activeWorklistId]);

  const close = useCallback(() => { setOpen(false); setQ(''); }, []);

  const pick = (hit: Hit) => {
    if (hit.board) {
      // Another board's worklist: that board has to be open first. Send the
      // user to the catalog, which knows how to say so.
      showSidebarTab('tools');
      setActiveTool('worklists');
      close();
      return;
    }
    worklistStore.setActiveWorklist(hit.id);
    close();
  };

  const create = () => {
    const name = q.trim();
    const made = worklistStore.createWorklist(name || undefined);
    if (!made) { boardStore.addToast('Could not create worklist — open a board first.', 'error'); return; }
    if (!name) onCreated(made.id);   // no name typed → open the header in edit
    close();
  };

  if (!open) {
    return (
      <button
        type="button"
        className="wl-find"
        data-testid="worklist-find"
        onClick={() => setOpen(true)}
        title="Find or switch worklist"
      >
        <IconSearch size={13} stroke={1.9} />
        <span className="cur">{active ? active.name : 'No worklist'}</span>
        {active && <span className="n">{active.entries.length + (active.netEntries?.length ?? 0)}</span>}
        {mine.length > 1 && <span className="more">{mine.length - 1} more</span>}
      </button>
    );
  }

  return (
    <div ref={wrapRef} style={{ flex: 'none' }}>
      <div className="wl-find-open">
        <IconSearch size={13} stroke={1.9} />
        <input
          ref={inputRef}
          className="wl-find-input"
          data-testid="worklist-find-input"
          placeholder="Search worklists"
          value={q}
          onChange={e => setQ(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Escape') { e.preventDefault(); close(); }
            if (e.key === 'Enter') { e.preventDefault(); if (hits[0]) pick(hits[0]); else create(); }
          }}
        />
      </div>
      <div className="wl-results" data-testid="worklist-results">
        {hits.length === 0 && <div className="wl-nohit">No worklist matches “{q.trim()}”.</div>}
        {hits.map(h => (
          <button
            key={h.id}
            type="button"
            className={`wl-hit${h.current ? ' cur' : ''}`}
            data-testid="worklist-hit"
            onClick={() => pick(h)}
          >
            <span className="nm">{highlight(h.name, q.trim())}</span>
            {h.board && <span className="bd">{h.board}</span>}
            <span className="n">{h.count}</span>
          </button>
        ))}
      </div>
      <div className="wl-acts">
        <button type="button" className="wl-act" data-testid="worklist-new" onClick={create}>
          <IconPlus size={13} stroke={1.9} />
          {q.trim() ? <>New worklist “{q.trim()}”</> : 'New worklist'}
        </button>
        <button type="button" className="wl-act" data-testid="worklist-paste"
          onClick={() => { void importFromClipboard(); close(); }}>
          <IconClipboardText size={13} stroke={1.9} />Paste a worklist
        </button>
        <button type="button" className="wl-act link" data-testid="worklist-all"
          onClick={() => { showSidebarTab('tools'); setActiveTool('worklists'); close(); }}>
          <IconList size={13} stroke={1.9} />All worklists…
        </button>
      </div>
    </div>
  );
}

/** Mark the matched run inside a name, so a hit shows why it matched. */
function highlight(name: string, needle: string): React.ReactNode {
  if (!needle) return name;
  const i = name.toLowerCase().indexOf(needle.toLowerCase());
  if (i < 0) return name;
  return (<>{name.slice(0, i)}<mark>{name.slice(i, i + needle.length)}</mark>{name.slice(i + needle.length)}</>);
}

// Remembered scroll offset per worklist. Module scope so it survives a full
// remount of the view (issue #22: selecting a component on the board must not
// snap a long worklist back to the top).
const worklistScrollTop = new Map<string, number>();

function ActiveWorklistView({ renameOnMount, onRenameHandled }: {
  renameOnMount: boolean; onRenameHandled: () => void;
}) {
  const { activeWorklist } = useWorklist();
  const { connectionHighlight } = useBoardStore();
  const listRef = useRef<HTMLDivElement>(null);
  const [renaming, setRenaming] = useState(renameOnMount);
  const [renameDraft, setRenameDraft] = useState(activeWorklist?.name ?? '');
  const renameRef = useRef<HTMLInputElement>(null);
  const [ticketOpen, setTicketOpen] = useState(false);
  const [ticketDraft, setTicketDraft] = useState(activeWorklist?.note ?? '');
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [confirm, setConfirm] = useState<null | 'wipe' | 'delete'>(null);
  /** The row whose empty reading slots are open. One at a time: the slots are
   *  for the row you are working on. */
  const [selected, setSelected] = useState<string | null>(null);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el || !activeWorklist) return;
    const saved = worklistScrollTop.get(activeWorklist.id);
    if (saved != null && saved !== el.scrollTop) el.scrollTop = saved;
    // Keyed on the id, not the object: this must run on mount and on a switch,
    // not every time an edit replaces the worklist and would scroll you back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorklist?.id]);

  useEffect(() => { if (renaming) renameRef.current?.select(); }, [renaming]);
  useEffect(() => { if (renameOnMount) onRenameHandled(); }, [renameOnMount, onRenameHandled]);

  if (!activeWorklist) return null;
  const entryCount = activeWorklist.entries.length;
  const netCount = activeWorklist.netEntries?.length ?? 0;

  const startRename = () => { setRenameDraft(activeWorklist.name); setRenaming(true); };
  const commitRename = () => { worklistStore.renameWorklist(activeWorklist.id, renameDraft); setRenaming(false); };

  const onCopyAll = () => {
    const text = worklistStore.formatWorklistForClipboard(activeWorklist.id);
    if (!text) return;
    void copyToClipboard(text, `Copied ${entryCount} row${entryCount === 1 ? '' : 's'}`);
  };

  return (
    <>
      <header className="wl-head">
        {renaming ? (
          <input
            ref={renameRef}
            className="wl-rename"
            data-testid="worklist-rename"
            value={renameDraft}
            onChange={e => setRenameDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={e => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') setRenaming(false);
            }}
          />
        ) : (
          <button type="button" className="wl-name" onClick={startRename} title="Click to rename">
            {activeWorklist.name}
          </button>
        )}
        <button
          type="button"
          className={`wl-hl${connectionHighlight ? ' on' : ''}`}
          data-testid="worklist-highlight"
          onClick={() => boardStore.setConnectionHighlight(!boardStore.connectionHighlight)}
          disabled={entryCount === 0}
          aria-pressed={connectionHighlight}
          title={connectionHighlight
            ? 'Highlight ON — click to hide worklist outlines and shared-net glow'
            : 'Show this worklist on the board (mark colours) and glow the nets its parts share.'}
        >
          <IconSparkles size={13} stroke={1.9} />Highlight
        </button>
        <button
          type="button"
          className={`wl-icon-btn${menu ? ' on' : ''}`}
          data-testid="worklist-menu-btn"
          aria-haspopup="menu"
          aria-expanded={!!menu}
          title="More"
          onClick={e => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setMenu(menu ? null : { x: r.right - 176, y: r.bottom + 4 });
          }}
        >
          <IconDots size={15} stroke={1.9} />
        </button>
        {menu && (
          <QuickMenu
            x={menu.x}
            y={menu.y}
            onClose={() => setMenu(null)}
            ariaLabel="Worklist actions"
            testId="worklist-menu"
            items={[
              { label: 'Rename', testId: 'worklist-menu-rename', onSelect: startRename },
              { label: 'Copy to clipboard', testId: 'worklist-menu-copy', onSelect: onCopyAll },
              { label: ticketOpen ? 'Hide ticket note' : 'Ticket note…', onSelect: () => setTicketOpen(x => !x) },
              { kind: 'sep' },
              { label: 'Clear all entries', testId: 'worklist-menu-wipe', onSelect: () => setConfirm('wipe') },
              { label: 'Delete worklist', testId: 'worklist-menu-delete', onSelect: () => setConfirm('delete') },
            ]}
          />
        )}
      </header>

      {/* Asked here, not through a browser confirm, so the question sits with
          the thing it is about. */}
      {confirm && (
        <div className="wl-confirm" data-testid="worklist-confirm" role="alertdialog">
          <span className="q">
            {confirm === 'wipe'
              ? `Clear all ${entryCount + netCount} entries from “${activeWorklist.name}”?`
              : `Delete “${activeWorklist.name}”? This cannot be undone.`}
          </span>
          <button type="button" onClick={() => setConfirm(null)} data-testid="worklist-confirm-no">Cancel</button>
          <button
            type="button"
            className="go"
            data-testid="worklist-confirm-yes"
            onClick={() => {
              if (confirm === 'wipe') worklistStore.wipeWorklist(activeWorklist.id);
              else worklistStore.deleteWorklist(activeWorklist.id);
              setConfirm(null);
            }}
          >{confirm === 'wipe' ? 'Clear' : 'Delete'}</button>
        </div>
      )}

      <div className="wl-ticket">
        <button
          type="button"
          className="wl-ticket-toggle"
          data-testid="worklist-ticket-toggle"
          onClick={() => setTicketOpen(x => !x)}
          title={ticketOpen ? 'Collapse ticket note' : 'Expand ticket note'}
        >
          {ticketOpen ? <IconChevronDown size={12} stroke={2} /> : <IconChevronRight size={12} stroke={2} />}
          <b>Ticket note</b>
          {!ticketOpen && (ticketDraft.trim()
            ? <span className="wl-ticket-peek">{peek(ticketDraft.split('\n', 1)[0].trim(), 60)}</span>
            : <span className="wl-ticket-peek">(empty)</span>)}
        </button>
        {ticketOpen && (
          <textarea
            className="wl-ticket-area"
            data-testid="worklist-ticket-area"
            value={ticketDraft}
            placeholder="General note for this worklist / ticket. Saved when you click out."
            onChange={e => setTicketDraft(e.target.value)}
            onBlur={() => {
              if ((activeWorklist.note ?? '') !== ticketDraft) worklistStore.setWorklistNote(activeWorklist.id, ticketDraft);
            }}
          />
        )}
      </div>

      <div
        ref={listRef}
        className="wl-list"
        data-testid="worklist-scroll"
        onScroll={e => worklistScrollTop.set(activeWorklist.id, e.currentTarget.scrollTop)}
      >
        {entryCount === 0 && netCount === 0 && (
          <div className="wl-empty">Empty. Shift-click parts on the board, or hit the pin button in the Search tab.</div>
        )}
        {activeWorklist.entries.map(entry => (
          <WorklistRow
            key={entry.refdes}
            kind="part"
            worklistId={activeWorklist.id}
            partEntry={entry}
            selected={selected === 'p:' + entry.refdes}
            onSelect={() => setSelected('p:' + entry.refdes)}
          />
        ))}
        {netCount > 0 && entryCount > 0 && <div className="wl-sec">Nets</div>}
        {activeWorklist.netEntries?.map(entry => (
          <WorklistRow
            key={'net:' + entry.netName}
            kind="net"
            worklistId={activeWorklist.id}
            netEntry={entry}
            selected={selected === 'n:' + entry.netName}
            onSelect={() => setSelected('n:' + entry.netName)}
          />
        ))}
      </div>
      {!isLiteBuild() && <AiWorklistSection worklist={activeWorklist} />}
    </>
  );
}

function peek(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// ── One row for both kinds ────────────────────────────────────────────────
// Parts and nets differ by a flag icon, a colour table, which store call acts,
// and whether readings can hang underneath. That is arguments, not a second
// component.

interface RowProps {
  kind: 'part' | 'net';
  worklistId: string;
  partEntry?: WorklistEntry;
  netEntry?: NetWorklistEntry;
  selected: boolean;
  onSelect: () => void;
}

function WorklistRow({ kind, worklistId, partEntry, netEntry, selected, onSelect }: RowProps) {
  const isNet = kind === 'net';
  const name = isNet ? netEntry!.netName : partEntry!.refdes;
  const mark = isNet ? netEntry!.mark : partEntry!.mark;
  const note = (isNet ? netEntry!.note : partEntry!.note) ?? '';
  const unresolved = (isNet ? netEntry!.unresolved : partEntry!.unresolved) === true;
  const flagOn = (isNet ? netEntry!.surge : partEntry!.waterdamage) === true;

  const [expanded, setExpanded] = useState(false);
  // Keyed by name upstream, so a rename remounts and re-seeds the draft. We do
  // not sync later prop changes back: the in-progress edit wins, and blur
  // persists it.
  const [noteDraft, setNoteDraft] = useState(note);
  const [flash, setFlash] = useState<{ label: string; color: string; x: number; y: number } | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);

  const markColor = isNet ? NET_MARK_BTN_COLOR[mark as NetWorklistMark] : MARK_BTN_COLOR[mark as WorklistMark];
  const MarkIcon = isNet ? NET_MARK_ICON[mark as NetWorklistMark] : MARK_ICON[mark as WorklistMark];
  const markTitle = isNet ? NET_MARK_TITLE[mark as NetWorklistMark] : MARK_TITLE[mark as WorklistMark];

  const onFocus = () => {
    onSelect();
    if (unresolved) return;
    if (isNet) boardStore.focusNet(name); else boardStore.focusPart(name);
  };

  const onCycleMark = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isNet) worklistStore.cycleNetMark(worklistId, name, e.shiftKey);
    else worklistStore.cycleMark(worklistId, name, e.shiftKey);
    const updated = isNet
      ? worklistStore.activeWorklist?.netEntries?.find(x => x.netName === name)?.mark
      : worklistStore.activeWorklist?.entries.find(x => x.refdes === name)?.mark;
    if (updated === undefined) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const color = isNet ? NET_MARK_BTN_COLOR[updated as NetWorklistMark] : MARK_BTN_COLOR[updated as WorklistMark];
    setFlash({
      label: isNet ? NET_MARK_SHORT_LABEL[updated as NetWorklistMark] : MARK_SHORT_LABEL[updated as WorklistMark],
      color: updated === 'none' ? 'var(--bg-tertiary)' : color,
      x: r.left + r.width / 2,
      y: r.bottom + 4,
    });
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 1600);
  };

  const onToggleFlag = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isNet) worklistStore.toggleSurge(worklistId, name);
    else worklistStore.toggleWaterdamage(worklistId, name);
  };

  const onRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isNet) worklistStore.removeNetEntry(worklistId, name);
    else worklistStore.removeEntry(worklistId, name);
  };

  const onCommitNote = () => {
    if (noteDraft === note) return;
    if (isNet) worklistStore.setNetNote(worklistId, name, noteDraft);
    else worklistStore.setNote(worklistId, name, noteDraft);
  };

  const FlagIcon = isNet ? IconBolt : IconDroplet;
  const flagTitle = isNet
    ? (flagOn ? 'Surge / over-current flagged. Click to clear.' : 'Mark as surge / over-current.')
    : (flagOn ? 'Water damage flagged. Click to clear.' : 'Mark as water-damaged.');

  return (
    <div
      className={`wl-row${unresolved ? ' unresolved' : ''}${selected ? ' sel' : ''}`}
      {...(isNet ? { 'data-testid': 'worklist-net-row' } : { 'data-testid': 'worklist-part-row' })}
    >
      <div className="wl-row-main" onClick={onFocus}>
        <button
          type="button"
          className="wl-mark"
          style={{ color: markColor, borderColor: mark === 'none' ? 'var(--border)' : markColor }}
          onClick={onCycleMark}
          title={markTitle}
        >
          {MarkIcon ? <MarkIcon size={14} stroke={2} /> : <span className="none">·</span>}
        </button>
        {flash && createPortal(
          <div
            className="wl-flash"
            style={{ left: flash.x, top: flash.y, background: flash.color, color: flash.color.startsWith('var') ? 'var(--text-primary)' : '#0a0a0a' }}
            role="status"
          >{flash.label}</div>,
          document.body,
        )}
        <button
          type="button"
          className={`wl-flag${flagOn ? ' on' : ''}`}
          style={flagOn ? { color: isNet ? '#ffcf3a' : '#5fb6ff' } : undefined}
          onClick={onToggleFlag}
          aria-pressed={flagOn}
          title={flagTitle}
        >
          <FlagIcon size={14} stroke={2} />
        </button>
        <span className="wl-ref">
          {name}
          {unresolved && <span className="missing">(missing)</span>}
        </span>
        <button
          type="button"
          className="wl-note-btn"
          onClick={e => { e.stopPropagation(); setExpanded(x => !x); }}
          title={expanded ? 'Collapse note' : 'Expand note'}
        >
          {expanded ? <IconChevronDown size={12} stroke={2} /> : <IconChevronRight size={12} stroke={2} />}
          {note && !expanded && <span className="wl-note-peek">{peek(note, 14)}</span>}
        </button>
        <button type="button" className="wl-x" onClick={onRemove} title="Remove from worklist">
          <IconX size={13} stroke={2} />
        </button>
      </div>
      {expanded && (
        <textarea
          className="wl-note-area"
          value={noteDraft}
          placeholder="Note (saved when you click out)"
          onChange={e => setNoteDraft(e.target.value)}
          onBlur={onCommitNote}
        />
      )}
      {isNet && <NetReadings worklistId={worklistId} entry={netEntry!} open={selected} />}
    </div>
  );
}

// ── Readings ──────────────────────────────────────────────────────────────

/** Display label for a kind: V and Ω are their own unit symbols, diode mode
 *  gets the circuit-diode glyph. (The clipboard format still spells out
 *  "Diode" so copied text stays parser-readable.) */
function MeasLabel({ k }: { k: NetMeasurement['kind'] }) {
  if (k === 'diode') return <IconCircuitDiode size={13} stroke={2} />;
  return <>{k === 'voltage' ? 'V' : 'Ω'}</>;
}

/** Collapsed, a net shows only the readings it holds. Selected, it shows all
 *  three slots so a missing one can be filled in. Before, all three rendered
 *  on every net for ever, so ten nets were twenty lines of which ten were
 *  empty boxes. */
function NetReadings({ worklistId, entry, open }: {
  worklistId: string; entry: NetWorklistEntry; open: boolean;
}) {
  const held = MEAS_KINDS.filter(k => (entry.measurements?.[k]?.value ?? '') !== '');
  if (open) {
    return (
      <div className="wl-meas" data-testid="net-meas-strip">
        {MEAS_KINDS.map(k => (
          <NetMeasSlot key={k} worklistId={worklistId} netName={entry.netName} kind={k} m={entry.measurements?.[k]} />
        ))}
      </div>
    );
  }
  if (held.length === 0) return null;
  return (
    <div className="wl-vals" data-testid="net-meas-values">
      {held.map(k => {
        const m = entry.measurements?.[k];
        return (
          <span key={k} className={`wl-val${m?.status === 'requested' ? ' asked' : ''}`} data-testid={`net-meas-value-${k}`}>
            <span className="k"><MeasLabel k={k} /></span>{m?.value}
          </span>
        );
      })}
    </div>
  );
}

function NetMeasSlot({ worklistId, netName, kind, m }: {
  worklistId: string; netName: string; kind: NetMeasurement['kind']; m: NetMeasurement | undefined;
}) {
  const [val, setVal] = useState(m?.value ?? '');
  // Reflect external changes (agent records a value, another tab edits, clear).
  // Legitimate "subscribe to an external prop change" — the same case the
  // React Compiler rule over-flags elsewhere in this file's history.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setVal(m?.value ?? ''); }, [m?.value]);
  const requested = m?.status === 'requested';
  const commit = () => {
    const v = val.trim();
    if (v) {
      if (requested) worklistStore.recordNetMeasurement(netName, v, undefined, kind);
      else worklistStore.setNetMeasurement(worklistId, netName, kind, v);
    } else if (m) {
      worklistStore.clearNetMeasurement(worklistId, netName, kind);
    }
  };
  return (
    <span className="wl-slot" data-testid={`net-meas-slot-${kind}`}>
      <span
        className="wl-chip"
        data-testid={`net-meas-chip-${kind}`}
        title={requested ? `Agent requested ${kind}${m?.prompt ? `: ${m.prompt}` : ''}` : `Record ${kind}`}
      >
        <MeasLabel k={kind} />
      </span>
      <input
        className={`wl-in${requested ? ' req' : ''}`}
        data-testid={`net-meas-input-${kind}`}
        value={val}
        placeholder={requested && m?.expected ? `exp ${m.expected}` : '—'}
        onChange={e => setVal(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        onBlur={commit}
        onClick={e => e.stopPropagation()}
      />
    </span>
  );
}

// ── AI relay: transcript + prompt box for the agent feedback loop ──────────
// Shown when the MCP server is connected, or whenever the worklist already
// carries relay messages, so a transcript stays visible once started.
function AiWorklistSection({ worklist }: { worklist: Worklist }) {
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let live = true;
    const probe = () => fetch('/api/mcp/status')
      .then(r => r.ok ? r.json() : null)
      .then(s => { if (live) setConnected(!!s?.enabled); })
      .catch(() => { if (live) setConnected(false); });
    probe();
    const t = setInterval(probe, 5000);
    return () => { live = false; clearInterval(t); };
  }, []);

  const messages = worklist.messages ?? [];
  if (!connected && messages.length === 0) return null;

  return (
    <div className="wl-ai">
      <div className="wl-ai-head">
        <IconSparkles size={13} /> AI relay{connected ? '' : ' (MCP offline)'}
      </div>
      {messages.length > 0 && (
        <div className="wl-ai-log">
          {messages.map(msg => (
            <div key={msg.id} className="wl-ai-msg">
              <span className={`wl-ai-who ${msg.role === 'agent' ? 'agent' : 'user'}`}>
                {msg.role === 'agent' ? 'AI' : 'You'}:
              </span>{' '}
              <span style={{ fontSize: 11 }}><NoteBody body={msg.text} board={boardStore.board} /></span>
            </div>
          ))}
        </div>
      )}
      <AiPromptBox disabled={!connected} />
    </div>
  );
}

function AiPromptBox({ disabled }: { disabled: boolean }) {
  const [text, setText] = useState('');
  const send = () => {
    const t = text.trim();
    if (!t) return;
    worklistStore.addMessage('user', t);
    setText('');
  };
  return (
    <div className="wl-ai-row">
      <input
        className="wl-ai-in"
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && send()}
        placeholder={disabled ? 'Connect an MCP agent to chat…' : 'Message the agent (it reads this)…'}
      />
      <button className="wl-ai-send" onClick={send} disabled={!text.trim()}>Send</button>
    </div>
  );
}
