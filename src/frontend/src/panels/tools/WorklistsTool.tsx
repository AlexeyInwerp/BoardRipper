/**
 * Worklist navigator (Tools ▸ Worklists) — every worklist, board open or
 * not. Grouped by the board name each worklist is attributed to, searchable
 * by name, board and tag (loose rule), filterable by tag.
 *
 * A row opens its editor in place: name, board name and tags; Load into any
 * open board tab (for that session — it does not change the board name);
 * Duplicate, Copy, Delete; and the rows themselves, with marks, notes and
 * readings editable without a board. Highlighting on the board is the only
 * thing that needs one. Spec: docs/specs/2026-11-10-worklist-storage-redesign.md §6.
 */
import { useMemo, useState } from 'react';
import { IconChevronDown, IconChevronRight, IconPlus, IconClipboardText } from '@tabler/icons-react';
import { worklistStore, type WorklistSummary } from '../../store/worklist-store';
import { boardStore } from '../../store/board-store';
import { useWorklist } from '../../hooks/useWorklist';
import { useBoardStore } from '../../hooks/useBoardStore';
import { looseMatcher } from '../../store/loose-match';
import { copyText } from '../../clipboard';
import { WorklistRow } from '../WorklistPanel';

function ago(at: number | undefined): string {
  if (!at) return '';
  const days = Math.floor((Date.now() - at) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days`;
  if (days < 14) return 'last week';
  if (days < 60) return `${Math.floor(days / 7)} weeks`;
  return `${Math.floor(days / 30)} months`;
}

const counts = (w: WorklistSummary) =>
  `${w.parts} part${w.parts === 1 ? '' : 's'} · ${w.nets} net${w.nets === 1 ? '' : 's'}`;

export function WorklistsTool() {
  const { summaries } = useWorklist();
  const [q, setQ] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const allTags = useMemo(() => {
    const n = new Map<string, number>();
    for (const w of summaries) for (const t of w.tags) n.set(t, (n.get(t) ?? 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
  }, [summaries]);

  const groups = useMemo(() => {
    const m = looseMatcher(q.trim());
    const shown = summaries.filter(w =>
      (!tag || w.tags.includes(tag))
      && (!q.trim() || m.test(w.name) || m.test(w.board) || w.tags.some(t => m.test(t))));
    const by = new Map<string, WorklistSummary[]>();
    for (const w of shown) {
      const k = w.board || '';
      if (!by.has(k)) by.set(k, []);
      by.get(k)!.push(w);
    }
    // Groups by their most recent worklist, rows most recent first.
    return [...by.entries()].sort((a, b) => b[1][0].updatedAt - a[1][0].updatedAt);
  }, [summaries, q, tag]);

  const create = () => {
    const w = worklistStore.createWorklist(undefined, { onTab: false, board: '' });
    if (w) setOpenId(w.id);
  };

  const paste = async () => {
    let text = '';
    try { text = await navigator.clipboard.readText(); } catch { boardStore.addToast('Clipboard read failed.', 'error'); return; }
    const r = worklistStore.importFromText(text);
    if (!r) { boardStore.addToast('Clipboard does not look like a worklist. First line must be -[name]-.', 'error'); return; }
    boardStore.addToast(`Imported “${r.created}”.`, 'info');
  };

  return (
    <div className="wlnav" data-testid="tools-worklists">
      <div className="wlnav-head">
        <div className="tools-group-label">{`Worklists (${summaries.length})`}</div>
        <button type="button" className="wl-act" data-testid="wlnav-new" onClick={create}>
          <IconPlus size={13} stroke={1.9} />New
        </button>
        <button type="button" className="wl-act" data-testid="wlnav-paste" onClick={() => { void paste(); }}>
          <IconClipboardText size={13} stroke={1.9} />Paste
        </button>
      </div>
      <input
        className="wlnav-search"
        data-testid="wlnav-search"
        placeholder="Search name, board or tag"
        value={q}
        onChange={e => setQ(e.target.value)}
      />
      {allTags.length > 0 && (
        <div className="wlnav-tags">
          {allTags.map(t => (
            <button key={t} type="button" className={`wl-tag${tag === t ? ' on' : ''}`} data-testid="wlnav-tag"
              onClick={() => setTag(tag === t ? null : t)} translate="no">{t}</button>
          ))}
        </div>
      )}
      {summaries.length === 0 && <div className="library-empty">No worklists yet.</div>}
      {groups.map(([board, rows]) => (
        <div key={board} className="wlnav-group" data-testid="wlnav-group">
          <div className="tools-group-label" translate="no">{board || 'No board name'}</div>
          {rows.map(w => (
            <div key={w.id}>
              <button
                type="button"
                className={`wlcat-row${openId === w.id ? ' cur' : ''}`}
                data-testid="worklist-catalog-row"
                data-id={w.id}
                onClick={() => setOpenId(openId === w.id ? null : w.id)}
              >
                {openId === w.id ? <IconChevronDown size={13} stroke={2} /> : <IconChevronRight size={13} stroke={2} />}
                <span className="wlcat-body">
                  <span className="wlcat-name">{w.name}</span>
                  <span className="wlcat-meta">
                    {`${counts(w)}${ago(w.updatedAt) ? ` · ${ago(w.updatedAt)}` : ''}`}
                    {w.tags.length > 0 && ` · ${w.tags.join(', ')}`}
                  </span>
                </span>
              </button>
              {openId === w.id && <WorklistEditor id={w.id} onGone={() => setOpenId(null)} />}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** One worklist, edited with no board: its name, board name and tags, where
 *  it is open, and its rows. */
function WorklistEditor({ id, onGone }: { id: string; onGone: () => void }) {
  useWorklist();                       // re-render on store changes
  const { tabs } = useBoardStore();
  const w = worklistStore.view(id);
  const [name, setName] = useState(w?.name ?? '');
  const [board, setBoard] = useState(w?.board ?? '');
  const [tags, setTags] = useState((w?.tags ?? []).join(', '));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  if (!w) return null;
  const openOn = worklistStore.tabsShowing(id);

  const commitTags = () => worklistStore.setTags(id, tags.split(','));

  return (
    <div className="wlnav-editor" data-testid="wlnav-editor">
      <label className="wlnav-field">
        <span>Name</span>
        <input data-testid="wlnav-name" value={name} onChange={e => setName(e.target.value)}
          onBlur={() => worklistStore.renameWorklist(id, name)}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
      </label>
      <label className="wlnav-field">
        <span>Board</span>
        <input data-testid="wlnav-board" value={board} placeholder="e.g. 820-02016" translate="no"
          onChange={e => setBoard(e.target.value)}
          onBlur={() => worklistStore.setBoardName(id, board)}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
      </label>
      <label className="wlnav-field">
        <span>Tags</span>
        <input data-testid="wlnav-tags" value={tags} placeholder="A2337, water, no power" translate="no"
          onChange={e => setTags(e.target.value)} onBlur={commitTags}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
      </label>
      {w.origin?.fileName && <div className="wlnav-origin">{`Started on ${w.origin.fileName}`}</div>}

      <div className="wlnav-load">
        <span>{tabs.length ? 'Load into' : 'Open a board to load it there.'}</span>
        {tabs.map(t => {
          const on = openOn.includes(t.id);
          return (
            <button key={t.id} type="button" className={`wl-hl${on ? ' on' : ''}`} data-testid="wlnav-load"
              disabled={on} title={on ? 'Open on this board' : `Load on ${t.fileName} for this session`}
              onClick={() => { boardStore.switchTab(t.id); worklistStore.loadOnTab(t.id, id); }} translate="no">
              {t.fileName}
            </button>
          );
        })}
      </div>

      <div className="wlnav-actions">
        <button type="button" className="wl-act" data-testid="wlnav-duplicate"
          onClick={() => { const d = worklistStore.duplicateWorklist(id); if (d) boardStore.addToast(`Made “${d.name}”.`, 'info'); }}>
          Duplicate
        </button>
        <button type="button" className="wl-act" data-testid="wlnav-copy"
          onClick={() => { void copyText(worklistStore.formatWorklistForClipboard(id)).then(() => boardStore.addToast('Copied.', 'info')); }}>
          Copy
        </button>
        {!confirmDelete
          ? <button type="button" className="wl-act" data-testid="wlnav-delete" onClick={() => setConfirmDelete(true)}>Delete</button>
          : (
            <span className="wl-confirm">
              <span className="q">{`Delete “${w.name}”? This cannot be undone.${openOn.length ? ` It is open on ${openOn.length} board tab${openOn.length === 1 ? '' : 's'}.` : ''}`}</span>
              <button type="button" onClick={() => setConfirmDelete(false)}>Cancel</button>
              <button type="button" className="go" data-testid="wlnav-delete-yes"
                onClick={() => { worklistStore.deleteWorklist(id); onGone(); }}>Delete</button>
            </span>
          )}
      </div>

      <div className="wlnav-rows">
        {w.entries.length + w.netEntries.length === 0 && <div className="wl-empty">Empty. Add parts and nets from a board.</div>}
        {w.entries.map(e => (
          <WorklistRow key={e.refdes} kind="part" worklistId={id} partEntry={e} boardless
            selected={sel === 'p:' + e.refdes} onSelect={() => setSel('p:' + e.refdes)} />
        ))}
        {w.netEntries.map(n => (
          <WorklistRow key={'net:' + n.netName} kind="net" worklistId={id} netEntry={n} boardless
            selected={sel === 'n:' + n.netName} onSelect={() => setSel('n:' + n.netName)} />
        ))}
      </div>
    </div>
  );
}
