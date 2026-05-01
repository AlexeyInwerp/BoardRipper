import { useEffect } from 'react';
import { useObdForBoard, type ObdData } from '../store/obd-store';

/**
 * Compact OBD card for the Library file detail pane: variant chips,
 * board-level summary, and a link to the full upstream page. The big
 * measurement table that used to live here is gone — the data lives
 * in the BoardSidebar's Info tab now (where the user is actually
 * inspecting the board), so duplicating 1300 net rows in the file
 * listing was just visual noise.
 */
export function ObdSection({ boardNumber }: { boardNumber: string }) {
  const obd = useObdForBoard(boardNumber);

  useEffect(() => {
    if (boardNumber) obd.loadMatches();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardNumber]);

  if (!obd.indexSynced && (obd.matches === null || obd.matches.length === 0)) {
    return null;
  }
  if (obd.matches === null || obd.matches.length === 0) return null;

  const stale = (() => {
    if (!obd.indexSyncedAt) return false;
    const age = Date.now() - new Date(obd.indexSyncedAt).getTime();
    return age > 30 * 24 * 60 * 60 * 1000;
  })();

  // First fetched variant feeds the summary line. Picking arbitrary one is
  // fine — variants on the same board share the header comment.
  const firstFetched = obd.matches
    .map(m => ({ match: m, data: obd.dataByBpath.get(m.bpath) }))
    .find(x => x.data) as { match: typeof obd.matches[0]; data: ObdData } | undefined;

  return (
    <div className="library-detail-section" data-testid="obd-section">
      <div className="library-detail-section-header">
        <strong>OpenBoardData</strong>
        {stale && (
          <span
            data-testid="obd-stale-warning"
            style={{ marginLeft: 8, fontSize: 10, color: '#c80', padding: '0 4px', border: '1px solid #c80', borderRadius: 6 }}
          >
            index may be stale — re-sync in Settings
          </span>
        )}
      </div>

      {firstFetched?.data.header.comment && (
        <div
          style={{ fontSize: 11, color: '#aaa', fontStyle: 'italic', margin: '2px 0 4px' }}
          data-testid="obd-header-comment"
        >
          {firstFetched.data.header.comment}
        </div>
      )}

      {firstFetched && (
        <div style={{ fontSize: 11, color: '#aaa', margin: '2px 0 6px' }} data-testid="obd-summary">
          {firstFetched.data.nets.length} nets · {firstFetched.data.components.length} components
          {firstFetched.data.sections && firstFetched.data.sections.length > 0
            ? ` · ${firstFetched.data.sections.length} repair section${firstFetched.data.sections.length === 1 ? '' : 's'}`
            : null}
          {' — '}
          full data is shown in the BoardViewer's <em>Info</em> sidebar; this card just lists what's available.
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '4px 0 4px', alignItems: 'center' }}>
        {obd.matches.map(m => {
          const isFetched = m.fetched || obd.dataByBpath.has(m.bpath);
          const isFetching = obd.fetching.has(m.bpath);
          const leaf = m.bpath.slice(m.bpath.lastIndexOf('/') + 1);
          const upstreamUrl = `https://openboarddata.org/?a=showboardsolutions&bpath=${encodeURIComponent(m.bpath)}`;
          return (
            <span key={m.bpath} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <button
                data-testid={`obd-chip-${leaf}`}
                data-fetched={isFetched ? 'true' : 'false'}
                onClick={() => obd.fetchBoard(m.bpath)}
                disabled={isFetching}
                style={{
                  padding: '2px 8px',
                  borderRadius: 12,
                  border: '1px solid #888',
                  background: isFetched ? '#3a5' : 'transparent',
                  color: isFetched ? '#fff' : 'inherit',
                  fontSize: 11,
                  cursor: isFetching ? 'wait' : 'pointer',
                }}
                title={isFetched ? 'Click to update' : 'Click to fetch'}
              >
                {leaf} {isFetching ? '…' : isFetched ? '↻' : '↓'}
              </button>
              <a
                href={upstreamUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: 10, color: '#888', textDecoration: 'none' }}
                title={`Open ${m.bpath} on openboarddata.org`}
                data-testid={`obd-upstream-${leaf}`}
              >
                ↗
              </a>
            </span>
          );
        })}
      </div>
    </div>
  );
}
