import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { log } from '../store/log-store';
import {
  contribdbStore,
  useContribDBPendingForField,
  type SubmissionRow,
} from '../store/contribdb-store';
import { useBoardStore } from '../hooks/useBoardStore';

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

// ---------- Contribution allowlist ----------

/** Field allowlist — must mirror the server-side allowlist in contribdb. Any
 *  field NOT in this map stays read-only in the detail pane. */
export const WRITABLE_FIELDS: Record<TargetType, readonly string[]> = {
  board:  ['odm', 'board_name', 'notes', 'source', 'source_url'],
  model:  ['display_name', 'notes'],
  family: ['name', 'notes'],
  brand:  ['notes'],
};

type TargetType = 'board' | 'model' | 'family' | 'brand';

function isWritable(t: TargetType, field: string): boolean {
  return WRITABLE_FIELDS[t].includes(field);
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

function fmtRelative(iso?: string): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diff = Math.max(0, Date.now() - t);
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

// ---------- Panel ----------

export function DatabaseEditorPanel(_props: IDockviewPanelProps) {
  const [data, setData] = useState<HierarchyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Selection | null>(null);

  // Reference-counted contribdb polling — Settings panel and Editor each hold
  // one slot. The store dedupes the timer; this only matters for the start /
  // stop balance.
  useEffect(() => {
    contribdbStore.startPolling(30_000);
    void contribdbStore.refreshUserToken();
    return () => { contribdbStore.stopPolling(); };
  }, []);

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
  const selectedEntity = useMemo(() => {
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
  }, [selected, data]);

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
      <EditableOrField
        label="Notes" targetType="brand" targetUuid={brand.uuid}
        field="notes" value={brand.notes}
      />
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
      <EditableOrField
        label="Name" targetType="family" targetUuid={family.uuid}
        field="name" value={family.name}
      />
      <EditableOrField
        label="Notes" targetType="family" targetUuid={family.uuid}
        field="notes" value={family.notes}
      />
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
      <EditableOrField
        label="Display Name" targetType="model" targetUuid={model.uuid}
        field="display_name" value={model.display_name}
      />
      <Field label="UUID" value={<code style={styles.uuid}>{model.uuid}</code>} />
      <EditableOrField
        label="Notes" targetType="model" targetUuid={model.uuid}
        field="notes" value={model.notes}
      />
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
      <EditableOrField
        label="Board Name" targetType="board" targetUuid={board.uuid}
        field="board_name" value={board.board_name}
      />
      <EditableOrField
        label="ODM" targetType="board" targetUuid={board.uuid}
        field="odm" value={board.odm}
      />
      <Field label="Number Type" value={board.board_number_type} />
      <EditableOrField
        label="Source" targetType="board" targetUuid={board.uuid}
        field="source" value={board.source}
      />
      <EditableOrField
        label="Source URL" targetType="board" targetUuid={board.uuid}
        field="source_url"
        value={board.source_url}
        renderValue={(v) => v
          ? <a href={v} target="_blank" rel="noreferrer">{v}</a>
          : null}
      />
      <EditableOrField
        label="Notes" targetType="board" targetUuid={board.uuid}
        field="notes" value={board.notes}
        multiline
      />
      <AliasList aliases={board.aliases} />
    </>
  );
}

// ---------- Editable field ----------

interface EditableFieldProps {
  label: string;
  targetType: TargetType;
  targetUuid: string;
  field: string;
  value: string | undefined;
  /** Optional custom renderer for the read-mode value (e.g. anchor for URLs). */
  renderValue?: (v: string) => React.ReactNode;
  /** Use textarea instead of input. */
  multiline?: boolean;
}

/** Renders Field (read-only) for non-writable fields, EditableField for writable. */
function EditableOrField(props: EditableFieldProps) {
  if (!isWritable(props.targetType, props.field)) {
    const display = props.renderValue && props.value ? props.renderValue(props.value) : props.value;
    return <Field label={props.label} value={display} />;
  }
  return <EditableField {...props} />;
}

function EditableField({ label, targetType, targetUuid, field, value, renderValue, multiline }: EditableFieldProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>(value ?? '');
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const pending = useContribDBPendingForField(targetType, targetUuid, field);

  // Resync draft when the underlying value changes (e.g. hierarchy reload).
  useEffect(() => { setDraft(value ?? ''); }, [value]);

  const startEdit = () => { setDraft(value ?? ''); setEditing(true); };
  const cancelEdit = () => { setEditing(false); setDraft(value ?? ''); };

  const tryOpenEvidence = () => {
    if (draft === (value ?? '')) {
      // No change — bail.
      setEditing(false);
      return;
    }
    setEvidenceOpen(true);
  };

  const onSubmitted = () => {
    setEvidenceOpen(false);
    setEditing(false);
  };

  return (
    <div style={styles.field}>
      <div style={styles.fieldLabel}>
        {label}
        {pending && (
          <PendingBadge pending={pending} />
        )}
      </div>
      {!editing && (
        <div
          style={{ ...styles.fieldValue, ...styles.editableValue }}
          onClick={startEdit}
          title="Click to edit"
        >
          {(value && renderValue) ? renderValue(value) : (value || <span style={styles.emptyValue}>(empty)</span>)}
          <span style={styles.editHint}> ✎</span>
        </div>
      )}
      {editing && (
        <div style={styles.editorRow}>
          {multiline ? (
            <textarea
              autoFocus
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); tryOpenEvidence(); }
                else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
              }}
              style={styles.editorTextarea}
              rows={4}
            />
          ) : (
            <input
              type="text"
              autoFocus
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); tryOpenEvidence(); }
                else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
              }}
              style={styles.editorInput}
            />
          )}
          <div style={styles.editorButtons}>
            <button onClick={tryOpenEvidence} disabled={draft === (value ?? '')}>Submit…</button>
            <button onClick={cancelEdit}>Cancel</button>
          </div>
          <div style={styles.editorHint}>
            {multiline ? '⌘/Ctrl+Enter to submit · Esc to cancel' : 'Enter to submit · Esc to cancel'}
          </div>
        </div>
      )}
      {evidenceOpen && (
        <EvidenceDialog
          label={label}
          targetType={targetType}
          targetUuid={targetUuid}
          field={field}
          valueFrom={value ?? ''}
          valueTo={draft}
          onClose={() => setEvidenceOpen(false)}
          onSubmitted={onSubmitted}
        />
      )}
    </div>
  );
}

// ---------- Pending badge ----------

function PendingBadge({ pending }: { pending: SubmissionRow }) {
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFired = useRef(false);

  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (longPressFired.current) {
      longPressFired.current = false;
      return;
    }
    setTooltipOpen(o => !o);
  };

  const onPointerDown = () => {
    longPressFired.current = false;
    longPressTimer.current = setTimeout(() => {
      longPressFired.current = true;
      void confirmWithdraw();
    }, 700);
  };

  const cancelLongPress = () => {
    if (longPressTimer.current != null) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    void confirmWithdraw();
  };

  // Withdraw is a no-op here because the backend handler isn't part of the
  // wire surface we were given. We surface a toast-ish hint and log so the
  // user understands why nothing happened; if/when the backend exposes a
  // DELETE endpoint, wire it here.
  const confirmWithdraw = async () => {
    const ok = typeof window !== 'undefined'
      ? window.confirm('Withdraw this submission?')
      : false;
    if (!ok) return;
    log.contribdb.warn('withdraw requested but no DELETE endpoint available', pending.local_uuid);
    if (typeof window !== 'undefined') {
      window.alert('Withdraw is not yet supported by the backend. The submission stays in the outbox until reviewed.');
    }
  };

  const labelByStatus = {
    pending_send: 'Pending (queued)',
    submitted:    'Pending review',
    failed:       'Failed',
    accepted:     'Accepted',
    rejected:     'Rejected',
    withdrawn:    'Withdrawn',
    superseded:   'Superseded',
  } as const;
  const text = labelByStatus[pending.status] ?? pending.status;
  const color = pending.status === 'failed' ? '#c33' : '#c80';

  return (
    <span style={{ position: 'relative', display: 'inline-block' }}>
      <span
        style={{ ...styles.pendingBadge, color }}
        onClick={onClick}
        onPointerDown={onPointerDown}
        onPointerUp={cancelLongPress}
        onPointerLeave={cancelLongPress}
        onContextMenu={onContextMenu}
        title="Click for details · Long-press / right-click to withdraw"
      >
        ⏳ {text} {fmtRelative(pending.created_at) && `· ${fmtRelative(pending.created_at)}`}
      </span>
      {tooltipOpen && (
        <div style={styles.pendingTooltip} onClick={(e) => e.stopPropagation()}>
          <div><strong>Status:</strong> {pending.status}</div>
          <div><strong>Proposed:</strong> <code>{pending.value_to}</code></div>
          <div><strong>Previous:</strong> <code>{pending.value_from || '(empty)'}</code></div>
          <div><strong>Submitted:</strong> {pending.created_at}</div>
          {pending.server_uuid && <div><strong>Server UUID:</strong> <code>{pending.server_uuid}</code></div>}
          {pending.last_error && <div style={{ color: '#c33' }}><strong>Error:</strong> {pending.last_error}</div>}
        </div>
      )}
    </span>
  );
}

// ---------- Evidence dialog ----------

interface EvidenceDialogProps {
  label: string;
  targetType: TargetType;
  targetUuid: string;
  field: string;
  valueFrom: string;
  valueTo: string;
  onClose: () => void;
  onSubmitted: () => void;
}

function EvidenceDialog({ label, targetType, targetUuid, field, valueFrom, valueTo, onClose, onSubmitted }: EvidenceDialogProps) {
  const { fileName } = useBoardStore();
  const hasActiveBoard = !!fileName;

  const [sourceUrl, setSourceUrl] = useState('');
  const [boardInHand, setBoardInHand] = useState(false);
  const [rationale, setRationale] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid =
    sourceUrl.trim().length > 0 ||
    boardInHand ||
    rationale.trim().length > 0;

  const onSubmit = async () => {
    if (!valid || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const evidence: {
        source_url?: string;
        board_in_hand?: boolean;
        board_in_hand_ctx?: Record<string, unknown>;
        rationale?: string;
      } = {};
      if (sourceUrl.trim()) evidence.source_url = sourceUrl.trim();
      if (boardInHand) {
        evidence.board_in_hand = true;
        evidence.board_in_hand_ctx = {
          file_name: fileName,
          opened_at: new Date().toISOString(),
        };
      }
      if (rationale.trim()) evidence.rationale = rationale.trim();

      const r = await contribdbStore.submit({
        target_type: targetType,
        target_uuid: targetUuid,
        target_field: field,
        value_to: valueTo,
        value_from: valueFrom,
        evidence,
      });
      if (!r.ok) {
        setError(r.error ?? 'Submission failed');
      } else {
        log.contribdb.log('submitted', targetType, field, '→', valueTo);
        onSubmitted();
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={styles.modalBackdrop} onClick={onClose}>
      <div style={styles.modalCard} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalTitle}>Contribute a change</div>
        <div style={styles.modalSubtitle}>
          {targetType} · {label}
        </div>
        <div style={styles.modalDiff}>
          <div><span style={styles.modalDiffLabel}>From:</span> <code>{valueFrom || '(empty)'}</code></div>
          <div><span style={styles.modalDiffLabel}>To:</span> <code>{valueTo || '(empty)'}</code></div>
        </div>

        <div style={styles.modalSection}>
          <div style={styles.modalSectionTitle}>Evidence</div>
          <div style={styles.modalHint}>
            At least one of source URL, "board in hand", or rationale is required.
          </div>

          <div style={styles.modalField}>
            <label style={styles.modalLabel}>Source URL</label>
            <input
              type="url"
              placeholder="https://example.com/datasheet.pdf"
              value={sourceUrl}
              onChange={e => setSourceUrl(e.target.value)}
              style={styles.modalInput}
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          <div style={styles.modalField}>
            <label style={styles.modalLabel}>
              <input
                type="checkbox"
                checked={boardInHand}
                onChange={e => setBoardInHand(e.target.checked)}
                disabled={!hasActiveBoard}
              />
              {' '}I have this board in hand
              {!hasActiveBoard && (
                <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--text-secondary)' }}>
                  (open a board file to enable)
                </span>
              )}
            </label>
            {hasActiveBoard && boardInHand && (
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
                Will attach: <code>{fileName}</code>
              </div>
            )}
          </div>

          <div style={styles.modalField}>
            <label style={styles.modalLabel}>Rationale</label>
            <textarea
              placeholder="Explain why this change is correct…"
              value={rationale}
              onChange={e => setRationale(e.target.value)}
              style={styles.modalTextarea}
              rows={4}
            />
          </div>
        </div>

        {error && <div style={styles.modalError}>{error}</div>}

        <div style={styles.modalButtons}>
          <button onClick={onClose} disabled={submitting}>Cancel</button>
          <button onClick={onSubmit} disabled={!valid || submitting}>
            {submitting ? 'Submitting…' : 'Submit contribution'}
          </button>
        </div>
        {!valid && (
          <div style={styles.modalHint}>
            Fill in at least one evidence slot to enable submission.
          </div>
        )}
      </div>
    </div>
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
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  fieldValue: {
    fontSize: 13,
    wordBreak: 'break-word',
  },
  editableValue: {
    cursor: 'pointer',
    padding: '2px 4px',
    margin: '-2px -4px',
    borderRadius: 3,
    border: '1px dashed transparent',
  },
  editHint: {
    marginLeft: 6,
    fontSize: 10,
    color: 'var(--text-secondary)',
    opacity: 0.5,
  },
  emptyValue: {
    color: 'var(--text-secondary)',
    fontStyle: 'italic',
  },
  editorRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    padding: '4px 0',
  },
  editorInput: {
    fontSize: 13,
    padding: '4px 6px',
    background: 'var(--bg-primary, #0a0a0a)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border, #333)',
    borderRadius: 3,
    fontFamily: 'inherit',
  },
  editorTextarea: {
    fontSize: 13,
    padding: '4px 6px',
    background: 'var(--bg-primary, #0a0a0a)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border, #333)',
    borderRadius: 3,
    fontFamily: 'inherit',
    resize: 'vertical',
  },
  editorButtons: {
    display: 'flex',
    gap: 6,
  },
  editorHint: {
    fontSize: 11,
    color: 'var(--text-secondary)',
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
  // ---- Pending badge ----
  pendingBadge: {
    display: 'inline-block',
    fontSize: 10,
    fontWeight: 500,
    padding: '1px 6px',
    borderRadius: 3,
    border: '1px solid currentColor',
    cursor: 'pointer',
    textTransform: 'none',
    letterSpacing: 0,
    userSelect: 'none',
  },
  pendingTooltip: {
    position: 'absolute',
    top: '100%',
    left: 0,
    zIndex: 10,
    marginTop: 4,
    padding: 8,
    background: 'var(--bg-primary, #1a1a1a)',
    border: '1px solid var(--border, #333)',
    borderRadius: 4,
    fontSize: 11,
    color: 'var(--text-primary)',
    minWidth: 220,
    maxWidth: 360,
    boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
    textTransform: 'none',
    letterSpacing: 0,
    fontWeight: 400,
    lineHeight: 1.5,
  },
  // ---- Modal ----
  modalBackdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  modalCard: {
    background: 'var(--bg-primary, #121212)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border, #333)',
    borderRadius: 6,
    padding: 20,
    minWidth: 420,
    maxWidth: 560,
    maxHeight: '85vh',
    overflow: 'auto',
    fontSize: 13,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: 700,
    marginBottom: 4,
  },
  modalSubtitle: {
    fontSize: 12,
    color: 'var(--text-secondary)',
    marginBottom: 12,
    textTransform: 'capitalize',
  },
  modalDiff: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 11,
    background: 'var(--bg-secondary, rgba(255,255,255,0.04))',
    padding: 8,
    borderRadius: 3,
    marginBottom: 12,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    wordBreak: 'break-all',
  },
  modalDiffLabel: {
    color: 'var(--text-secondary)',
    marginRight: 4,
  },
  modalSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  modalSectionTitle: {
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    color: 'var(--text-secondary)',
  },
  modalHint: {
    fontSize: 11,
    color: 'var(--text-secondary)',
    lineHeight: 1.4,
  },
  modalField: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  modalLabel: {
    fontSize: 12,
  },
  modalInput: {
    fontSize: 13,
    padding: '4px 6px',
    background: 'var(--bg-primary, #0a0a0a)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border, #333)',
    borderRadius: 3,
    fontFamily: 'inherit',
  },
  modalTextarea: {
    fontSize: 13,
    padding: '4px 6px',
    background: 'var(--bg-primary, #0a0a0a)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border, #333)',
    borderRadius: 3,
    fontFamily: 'inherit',
    resize: 'vertical',
  },
  modalError: {
    color: '#c33',
    fontSize: 12,
    marginTop: 10,
  },
  modalButtons: {
    display: 'flex',
    gap: 8,
    justifyContent: 'flex-end',
    marginTop: 16,
  },
};
