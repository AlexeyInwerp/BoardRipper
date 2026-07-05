import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ComponentType } from 'react';
import { IconReplace, IconSparkles, IconClipboardText, IconDroplet, IconBolt, IconAlertTriangle, IconCheck, IconUnlink, IconCircuitDiode } from '@tabler/icons-react';
import { IconSolderingIron } from '../icons/IconSolderingIron';
import { worklistStore, MARK_COLOR_CSS, NET_MARK_COLOR_CSS, MEAS_KINDS } from '../store/worklist-store';
import type { WorklistEntry, WorklistMark, NetWorklistEntry, NetWorklistMark, Worklist, NetMeasurement } from '../store/worklist-store';
import { NoteBody } from '../components/DiagnosisNotes';
import { selectionSetStore } from '../store/selection-set-store';
import { boardStore } from '../store/board-store';
import { useWorklist } from '../hooks/useWorklist';
import { useSelectionSet } from '../hooks/useSelectionSet';
import { useBoardStore } from '../hooks/useBoardStore';
import { copyText } from '../clipboard';

// Icon per mark + hover tooltip with full meaning. Cycling order:
// none → replaced → reworked → cleaned → none. The same colours are used
// on the canvas highlight (MARK_COLOR_HEX in worklist-store).
/** Icon per mark — null for `none` so the row renders a dim `·` instead.
 *  IconMinus read as "subtract", not "no mark yet". */
const MARK_ICON: Record<WorklistMark, ComponentType<{ size?: number; stroke?: number }> | null> = {
  none: null,
  replaced: IconReplace,
  reworked: IconSolderingIron as typeof IconReplace, // hand-composed (MDI + game-icons), fill-based
  cleaned: IconSparkles,
};
const MARK_SHORT_LABEL: Record<WorklistMark, string> = {
  none: 'No mark',
  replaced: 'Replaced',
  reworked: 'Reworked',
  cleaned: 'Cleaned',
};
const MARK_TITLE: Record<WorklistMark, string> = {
  none: 'No mark. Click to set Replaced. Cycle: Replaced → Reworked → Cleaned → no mark. Shift-click cycles backwards.',
  replaced: 'Replaced. Click to advance to Reworked. Shift-click to clear.',
  reworked: 'Reworked. Click to advance to Cleaned. Shift-click to go back to Replaced.',
  cleaned: 'Cleaned. Click to clear. Shift-click to go back to Reworked.',
};
// Button-side colour map: 'none' stays muted so an unmarked row reads as
// "not yet touched" instead of glowing in MARK_COLOR_CSS.none amber, which
// is the canvas-side colour used for worklist outlines that don't carry a
// per-part mark yet.
const MARK_BTN_COLOR: Record<WorklistMark, string> = {
  none: 'var(--muted, #888)',
  replaced: MARK_COLOR_CSS.replaced,
  reworked: MARK_COLOR_CSS.reworked,
  cleaned: MARK_COLOR_CSS.cleaned,
};

// ── Net-row mark tables ───────────────────────────────────────────────────
const NET_MARK_ICON: Record<NetWorklistMark, ComponentType<{ size?: number; stroke?: number }> | null> = {
  none: null,
  short: IconAlertTriangle,
  solved: IconCheck,
  absent: IconUnlink,
};
const NET_MARK_SHORT_LABEL: Record<NetWorklistMark, string> = {
  none: 'No mark',
  short: 'Short',
  solved: 'Solved',
  absent: 'Absent',
};
const NET_MARK_TITLE: Record<NetWorklistMark, string> = {
  none: 'No mark. Click to set Short. Cycle: Short → Solved → Absent → no mark. Shift-click cycles backwards.',
  short: 'Short. Click to advance to Solved. Shift-click to clear.',
  solved: 'Solved. Click to advance to Absent. Shift-click to go back to Short.',
  absent: 'Absent (net not present / not reaching). Click to clear. Shift-click to go back to Solved.',
};
const NET_MARK_BTN_COLOR: Record<NetWorklistMark, string> = {
  none: 'var(--muted, #888)',
  short: NET_MARK_COLOR_CSS.short,
  solved: NET_MARK_COLOR_CSS.solved,
  absent: NET_MARK_COLOR_CSS.absent,
};

async function copyToClipboard(text: string, summary: string): Promise<void> {
  try {
    await copyText(text);
    boardStore.addToast(summary, 'info');
  } catch (e) {
    boardStore.addToast(
      `Copy failed: ${e instanceof Error ? e.message : String(e)}`,
      'error',
    );
  }
}

export function WorklistPanel() {
  const { current, activeWorklist, hasBoard } = useWorklist();
  const sel = useSelectionSet();
  const { activeTabId } = useBoardStore();

  // Hydrate when this panel mounts / tab changes.
  useEffect(() => {
    void worklistStore.syncToActiveTab();
  }, [activeTabId]);

  const onClearSelection = () => {
    if (activeTabId != null) selectionSetStore.clear(activeTabId);
  };

  const onCreateWorklist = () => {
    const name = window.prompt('Worklist name (ticket #, location, …)');
    if (name === null) return;
    const created = worklistStore.createWorklist(name);
    if (!created) {
      boardStore.addToast('Could not create worklist — open a board first.', 'error');
    }
  };

  /** Read the clipboard, validate the `-[name]-` header, and import as a
   *  new active worklist. Entries whose refdes can't be found in this
   *  board are still imported but flagged unresolved — useful when the
   *  sender's board version is slightly off but you want their notes. */
  const onImportFromClipboard = async () => {
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch (e) {
      boardStore.addToast(
        `Clipboard read failed: ${e instanceof Error ? e.message : String(e)}`,
        'error',
      );
      return;
    }
    if (!text.trim()) {
      boardStore.addToast('Clipboard is empty.', 'error');
      return;
    }
    const r = worklistStore.importFromText(text);
    if (!r) {
      boardStore.addToast(
        'Clipboard does not look like a worklist. First line must be -[name]-.',
        'error',
      );
      return;
    }
    const missing = r.parts - r.resolved;
    const netSuffix = r.nets > 0 ? `, ${r.nets} net${r.nets === 1 ? '' : 's'}` : '';
    if (missing > 0) {
      boardStore.addToast(
        `Imported "${r.created}": ${r.resolved}/${r.parts} parts found on this board (${missing} missing)${netSuffix}.`,
        'info',
      );
    } else {
      boardStore.addToast(`Imported "${r.created}" (${r.parts} part${r.parts === 1 ? '' : 's'}${netSuffix}).`, 'info');
    }
  };

  if (!hasBoard) {
    return (
      <div style={emptyStyle}>
        <div style={{ opacity: 0.6 }}>Open a board to begin worklisting.</div>
      </div>
    );
  }

  return (
    <div style={rootStyle}>
      {/* ─── Selection band (cyan canvas highlight) ──────────────────────── */}
      {sel.count > 0 && (
        <section style={bandStyle}>
          <div style={bandHeaderStyle}>
            <span style={{ fontWeight: 600 }}>Cyan selection</span>
            <span style={countPillStyle}>{sel.count}</span>
            <button style={{ ...subtleBtnStyle, marginLeft: 'auto' }} onClick={onClearSelection} title="Clear the cyan canvas highlight + connection glow (parts stay on the board, worklist untouched)">Clear</button>
          </div>
          <div style={{ fontSize: 11, opacity: 0.6, marginTop: 4 }}>
            Loaded by multi-select on the canvas. Visual only — has no effect on the worklist contents.
          </div>
        </section>
      )}

      {/* ─── Worklist tabs ─────────────────────────────────────────────────── */}
      <section style={{ ...bandStyle, padding: '6px 8px' }}>
        <div style={tabsRowStyle}>
          {(current?.worklistes ?? []).map(s => {
            const isActive = s.id === current?.activeWorklistId;
            return (
              <button
                key={s.id}
                style={isActive ? activeTabStyle : tabStyle}
                onClick={() => worklistStore.setActiveWorklist(s.id)}
                title={`${s.entries.length} part${s.entries.length === 1 ? '' : 's'}`}
              >
                {s.name}
                <span style={{ marginLeft: 6, opacity: 0.55, fontSize: 11 }}>{s.entries.length}</span>
              </button>
            );
          })}
          <button style={newTabStyle} onClick={onCreateWorklist} title="New empty worklist">+</button>
          <button
            style={{ ...newTabStyle, display: 'flex', alignItems: 'center', gap: 4 }}
            onClick={onImportFromClipboard}
            title="Import a worklist from the clipboard. Must start with -[name]- on the first line."
          >
            <IconClipboardText size={13} stroke={1.8} />
            <span>Import</span>
          </button>
        </div>
      </section>

      {/* ─── Active worklist body ──────────────────────────────────────────── */}
      <section style={{ ...bodyStyle, flex: 1, minHeight: 0 }}>
        {!activeWorklist ? (
          <div style={emptyStyle}>
            <div style={{ opacity: 0.6 }}>No active worklist. Create one above to begin.</div>
          </div>
        ) : (
          <ActiveWorklistView />
        )}
      </section>
    </div>
  );
}

// Remembered scroll offset of the worklist list, keyed by worklist id. Lives
// at module scope so it survives not just re-renders but a full remount of
// ActiveWorklistView (issue #22: selecting a component on the board must not
// snap a long worklist back to the top). Restored on mount / worklist switch,
// saved on every scroll.
const worklistScrollTop = new Map<string, number>();

function ActiveWorklistView() {
  const { activeWorklist } = useWorklist();
  const { connectionHighlight } = useBoardStore();
  const listRef = useRef<HTMLDivElement>(null);
  // Restore the saved scroll offset for this worklist after every mount and on
  // worklist switch. A plain re-render preserves scrollTop natively; this makes
  // the position durable even if the container is remounted underneath us.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el || !activeWorklist) return;
    const saved = worklistScrollTop.get(activeWorklist.id);
    if (saved != null && saved !== el.scrollTop) el.scrollTop = saved;
  }, [activeWorklist?.id]);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const renameRef = useRef<HTMLInputElement>(null);
  const [ticketOpen, setTicketOpen] = useState(false);
  // Local draft for the ticket-level note. Re-seeded when the worklist id
  // changes (tab switch), otherwise the user's in-progress edit wins and
  // is committed on blur — same pattern as the per-row note.
  const [ticketDraft, setTicketDraft] = useState(activeWorklist?.note ?? '');
  const lastSeenWorklistIdRef = useRef<string | null>(activeWorklist?.id ?? null);
  useEffect(() => {
    if (!activeWorklist) return;
    if (lastSeenWorklistIdRef.current !== activeWorklist.id) {
      lastSeenWorklistIdRef.current = activeWorklist.id;
      // Sync the draft / popover state to the new worklist's stored note —
      // legitimate "subscribe to external prop change" pattern that the new
      // React Compiler rule (react-hooks/set-state-in-effect) over-flags.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTicketDraft(activeWorklist.note ?? '');
      setTicketOpen(false);
    }
  }, [activeWorklist]);

  useEffect(() => {
    if (renaming) renameRef.current?.select();
  }, [renaming]);

  if (!activeWorklist) return null;

  const startRename = () => {
    setRenameDraft(activeWorklist.name);
    setRenaming(true);
  };
  const commitRename = () => {
    worklistStore.renameWorklist(activeWorklist.id, renameDraft);
    setRenaming(false);
  };

  const onCopyAll = () => {
    const text = worklistStore.formatWorklistForClipboard(activeWorklist.id);
    if (!text) return;
    void copyToClipboard(text, `Copied ${activeWorklist.entries.length} row${activeWorklist.entries.length === 1 ? '' : 's'}`);
  };

  const onWipe = () => {
    if (activeWorklist.entries.length === 0) return;
    const ok = window.confirm(`Wipe all ${activeWorklist.entries.length} entries from "${activeWorklist.name}"?`);
    if (!ok) return;
    worklistStore.wipeWorklist(activeWorklist.id);
  };

  const onDeleteWorklist = () => {
    const ok = window.confirm(`Delete worklist "${activeWorklist.name}"? This cannot be undone.`);
    if (!ok) return;
    worklistStore.deleteWorklist(activeWorklist.id);
  };

  const onCommitTicketNote = () => {
    if (!activeWorklist) return;
    if ((activeWorklist.note ?? '') === ticketDraft) return;
    worklistStore.setWorklistNote(activeWorklist.id, ticketDraft);
  };

  // "Highlight" toggle: ON outlines every worklist part in its mark colour and
  // glows the nets they share; OFF clears both. Parts are no longer pushed into
  // the cyan selectionSetStore so mark colours are preserved.
  const onToggleConnections = () => {
    boardStore.setConnectionHighlight(!boardStore.connectionHighlight);
  };

  return (
    <>
      <header style={worklistHeaderStyle}>
        {renaming ? (
          <input
            ref={renameRef}
            style={renameInputStyle}
            value={renameDraft}
            onChange={e => setRenameDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={e => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') setRenaming(false);
            }}
          />
        ) : (
          <span
            onClick={startRename}
            style={{ cursor: 'text', fontWeight: 600, flex: 1, padding: '2px 4px', borderRadius: 3 }}
            title="Click to rename"
          >
            {activeWorklist.name}
          </span>
        )}
        <button
          style={connectionHighlight ? activeToggleBtnStyle : subtleBtnStyle}
          onClick={onToggleConnections}
          disabled={activeWorklist.entries.length === 0}
          aria-pressed={connectionHighlight}
          title={connectionHighlight
            ? 'Highlight ON — click to hide worklist outlines and shared-net glow'
            : 'Show this worklist on the board (mark colours) and glow the nets its parts share.'}
        >
          Highlight
        </button>
        <button style={subtleBtnStyle} onClick={onCopyAll} disabled={activeWorklist.entries.length === 0} title="Copy all rows to clipboard">Copy</button>
        <button style={subtleBtnStyle} onClick={onWipe} disabled={activeWorklist.entries.length === 0} title="Wipe all entries (keeps the worklist)">Wipe</button>
        <button style={dangerBtnStyle} onClick={onDeleteWorklist} title="Delete this worklist entirely">✕</button>
      </header>
      <div style={ticketNoteWrapStyle}>
        <button
          style={ticketNoteToggleStyle}
          onClick={() => setTicketOpen(x => !x)}
          title={ticketOpen ? 'Collapse ticket note' : 'Expand ticket note'}
        >
          <span>{ticketOpen ? '▾' : '▸'}</span>
          <span style={{ fontWeight: 600 }}>Ticket note</span>
          {!ticketOpen && ticketDraft.trim() && (
            <span style={ticketNotePeekStyle}>
              {(() => {
                const firstLine = ticketDraft.split('\n', 1)[0].trim();
                return firstLine.length > 60 ? firstLine.slice(0, 60) + '…' : firstLine;
              })()}
            </span>
          )}
          {!ticketOpen && !ticketDraft.trim() && (
            <span style={{ opacity: 0.45, fontSize: 11 }}>(empty)</span>
          )}
        </button>
        {ticketOpen && (
          <textarea
            style={ticketNoteAreaStyle}
            value={ticketDraft}
            placeholder="General note for this worklist / ticket. Saved when you click out."
            onChange={e => setTicketDraft(e.target.value)}
            onBlur={onCommitTicketNote}
          />
        )}
      </div>
      <div
        ref={listRef}
        style={listStyle}
        data-testid="worklist-scroll"
        onScroll={e => worklistScrollTop.set(activeWorklist.id, e.currentTarget.scrollTop)}
      >
        {activeWorklist.entries.length === 0 && (activeWorklist.netEntries?.length ?? 0) === 0 && (
          <div style={emptyStyle}>
            <div style={{ opacity: 0.55 }}>Empty. Shift-click parts on the board, or hit the pin button in the Search tab.</div>
          </div>
        )}
        {activeWorklist.entries.map(entry => (
          <WorklistRow key={entry.refdes} worklistId={activeWorklist.id} entry={entry} />
        ))}
        {(activeWorklist.netEntries?.length ?? 0) > 0 && activeWorklist.entries.length > 0 && (
          <div style={netsHeadingStyle}>Nets</div>
        )}
        {activeWorklist.netEntries?.map(entry => (
          <WorklistNetRow key={'net:' + entry.netName} worklistId={activeWorklist.id} entry={entry} />
        ))}
      </div>
      <AiWorklistSection worklist={activeWorklist} />
    </>
  );
}

// ── AI relay: transcript + prompt box for the agent feedback loop ──────────
// Shown when the MCP server is connected, or whenever the worklist already
// carries relay messages, so the transcript is always visible once started.
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
    <div style={aiSectionStyle}>
      <div style={aiHeadingStyle}>
        <IconSparkles size={13} /> AI relay{connected ? '' : ' (MCP offline)'}
      </div>

      {messages.length > 0 && (
        <div style={aiTranscriptStyle}>
          {messages.map(msg => (
            <div key={msg.id} style={{ marginBottom: 3 }}>
              <span style={{ color: msg.role === 'agent' ? '#7cc' : '#aa8', fontWeight: 600, fontSize: 10 }}>
                {msg.role === 'agent' ? 'AI' : 'You'}:
              </span>{' '}
              <span style={{ fontSize: 11 }}><NoteBody body={msg.text} board={boardStore.board} /></span>
            </div>
          ))}
        </div>
      )}

      <AiPromptBox worklistId={worklist.id} disabled={!connected} />
    </div>
  );
}

function AiPromptBox({ disabled }: { worklistId: string; disabled: boolean }) {
  const [text, setText] = useState('');
  const send = () => {
    const t = text.trim();
    if (!t) return;
    worklistStore.addMessage('user', t);
    setText('');
  };
  return (
    <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
      <input value={text} onChange={e => setText(e.target.value)} onKeyDown={e => e.key === 'Enter' && send()}
        placeholder={disabled ? 'Connect an MCP agent to chat…' : 'Message the agent (it reads this)…'}
        style={aiPromptInputStyle} />
      <button onClick={send} disabled={!text.trim()} style={aiSendBtnStyle}>Send</button>
    </div>
  );
}

const aiSectionStyle: React.CSSProperties = { borderTop: '1px solid var(--border, #333)', marginTop: 6, padding: '6px 8px', background: 'var(--panel-alt, rgba(120,140,255,0.05))' };
const aiHeadingStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600, color: '#9af', marginBottom: 5 };
const aiTranscriptStyle: React.CSSProperties = { maxHeight: 160, overflowY: 'auto', fontSize: 11, marginBottom: 4, padding: '2px 0' };
const measureInputStyle: React.CSSProperties = { width: 46, fontSize: 11, padding: '2px 4px', background: 'rgba(0,0,0,0.3)', border: '1px solid #444', borderRadius: 4, color: '#eee' };
const netMeasInputRequestedStyle: React.CSSProperties = { ...measureInputStyle, borderColor: 'var(--accent, #00e5ff)' };
const netMeasSlotStyle: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 3 };
const aiPromptInputStyle: React.CSSProperties = { flex: 1, fontSize: 11, padding: '4px 6px', background: 'rgba(0,0,0,0.3)', border: '1px solid #444', borderRadius: 4, color: '#eee' };
const aiSendBtnStyle: React.CSSProperties = { fontSize: 11, padding: '4px 10px', borderRadius: 4, border: '1px solid #557', background: 'rgba(120,140,255,0.15)', color: '#bcf', cursor: 'pointer' };

interface WorklistRowProps {
  worklistId: string;
  entry: WorklistEntry;
}

function WorklistRow({ worklistId, entry }: WorklistRowProps) {
  const [expanded, setExpanded] = useState(false);
  // The row is keyed by refdes upstream, so a refdes change remounts the
  // component and re-seeds noteDraft from the new entry. We deliberately do
  // not sync subsequent prop.note changes back into local state — the user's
  // in-progress edits win, and onCommitNote persists them on blur.
  const [noteDraft, setNoteDraft] = useState(entry.note);
  /** Click-time popover under the mark button. Set on cycle, auto-cleared
   *  after 1.6s. Bypasses the browser-native `title` 1+s hover delay so
   *  the new mark name appears immediately at click. Uses position:fixed
   *  + button bounding rect so the chip escapes ancestor `overflow:auto`
   *  (sidebar scroll container) — earlier `position:absolute` was clipped
   *  by the worklist list and could end up tucked behind the canvas. */
  const [flash, setFlash] = useState<{ mark: WorklistMark; x: number; y: number } | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
  }, []);

  const onFocus = () => {
    if (entry.unresolved) return;
    boardStore.focusPart(entry.refdes);
  };

  const onCycleMark = (e: React.MouseEvent) => {
    e.stopPropagation();
    worklistStore.cycleMark(worklistId, entry.refdes, e.shiftKey);
    const updated = worklistStore.activeWorklist?.entries.find(x => x.refdes === entry.refdes);
    if (updated) {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      setFlash({
        mark: updated.mark,
        x: rect.left + rect.width / 2,
        y: rect.bottom + 4,
      });
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      flashTimerRef.current = setTimeout(() => setFlash(null), 1600);
    }
  };

  const onToggleWater = (e: React.MouseEvent) => {
    e.stopPropagation();
    worklistStore.toggleWaterdamage(worklistId, entry.refdes);
  };

  const onRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    worklistStore.removeEntry(worklistId, entry.refdes);
  };

  const onCommitNote = () => {
    if (noteDraft !== entry.note) worklistStore.setNote(worklistId, entry.refdes, noteDraft);
  };

  return (
    <div style={{ ...rowStyle, opacity: entry.unresolved ? 0.45 : 1 }}>
      <div style={rowMainStyle} onClick={onFocus}>
        <button
          style={{
            ...markBtnStyle,
            color: MARK_BTN_COLOR[entry.mark],
            borderColor: entry.mark === 'none' ? 'var(--border, #444)' : MARK_BTN_COLOR[entry.mark],
          }}
          onClick={onCycleMark}
          title={MARK_TITLE[entry.mark]}
        >
          {(() => {
            const Icon = MARK_ICON[entry.mark];
            if (!Icon) return <span style={{ opacity: 0.4 }}>·</span>;
            return <Icon size={14} stroke={2} />;
          })()}
        </button>
        {flash && createPortal(
          <div
            style={{
              ...flashTooltipStyle,
              left: flash.x,
              top: flash.y,
              background: flash.mark === 'none' ? 'var(--panel-bg, #222)' : MARK_BTN_COLOR[flash.mark],
              color: flash.mark === 'none' ? 'var(--text, #ddd)' : '#0a0a0a',
            }}
            role="status"
          >
            {MARK_SHORT_LABEL[flash.mark]}
          </div>,
          document.body,
        )}
        <button
          style={waterBtnStyle(entry.waterdamage === true)}
          onClick={onToggleWater}
          title={entry.waterdamage ? 'Water damage flagged. Click to clear.' : 'Mark as water-damaged.'}
          aria-pressed={entry.waterdamage === true}
        >
          <IconDroplet size={14} stroke={2} />
        </button>
        <span style={{ fontFamily: 'monospace', fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {entry.refdes}
          {entry.unresolved && <span style={{ marginLeft: 6, opacity: 0.7, fontSize: 11 }}>(missing)</span>}
        </span>
        <button
          style={chevronBtnStyle}
          onClick={e => { e.stopPropagation(); setExpanded(x => !x); }}
          title={expanded ? 'Collapse note' : 'Expand note'}
        >
          {expanded ? '▾' : '▸'}
          {entry.note && !expanded && <span style={notePeekStyle}>{entry.note.length > 14 ? entry.note.slice(0, 14) + '…' : entry.note}</span>}
        </button>
        <button style={removeBtnStyle} onClick={onRemove} title="Remove from worklist">✕</button>
      </div>
      {expanded && (
        <textarea
          style={noteAreaStyle}
          value={noteDraft}
          placeholder="Note (saved when you click out)"
          onChange={e => setNoteDraft(e.target.value)}
          onBlur={onCommitNote}
        />
      )}
    </div>
  );
}

interface WorklistNetRowProps {
  worklistId: string;
  entry: NetWorklistEntry;
}

/** Net-entry analogue of WorklistRow. Same mark-cycle + note machinery; the
 *  water-damage drop is swapped for a lightning bolt (`surge` flag) since the
 *  failure mode for a signal isn't "got wet" but "saw an over-current event". */
function WorklistNetRow({ worklistId, entry }: WorklistNetRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [noteDraft, setNoteDraft] = useState(entry.note);
  const [flash, setFlash] = useState<{ mark: NetWorklistMark; x: number; y: number } | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
  }, []);

  const onFocus = () => {
    if (entry.unresolved) return;
    boardStore.focusNet(entry.netName);
  };

  const onCycleMark = (e: React.MouseEvent) => {
    e.stopPropagation();
    worklistStore.cycleNetMark(worklistId, entry.netName, e.shiftKey);
    const updated = worklistStore.activeWorklist?.netEntries?.find(x => x.netName === entry.netName);
    if (updated) {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      setFlash({
        mark: updated.mark,
        x: rect.left + rect.width / 2,
        y: rect.bottom + 4,
      });
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      flashTimerRef.current = setTimeout(() => setFlash(null), 1600);
    }
  };

  const onToggleSurge = (e: React.MouseEvent) => {
    e.stopPropagation();
    worklistStore.toggleSurge(worklistId, entry.netName);
  };

  const onRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    worklistStore.removeNetEntry(worklistId, entry.netName);
  };

  const onCommitNote = () => {
    if (noteDraft !== entry.note) worklistStore.setNetNote(worklistId, entry.netName, noteDraft);
  };

  return (
    <div style={{ ...rowStyle, opacity: entry.unresolved ? 0.45 : 1 }} data-testid="worklist-net-row">
      <div style={rowMainStyle} onClick={onFocus}>
        <button
          style={{
            ...markBtnStyle,
            color: NET_MARK_BTN_COLOR[entry.mark],
            borderColor: entry.mark === 'none' ? 'var(--border, #444)' : NET_MARK_BTN_COLOR[entry.mark],
          }}
          onClick={onCycleMark}
          title={NET_MARK_TITLE[entry.mark]}
        >
          {(() => {
            const Icon = NET_MARK_ICON[entry.mark];
            if (!Icon) return <span style={{ opacity: 0.4 }}>·</span>;
            return <Icon size={14} stroke={2} />;
          })()}
        </button>
        {flash && createPortal(
          <div
            style={{
              ...flashTooltipStyle,
              left: flash.x,
              top: flash.y,
              background: flash.mark === 'none' ? 'var(--panel-bg, #222)' : NET_MARK_BTN_COLOR[flash.mark],
              color: flash.mark === 'none' ? 'var(--text, #ddd)' : '#0a0a0a',
            }}
            role="status"
          >
            {NET_MARK_SHORT_LABEL[flash.mark]}
          </div>,
          document.body,
        )}
        <button
          style={surgeBtnStyle(entry.surge === true)}
          onClick={onToggleSurge}
          title={entry.surge ? 'Surge / over-current flagged. Click to clear.' : 'Mark as surge / over-current.'}
          aria-pressed={entry.surge === true}
        >
          <IconBolt size={14} stroke={2} />
        </button>
        <span style={{ fontFamily: 'monospace', fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {entry.netName}
          {entry.unresolved && <span style={{ marginLeft: 6, opacity: 0.7, fontSize: 11 }}>(missing)</span>}
        </span>
        <button
          style={chevronBtnStyle}
          onClick={e => { e.stopPropagation(); setExpanded(x => !x); }}
          title={expanded ? 'Collapse note' : 'Expand note'}
        >
          {expanded ? '▾' : '▸'}
          {entry.note && !expanded && <span style={notePeekStyle}>{entry.note.length > 14 ? entry.note.slice(0, 14) + '…' : entry.note}</span>}
        </button>
        <button style={removeBtnStyle} onClick={onRemove} title="Remove from worklist">✕</button>
      </div>
      {expanded && (
        <textarea
          style={noteAreaStyle}
          value={noteDraft}
          placeholder="Note (saved when you click out)"
          onChange={e => setNoteDraft(e.target.value)}
          onBlur={onCommitNote}
        />
      )}
      <NetMeasurementStrip worklistId={worklistId} entry={entry} />
    </div>
  );
}

// ── Measurement strip for net rows ──────────────────────────────────────────

// Display label for a measurement kind: V / Ω are their own unit symbols; diode
// mode uses the Tabler circuit-diode icon. (The clipboard format still spells
// out "Diode" so copied text stays parser-readable.)
function MeasLabel({ k }: { k: NetMeasurement['kind'] }) {
  if (k === 'diode') return <IconCircuitDiode size={15} stroke={2} style={{ verticalAlign: 'middle' }} />;
  return <>{k === 'voltage' ? 'V' : 'Ω'}</>;
}

// Three independent reading slots (V / diode / Ω) — all coexist, no type switch.
function NetMeasurementStrip({ worklistId, entry }: { worklistId: string; entry: NetWorklistEntry }) {
  return (
    <div style={netMeasStripStyle} data-testid="net-meas-strip">
      {MEAS_KINDS.map(k => (
        <NetMeasSlot key={k} worklistId={worklistId} netName={entry.netName} kind={k} m={entry.measurements?.[k]} />
      ))}
    </div>
  );
}

function NetMeasSlot({ worklistId, netName, kind, m }: {
  worklistId: string; netName: string; kind: NetMeasurement['kind']; m: NetMeasurement | undefined;
}) {
  const [val, setVal] = useState(m?.value ?? '');
  // Reflect external changes (agent records a value, another tab edits, clear).
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
    <span style={netMeasSlotStyle} data-testid={`net-meas-slot-${kind}`}>
      <span style={netMeasChipStyle} data-testid={`net-meas-chip-${kind}`}
        title={requested ? `Agent requested ${kind}${m?.prompt ? `: ${m.prompt}` : ''}` : `Record ${kind}`}>
        <MeasLabel k={kind} />
      </span>
      <input data-testid={`net-meas-input-${kind}`} value={val}
        placeholder={requested && m?.expected ? `exp ${m.expected}` : ''}
        onChange={e => setVal(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        onBlur={commit}
        style={requested ? netMeasInputRequestedStyle : measureInputStyle} />
    </span>
  );
}

// ── Inline styles (kept here so this whole feature lives in two files; we can
//    promote to a real stylesheet later once the layout settles). ─────────

const rootStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
  background: 'var(--panel-bg, #1a1a1a)',
  color: 'var(--text, #ddd)',
  fontSize: 13,
};

const bandStyle: React.CSSProperties = {
  padding: '8px 10px',
  borderBottom: '1px solid var(--border, #2a2a2a)',
  flexShrink: 0,
};

const bandHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

const countPillStyle: React.CSSProperties = {
  background: 'var(--accent, #00e5ff)',
  color: '#000',
  fontWeight: 700,
  fontSize: 11,
  padding: '1px 7px',
  borderRadius: 8,
  minWidth: 18,
  textAlign: 'center',
};

const subtleBtnStyle: React.CSSProperties = {
  background: 'transparent',
  color: 'inherit',
  border: '1px solid var(--border, #444)',
  padding: '3px 9px',
  cursor: 'pointer',
  borderRadius: 3,
  fontSize: 12,
};

const dangerBtnStyle: React.CSSProperties = {
  ...subtleBtnStyle,
  color: '#ff5566',
  borderColor: '#553034',
};

const activeToggleBtnStyle: React.CSSProperties = {
  ...subtleBtnStyle,
  background: 'var(--accent-dim, #2a3a3f)',
  borderColor: 'var(--accent, #00e5ff)',
  color: 'var(--accent, #00e5ff)',
  fontWeight: 600,
};

const tabsRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 2,
  flexWrap: 'wrap',
  alignItems: 'center',
};

const tabStyle: React.CSSProperties = {
  background: 'var(--panel-bg-dim, #161616)',
  color: 'var(--text, #ddd)',
  border: '1px solid var(--border, #333)',
  padding: '3px 8px',
  fontSize: 12,
  cursor: 'pointer',
  borderRadius: 3,
  display: 'flex',
  alignItems: 'center',
};

const activeTabStyle: React.CSSProperties = {
  ...tabStyle,
  background: 'var(--accent-dim, #2a3a3f)',
  borderColor: 'var(--accent, #00e5ff)',
  color: 'var(--accent, #00e5ff)',
  fontWeight: 600,
};

const newTabStyle: React.CSSProperties = {
  ...tabStyle,
  padding: '3px 8px',
  fontWeight: 700,
};

const bodyStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
};

const worklistHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 10px',
  borderBottom: '1px solid var(--border, #2a2a2a)',
  flexShrink: 0,
};

const renameInputStyle: React.CSSProperties = {
  flex: 1,
  background: 'var(--input-bg, #0e0e0e)',
  color: 'inherit',
  border: '1px solid var(--accent, #00e5ff)',
  padding: '2px 4px',
  borderRadius: 3,
  fontSize: 13,
  fontWeight: 600,
};

const listStyle: React.CSSProperties = {
  overflow: 'auto',
  flex: 1,
  minHeight: 0,
};

const ticketNoteWrapStyle: React.CSSProperties = {
  borderBottom: '1px solid var(--border, #2a2a2a)',
  flexShrink: 0,
  background: 'transparent',
};

const ticketNoteToggleStyle: React.CSSProperties = {
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  background: 'transparent',
  border: 'none',
  color: 'inherit',
  cursor: 'pointer',
  padding: '6px 10px',
  fontSize: 12,
  textAlign: 'left',
};

const ticketNotePeekStyle: React.CSSProperties = {
  opacity: 0.6,
  fontStyle: 'italic',
  fontSize: 11,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  flex: 1,
  minWidth: 0,
};

const ticketNoteAreaStyle: React.CSSProperties = {
  width: 'calc(100% - 20px)',
  margin: '0 10px 8px 10px',
  minHeight: 70,
  background: 'var(--input-bg, #0e0e0e)',
  color: 'inherit',
  border: '1px solid var(--border, #333)',
  borderRadius: 3,
  padding: 6,
  fontSize: 12,
  resize: 'vertical',
  fontFamily: 'inherit',
};

const rowStyle: React.CSSProperties = {
  borderBottom: '1px solid var(--border, #232323)',
  background: 'transparent',
};

const rowMainStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 10px',
  cursor: 'pointer',
};

const markBtnStyle: React.CSSProperties = {
  width: 24,
  height: 22,
  border: '1px solid var(--border, #444)',
  background: 'transparent',
  borderRadius: 3,
  fontFamily: 'monospace',
  fontWeight: 700,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  padding: 0,
};

const WATER_COLOR = '#5fb6ff';
const SURGE_COLOR = '#ffcf3a';

function waterBtnStyle(on: boolean): React.CSSProperties {
  return {
    width: 22,
    height: 22,
    background: 'transparent',
    border: 'none',
    borderRadius: 3,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    padding: 0,
    color: on ? WATER_COLOR : 'var(--muted, #888)',
    opacity: on ? 1 : 0.35,
  };
}

function surgeBtnStyle(on: boolean): React.CSSProperties {
  return {
    ...waterBtnStyle(on),
    color: on ? SURGE_COLOR : 'var(--muted, #888)',
  };
}

const netsHeadingStyle: React.CSSProperties = {
  padding: '8px 4px 4px',
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: 0.5,
  textTransform: 'uppercase',
  color: 'var(--muted, #888)',
  opacity: 0.7,
};

const flashTooltipStyle: React.CSSProperties = {
  // position:fixed so the chip escapes ancestor overflow:auto (sidebar
  // scroll container) and any z-index stacking context — earlier
  // position:absolute was clipped by the worklist list and ended up
  // behind the canvas at row edges. left/top are set per-click from
  // the button's getBoundingClientRect.
  position: 'fixed',
  transform: 'translateX(-50%)',
  padding: '3px 8px',
  fontSize: 11,
  fontWeight: 700,
  borderRadius: 3,
  whiteSpace: 'nowrap',
  zIndex: 10000,
  boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
  pointerEvents: 'none',
};

const chevronBtnStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: 12,
  padding: '2px 6px',
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  opacity: 0.75,
};

const notePeekStyle: React.CSSProperties = {
  opacity: 0.6,
  fontStyle: 'italic',
  maxWidth: 140,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const removeBtnStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--muted, #888)',
  cursor: 'pointer',
  padding: '0 4px',
  fontSize: 13,
};

const noteAreaStyle: React.CSSProperties = {
  width: 'calc(100% - 20px)',
  margin: '0 10px 8px 38px',
  minHeight: 50,
  background: 'var(--input-bg, #0e0e0e)',
  color: 'inherit',
  border: '1px solid var(--border, #333)',
  borderRadius: 3,
  padding: 5,
  fontSize: 12,
  resize: 'vertical',
  fontFamily: 'inherit',
};

const emptyStyle: React.CSSProperties = {
  padding: '24px 16px',
  textAlign: 'center',
  fontSize: 12,
};

const netMeasStripStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 4,
  padding: '3px 10px 5px 10px',
};

const netMeasChipStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  fontSize: 10,
  padding: '1px 5px',
  borderRadius: 4,
  border: '1px solid var(--border, #444)',
  background: 'transparent',
  color: 'var(--muted, #888)',
};
