/**
 * Worklists catalog — every worklist stored on this device.
 *
 * It used to be printed text: you could read the names and do nothing with
 * them. It is now the index the worklist panel's finder points at, so a row
 * carries what you would choose on (how much is in it, how much is marked
 * done, when it was last touched) and opens what it names.
 *
 * Rows for the open board switch straight to that worklist. Rows for another
 * board say which board and cannot open it: a stored worklist records the
 * board's FILE NAME, not a path, so there is nothing here to open it from.
 * Loading that board yourself makes its worklists switchable.
 */
import { useEffect, useMemo, useState } from 'react';
import { worklistStore, type BoardWorklistes, type Worklist } from '../../store/worklist-store';
import { boardStore } from '../../store/board-store';
import { showSidebarTab } from '../../components/Sidebar.utils';
import { useWorklist } from '../../hooks/useWorklist';

/** Entries carrying any mark, over all entries. The bar is the same green as
 *  the `cleaned` mark, so progress and marks agree on their colour. */
function progress(w: Worklist): { done: number; total: number } {
  const parts = w.entries ?? [];
  const nets = w.netEntries ?? [];
  const total = parts.length + nets.length;
  const done = parts.filter(e => e.mark !== 'none').length + nets.filter(e => e.mark !== 'none').length;
  return { done, total };
}

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

export function WorklistsTool() {
  const [catalog, setCatalog] = useState<BoardWorklistes[]>([]);
  const { current } = useWorklist();

  useEffect(() => { void worklistStore.listAllStored().then(setCatalog); }, []);

  const { mine, others, total } = useMemo(() => {
    const byRecent = (a: Worklist, b: Worklist) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
    const here = catalog.find(b => b.key === current?.key);
    const rest = catalog.filter(b => b.key !== current?.key);
    return {
      mine: [...(here?.worklistes ?? [])].sort(byRecent),
      others: rest.flatMap(b => (b.worklistes ?? []).map(w => ({ board: b.fileName, w })))
        .sort((a, b) => byRecent(a.w, b.w)),
      total: catalog.reduce((n, b) => n + (b.worklistes?.length ?? 0), 0),
    };
  }, [catalog, current?.key]);

  const open = (id: string) => {
    worklistStore.setActiveWorklist(id);
    showSidebarTab('library');           // leave Tools; the board panel owns the list
    boardStore.addToast('Switched worklist — see the board panel’s Worklist tab.', 'info');
  };

  const row = (w: Worklist, board?: string) => {
    const { done, total: n } = progress(w);
    const pct = n === 0 ? 0 : Math.round((done / n) * 100);
    const counts = `${w.entries?.length ?? 0} part${(w.entries?.length ?? 0) === 1 ? '' : 's'} · ${w.netEntries?.length ?? 0} net${(w.netEntries?.length ?? 0) === 1 ? '' : 's'}`;
    return (
      <button
        key={`${board ?? 'here'}:${w.id}`}
        type="button"
        className={`wlcat-row${!board && w.id === current?.activeWorklistId ? ' cur' : ''}`}
        data-testid="worklist-catalog-row"
        onClick={() => {
          if (board) {
            boardStore.addToast(`“${w.name}” belongs to ${board}. Open that board to use it.`, 'info');
            return;
          }
          open(w.id);
        }}
        title={board ? `On ${board} — open that board to use this worklist` : `Switch to “${w.name}”`}
      >
        <span className="wlcat-body">
          <span className="wlcat-name">{w.name}</span>
          <span className="wlcat-meta">
            {board ? `${board} · ${counts}` : counts}{ago(w.updatedAt) ? ` · ${ago(w.updatedAt)}` : ''}
          </span>
        </span>
        <span className="wlcat-bar" title={n === 0 ? 'Nothing in it yet' : `${done} of ${n} marked`}>
          <i style={{ width: `${pct}%` }} />
        </span>
      </button>
    );
  };

  return (
    <div data-testid="tools-worklists">
      <div className="tools-group-label">Worklists ({total})</div>
      {total === 0 && <div className="library-empty">No worklists stored yet.</div>}

      {mine.length > 0 && <div className="tools-group-label">This board</div>}
      {mine.map(w => row(w))}

      {others.length > 0 && <div className="tools-group-label">Other boards</div>}
      {others.map(({ board, w }) => row(w, board))}
    </div>
  );
}
