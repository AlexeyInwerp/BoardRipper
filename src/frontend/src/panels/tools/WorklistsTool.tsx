import { useEffect, useState } from 'react';
import { worklistStore, type BoardWorklistes } from '../../store/worklist-store';

export function WorklistsTool() {
  const [catalog, setCatalog] = useState<BoardWorklistes[]>([]);

  useEffect(() => {
    worklistStore.listAllStored().then(setCatalog);
  }, []);

  const total = catalog.reduce((n, b) => n + (b.worklistes?.length ?? 0), 0);

  return (
    <div className="library-worklist-catalog" data-testid="tools-worklists">
      <div className="tools-group-label">Worklists ({total})</div>
      <div className="library-empty" style={{ fontSize: 11 }}>
        Every worklist stored on this device. A shared knowledge database is coming.
      </div>
      {catalog.flatMap(b =>
        (b.worklistes ?? []).map(w => (
          <div key={`${b.key}:${w.id}`} className="library-worklist-row" data-testid="worklist-catalog-row">
            <span className="library-worklist-name" title={w.name}>{w.name}</span>
            <span className="library-worklist-board" title={b.fileName}>{b.fileName}</span>
            <span className="library-worklist-counts">
              {w.entries?.length ?? 0}p · {w.netEntries?.length ?? 0}n
            </span>
          </div>
        )),
      )}
      {total === 0 && <div className="library-empty">No worklists stored yet.</div>}
    </div>
  );
}
