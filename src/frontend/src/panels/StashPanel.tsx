import React, { useEffect, useMemo, useRef, useState } from 'react';
import { stashStore } from '../store/stash-store';
import type { StashEntry, StashMark } from '../store/stash-store';
import { selectionSetStore } from '../store/selection-set-store';
import { boardStore } from '../store/board-store';
import { useStash } from '../hooks/useStash';
import { useSelectionSet } from '../hooks/useSelectionSet';
import { useBoardStore } from '../hooks/useBoardStore';

const MARK_LABELS: Record<StashMark, string> = {
  none: '·',
  replaced: 'R',
  reworked: 'W',
  cleaned: 'C',
};
const MARK_TITLE: Record<StashMark, string> = {
  none: 'no mark — click to cycle: replaced → reworked → cleaned',
  replaced: 'replaced — click to cycle to reworked',
  reworked: 'reworked — click to cycle to cleaned',
  cleaned: 'cleaned — click to clear',
};
const MARK_COLOR: Record<StashMark, string> = {
  none: 'var(--muted, #888)',
  replaced: '#ff5566',
  reworked: '#ffaa33',
  cleaned: '#33cc88',
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

export function StashPanel() {
  const { current, activeStash, hasBoard } = useStash();
  const sel = useSelectionSet();
  const { activeTabId, board } = useBoardStore();
  const [pushMenuOpen, setPushMenuOpen] = useState(false);
  const pushMenuRef = useRef<HTMLDivElement>(null);

  // Hydrate when this panel mounts / tab changes.
  useEffect(() => {
    void stashStore.syncToActiveTab();
  }, [activeTabId]);

  // Close push menu on outside click
  useEffect(() => {
    if (!pushMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (pushMenuRef.current && !pushMenuRef.current.contains(e.target as Node)) {
        setPushMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [pushMenuOpen]);

  const selectedRefdes = useMemo(() => {
    if (!board) return [];
    return sel.ordered
      .map(i => board.parts[i]?.name)
      .filter((n): n is string => !!n);
  }, [sel.ordered, board]);

  const onPushToStash = (stashId: string | null) => {
    if (sel.ordered.length === 0) return;
    const result = stashStore.pushParts(stashId, sel.ordered);
    setPushMenuOpen(false);
    if (result > 0) {
      const target = stashStore.activeStash?.name ?? 'stash';
      boardStore.addToast(`Pushed ${result} part${result === 1 ? '' : 's'} to ${target}`, 'info');
    }
  };

  const onCopySelection = () => {
    if (selectedRefdes.length === 0) return;
    const text = selectedRefdes.join('\n');
    void copyToClipboard(text, `Copied ${selectedRefdes.length} refdes`);
  };

  const onClearSelection = () => {
    if (activeTabId != null) selectionSetStore.clear(activeTabId);
  };

  const onCreateStash = () => {
    const name = window.prompt('Stash name (ticket #, location, …)');
    if (name === null) return;
    stashStore.createStash(name);
  };

  if (!hasBoard) {
    return (
      <div style={emptyStyle}>
        <div style={{ opacity: 0.6 }}>Open a board to begin stashing.</div>
      </div>
    );
  }

  return (
    <div style={rootStyle}>
      {/* ─── Selection band ─────────────────────────────────────────────── */}
      <section style={bandStyle}>
        <div style={bandHeaderStyle}>
          <span style={{ fontWeight: 600 }}>Selection</span>
          <span style={countPillStyle}>{sel.count}</span>
        </div>
        <div style={{ fontSize: 12, opacity: 0.7, margin: '4px 0 8px' }}>
          Shift-click parts on the board to build a set. Push it into a stash to keep it.
        </div>
        <div style={btnRowStyle}>
          <div ref={pushMenuRef} style={{ position: 'relative', display: 'flex' }}>
            <button
              style={primaryBtnStyle}
              disabled={sel.count === 0}
              onClick={() => {
                if (!current || current.stashes.length === 0) {
                  // No stash yet — create one and push.
                  const s = stashStore.createStash();
                  if (s) onPushToStash(s.id);
                  return;
                }
                onPushToStash(current.activeStashId);
              }}
              title={activeStash ? `Push selection to "${activeStash.name}"` : 'Create a new stash and push'}
            >
              Push to {activeStash?.name ?? 'new stash'}
            </button>
            <button
              style={{ ...primaryBtnStyle, borderLeft: '1px solid rgba(0,0,0,0.25)', padding: '4px 8px' }}
              disabled={sel.count === 0}
              onClick={() => setPushMenuOpen(o => !o)}
              title="Pick another stash to push into"
            >
              ▾
            </button>
            {pushMenuOpen && current && (
              <div style={dropdownStyle}>
                {current.stashes.map(s => (
                  <button key={s.id} style={dropdownItemStyle} onClick={() => onPushToStash(s.id)}>
                    {s.name}
                    {s.id === current.activeStashId && <span style={{ opacity: 0.5, marginLeft: 8 }}>(active)</span>}
                  </button>
                ))}
                <div style={dropdownSepStyle} />
                <button
                  style={dropdownItemStyle}
                  onClick={() => {
                    setPushMenuOpen(false);
                    const name = window.prompt('Name for the new stash');
                    if (name === null) return;
                    const s = stashStore.createStash(name);
                    if (s) onPushToStash(s.id);
                  }}
                >
                  + New stash…
                </button>
              </div>
            )}
          </div>
          <button
            style={subtleBtnStyle}
            disabled={sel.count === 0}
            onClick={onCopySelection}
            title="Copy refdes list (one per line)"
          >
            Copy
          </button>
          <button
            style={subtleBtnStyle}
            disabled={sel.count === 0}
            onClick={onClearSelection}
            title="Clear the selection set (parts stay on the board)"
          >
            Clear
          </button>
        </div>
      </section>

      {/* ─── Stash tabs ─────────────────────────────────────────────────── */}
      <section style={{ ...bandStyle, padding: '6px 8px' }}>
        <div style={tabsRowStyle}>
          {(current?.stashes ?? []).map(s => {
            const isActive = s.id === current?.activeStashId;
            return (
              <button
                key={s.id}
                style={isActive ? activeTabStyle : tabStyle}
                onClick={() => stashStore.setActiveStash(s.id)}
                title={`${s.entries.length} part${s.entries.length === 1 ? '' : 's'}`}
              >
                {s.name}
                <span style={{ marginLeft: 6, opacity: 0.55, fontSize: 11 }}>{s.entries.length}</span>
              </button>
            );
          })}
          <button style={newTabStyle} onClick={onCreateStash} title="New stash">+</button>
        </div>
      </section>

      {/* ─── Active stash body ──────────────────────────────────────────── */}
      <section style={{ ...bodyStyle, flex: 1, minHeight: 0 }}>
        {!activeStash ? (
          <div style={emptyStyle}>
            <div style={{ opacity: 0.6 }}>No active stash. Create one above to begin.</div>
          </div>
        ) : (
          <ActiveStashView />
        )}
      </section>
    </div>
  );
}

function ActiveStashView() {
  const { activeStash } = useStash();
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const renameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) renameRef.current?.select();
  }, [renaming]);

  if (!activeStash) return null;

  const startRename = () => {
    setRenameDraft(activeStash.name);
    setRenaming(true);
  };
  const commitRename = () => {
    stashStore.renameStash(activeStash.id, renameDraft);
    setRenaming(false);
  };

  const onCopyAll = () => {
    const text = stashStore.formatStashForClipboard(activeStash.id);
    if (!text) return;
    void copyToClipboard(text, `Copied ${activeStash.entries.length} row${activeStash.entries.length === 1 ? '' : 's'}`);
  };

  const onWipe = () => {
    if (activeStash.entries.length === 0) return;
    const ok = window.confirm(`Wipe all ${activeStash.entries.length} entries from "${activeStash.name}"?`);
    if (!ok) return;
    stashStore.wipeStash(activeStash.id);
  };

  const onDeleteStash = () => {
    const ok = window.confirm(`Delete stash "${activeStash.name}"? This cannot be undone.`);
    if (!ok) return;
    stashStore.deleteStash(activeStash.id);
  };

  return (
    <>
      <header style={stashHeaderStyle}>
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
            {activeStash.name}
          </span>
        )}
        <button style={subtleBtnStyle} onClick={onCopyAll} disabled={activeStash.entries.length === 0} title="Copy all rows to clipboard">Copy</button>
        <button style={subtleBtnStyle} onClick={onWipe} disabled={activeStash.entries.length === 0} title="Wipe all entries (keeps the stash)">Wipe</button>
        <button style={dangerBtnStyle} onClick={onDeleteStash} title="Delete this stash entirely">✕</button>
      </header>
      <div style={listStyle}>
        {activeStash.entries.length === 0 && (
          <div style={emptyStyle}>
            <div style={{ opacity: 0.55 }}>Empty. Shift-click parts on the board and push them here.</div>
          </div>
        )}
        {activeStash.entries.map(entry => (
          <StashRow key={entry.refdes} stashId={activeStash.id} entry={entry} />
        ))}
      </div>
    </>
  );
}

interface StashRowProps {
  stashId: string;
  entry: StashEntry;
}

function StashRow({ stashId, entry }: StashRowProps) {
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
    stashStore.cycleMark(stashId, entry.refdes, e.shiftKey);
  };

  const onRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    stashStore.removeEntry(stashId, entry.refdes);
  };

  const onCommitNote = () => {
    if (noteDraft !== entry.note) stashStore.setNote(stashId, entry.refdes, noteDraft);
  };

  return (
    <div style={{ ...rowStyle, opacity: entry.unresolved ? 0.45 : 1 }}>
      <div style={rowMainStyle} onClick={onFocus}>
        <button
          style={{
            ...markBtnStyle,
            color: MARK_COLOR[entry.mark],
            borderColor: entry.mark === 'none' ? 'var(--border, #444)' : MARK_COLOR[entry.mark],
          }}
          onClick={onCycleMark}
          title={MARK_TITLE[entry.mark]}
        >
          {MARK_LABELS[entry.mark]}
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
        <button style={removeBtnStyle} onClick={onRemove} title="Remove from stash">✕</button>
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

const btnRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 6,
  alignItems: 'center',
};

const primaryBtnStyle: React.CSSProperties = {
  background: 'var(--accent, #00e5ff)',
  color: '#000',
  border: 'none',
  padding: '4px 10px',
  fontWeight: 600,
  cursor: 'pointer',
  borderRadius: 3,
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

const dropdownStyle: React.CSSProperties = {
  position: 'absolute',
  top: '100%',
  left: 0,
  marginTop: 2,
  background: 'var(--panel-bg, #222)',
  border: '1px solid var(--border, #444)',
  borderRadius: 4,
  minWidth: 180,
  zIndex: 100,
  boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
};

const dropdownItemStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  background: 'transparent',
  color: 'inherit',
  border: 'none',
  padding: '6px 10px',
  cursor: 'pointer',
  fontSize: 12,
};

const dropdownSepStyle: React.CSSProperties = {
  borderTop: '1px solid var(--border, #444)',
  margin: '2px 0',
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

const stashHeaderStyle: React.CSSProperties = {
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
