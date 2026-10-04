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

  const d = firstFetched?.data;
  const counts = d
    ? [
        `${d.nets.length} nets`,
        `${d.components.length} components`,
        d.sections && d.sections.length > 0 ? `${d.sections.length} repair section${d.sections.length === 1 ? '' : 's'}` : '',
      ].filter(Boolean).join(' · ')
    : 'not fetched yet — click the board number';

  // Two lines: what is there, and where to get it. The readings and notes
  // themselves live in the board sidebar's Info tab.
  return (
    <div className="library-detail-section obd-card" data-testid="obd-section">
      <div className="obd-card-line">
        <span className="obd-card-label">OpenBoardData</span>
        {obd.matches.map(m => {
          const isFetched = m.fetched || obd.dataByBpath.has(m.bpath);
          const isFetching = obd.fetching.has(m.bpath);
          const leaf = m.bpath.slice(m.bpath.lastIndexOf('/') + 1);
          const upstreamUrl = `https://openboarddata.org/?a=showboardsolutions&bpath=${encodeURIComponent(m.bpath)}`;
          return (
            <span key={m.bpath} className="obd-card-variant">
              <button
                data-testid={`obd-chip-${leaf}`}
                data-fetched={isFetched ? 'true' : 'false'}
                className={`obd-card-chip ${isFetched ? 'fetched' : ''}`}
                onClick={() => obd.fetchBoard(m.bpath)}
                disabled={isFetching}
                title={isFetched ? 'Update from openboarddata.org' : 'Fetch from openboarddata.org'}
              >
                <span translate="no">{leaf}</span>
                <span>{isFetching ? ' …' : isFetched ? ' ↻' : ' ↓'}</span>
              </button>
              <a
                href={upstreamUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="obd-card-upstream"
                title={`Open ${m.bpath} on openboarddata.org`}
                data-testid={`obd-upstream-${leaf}`}
              >
                ↗
              </a>
            </span>
          );
        })}
        {stale && (
          <span className="obd-card-stale" data-testid="obd-stale-warning" title="The OpenBoardData index is over 30 days old — re-sync it in Settings ▸ Library">
            stale
          </span>
        )}
      </div>
      <div
        className="obd-card-counts"
        data-testid="obd-summary"
        title={`${d?.header.comment ? `${d.header.comment}\n\n` : ''}Readings and repair notes are shown in the board's Info tab when it is open.`}
      >
        {counts}
      </div>
    </div>
  );
}
