import React, { useEffect, useRef, useState } from 'react';
import { IconReplace, IconTool, IconSparkles, IconMinus } from '@tabler/icons-react';
import { worklistStore, MARK_COLOR_CSS } from '../store/worklist-store';
import type { WorklistEntry, WorklistMark } from '../store/worklist-store';
import { selectionSetStore } from '../store/selection-set-store';
import { boardStore } from '../store/board-store';
import { useWorklist } from '../hooks/useWorklist';
import { useSelectionSet } from '../hooks/useSelectionSet';
import { useBoardStore } from '../hooks/useBoardStore';

// Icon per mark + hover tooltip with full meaning. Cycling order:
// none → replaced → reworked → cleaned → none. The same colours are used
// on the canvas highlight (MARK_COLOR_HEX in worklist-store).
const MARK_ICON: Record<WorklistMark, typeof IconReplace> = {
  none: IconMinus,
  replaced: IconReplace,
  reworked: IconTool,
  cleaned: IconSparkles,
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

async function copyToClipboard(text: string, summary: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
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
            <button style={{ ...subtleBtnStyle, marginLeft: 'auto' }} onClick={onClearSelection} title="Clear the cyan canvas highlight (parts stay on the board, worklist untouched)">Clear</button>
          </div>
          <div style={{ fontSize: 11, opacity: 0.6, marginTop: 4 }}>
            Loaded by <b>Select</b> on a worklist below. Visual only — has no effect on the worklist contents.
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
          <button style={newTabStyle} onClick={onCreateWorklist} title="New worklist">+</button>
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

function ActiveWorklistView() {
  const { activeWorklist } = useWorklist();
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const renameRef = useRef<HTMLInputElement>(null);

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

  const onSelectAll = () => {
    const tabId = boardStore.activeTabId;
    if (tabId == null) return;
    const board = boardStore.board;
    if (!board) return;
    // Re-resolve refdes → partIndex against the *current* derived board so
    // fold-mode / sub-board changes since hydration don't paint highlights
    // on the wrong components.
    const indices: number[] = [];
    for (const e of activeWorklist.entries) {
      const idx = board.parts.findIndex(p => p?.name === e.refdes);
      if (idx >= 0) indices.push(idx);
    }
    selectionSetStore.replaceWith(tabId, indices);
    boardStore.addToast(`Selected ${indices.length} part${indices.length === 1 ? '' : 's'} on canvas`, 'info');
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
        <button style={subtleBtnStyle} onClick={onSelectAll} disabled={activeWorklist.entries.length === 0} title="Put every part in this worklist into the canvas selection (cyan outline)">Select</button>
        <button style={subtleBtnStyle} onClick={onCopyAll} disabled={activeWorklist.entries.length === 0} title="Copy all rows to clipboard">Copy</button>
        <button style={subtleBtnStyle} onClick={onWipe} disabled={activeWorklist.entries.length === 0} title="Wipe all entries (keeps the worklist)">Wipe</button>
        <button style={dangerBtnStyle} onClick={onDeleteWorklist} title="Delete this worklist entirely">✕</button>
      </header>
      <div style={listStyle}>
        {activeWorklist.entries.length === 0 && (
          <div style={emptyStyle}>
            <div style={{ opacity: 0.55 }}>Empty. Shift-click parts on the board to add them.</div>
          </div>
        )}
        {activeWorklist.entries.map(entry => (
          <WorklistRow key={entry.refdes} worklistId={activeWorklist.id} entry={entry} />
        ))}
      </div>
    </>
  );
}

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

  const onFocus = () => {
    if (entry.unresolved) return;
    boardStore.focusPart(entry.refdes);
  };

  const onCycleMark = (e: React.MouseEvent) => {
    e.stopPropagation();
    worklistStore.cycleMark(worklistId, entry.refdes, e.shiftKey);
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
            return <Icon size={14} stroke={2} />;
          })()}
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
