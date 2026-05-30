import { useEffect, useState, useCallback } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { log } from '../store/log-store';

// ---------- Types (mirror Go shape from /api/boards/hierarchy) ----------

export interface HierarchyAlias {
  uuid: string;
  alias: string;
  alias_type?: string;
}

export interface HierarchyBoard {
  uuid: string;
  board_number: string;
  board_name?: string;
  odm?: string;
  board_number_type?: string;
  source?: string;
  source_url?: string;
  notes?: string;
  aliases?: HierarchyAlias[];
}

export interface HierarchyModel {
  uuid: string;
  model_number: string;
  display_name?: string;
  notes?: string;
  aliases?: HierarchyAlias[];
  boards?: HierarchyBoard[];
}

export interface HierarchyFamily {
  uuid: string;
  name: string;
  notes?: string;
  models?: HierarchyModel[];
}

export interface HierarchyBrand {
  uuid: string;
  name: string;
  notes?: string;
  families?: HierarchyFamily[];
}

export interface HierarchyResponse {
  available: boolean;
  brands?: HierarchyBrand[];
}

type SelKind = 'brand' | 'family' | 'model' | 'board';
interface Selection {
  kind: SelKind;
  uuid: string;
}

// ---------- Helpers ----------

function countBoardsInFamily(f: HierarchyFamily): number {
  let n = 0;
  for (const m of f.models ?? []) n += (m.boards ?? []).length;
  return n;
}

function countBoardsInBrand(b: HierarchyBrand): number {
  let n = 0;
  for (const f of b.families ?? []) n += countBoardsInFamily(f);
  return n;
}

// ---------- Panel ----------

export function DatabaseEditorPanel(_props: IDockviewPanelProps) {
  const [data, setData] = useState<HierarchyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Selection | null>(null);

  // Fetch on mount.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/boards/hierarchy')
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<HierarchyResponse>;
      })
      .then(d => {
        if (cancelled) return;
        setData(d);
        // Auto-expand all brands so the user sees the second level immediately.
        if (d.brands) {
          setExpanded(new Set(d.brands.map(b => b.uuid)));
        }
      })
      .catch(err => {
        if (cancelled) return;
        log.ui.error('[DatabaseEditor] fetch failed:', err);
        setError(String(err?.message || err));
      });
    return () => { cancelled = true; };
  }, []);

  const toggle = useCallback((uuid: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(uuid)) next.delete(uuid);
      else next.add(uuid);
      return next;
    });
  }, []);

  // Resolve selected entity by walking the tree (cheap at v2 scale, ~150 nodes).
  // React Compiler memoizes this automatically.
  const selectedEntity = (() => {
    if (!selected || !data?.brands) return null;
    for (const b of data.brands) {
      if (selected.kind === 'brand' && b.uuid === selected.uuid) return { kind: 'brand' as const, brand: b };
      for (const f of b.families ?? []) {
        if (selected.kind === 'family' && f.uuid === selected.uuid) return { kind: 'family' as const, brand: b, family: f };
        for (const m of f.models ?? []) {
          if (selected.kind === 'model' && m.uuid === selected.uuid) return { kind: 'model' as const, brand: b, family: f, model: m };
          for (const bd of m.boards ?? []) {
            if (selected.kind === 'board' && bd.uuid === selected.uuid) {
              return { kind: 'board' as const, brand: b, family: f, model: m, board: bd };
            }
          }
        }
      }
    }
    return null;
  })();

  return (
    <div style={styles.root}>
      <div style={styles.left}>
        <div style={styles.leftHeader}>Boards Database</div>
        <div style={styles.tree}>
          {error && <div style={styles.errorMsg}>Error: {error}</div>}
          {!error && !data && <div style={styles.loadingMsg}>Loading…</div>}
          {data && data.available === false && <div style={styles.loadingMsg}>Board database not available.</div>}
          {data?.available && (data.brands?.length ?? 0) === 0 && (
            <div style={styles.loadingMsg}>Database is empty.</div>
          )}
          {data?.available && data.brands?.map(brand => (
            <BrandNode
              key={brand.uuid}
              brand={brand}
              expanded={expanded}
              selected={selected}
              toggle={toggle}
              setSelected={setSelected}
            />
          ))}
        </div>
      </div>
      <div style={styles.divider} />
      <div style={styles.right}>
        {!selectedEntity && (
          <div style={styles.emptyDetail}>Select an entity on the left to inspect.</div>
        )}
        {selectedEntity && <DetailCard entity={selectedEntity} />}
      </div>
    </div>
  );
}

// ---------- Tree nodes ----------

interface NodeProps {
  expanded: Set<string>;
  selected: Selection | null;
  toggle: (uuid: string) => void;
  setSelected: (s: Selection) => void;
}

function Row({
  level, hasChildren, isOpen, isSelected, label, onToggle, onSelect, badge,
}: {
  level: number;
  hasChildren: boolean;
  isOpen: boolean;
  isSelected: boolean;
  label: React.ReactNode;
  badge?: React.ReactNode;
  onToggle: () => void;
  onSelect: () => void;
}) {
  return (
    <div
      style={{
        ...styles.row,
        paddingLeft: 8 + level * 14,
        background: isSelected ? 'var(--bg-selected, #2a3a55)' : 'transparent',
      }}
      onClick={onSelect}
    >
      <span
        style={styles.chevron}
        onClick={(e) => { e.stopPropagation(); if (hasChildren) onToggle(); }}
      >
        {hasChildren ? (isOpen ? '▾' : '▸') : ''}
      </span>
      <span style={styles.rowLabel}>{label}</span>
      {badge != null && <span style={styles.rowBadge}>{badge}</span>}
    </div>
  );
}

function BrandNode({ brand, expanded, selected, toggle, setSelected }: NodeProps & { brand: HierarchyBrand }) {
  const isOpen = expanded.has(brand.uuid);
  const families = brand.families ?? [];
  const totalBoards = countBoardsInBrand(brand);
  return (
    <div>
      <Row
        level={0}
        hasChildren={families.length > 0}
        isOpen={isOpen}
        isSelected={selected?.kind === 'brand' && selected.uuid === brand.uuid}
        label={<strong>{brand.name}</strong>}
        badge={`${families.length}f / ${totalBoards}b`}
        onToggle={() => toggle(brand.uuid)}
        onSelect={() => setSelected({ kind: 'brand', uuid: brand.uuid })}
      />
      {isOpen && families.map(f => (
        <FamilyNode key={f.uuid} family={f} expanded={expanded} selected={selected} toggle={toggle} setSelected={setSelected} />
      ))}
    </div>
  );
}

function FamilyNode({ family, expanded, selected, toggle, setSelected }: NodeProps & { family: HierarchyFamily }) {
  const isOpen = expanded.has(family.uuid);
  const models = family.models ?? [];
  const totalBoards = countBoardsInFamily(family);
  return (
    <div>
      <Row
        level={1}
        hasChildren={models.length > 0}
        isOpen={isOpen}
        isSelected={selected?.kind === 'family' && selected.uuid === family.uuid}
        label={family.name}
        badge={`${models.length}m / ${totalBoards}b`}
        onToggle={() => toggle(family.uuid)}
        onSelect={() => setSelected({ kind: 'family', uuid: family.uuid })}
      />
      {isOpen && models.map(m => (
        <ModelNode key={m.uuid} model={m} expanded={expanded} selected={selected} toggle={toggle} setSelected={setSelected} />
      ))}
    </div>
  );
}

function ModelNode({ model, expanded, selected, toggle, setSelected }: NodeProps & { model: HierarchyModel }) {
  const isOpen = expanded.has(model.uuid);
  const boards = model.boards ?? [];
  const labelText = model.display_name
    ? `${model.model_number} — ${model.display_name}`
    : model.model_number;
  return (
    <div>
      <Row
        level={2}
        hasChildren={boards.length > 0}
        isOpen={isOpen}
        isSelected={selected?.kind === 'model' && selected.uuid === model.uuid}
        label={labelText}
        badge={`${boards.length}b`}
        onToggle={() => toggle(model.uuid)}
        onSelect={() => setSelected({ kind: 'model', uuid: model.uuid })}
      />
      {isOpen && boards.map(b => (
        <BoardLeaf
          key={b.uuid}
          board={b}
          isSelected={selected?.kind === 'board' && selected.uuid === b.uuid}
          onSelect={() => setSelected({ kind: 'board', uuid: b.uuid })}
        />
      ))}
    </div>
  );
}

function BoardLeaf({ board, isSelected, onSelect }: { board: HierarchyBoard; isSelected: boolean; onSelect: () => void }) {
  const labelText = board.board_name
    ? `${board.board_number} — ${board.board_name}`
    : board.board_number;
  return (
    <Row
      level={3}
      hasChildren={false}
      isOpen={false}
      isSelected={isSelected}
      label={labelText}
      onToggle={() => { /* leaf */ }}
      onSelect={onSelect}
    />
  );
}

// ---------- Detail card ----------

type DetailEntity =
  | { kind: 'brand'; brand: HierarchyBrand }
  | { kind: 'family'; brand: HierarchyBrand; family: HierarchyFamily }
  | { kind: 'model'; brand: HierarchyBrand; family: HierarchyFamily; model: HierarchyModel }
  | { kind: 'board'; brand: HierarchyBrand; family: HierarchyFamily; model: HierarchyModel; board: HierarchyBoard };

function DetailCard({ entity }: { entity: DetailEntity }) {
  return (
    <div style={styles.detailWrap}>
      <div style={styles.detailKind}>{entity.kind.toUpperCase()}</div>
      {entity.kind === 'brand' && <BrandDetail brand={entity.brand} />}
      {entity.kind === 'family' && <FamilyDetail brand={entity.brand} family={entity.family} />}
      {entity.kind === 'model' && <ModelDetail brand={entity.brand} family={entity.family} model={entity.model} />}
      {entity.kind === 'board' && <BoardDetail brand={entity.brand} family={entity.family} model={entity.model} board={entity.board} />}
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  if (value == null || value === '') return null;
  return (
    <div style={styles.field}>
      <div style={styles.fieldLabel}>{label}</div>
      <div style={styles.fieldValue}>{value}</div>
    </div>
  );
}

function AliasList({ aliases }: { aliases: HierarchyAlias[] | undefined }) {
  if (!aliases || aliases.length === 0) return null;
  return (
    <div style={styles.field}>
      <div style={styles.fieldLabel}>Aliases ({aliases.length})</div>
      <ul style={styles.aliasList}>
        {aliases.map(a => (
          <li key={a.uuid} style={styles.aliasItem}>
            <span style={styles.aliasName}>{a.alias}</span>
            {a.alias_type && <span style={styles.aliasType}>{a.alias_type}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function BrandDetail({ brand }: { brand: HierarchyBrand }) {
  const families = brand.families ?? [];
  let boards = 0;
  for (const f of families) boards += countBoardsInFamily(f);
  return (
    <>
      <div style={styles.detailTitle}>{brand.name}</div>
      <Field label="UUID" value={<code style={styles.uuid}>{brand.uuid}</code>} />
      <Field label="Notes" value={brand.notes} />
      <Field label="Families" value={families.length} />
      <Field label="Boards" value={boards} />
    </>
  );
}

function FamilyDetail({ brand, family }: { brand: HierarchyBrand; family: HierarchyFamily }) {
  const models = family.models ?? [];
  const boards = countBoardsInFamily(family);
  return (
    <>
      <div style={styles.detailTitle}>{family.name}</div>
      <div style={styles.detailCrumb}>{brand.name}</div>
      <Field label="UUID" value={<code style={styles.uuid}>{family.uuid}</code>} />
      <Field label="Notes" value={family.notes} />
      <Field label="Models" value={models.length} />
      <Field label="Boards" value={boards} />
    </>
  );
}

function ModelDetail({ brand, family, model }: { brand: HierarchyBrand; family: HierarchyFamily; model: HierarchyModel }) {
  const boards = model.boards ?? [];
  return (
    <>
      <div style={styles.detailTitle}>{model.model_number}</div>
      <div style={styles.detailCrumb}>{brand.name} › {family.name}</div>
      {model.display_name && <Field label="Display Name" value={model.display_name} />}
      <Field label="UUID" value={<code style={styles.uuid}>{model.uuid}</code>} />
      <Field label="Notes" value={model.notes} />
      <Field label="Boards" value={boards.length} />
      <AliasList aliases={model.aliases} />
    </>
  );
}

function BoardDetail({ brand, family, model, board }: { brand: HierarchyBrand; family: HierarchyFamily; model: HierarchyModel; board: HierarchyBoard }) {
  return (
    <>
      <div style={styles.detailTitle}>{board.board_number}</div>
      <div style={styles.detailCrumb}>{brand.name} › {family.name} › {model.model_number}</div>
      <Field label="UUID" value={<code style={styles.uuid}>{board.uuid}</code>} />
      <Field label="Board Name" value={board.board_name} />
      <Field label="ODM" value={board.odm} />
      <Field label="Number Type" value={board.board_number_type} />
      <Field label="Source" value={board.source} />
      <Field
        label="Source URL"
        value={board.source_url
          ? <a href={board.source_url} target="_blank" rel="noreferrer">{board.source_url}</a>
          : null}
      />
      <Field label="Notes" value={board.notes} />
      <AliasList aliases={board.aliases} />
    </>
  );
}

// ---------- Inline styles ----------
// Kept inline to avoid CSS infrastructure for a first-slice prototype. We can
// migrate to index.css classes once the layout settles.

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex',
    flexDirection: 'row',
    width: '100%',
    height: '100%',
    background: 'var(--bg-primary)',
    color: 'var(--text-primary)',
    fontSize: 13,
    overflow: 'hidden',
  },
  left: {
    display: 'flex',
    flexDirection: 'column',
    flex: '0 0 45%',
    minWidth: 220,
    overflow: 'hidden',
  },
  divider: {
    width: 1,
    background: 'var(--border)',
    flex: '0 0 1px',
  },
  right: {
    flex: 1,
    overflow: 'auto',
    padding: 16,
  },
  leftHeader: {
    padding: '8px 12px',
    fontWeight: 600,
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    color: 'var(--text-secondary)',
    borderBottom: '1px solid var(--border)',
  },
  tree: {
    flex: 1,
    overflow: 'auto',
    paddingBottom: 16,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '3px 8px',
    cursor: 'pointer',
    userSelect: 'none',
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
  },
  chevron: {
    display: 'inline-block',
    width: 14,
    textAlign: 'center',
    color: 'var(--text-secondary)',
    fontSize: 11,
    flexShrink: 0,
  },
  rowLabel: {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  rowBadge: {
    fontSize: 11,
    color: 'var(--text-secondary)',
    paddingLeft: 8,
    flexShrink: 0,
  },
  errorMsg: {
    padding: 16,
    color: '#e55',
  },
  loadingMsg: {
    padding: 16,
    color: 'var(--text-secondary)',
  },
  emptyDetail: {
    width: '100%',
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--text-secondary)',
    fontStyle: 'italic',
  },
  detailWrap: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    maxWidth: 720,
  },
  detailKind: {
    fontSize: 10,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    color: 'var(--text-secondary)',
  },
  detailTitle: {
    fontSize: 18,
    fontWeight: 700,
  },
  detailCrumb: {
    fontSize: 12,
    color: 'var(--text-secondary)',
    marginBottom: 8,
  },
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    padding: '4px 0',
  },
  fieldLabel: {
    fontSize: 10,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    color: 'var(--text-secondary)',
  },
  fieldValue: {
    fontSize: 13,
    wordBreak: 'break-word',
  },
  uuid: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 11,
    color: 'var(--text-secondary)',
  },
  aliasList: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  aliasItem: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 8,
    fontSize: 12,
  },
  aliasName: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  },
  aliasType: {
    fontSize: 10,
    color: 'var(--text-secondary)',
    background: 'var(--bg-secondary, rgba(255,255,255,0.05))',
    padding: '0 4px',
    borderRadius: 2,
  },
};
