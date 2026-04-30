import { useEffect, useMemo, useState } from 'react';
import { useObdForBoard, type ObdData, type ObdNet } from '../store/obd-store';

export function ObdSection({ boardNumber }: { boardNumber: string }) {
  const obd = useObdForBoard(boardNumber);

  useEffect(() => {
    if (boardNumber) obd.loadMatches();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardNumber]);

  if (!obd.indexSynced && (obd.matches === null || obd.matches.length === 0)) {
    // Probe state — until the user syncs in Settings, we render nothing.
    return null;
  }
  if (obd.matches === null) return null; // still loading
  if (obd.matches.length === 0) return null;

  const fetchedDataPerVariant = obd.matches
    .map(m => ({ match: m, data: obd.dataByBpath.get(m.bpath) ?? null }))
    .filter(x => x.data !== null) as Array<{ match: typeof obd.matches[0]; data: ObdData }>;

  // Soft stale warning: if the index is older than 30 days, surface a chip.
  const stale = (() => {
    if (!obd.indexSyncedAt) return false;
    const age = Date.now() - new Date(obd.indexSyncedAt).getTime();
    return age > 30 * 24 * 60 * 60 * 1000;
  })();

  return (
    <div className="library-detail-section" data-testid="obd-section">
      <div className="library-detail-section-header">
        <strong>OpenBoardData</strong>
        {stale && (
          <span data-testid="obd-stale-warning" style={{ marginLeft: 8, fontSize: 10, color: '#c80', padding: '0 4px', border: '1px solid #c80', borderRadius: 6 }}>
            index may be stale — re-sync in Settings
          </span>
        )}
      </div>

      {/* Board-level comment from OBDATA_V002 header — surfaced visibly below
          the section header so the user sees it without any hover interaction. */}
      {fetchedDataPerVariant.length > 0 && fetchedDataPerVariant[0].data.header.comment && (
        <div
          style={{ fontSize: 11, color: '#aaa', fontStyle: 'italic', margin: '2px 0 4px' }}
          data-testid="obd-header-comment"
        >
          {fetchedDataPerVariant[0].data.header.comment}
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '4px 0 8px', alignItems: 'center' }}>
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
      {fetchedDataPerVariant.length > 0 && (
        <ObdMeasurementTable variants={fetchedDataPerVariant} />
      )}
    </div>
  );
}

function ObdMeasurementTable({ variants }: {
  variants: Array<{ match: { bpath: string }; data: ObdData }>;
}) {
  const [search, setSearch] = useState('');

  // Build a merged net map: net name → (variantBpath → ObdNet).
  const merged = useMemo(() => {
    const map = new Map<string, Map<string, ObdNet>>();
    for (const v of variants) {
      for (const net of v.data.nets) {
        if (!map.has(net.name)) map.set(net.name, new Map());
        map.get(net.name)!.set(v.match.bpath, net);
      }
    }
    return map;
  }, [variants]);

  const filteredNets = useMemo(() => {
    const q = search.toLowerCase();
    return Array.from(merged.entries())
      .filter(([name]) => !q || name.toLowerCase().includes(q))
      .sort((a, b) => a[0].localeCompare(b[0]));
  }, [merged, search]);

  // Diagnosis: union of all variants' diagnosis text (header per variant).
  const [diagnosisOpen, setDiagnosisOpen] = useState(false);
  const hasDiagnosis = variants.some(v => v.data.diagnosis.trim());

  return (
    <>
      {hasDiagnosis && (
        <div style={{ margin: '4px 0' }}>
          <button onClick={() => setDiagnosisOpen(o => !o)} style={{ fontSize: 11 }}>
            {diagnosisOpen ? '▾' : '▸'} Diagnostic notes
          </button>
          {diagnosisOpen && (
            <div style={{ fontSize: 11, padding: 6, background: '#222', whiteSpace: 'pre-wrap' }}>
              {variants.map(v => v.data.diagnosis.trim() && (
                <div key={v.match.bpath} style={{ marginBottom: 6 }}>
                  <strong>{v.match.bpath.slice(v.match.bpath.lastIndexOf('/') + 1)}:</strong>
                  {'\n'}{v.data.diagnosis}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <input
        type="search"
        placeholder="Filter nets…"
        value={search}
        onChange={e => setSearch(e.target.value)}
        style={{ width: '100%', marginBottom: 4, fontSize: 11 }}
        data-testid="obd-search"
      />

      <div style={{ maxHeight: 300, overflow: 'auto' }}>
        <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }} data-testid="obd-table">
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Net</th>
              {variants.map(v => (
                <th key={v.match.bpath} style={{ textAlign: 'left' }}>
                  {v.match.bpath.slice(v.match.bpath.lastIndexOf('/') + 1)}
                  <div style={{ fontSize: 9, color: '#888' }}>d / V / Ω</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filteredNets.map(([name, byBpath]) => (
              <tr key={name}>
                {/* Net name column: shows per-net comments inline below the name
                    (from OBDATA_V002 `t` rows, e.g. "measure with PMIC enabled").
                    Comments are collected from all variants for this net and
                    de-duplicated so the user sees them without any hover needed. */}
                <td>
                  {name}
                  {(() => {
                    const allComments = new Set<string>();
                    for (const [, n] of byBpath) {
                      n.comments.forEach(c => c.trim() && allComments.add(c.trim()));
                    }
                    if (allComments.size === 0) return null;
                    return (
                      <div
                        style={{ fontSize: 9, color: '#999', fontStyle: 'italic' }}
                        data-testid="obd-net-comment"
                      >
                        {Array.from(allComments).join(' · ')}
                      </div>
                    );
                  })()}
                </td>
                {variants.map(v => {
                  const n = byBpath.get(v.match.bpath);
                  if (!n) return <td key={v.match.bpath}>—</td>;
                  return (
                    <td key={v.match.bpath}>
                      {n.diode ?? '—'} / {n.voltage ?? '—'} / {n.resistance ?? '—'}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
