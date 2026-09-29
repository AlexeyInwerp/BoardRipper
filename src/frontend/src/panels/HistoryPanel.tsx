/**
 * History — the rail destination for the navigation timeline.
 *
 * One list across every open board and PDF, newest at the top, with the four
 * layer chips (clicks · PDF lookups · searches · viewpoints) as filters over
 * what is listed and where ⌘[ / ⌘] stop. The cursor row is "you are here";
 * rows above it are forward, rows below it are back. Clicking a row jumps to
 * it (the cursor moves, nothing is appended). Rows whose file is closed stay,
 * greyed, and are skipped by the shortcuts.
 *
 * Status and content follow the 2026-09-22 rules: the chips and the confirm
 * strip live above the list so it never jumps; the content area carries a
 * message only while there is nothing to list.
 *
 * Design: docs/specs/2026-09-29-navigation-history-design.md §8.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  IconPointer, IconArrowsExchange, IconSearch, IconEye, IconHistory, IconArrowBackUp, IconFileTypePdf, IconCpu,
} from '@tabler/icons-react';
import { useNavHistory } from '../hooks/useNavHistory';
import { useBoardStore } from '../hooks/useBoardStore';
import { navHistoryStore } from '../store/nav-history-store';
import { historyJumpTo, entryReachable } from '../store/nav-history-actions';
import { NAV_CAUSES, type NavCause, type NavEntry } from '../store/nav-history';
import { formatShortcut } from '../store/keyboard-shortcuts';

const LAYER_LABELS: Record<NavCause, string> = {
  click: 'Clicks',
  lookup: 'PDF lookups',
  search: 'Searches',
  view: 'Viewpoints',
};

const LAYER_HINTS: Record<NavCause, string> = {
  click: 'Parts, pins and nets picked on the board',
  lookup: 'Jumps between a board and a PDF, or PDF to PDF',
  search: 'Queries typed in a search field, with the result picked',
  view: 'Regions and pages looked at with no selection (recorded only while on)',
};

function CauseGlyph({ cause }: { cause: NavCause }) {
  switch (cause) {
    case 'click':  return <IconPointer size={14} stroke={1.8} />;
    case 'lookup': return <IconArrowsExchange size={14} stroke={1.8} />;
    case 'search': return <IconSearch size={14} stroke={1.8} />;
    case 'view':   return <IconEye size={14} stroke={1.8} />;
  }
}

export function ago(at: number, now: number): string {
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 5) return 'now';
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'yesterday' : `${d} d`;
}

/** The file an entry belongs to, for grouping and the "closed" note. */
function fileOf(e: NavEntry): string | null {
  if (!e.place) return null;
  return e.place.fileName;
}

function secondary(e: NavEntry): string {
  const bits: string[] = [];
  if (e.revisit) bits.push('returned');
  if (e.from) bits.push(`from ${e.from}`);
  if (e.query) {
    if (e.query.results != null) bits.push(`${e.query.results} result${e.query.results === 1 ? '' : 's'}`);
    bits.push({ board: 'Board search', global: 'Global search', pdf: 'PDF find', 'ribbon-parts': 'Find part', 'ribbon-nets': 'Find net' }[e.query.surface]);
  }
  if (e.follow) bits.push(`→ ${e.follow.fileName} p.${e.follow.page}`);
  if (e.via === 'mcp') bits.push('by agent');
  return bits.join(' · ');
}

export function HistoryPanel() {
  const { listed, currentId, layers, entries } = useNavHistory();
  const { activeTabId, tabs } = useBoardStore();
  const [scope, setScope] = useState<'all' | 'board'>('all');
  /** Boards / PDFs — a list filter only; ⌘[ / ⌘] still walk both. */
  const [kind, setKind] = useState<'all' | 'boards' | 'pdfs'>('all');
  const [confirmClear, setConfirmClear] = useState(false);
  const [, tick] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const now = Date.now();

  // Relative times re-render twice a minute while the panel has rows.
  useEffect(() => {
    if (listed.length === 0) return;
    const t = setInterval(() => tick(n => n + 1), 30_000);
    return () => clearInterval(t);
  }, [listed.length]);

  const activeTab = tabs.find(t => t.id === activeTabId) ?? null;
  const activeFiles = useMemo(() => {
    const set = new Set<string>();
    if (activeTab) { set.add(activeTab.fileName); for (const p of activeTab.pdfFileNames) set.add(p); }
    return set;
  }, [activeTab]);

  const rows = useMemo(() => {
    let out = listed;
    if (kind !== 'all') {
      out = out.filter(e => {
        const isPdf = e.place ? e.place.kind === 'pdf' : e.query?.surface === 'pdf';
        return kind === 'pdfs' ? isPdf : !isPdf;
      });
    }
    if (scope === 'board') out = out.filter(e => { const f = fileOf(e); return f == null || activeFiles.has(f); });
    return out;
  }, [listed, scope, kind, activeFiles]);

  // Keep the cursor row in view when it moves.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-current="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [currentId]);

  const counts = useMemo(() => {
    const c: Record<NavCause, number> = { click: 0, lookup: 0, search: 0, view: 0 };
    for (const e of entries) c[e.cause]++;
    return c;
  }, [entries]);

  const cursorIndex = currentId == null ? -1 : entries.findIndex(e => e.id === currentId);
  const allOff = NAV_CAUSES.every(c => !layers[c]);

  const onRowKey = (e: React.KeyboardEvent<HTMLDivElement>, id: number) => {
    if (e.key === 'Enter') { e.preventDefault(); historyJumpTo(id); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); navHistoryStore.remove(id); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const sib = e.key === 'ArrowDown' ? e.currentTarget.nextElementSibling : e.currentTarget.previousElementSibling;
      (sib as HTMLElement | null)?.focus();
    }
  };

  let lastFile: string | null | undefined;

  return (
    <div className="hist-panel" data-testid="history-panel">
      <div className="hist-strip">
        <div className="hist-layers" role="group" aria-label="History layers">
          {NAV_CAUSES.map(c => (
            <button
              key={c}
              type="button"
              className={`hist-chip${layers[c] ? ' on' : ''}`}
              data-history-layer={c}
              aria-pressed={layers[c]}
              title={LAYER_HINTS[c]}
              onClick={() => navHistoryStore.setLayer(c, !layers[c])}
            >
              <CauseGlyph cause={c} />
              <span>{LAYER_LABELS[c]}</span>
              {counts[c] > 0 && <span className="hist-chip-n">{counts[c]}</span>}
            </button>
          ))}
        </div>
        <div className="hist-scope-row">
          <div className="hist-scope" role="group" aria-label="Scope">
            <button type="button" className={`hist-scope-btn${scope === 'all' ? ' on' : ''}`} aria-pressed={scope === 'all'} onClick={() => setScope('all')} data-testid="history-scope-all">Everything</button>
            <button type="button" className={`hist-scope-btn${scope === 'board' ? ' on' : ''}`} aria-pressed={scope === 'board'} onClick={() => setScope('board')} disabled={!activeTab} data-testid="history-scope-board" title={activeTab ? `${activeTab.fileName} and its PDFs` : 'No board open'}>This board</button>
          </div>
          <div className="hist-scope" role="group" aria-label="Kind" title="Lists boards, PDFs or both — the shortcuts still walk both">
            <button type="button" className={`hist-scope-btn${kind === 'all' ? ' on' : ''}`} aria-pressed={kind === 'all'} onClick={() => setKind('all')} data-testid="history-kind-all">All</button>
            <button type="button" className={`hist-scope-btn${kind === 'boards' ? ' on' : ''}`} aria-pressed={kind === 'boards'} onClick={() => setKind('boards')} data-testid="history-kind-boards"><IconCpu size={11} stroke={2} /> Boards</button>
            <button type="button" className={`hist-scope-btn${kind === 'pdfs' ? ' on' : ''}`} aria-pressed={kind === 'pdfs'} onClick={() => setKind('pdfs')} data-testid="history-kind-pdfs"><IconFileTypePdf size={11} stroke={2} /> PDFs</button>
          </div>
        </div>
        {confirmClear && (
          <div className="wl-confirm" data-testid="history-confirm" role="alertdialog">
            <span className="q">Clear the whole history?</span>
            <button type="button" onClick={() => setConfirmClear(false)} data-testid="history-confirm-no">Cancel</button>
            <button type="button" className="go" onClick={() => { navHistoryStore.clear(); setConfirmClear(false); }} data-testid="history-confirm-yes">Clear</button>
          </div>
        )}
      </div>

      <div className="hist-list" ref={listRef} data-testid="history-list">
        {entries.length === 0 ? (
          <div className="panel-empty hist-empty">
            <IconHistory size={28} stroke={1.4} />
            <div>Nothing visited yet.</div>
            <small>Click a part, search, or look something up — then {formatShortcut('historyBack')} / {formatShortcut('historyForward')} walk back and forward through it.</small>
          </div>
        ) : allOff ? (
          <div className="panel-empty hist-empty"><div>Every layer is switched off.</div><small>Switch one on above to list it.</small></div>
        ) : rows.length === 0 ? (
          <div className="panel-empty hist-empty"><div>{kind === 'pdfs' ? 'No PDF visits yet.' : kind === 'boards' ? 'No board visits yet.' : 'Nothing on this board yet.'}</div></div>
        ) : rows.map(e => {
          const file = fileOf(e);
          const header = scope === 'all' && file !== lastFile ? file : null;
          lastFile = file;
          const idx = entries.indexOf(e);
          const isCurrent = e.id === currentId;
          const reachable = entryReachable(e);
          const dir = idx > cursorIndex ? 'forward' : idx < cursorIndex ? 'back' : 'here';
          return (
            <div key={e.id}>
              {header !== null && (
                <div className="hist-group">
                  {header?.toLowerCase().endsWith('.pdf') ? <IconFileTypePdf size={12} stroke={1.8} /> : <IconCpu size={12} stroke={1.8} />}
                  <span>{header ?? 'Searches'}</span>
                </div>
              )}
              <div
                className={`hist-row${isCurrent ? ' current' : ''}${reachable ? '' : ' closed'} ${dir}`}
                data-testid="history-row"
                data-history-id={e.id}
                data-current={isCurrent ? 'true' : undefined}
                data-cause={e.cause}
                role="button"
                tabIndex={0}
                title={reachable ? (isCurrent ? 'You are here' : `Jump here · ${e.label}`) : (e.place?.fileId != null ? `${file} is closed · click to open it from the library` : `${file} is closed`)}
                onClick={() => { if (!isCurrent || !reachable) historyJumpTo(e.id); }}
                onKeyDown={ev => onRowKey(ev, e.id)}
              >
                <span className={`hist-glyph hist-glyph-${e.cause}`}>{e.revisit ? <IconArrowBackUp size={14} stroke={1.8} /> : <CauseGlyph cause={e.cause} />}</span>
                <span className="hist-main">
                  <span className="hist-label">{e.label || (file ?? '')}</span>
                  {secondary(e) && <span className="hist-sub">{secondary(e)}</span>}
                </span>
                <span className="hist-time" title={new Date(e.at).toLocaleString()}>{ago(e.at, now)}</span>
              </div>
            </div>
          );
        })}
      </div>

      {entries.length > 0 && (
        <div className="hist-foot">
          <span className="hist-foot-n">{entries.length} visit{entries.length === 1 ? '' : 's'}{cursorIndex >= 0 ? ` · at ${cursorIndex + 1}` : ''}</span>
          <button type="button" className="hist-foot-btn" onClick={() => setConfirmClear(true)} data-testid="history-clear">Clear</button>
        </div>
      )}
    </div>
  );
}
