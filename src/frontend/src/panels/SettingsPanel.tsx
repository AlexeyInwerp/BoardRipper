import { useState, useCallback, useRef, useMemo, useEffect, createContext, useContext } from 'react';
import { renderSettingsStore, DEFAULTS, computeOverrides } from '../store/render-settings';
import type { RenderSettings, LabelSize, NetColorRule, PartTypeOverride, PadShape, BodyShape } from '../store/render-settings';
import { SettingsMockup } from './SettingsMockup';
import type { MockupSectionId } from './SettingsMockup';
import { shortcuts, formatShortcut } from '../store/keyboard-shortcuts';
import { getAllFormats, setFormatOverride } from '../parsers/registry';
import { useBoardStore } from '../hooks/useBoardStore';
import { useDatabank } from '../hooks/useDatabank';
import { databankStore } from '../store/databank-store';
import { SCROLL_BINDINGS_KEY, SCROLL_ACTIONS, DEFAULT_SCROLL_BINDINGS, loadScrollBindings, PDF_QUALITY_KEY, PDF_RENDER_QUALITY_OPTIONS, loadPdfQuality, getPdfQualityConfig, PDF_INERTIA_KEY, loadPdfInertia } from './PdfViewerPanel';
import type { ScrollAction, ScrollBindings, PdfRenderQuality } from './PdfViewerPanel';

/** Context that provides per-field override info to Slider/Toggle children */
interface OverrideCtx {
  isBoardMode: boolean;
  globalSettings: RenderSettings;
  draft: RenderSettings;
}
const OverrideContext = createContext<OverrideCtx | null>(null);

function useOverride(field: keyof RenderSettings) {
  const ctx = useContext(OverrideContext);
  if (!ctx || !ctx.isBoardMode) return { isOverride: false, resetValue: undefined };
  const gv = ctx.globalSettings[field];
  const dv = ctx.draft[field];
  const isOverride = typeof gv === 'object'
    ? JSON.stringify(gv) !== JSON.stringify(dv)
    : gv !== dv;
  return { isOverride, resetValue: gv as number & boolean };
}

type SectionId = MockupSectionId | 'zoomLod' | 'netLines' | 'navigation' | 'performance' | 'shortcuts' | 'formats' | 'partTypeOverrides' | 'server' | 'pdf';

type DraftUpdater = (partial: Partial<RenderSettings>) => void;
type RuleUpdater = {
  add: (pattern: string, color: string) => void;
  update: (id: string, updates: Partial<NetColorRule>) => void;
  remove: (id: string) => void;
};

// ---- Collapsible section ----

function CollapsibleSection({
  id, title, children, isOpen, onToggle, sectionRef, isFocused,
}: {
  id: SectionId;
  title: string;
  children: React.ReactNode;
  isOpen: boolean;
  onToggle: (id: SectionId) => void;
  sectionRef: React.RefObject<HTMLDivElement | null>;
  isFocused: boolean;
}) {
  return (
    <div
      ref={sectionRef}
      className={`settings-section${isFocused ? ' settings-section-focused' : ''}`}
    >
      <button className="settings-section-header" onClick={() => onToggle(id)}>
        <span className="settings-section-title">{title}</span>
        <span className="settings-section-chevron">{isOpen ? '▾' : '▸'}</span>
      </button>
      {isOpen && <div className="settings-section-body">{children}</div>}
    </div>
  );
}

// ---- Primitive controls ----

interface SliderProps {
  label: string; value: number; min: number; max: number; step: number;
  field: keyof RenderSettings; onUpdate: DraftUpdater; title?: string;
}

function Slider({ label, value, min, max, step, field, onUpdate, title }: SliderProps) {
  const [dragging, setDragging] = useState(false);
  const { isOverride, resetValue: ovReset } = useOverride(field);
  const defaultValue = ovReset ?? DEFAULTS[field] as number;
  const pct = ((value - min) / (max - min)) * 100;
  const isModified = Math.abs(value - defaultValue) > step * 0.5;
  return (
    <div className={`settings-row${isOverride ? ' settings-override' : ''}`} title={title}>
      <label className="settings-label">
        {label}
        <span className="settings-value">{Number(value.toFixed(2))}</span>
      </label>
      <div className="settings-slider-wrap">
        <input
          type="range" className={`settings-slider${isOverride ? ' slider-override' : ''}`}
          min={min} max={max} step={step} value={value}
          onChange={(e) => onUpdate({ [field]: parseFloat(e.target.value) })}
          onPointerDown={() => setDragging(true)}
          onPointerUp={() => setDragging(false)}
          onDoubleClick={() => onUpdate({ [field]: defaultValue })}
        />
        <div className="settings-slider-tooltip" style={{ left: `${pct}%` }}>
          {dragging
            ? <span className="settings-slider-reset-hint">dbl-click to reset{isModified ? ` (${Number(defaultValue.toFixed(2))})` : ''}</span>
            : Number(value.toFixed(2))
          }
        </div>
      </div>
    </div>
  );
}

interface ToggleProps {
  label: string; value: boolean; field: keyof RenderSettings; onUpdate: DraftUpdater; title?: string;
}

function Toggle({ label, value, field, onUpdate, title }: ToggleProps) {
  const { isOverride, resetValue: ovReset } = useOverride(field);
  return (
    <div className={`settings-row settings-toggle-row${isOverride ? ' settings-override' : ''}`} title={title}>
      <label className="settings-label">{label}</label>
      <input type="checkbox" checked={value}
        onChange={(e) => onUpdate({ [field]: e.target.checked })}
        onDoubleClick={() => { const rv = ovReset ?? DEFAULTS[field] as boolean; onUpdate({ [field]: rv }); }}
      />
    </div>
  );
}

function LabelSizeSelector({ draft, onUpdate }: { draft: RenderSettings; onUpdate: DraftUpdater }) {
  const sizes: LabelSize[] = ['small', 'medium', 'large'];
  const fields: Record<LabelSize, keyof RenderSettings> = {
    small: 'labelSizeSmall', medium: 'labelSizeMedium', large: 'labelSizeLarge',
  };
  return (
    <>
      <div className="settings-row">
        <label className="settings-label">Active Size</label>
        <div className="settings-btn-group">
          {sizes.map((size) => (
            <button
              key={size}
              className={`settings-btn-option ${draft.labelSize === size ? 'active' : ''}`}
              onClick={() => onUpdate({ labelSize: size })}
            >
              {size[0].toUpperCase() + size.slice(1)}
            </button>
          ))}
        </div>
      </div>
      {sizes.map((size) => (
        <Slider
          key={size}
          label={`${size[0].toUpperCase() + size.slice(1)} Size`}
          value={draft[fields[size]] as number}
          min={1} max={30} step={1}
          field={fields[size]} onUpdate={onUpdate}
        />
      ))}
    </>
  );
}

// ---- Net color rules ----

function NetColorRuleRow({ rule, rules: ruleActions }: { rule: NetColorRule; rules: RuleUpdater }) {
  return (
    <div className="color-rule-row">
      <input
        type="checkbox" checked={rule.enabled}
        onChange={(e) => ruleActions.update(rule.id, { enabled: e.target.checked })}
        title="Enable/disable"
      />
      <input
        type="text" className="color-rule-pattern" value={rule.pattern}
        onChange={(e) => ruleActions.update(rule.id, { pattern: e.target.value })}
        placeholder="Keyword"
      />
      <input
        type="color" className="color-rule-color" value={rule.color}
        onChange={(e) => ruleActions.update(rule.id, { color: e.target.value })}
      />
      <button className="color-rule-remove" onClick={() => ruleActions.remove(rule.id)} title="Remove rule">×</button>
    </div>
  );
}

function NetColorRulesSection({ rules, ruleActions }: { rules: NetColorRule[]; ruleActions: RuleUpdater }) {
  const [newPattern, setNewPattern] = useState('');
  const [newColor, setNewColor] = useState('#ff6600');

  const addRule = () => {
    const trimmed = newPattern.trim();
    if (!trimmed) return;
    ruleActions.add(trimmed, newColor);
    setNewPattern('');
  };

  return (
    <>
      <div className="color-rules-list">
        {rules.map((rule) => <NetColorRuleRow key={rule.id} rule={rule} rules={ruleActions} />)}
      </div>
      <div className="color-rule-add">
        <input
          type="text" className="color-rule-pattern" value={newPattern}
          onChange={(e) => setNewPattern(e.target.value)}
          placeholder="Keyword (e.g. SDA)"
          onKeyDown={(e) => { if (e.key === 'Enter') addRule(); }}
        />
        <input type="color" className="color-rule-color" value={newColor} onChange={(e) => setNewColor(e.target.value)} />
        <button className="color-rule-add-btn" onClick={addRule}>+</button>
      </div>
      <div className="color-rule-hint">First matching rule wins. Case-insensitive substring match.</div>
    </>
  );
}

// ---- NC net patterns ----

function NcNetPatternsSection({ patterns, onChange }: { patterns: string[]; onChange: (p: string[]) => void }) {
  const [newPat, setNewPat] = useState('');

  const add = () => {
    const trimmed = newPat.trim();
    if (!trimmed || patterns.includes(trimmed)) return;
    onChange([...patterns, trimmed]);
    setNewPat('');
  };

  const remove = (idx: number) => onChange(patterns.filter((_, i) => i !== idx));

  return (
    <>
      <div className="nc-patterns-list">
        {patterns.map((pat, i) => (
          <div key={i} className="nc-pattern-row">
            <span className="nc-pattern-text">{pat}</span>
            <button className="color-rule-remove" onClick={() => remove(i)} title="Remove pattern">×</button>
          </div>
        ))}
      </div>
      <div className="color-rule-add">
        <input
          type="text" className="color-rule-pattern" value={newPat}
          onChange={(e) => setNewPat(e.target.value)}
          placeholder="e.g. NC_*"
          onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
        />
        <button className="color-rule-add-btn" onClick={add}>+</button>
      </div>
      <div className="color-rule-hint">Outline-only pins, no fill or labels. Case-insensitive. Trailing * = prefix match.</div>
    </>
  );
}

// ---- Part type overrides ----

type OverrideActions = {
  update: (key: string, o: PartTypeOverride) => void;
  rename: (oldKey: string, newKey: string) => void;
  remove: (key: string) => void;
  add: () => void;
};

const EMPTY_OVERRIDE: PartTypeOverride = { padShape: 'natural', bodyShape: 'natural', hidden: false, color: '' };

const PAD_SHAPES: PadShape[]  = ['natural', 'round', 'square'];
const BODY_SHAPES: BodyShape[] = ['natural', 'rect', 'square'];

function OverrideRow({ rowKey, override: o, actions }: { rowKey: string; override: PartTypeOverride; actions: OverrideActions }) {
  const [editKey, setEditKey] = useState(rowKey);

  // Keep local edit key in sync if parent renames it externally
  const prevKeyRef = useRef(rowKey);
  if (prevKeyRef.current !== rowKey) { prevKeyRef.current = rowKey; setEditKey(rowKey); }

  const commitRename = () => {
    const trimmed = editKey.trim().toUpperCase();
    if (!trimmed) { setEditKey(rowKey); return; }
    if (trimmed !== rowKey) actions.rename(rowKey, trimmed);
  };

  return (
    <div className="part-type-override-row">
      <input
        className="pto-key-input"
        value={editKey}
        onChange={e => setEditKey(e.target.value.toUpperCase())}
        onBlur={commitRename}
        onKeyDown={e => e.key === 'Enter' && commitRename()}
        title="Prefix mask (e.g. R, FB, SW)"
        maxLength={8}
      />
      <div className="pto-col-pad settings-btn-group">
        {PAD_SHAPES.map(shape => (
          <button key={shape}
            className={`settings-btn-option${o.padShape === shape ? ' active' : ''}`}
            onClick={() => actions.update(rowKey, { ...o, padShape: shape })}
            title={shape}
          >
            {shape === 'natural' ? '~' : shape === 'round' ? '●' : '■'}
          </button>
        ))}
      </div>
      <div className="pto-col-body settings-btn-group">
        {BODY_SHAPES.map(shape => (
          <button key={shape}
            className={`settings-btn-option${o.bodyShape === shape ? ' active' : ''}`}
            onClick={() => actions.update(rowKey, { ...o, bodyShape: shape })}
            title={shape}
          >
            {shape === 'natural' ? '~' : shape === 'rect' ? '▭' : '□'}
          </button>
        ))}
      </div>
      <span className="pto-col-color">
        <input type="color" className="pto-color-input"
          value={o.color || '#000000'}
          onChange={e => actions.update(rowKey, { ...o, color: e.target.value })}
        />
      </span>
      <span className="pto-col-hide">
        <input type="checkbox" checked={o.hidden}
          onChange={e => actions.update(rowKey, { ...o, hidden: e.target.checked })}
        />
      </span>
      <button className="pto-remove-btn" onClick={() => actions.remove(rowKey)} title="Remove">×</button>
    </div>
  );
}

function PartTypeOverridesSection({ overrides, actions }: { overrides: Record<string, PartTypeOverride>; actions: OverrideActions }) {
  return (
    <div className="part-type-overrides">
      <div className="part-type-overrides-header">
        <span>Mask</span>
        <span>Pads</span>
        <span>Body</span>
        <span>Fill</span>
        <span>Hide</span>
        <span></span>
      </div>
      {Object.entries(overrides).map(([key, o]) => (
        <OverrideRow key={key} rowKey={key} override={o} actions={actions} />
      ))}
      <button className="color-rule-add-btn pto-add-btn" onClick={actions.add} title="Add override">+</button>
      <div className="color-rule-hint">Prefix match, longest wins (e.g. FB beats F for FB1).</div>
    </div>
  );
}

// ---- Format settings table ----

function FormatSettingsTable() {
  const [, forceUpdate] = useState(0);
  const formats = getAllFormats();

  const toggle = (id: string, key: 'flipY' | 'swapSides', current: boolean) => {
    setFormatOverride(id, key, !current);
    forceUpdate(n => n + 1);
  };

  return (
    <>
      <table className="formats-table">
        <thead>
          <tr>
            <th>Format</th>
            <th>Extensions</th>
            <th>Flip Y</th>
            <th>Swap Sides</th>
          </tr>
        </thead>
        <tbody>
          {formats.map(fmt => (
            <tr key={fmt.id}>
              <td title={fmt.description}>{fmt.name}</td>
              <td>{fmt.extensions.join(', ')}</td>
              <td>
                <input type="checkbox" checked={fmt.flipY ?? false}
                  onChange={() => toggle(fmt.id, 'flipY', fmt.flipY ?? false)} />
              </td>
              <td>
                <input type="checkbox" checked={fmt.swapSides ?? false}
                  onChange={() => toggle(fmt.id, 'swapSides', fmt.swapSides ?? false)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="color-rule-hint">Changes apply to newly opened boards. Reload a board to see the effect.</div>
    </>
  );
}

// ---- Library folder setting (Docker mode) ----

function LibraryFolderSetting() {
  const { libraryPath, electronMode, backendAvailable } = useDatabank();
  const [editing, setEditing] = useState(false);
  const [inputVal, setInputVal] = useState(libraryPath ?? '');
  const [saving, setSaving] = useState(false);

  // Don't show in Electron mode (has its own folder picker)
  if (electronMode) return null;

  const handleSave = async () => {
    setSaving(true);
    const ok = await databankStore.setLibraryDir(inputVal.trim());
    setSaving(false);
    if (ok) {
      setEditing(false);
      // Trigger rescan with new library dir
      databankStore.triggerFileScan();
    }
  };

  if (!backendAvailable) {
    return (
      <div className="color-rule-hint">Backend not available. Start the Docker container to configure the library folder.</div>
    );
  }

  return (
    <div className="settings-library-folder">
      <div className="color-rule-hint" style={{ marginBottom: 6 }}>
        Path inside the container to scan for board/PDF files. Mount a NAS folder with <code>docker -v /host/path:/library</code>.
      </div>
      {editing ? (
        <div className="settings-library-edit">
          <input
            type="text"
            className="settings-library-input"
            value={inputVal}
            onChange={e => setInputVal(e.target.value)}
            placeholder="/library"
            autoFocus
            onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') setEditing(false); }}
          />
          <button className="settings-action-btn settings-apply-btn" onClick={handleSave} disabled={saving}>
            {saving ? '...' : 'Save'}
          </button>
          <button className="settings-action-btn" onClick={() => setEditing(false)}>Cancel</button>
        </div>
      ) : (
        <div className="settings-row settings-toggle-row">
          <label className="settings-label">Library Folder</label>
          <span
            className="settings-library-path"
            onClick={() => { setInputVal(libraryPath ?? '/library'); setEditing(true); }}
            title="Click to edit"
          >
            {libraryPath || <em>Not configured</em>}
          </span>
        </div>
      )}
    </div>
  );
}

// ---- Auto-scan toggle ----

function AutoScanToggle() {
  const { backendAvailable, electronMode } = useDatabank();
  const [autoScan, setAutoScan] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (electronMode || !backendAvailable) return;
    fetch('/api/config')
      .then(r => r.ok ? r.json() : null)
      .then(cfg => {
        if (cfg && typeof cfg.auto_scan === 'string') {
          setAutoScan(cfg.auto_scan === 'true');
        }
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [backendAvailable, electronMode]);

  if (electronMode || !loaded) return null;

  const handleToggle = async (checked: boolean) => {
    setAutoScan(checked);
    try {
      await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'auto_scan', value: checked ? 'true' : '' }),
      });
    } catch { /* ignore */ }
  };

  return (
    <div className="settings-row settings-toggle-row">
      <label className="settings-label">Auto-scan on startup</label>
      <input type="checkbox" checked={autoScan} onChange={e => handleToggle(e.target.checked)} />
    </div>
  );
}

// ---- Database info section ----

function DatabaseInfoSection() {
  const { stats, scanStatus, backendAvailable, electronMode } = useDatabank();
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    if (!electronMode && backendAvailable) {
      databankStore.fetchStats();
    }
  }, [backendAvailable, electronMode]);

  if (electronMode || !backendAvailable) return null;

  const isRunning = scanStatus?.running || scanStatus?.pdf_running;

  const formatDate = (ts: number) => {
    if (!ts) return 'Never';
    return new Date(ts * 1000).toLocaleString();
  };

  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  const handleResetPdf = async () => {
    if (!confirm('Reset all extracted PDF text? You will need to re-run PDF extraction.')) return;
    setResetting(true);
    await databankStore.resetPdf();
    setResetting(false);
  };

  const handleResetAll = async () => {
    if (!confirm('Wipe ALL scan data (files, bindings, PDF text)? This cannot be undone.')) return;
    setResetting(true);
    await databankStore.resetAll();
    setResetting(false);
  };

  return (
    <div className="settings-db-info">
      {stats && (
        <>
          <div className="settings-row settings-toggle-row">
            <label className="settings-label">Board files</label>
            <span>{stats.boards}</span>
          </div>
          <div className="settings-row settings-toggle-row">
            <label className="settings-label">PDF files</label>
            <span>{stats.pdfs}</span>
          </div>
          <div className="settings-row settings-toggle-row">
            <label className="settings-label">Bindings</label>
            <span>{stats.bindings}</span>
          </div>
          <div className="settings-row settings-toggle-row">
            <label className="settings-label">PDF pages indexed</label>
            <span>{stats.pdf_pages}</span>
          </div>
          {stats.pdf_errors > 0 && (
            <div className="settings-row settings-toggle-row">
              <label className="settings-label">PDF scan errors</label>
              <span>{stats.pdf_errors}</span>
            </div>
          )}
          <div className="settings-row settings-toggle-row">
            <label className="settings-label">Database size</label>
            <span>{formatBytes(stats.db_size_bytes)}</span>
          </div>
          <div className="settings-row settings-toggle-row">
            <label className="settings-label">Last file scan</label>
            <span>{formatDate(stats.last_file_scan_at)}</span>
          </div>
          <div className="settings-row settings-toggle-row">
            <label className="settings-label">Last PDF scan</label>
            <span>{formatDate(stats.last_pdf_scan_at)}</span>
          </div>
        </>
      )}
      <div className="settings-db-actions" style={{ marginTop: 8, display: 'flex', gap: 8 }}>
        <button
          className="settings-action-btn"
          onClick={handleResetPdf}
          disabled={!!isRunning || resetting}
          title="Wipe extracted PDF text — keeps file index and bindings"
        >
          Reset PDF Text
        </button>
        <button
          className="settings-action-btn"
          onClick={handleResetAll}
          disabled={!!isRunning || resetting}
          title="Wipe ALL scan data"
          style={{ color: '#e55' }}
        >
          Reset Database
        </button>
      </div>
    </div>
  );
}

// ---- PDF Scroll Bindings Editor (drag-and-drop) ----

const MODIFIER_KEYS: (keyof ScrollBindings)[] = ['bare', 'shift', 'meta'];
const MODIFIER_LABELS: Record<keyof ScrollBindings, string> = {
  bare: 'Scroll',
  shift: 'Shift + Scroll',
  meta: navigator.platform?.includes('Mac') ? '⌘ + Scroll' : 'Ctrl + Scroll',
};
const ACTION_LABELS: Record<ScrollAction, string> = { zoom: 'Zoom', pan: 'Pan', switch: 'Page' };
const ACTION_COLORS: Record<ScrollAction, string> = { zoom: '#00d4ff', pan: '#ffd93d', switch: '#ff6b9d' };

function ScrollBindingsEditor() {
  const [bindings, setBindings] = useState<ScrollBindings>(loadScrollBindings);
  const [dragging, setDragging] = useState<ScrollAction | null>(null);
  const [dragOver, setDragOver] = useState<keyof ScrollBindings | null>(null);

  const save = useCallback((next: ScrollBindings) => {
    setBindings(next);
    try { localStorage.setItem(SCROLL_BINDINGS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
    // Notify any open PDF panels (they read from localStorage on next wheel event via ref)
    window.dispatchEvent(new CustomEvent('pdf-scroll-bindings-changed', { detail: next }));
  }, []);

  const handleDragStart = useCallback((e: React.DragEvent, action: ScrollAction) => {
    setDragging(action);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', action);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, slot: keyof ScrollBindings) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOver(slot);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, targetSlot: keyof ScrollBindings) => {
    e.preventDefault();
    setDragOver(null);
    setDragging(null);
    const action = e.dataTransfer.getData('text/plain') as ScrollAction;
    if (!SCROLL_ACTIONS.includes(action)) return;

    // Find which slot currently holds this action and swap
    const sourceSlot = MODIFIER_KEYS.find(k => bindings[k] === action);
    if (!sourceSlot || sourceSlot === targetSlot) return;

    const next = { ...bindings };
    // Swap: source gets target's current action, target gets dragged action
    next[sourceSlot] = bindings[targetSlot];
    next[targetSlot] = action;
    save(next);
  }, [bindings, save]);

  const handleDragEnd = useCallback(() => {
    setDragging(null);
    setDragOver(null);
  }, []);

  const handleReset = useCallback(() => {
    save(DEFAULT_SCROLL_BINDINGS);
  }, [save]);

  return (
    <div className="scroll-bindings-editor">
      <div className="scroll-bindings-grid">
        {MODIFIER_KEYS.map(slot => {
          const action = bindings[slot];
          const isOver = dragOver === slot;
          return (
            <div
              key={slot}
              className={`scroll-binding-slot${isOver ? ' drag-over' : ''}`}
              onDragOver={e => handleDragOver(e, slot)}
              onDragLeave={() => setDragOver(null)}
              onDrop={e => handleDrop(e, slot)}
            >
              <span className="scroll-binding-modifier">{MODIFIER_LABELS[slot]}</span>
              <span
                className={`scroll-binding-pill${dragging === action ? ' dragging' : ''}`}
                style={{ '--pill-color': ACTION_COLORS[action] } as React.CSSProperties}
                draggable
                onDragStart={e => handleDragStart(e, action)}
                onDragEnd={handleDragEnd}
              >
                {ACTION_LABELS[action]}
              </span>
            </div>
          );
        })}
      </div>
      {(bindings.bare !== 'zoom' || bindings.shift !== 'pan' || bindings.meta !== 'switch') && (
        <button className="scroll-bindings-reset" onClick={handleReset}>Reset to default</button>
      )}
    </div>
  );
}

// ---- PDF render quality selector ----

const QUALITY_LABELS: Record<PdfRenderQuality, string> = {
  max: 'Max',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

const QUALITY_DESCRIPTIONS: Record<PdfRenderQuality, string> = {
  max: 'Pixel-perfect at all zoom levels. High GPU usage. Desktop with dedicated GPU.',
  high: 'Crisp text up to 800%. Good for modern laptops.',
  medium: 'Softens above 400%. Smooth on integrated GPUs and tablets.',
  low: 'Softens above 200%. Best for older machines or battery saving.',
};

function PdfQualitySelector() {
  const [quality, setQuality] = useState<PdfRenderQuality>(loadPdfQuality);

  const handleChange = useCallback((next: PdfRenderQuality) => {
    setQuality(next);
    try { localStorage.setItem(PDF_QUALITY_KEY, next); } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent('pdf-quality-changed', { detail: next }));
  }, []);

  const cfg = getPdfQualityConfig(quality);

  return (
    <div className="pdf-quality-selector">
      <div className="settings-btn-group">
        {PDF_RENDER_QUALITY_OPTIONS.map(q => (
          <button
            key={q}
            className={`settings-btn-option${quality === q ? ' active' : ''}`}
            onClick={() => handleChange(q)}
            title={QUALITY_DESCRIPTIONS[q]}
          >
            {QUALITY_LABELS[q]}
          </button>
        ))}
      </div>
      <p className="settings-hint">{QUALITY_DESCRIPTIONS[quality]}</p>
      <div className="pdf-quality-details">
        <span>Main tier: {cfg.maxMainTier}× | Adj tier: {cfg.maxAdjTier}× | Cache: {cfg.cacheMaxEntries} pages / {Math.round(cfg.cacheMaxPixels / 1_000_000)}MP</span>
      </div>
    </div>
  );
}

// ---- Board scroll bindings editor (drag-and-drop pills) ----

type BoardScrollAction = 'zoom' | 'pan';
const BOARD_ACTIONS: BoardScrollAction[] = ['zoom', 'pan'];
const BOARD_ACTION_LABELS: Record<BoardScrollAction, string> = { zoom: 'Zoom', pan: 'Pan' };
const BOARD_ACTION_COLORS: Record<BoardScrollAction, string> = { zoom: '#00d4ff', pan: '#ffd93d' };

const BOARD_MODIFIER_KEYS = ['bare', 'shift'] as const;
type BoardModifier = typeof BOARD_MODIFIER_KEYS[number];
const BOARD_MODIFIER_LABELS: Record<BoardModifier, string> = {
  bare: 'Scroll',
  shift: 'Shift + Scroll',
};

function BoardScrollBindingsEditor({ twoFingerPan, onUpdate }: { twoFingerPan: boolean; onUpdate: DraftUpdater }) {
  // Derive bindings from twoFingerPan: bare=pan when twoFingerPan, else bare=zoom
  const bindings: Record<BoardModifier, BoardScrollAction> = {
    bare: twoFingerPan ? 'pan' : 'zoom',
    shift: twoFingerPan ? 'zoom' : 'pan',
  };

  const [dragging, setDragging] = useState<BoardScrollAction | null>(null);
  const [dragOver, setDragOver] = useState<BoardModifier | null>(null);

  const handleDragStart = useCallback((e: React.DragEvent, action: BoardScrollAction) => {
    setDragging(action);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', action);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, slot: BoardModifier) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOver(slot);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, targetSlot: BoardModifier) => {
    e.preventDefault();
    setDragOver(null);
    setDragging(null);
    const action = e.dataTransfer.getData('text/plain') as BoardScrollAction;
    if (!BOARD_ACTIONS.includes(action)) return;
    const sourceSlot = BOARD_MODIFIER_KEYS.find(k => bindings[k] === action);
    if (!sourceSlot || sourceSlot === targetSlot) return;
    // Swapping bare and shift means toggling twoFingerPan
    onUpdate({ twoFingerPan: targetSlot === 'bare' && action === 'pan' });
  }, [bindings, onUpdate]);

  const handleDragEnd = useCallback(() => { setDragging(null); setDragOver(null); }, []);

  return (
    <div className="scroll-bindings-editor">
      <div className="scroll-bindings-grid">
        {BOARD_MODIFIER_KEYS.map(slot => {
          const action = bindings[slot];
          const isOver = dragOver === slot;
          return (
            <div key={slot} className={`scroll-binding-slot${isOver ? ' drag-over' : ''}`}
              onDragOver={e => handleDragOver(e, slot)}
              onDragLeave={() => setDragOver(null)}
              onDrop={e => handleDrop(e, slot)}>
              <span className="scroll-binding-modifier">{BOARD_MODIFIER_LABELS[slot]}</span>
              <span
                className={`scroll-binding-pill${dragging === action ? ' dragging' : ''}`}
                style={{ '--pill-color': BOARD_ACTION_COLORS[action] } as React.CSSProperties}
                draggable onDragStart={e => handleDragStart(e, action)} onDragEnd={handleDragEnd}>
                {BOARD_ACTION_LABELS[action]}
              </span>
            </div>
          );
        })}
      </div>
      <p className="settings-hint" style={{ marginTop: 4 }}>Pinch-to-zoom always works regardless of scroll assignment.</p>
    </div>
  );
}

// ---- PDF inertia toggle ----

function PdfInertiaToggle() {
  const [enabled, setEnabled] = useState(loadPdfInertia);
  const toggle = useCallback(() => {
    const next = !enabled;
    setEnabled(next);
    try { localStorage.setItem(PDF_INERTIA_KEY, String(next)); } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent('pdf-inertia-changed'));
  }, [enabled]);
  return (
    <div className="settings-row settings-toggle-row" title="Continue panning with momentum after releasing the drag. When disabled, panning stops immediately on release. Note: trackpad scroll momentum is controlled by your OS settings and cannot be disabled by the app">
      <label className="settings-label">Inertia</label>
      <input type="checkbox" checked={enabled} onChange={toggle} />
    </div>
  );
}

// ---- Main panel ----

const INITIALLY_OPEN: SectionId[] = [];

type SettingsMode = 'global' | 'board';

export function SettingsPanel() {
  const { fileName: activeFileName } = useBoardStore();
  const hasBoard = !!activeFileName;

  // Mode: global settings vs per-board overrides
  const [mode, setMode] = useState<SettingsMode>('global');
  // Force mode to global when no board is open
  const effectiveMode = hasBoard ? mode : 'global';
  const isBoardMode = effectiveMode === 'board';

  const baselineRef = useRef<RenderSettings>(
    isBoardMode ? renderSettingsStore.snapshot() : renderSettingsStore.globalSnapshot()
  );
  const [draft, setDraft] = useState<RenderSettings>(() =>
    isBoardMode ? renderSettingsStore.snapshot() : renderSettingsStore.globalSnapshot()
  );
  const [previewing, setPreviewing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const previewingRef = useRef(previewing);
  previewingRef.current = previewing;

  // Reset draft/baseline when mode changes
  useEffect(() => {
    const snap = isBoardMode ? renderSettingsStore.snapshot() : renderSettingsStore.globalSnapshot();
    baselineRef.current = structuredClone(snap);
    setDraft(structuredClone(snap));
    setDirty(false);
    if (previewing) { renderSettingsStore.applySettings(snap); setPreviewing(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveMode, activeFileName]);

  // Collapsible sections
  const [openSections, setOpenSections] = useState<Set<SectionId>>(new Set(INITIALLY_OPEN));
  const [focusedSection, setFocusedSection] = useState<SectionId | null>(null);
  const focusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Section scroll refs
  const outlineRef = useRef<HTMLDivElement>(null);
  const partsRef = useRef<HTMLDivElement>(null);
  const pinsRef = useRef<HTMLDivElement>(null);
  const netColorsRef = useRef<HTMLDivElement>(null);
  const selectionRef = useRef<HTMLDivElement>(null);
  const netLinesRef = useRef<HTMLDivElement>(null);
  const navigationRef = useRef<HTMLDivElement>(null);
  const performanceRef = useRef<HTMLDivElement>(null);
  const shortcutsRef = useRef<HTMLDivElement>(null);
  const formatsRef = useRef<HTMLDivElement>(null);
  const partTypeOverridesRef = useRef<HTMLDivElement>(null);
  const zoomLodRef = useRef<HTMLDivElement>(null);
  const serverRef = useRef<HTMLDivElement>(null);
  const pdfRef = useRef<HTMLDivElement>(null);

  const sectionRefsMapRef = useRef<Record<SectionId, React.RefObject<HTMLDivElement | null>>>({
    outline: outlineRef, parts: partsRef, pins: pinsRef,
    netColors: netColorsRef, selection: selectionRef, zoomLod: zoomLodRef, netLines: netLinesRef, navigation: navigationRef,
    performance: performanceRef, shortcuts: shortcutsRef, formats: formatsRef,
    partTypeOverrides: partTypeOverridesRef, server: serverRef, pdf: pdfRef,
  });

  const toggleSection = useCallback((id: SectionId) => {
    setOpenSections(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const focusSection = useCallback((id: SectionId) => {
    setOpenSections(prev => { const next = new Set(prev); next.add(id); return next; });
    requestAnimationFrame(() => {
      sectionRefsMapRef.current[id]?.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    if (focusTimerRef.current) clearTimeout(focusTimerRef.current);
    setFocusedSection(id);
    focusTimerRef.current = setTimeout(() => setFocusedSection(null), 1400);
  }, []);

  const updateDraft: DraftUpdater = useCallback((partial) => {
    setDraft(prev => {
      const next = { ...prev, ...partial };
      if (previewingRef.current) renderSettingsStore.applySettings(next);
      return next;
    });
    setDirty(true);
  }, []);

  const ruleActions: RuleUpdater = useMemo(() => ({
    add(pattern, color) {
      setDraft(prev => {
        const next = { ...prev, netColorRules: [...prev.netColorRules, { id: `rule_${Date.now()}`, pattern, color, enabled: true }] };
        if (previewingRef.current) renderSettingsStore.applySettings(next);
        return next;
      });
      setDirty(true);
    },
    update(id, updates) {
      setDraft(prev => {
        const next = { ...prev, netColorRules: prev.netColorRules.map(r => r.id === id ? { ...r, ...updates } : r) };
        if (previewingRef.current) renderSettingsStore.applySettings(next);
        return next;
      });
      setDirty(true);
    },
    remove(id) {
      setDraft(prev => {
        const next = { ...prev, netColorRules: prev.netColorRules.filter(r => r.id !== id) };
        if (previewingRef.current) renderSettingsStore.applySettings(next);
        return next;
      });
      setDirty(true);
    },
  }), []);

  const onNcPatternsChange = useCallback((patterns: string[]) => {
    setDraft(prev => {
      const next = { ...prev, ncNetPatterns: patterns };
      if (previewingRef.current) renderSettingsStore.applySettings(next);
      return next;
    });
    setDirty(true);
  }, []);

  const overrideActions: OverrideActions = useMemo(() => ({
    update(key, o) {
      setDraft(prev => {
        const next = { ...prev, partTypeOverrides: { ...prev.partTypeOverrides, [key]: o } };
        if (previewingRef.current) renderSettingsStore.applySettings(next);
        return next;
      });
      setDirty(true);
    },
    rename(oldKey, newKey) {
      setDraft(prev => {
        const entries = Object.entries(prev.partTypeOverrides);
        const idx = entries.findIndex(([k]) => k === oldKey);
        if (idx === -1 || prev.partTypeOverrides[newKey]) return prev;
        entries[idx] = [newKey, entries[idx][1]];
        const next = { ...prev, partTypeOverrides: Object.fromEntries(entries) };
        if (previewingRef.current) renderSettingsStore.applySettings(next);
        return next;
      });
      setDirty(true);
    },
    remove(key) {
      setDraft(prev => {
        const { [key]: _, ...rest } = prev.partTypeOverrides;
        const next = { ...prev, partTypeOverrides: rest };
        if (previewingRef.current) renderSettingsStore.applySettings(next);
        return next;
      });
      setDirty(true);
    },
    add() {
      setDraft(prev => {
        let key = 'NEW'; let i = 1;
        while (prev.partTypeOverrides[key]) key = `NEW${i++}`;
        const next = { ...prev, partTypeOverrides: { ...prev.partTypeOverrides, [key]: { ...EMPTY_OVERRIDE } } };
        if (previewingRef.current) renderSettingsStore.applySettings(next);
        return next;
      });
      setDirty(true);
    },
  }), []);

  const handleApply = () => {
    if (isBoardMode) {
      // Compute sparse diff against global and store as board overrides
      const global = renderSettingsStore.globalSettings;
      const overrides = computeOverrides(global, draft);
      renderSettingsStore.setBoardOverrides(activeFileName, overrides);
    } else {
      renderSettingsStore.applyGlobal(draft);
    }
    baselineRef.current = structuredClone(draft);
    setDirty(false); setPreviewing(false);
  };
  const handleCancel = () => {
    renderSettingsStore.applySettings(baselineRef.current);
    setDraft(structuredClone(baselineRef.current));
    setDirty(false); setPreviewing(false);
  };
  const handlePreview = () => {
    if (previewing) {
      renderSettingsStore.applySettings(baselineRef.current);
      setPreviewing(false);
    } else {
      renderSettingsStore.applySettings(draft);
      setPreviewing(true);
    }
  };
  const handleReset = () => {
    if (isBoardMode) {
      // Reset to global (clear all board overrides)
      const global = renderSettingsStore.globalSnapshot();
      setDraft(global);
      setDirty(true);
      if (previewing) renderSettingsStore.applySettings(global);
    } else {
      const defaults = structuredClone(DEFAULTS);
      setDraft(defaults);
      setDirty(true);
      if (previewing) renderSettingsStore.applySettings(defaults);
    }
  };

  const overrideCtx = useMemo<OverrideCtx>(() => ({
    isBoardMode,
    globalSettings: renderSettingsStore.globalSettings,
    draft,
  }), [isBoardMode, draft]);

  const panelRef = useRef<HTMLDivElement>(null);

  return (
    <div className="panel-content settings-panel" data-testid="settings-panel" ref={panelRef}>
      <div className="settings-top">
        {/* ── Mode switch: Global vs Board ── */}
        <div className="settings-mode-switch">
          <button
            className={`settings-mode-btn${effectiveMode === 'global' ? ' active' : ''}`}
            onClick={() => setMode('global')}
          >Global</button>
          <button
            className={`settings-mode-btn${effectiveMode === 'board' ? ' active' : ''}`}
            onClick={() => setMode('board')}
            disabled={!hasBoard}
            title={hasBoard ? `Board overrides for ${activeFileName}` : 'Open a board to edit per-board settings'}
          >Board</button>
        </div>
        <div className="settings-mode-hint">
          {isBoardMode
            ? <>Overrides for <strong>{activeFileName}</strong> &middot; <span className="settings-override-legend">yellow</span> = overridden</>
            : 'Changes apply to all boards'}
        </div>

        <SettingsMockup settings={draft} onElementClick={focusSection} />
        <div className="settings-footer">
          <button
            className={`settings-action-btn ${previewing ? 'active' : ''}`}
            onClick={handlePreview} disabled={!dirty}
            title={previewing ? 'Stop preview, revert board to saved' : 'Preview changes on the board'}
          >
            {previewing ? 'Stop Preview' : 'Preview'}
          </button>
          <button className="settings-action-btn settings-apply-btn" onClick={handleApply} disabled={!dirty}>Apply</button>
          <button className="settings-action-btn" onClick={handleCancel} disabled={!dirty}>Cancel</button>
        </div>
      </div>
      <OverrideContext.Provider value={overrideCtx}>
      <div className="settings-scroll">

      <CollapsibleSection id="outline" title="Board Outline" isOpen={openSections.has('outline')}
        onToggle={toggleSection} sectionRef={outlineRef} isFocused={focusedSection === 'outline'}>
        <Slider label="Stroke Width" value={draft.outlineWidth} min={0.5} max={20} step={0.5} field="outlineWidth" onUpdate={updateDraft}
          title="Thickness of the PCB board outline stroke (mils)" />
        <Slider label="Stroke Opacity" value={draft.outlineAlpha} min={0} max={1} step={0.05} field="outlineAlpha" onUpdate={updateDraft}
          title="Transparency of the board outline. 0 = invisible, 1 = fully opaque" />
        <Slider label="Board Fill" value={draft.boardFillAlpha} min={0} max={0.5} step={0.01} field="boardFillAlpha" onUpdate={updateDraft}
          title="Semi-transparent fill inside the board outline. Helps distinguish the PCB area from the background" />
      </CollapsibleSection>

      <CollapsibleSection id="parts" title="Parts / Components" isOpen={openSections.has('parts')}
        onToggle={toggleSection} sectionRef={partsRef} isFocused={focusedSection === 'parts'}>
        <Slider label="Border Width" value={draft.partBorderWidth} min={0.1} max={10} step={0.1} field="partBorderWidth" onUpdate={updateDraft}
          title="Thickness of component border outlines (mils). Always at least 1px on screen regardless of zoom" />
        <Slider label="Border Opacity" value={draft.partBorderAlpha} min={0} max={1} step={0.05} field="partBorderAlpha" onUpdate={updateDraft}
          title="Transparency of component border outlines. 0 = invisible, 1 = fully opaque" />
        <Slider label="Padding" value={draft.partPadding} min={0} max={30} step={1} field="partPadding" onUpdate={updateDraft}
          title="Extra space (mils) between component pins and the part border. Larger = more room around the IC/chip outline" />
        <Slider label="2-Pin Body Ratio" value={draft.partMinBodyRatio} min={0} max={1} step={0.01} field="partMinBodyRatio" onUpdate={updateDraft}
          title="Short-axis to pin-distance ratio for 2-pin parts (resistors, capacitors). 0.333 = 1:3 proportion. 0 = use file data as-is" />
        <Toggle label="Component Type Colors" value={draft.showComponentColors} field="showComponentColors" onUpdate={updateDraft}
          title="Fill component bodies with colors based on their type prefix (R = resistor, C = capacitor, U = IC, etc.). Colors are configured in Part Type Overrides" />
        <Slider label="Type Fill Opacity" value={draft.componentFillAlpha} min={0} max={1} step={0.05} field="componentFillAlpha" onUpdate={updateDraft}
          title="Transparency of the component type color fills. 0 = invisible, 1 = fully opaque" />
        <Toggle label="Show Part Labels" value={draft.showPartLabels} field="showPartLabels" onUpdate={updateDraft}
          title="Display component reference designators (e.g. U1, R100, C42) centered on each part" />
        <Toggle label="Label Drop Shadow" value={draft.partLabelShadow} field="partLabelShadow" onUpdate={updateDraft}
          title="Add a dark shadow halo behind part labels for better readability against colored or busy backgrounds" />
        <LabelSizeSelector draft={draft} onUpdate={updateDraft} />
      </CollapsibleSection>

      <CollapsibleSection id="pins" title="Pins / Pads" isOpen={openSections.has('pins')}
        onToggle={toggleSection} sectionRef={pinsRef} isFocused={focusedSection === 'pins'}>
        <Slider label="Min Radius" value={draft.pinMinRadius} min={1} max={20} step={0.5} field="pinMinRadius" onUpdate={updateDraft}
          title="Minimum pin circle radius (mils). All pins are rendered at least this size. Also the base size when Scale Factor = 0" />
        <Slider label="Max Radius" value={draft.pinMaxRadius} min={5} max={100} step={1} field="pinMaxRadius" onUpdate={updateDraft}
          title="Maximum pin circle radius (mils). Caps the visual size of large pins. On dense parts (BGA), pins are auto-clamped smaller to avoid overlap" />
        <Slider label="Scale Factor" value={draft.pinScaleFactor} min={0} max={3} step={0.1} field="pinScaleFactor" onUpdate={updateDraft}
          title="How much the file-specified pin radius affects rendered size. 0 = all pins identical (Min Radius). 1 = proportional to file data. >1 = exaggerated differences" />
        <Slider label="Fill Opacity" value={draft.pinAlpha} min={0} max={1} step={0.05} field="pinAlpha" onUpdate={updateDraft}
          title="Fill transparency of pin circles and rectangular pads. 0 = invisible, 1 = fully opaque" />
        <Toggle label="Show Pin Numbers" value={draft.showPinNumbers} field="showPinNumbers" onUpdate={updateDraft}
          title="Display pin number/name labels inside pin circles on multi-pin components (ICs, connectors). On BGA parts, numbers and net names alternate vertically to reduce overlap" />
        <Toggle label="Pin 1 Marker" value={draft.showPin1Marker} field="showPin1Marker" onUpdate={updateDraft}
          title="Highlight pin 1 with red color and a triangle indicator on multi-pin parts" />
        <Toggle label="Pin Label Background" value={draft.pinNetLabelBg} field="pinNetLabelBg" onUpdate={updateDraft}
          title="Draw a dark background plate behind net name labels on circle pins. Improves readability when labels overflow beyond the pin area" />
        <Toggle label="2-Pin Label Background" value={draft.twoPinNetLabelBg} field="twoPinNetLabelBg" onUpdate={updateDraft}
          title="Draw a dark background plate behind net name labels on 2-pin rectangular pads" />
        <Slider label="BGA Label Gap" value={draft.bgaLabelGapFactor} min={0} max={1} step={0.05} field="bgaLabelGapFactor" onUpdate={updateDraft}
          title="Vertical offset between pin number and net name labels on dense BGA parts, as a fraction of pin radius. On BGAs, pin numbers and net names alternate above/below the pin center to avoid overlap. Larger = more vertical separation" />
      </CollapsibleSection>

      <CollapsibleSection id="zoomLod" title="Zoom Level of Detail" isOpen={openSections.has('zoomLod')}
        onToggle={toggleSection} sectionRef={zoomLodRef} isFocused={focusedSection === 'zoomLod'}>
        <div className="color-rule-hint" style={{ marginBottom: 6 }}>Controls when text labels appear/disappear as you zoom. Higher = must zoom in more. At 100% zoom: 1 mil = 1 screen pixel.</div>
        <Slider label="Part Labels" value={draft.labelMinScreenPx} min={0} max={50} step={1} field="labelMinScreenPx" onUpdate={updateDraft}
          title="Part name labels (R1, U1, C42) appear when they reach this many screen pixels. At 100% zoom a medium (8 mil) label = 8px. Set to 10 to hide them below 125% zoom." />
        <Slider label="Pin Labels" value={draft.circleLabelMinScreenPx} min={0} max={50} step={1} field="circleLabelMinScreenPx" onUpdate={updateDraft}
          title="Pin numbers and net names on ICs/BGAs appear when they reach this many screen pixels. At 100% zoom a 6-mil pin label = 6px." />
        <Slider label="2-Pin Net Names" value={draft.twoPinLabelMinScreenPx} min={0} max={50} step={1} field="twoPinLabelMinScreenPx" onUpdate={updateDraft}
          title="Net names on resistors/capacitors (2-pin parts) appear when they reach this many screen pixels." />
        <Slider label="Label Cull (mils)" value={draft.labelHideThreshold} min={0} max={20} step={0.5} field="labelHideThreshold" onUpdate={updateDraft}
          title="Labels smaller than this (in board mils) are permanently removed from the scene — never drawn at any zoom. Saves GPU memory on dense boards." />
        <Slider label="Global Zoom Floor" value={draft.labelZoomHide} min={0} max={10} step={0.01} field="labelZoomHide" onUpdate={updateDraft}
          title="Hard minimum zoom level to show ANY text. 0 = disabled. All labels vanish below this zoom level." />
      </CollapsibleSection>

      <CollapsibleSection id="partTypeOverrides" title="Part Type Overrides" isOpen={openSections.has('partTypeOverrides')}
        onToggle={toggleSection} sectionRef={partTypeOverridesRef} isFocused={focusedSection === 'partTypeOverrides'}>
        <PartTypeOverridesSection overrides={draft.partTypeOverrides} actions={overrideActions} />
      </CollapsibleSection>

      <CollapsibleSection id="netColors" title="Pin Colors by Net" isOpen={openSections.has('netColors')}
        onToggle={toggleSection} sectionRef={netColorsRef} isFocused={focusedSection === 'netColors'}>
        <NetColorRulesSection rules={draft.netColorRules} ruleActions={ruleActions} />
        <div className="settings-subsection-label">No-Connect Patterns</div>
        <NcNetPatternsSection patterns={draft.ncNetPatterns} onChange={onNcPatternsChange} />
      </CollapsibleSection>

      <CollapsibleSection id="selection" title="Selection & Highlight" isOpen={openSections.has('selection')}
        onToggle={toggleSection} sectionRef={selectionRef} isFocused={focusedSection === 'selection'}>
        <Slider label="Selection Border" value={draft.selectionWidth} min={0.5} max={10} step={0.5} field="selectionWidth" onUpdate={updateDraft}
          title="Thickness of the yellow selection highlight outline around the selected component (mils)" />
        <Slider label="Selection Fill" value={draft.selectionFillAlpha} min={0} max={0.5} step={0.01} field="selectionFillAlpha" onUpdate={updateDraft}
          title="Brightness of the semi-transparent fill inside the selected component outline. 0 = no fill, higher = brighter" />
        <Slider label="Selection Padding" value={draft.selectionPadding} min={0} max={30} step={1} field="selectionPadding" onUpdate={updateDraft}
          title="Extra space (mils) around pins when drawing the selection highlight outline. Larger = selection box extends further beyond the component" />
        <Slider label="Net Highlight Ring" value={draft.netHighlightGrow} min={0} max={20} step={0.5} field="netHighlightGrow" onUpdate={updateDraft}
          title="How much larger (mils) the yellow net highlight circle is compared to the pin circle. Creates a visible ring around each pin in the selected net" />
        <Slider label="Highlight Ring Opacity" value={draft.netHighlightAlpha} min={0} max={1} step={0.05} field="netHighlightAlpha" onUpdate={updateDraft}
          title="Opacity of the yellow highlight ring around pins in the selected net. Higher = more visible ring" />
        <Slider label="Dim Overlay Strength" value={draft.dimOverlayAlpha} min={0} max={0.8} step={0.05} field="dimOverlayAlpha" onUpdate={updateDraft}
          title="Opacity of the black overlay that dims unselected areas when a net is highlighted. 0 = no dimming, higher = darker" />
        <Toggle label="Ambient Dim" value={draft.ambientDim} field="ambientDim" onUpdate={updateDraft}
          title="Always dim the board even when nothing is selected. Hovering over a pin punches through the overlay to reveal its net. Useful for high-contrast inspection" />
        <Toggle label="Floating Part Label" value={draft.showElevatedPartLabel} field="showElevatedPartLabel" onUpdate={updateDraft}
          title="Show a large background-backed label above the selected component with its reference designator (e.g. U1)" />
        <Toggle label="Floating Pin Label" value={draft.showElevatedPinLabel} field="showElevatedPinLabel" onUpdate={updateDraft}
          title="Show a background-backed label above the selected pin with its pin number and net name" />
        <Toggle label="Top Bar Overlay" value={draft.showSelectionOverlay} field="showSelectionOverlay" onUpdate={updateDraft}
          title="Show selected component and pin info in a text overlay bar at the top of the board viewport" />
      </CollapsibleSection>

      <CollapsibleSection id="netLines" title="Net Lines" isOpen={openSections.has('netLines')}
        onToggle={toggleSection} sectionRef={netLinesRef} isFocused={focusedSection === 'netLines'}>
        <Slider label="Line Width" value={draft.netLineWidth} min={0.5} max={5} step={0.5} field="netLineWidth" onUpdate={updateDraft}
          title="Thickness of the connection lines drawn between pins of the same net when a net is selected" />
        <Slider label="Line Opacity" value={draft.netLineAlpha} min={0} max={1} step={0.05} field="netLineAlpha" onUpdate={updateDraft}
          title="Transparency of net connection lines. 0 = invisible, 1 = fully opaque" />
        <Toggle label="Dashed Lines" value={draft.netLineDashed} field="netLineDashed" onUpdate={updateDraft}
          title="Draw net connection lines as dashed instead of solid. Easier to distinguish from board traces" />
        <Slider label="Dash Length" value={draft.netLineDashLength} min={2} max={20} step={1} field="netLineDashLength" onUpdate={updateDraft}
          title="Length of each dash segment (screen pixels) in the dashed net line pattern" />
        <Toggle label="Pulse Animation" value={draft.netLinePulse} field="netLinePulse" onUpdate={updateDraft}
          title="Animate net lines with a red traveling pulse effect, making the connection path easier to follow across the board" />
      </CollapsibleSection>

      <CollapsibleSection id="navigation" title="Navigation" isOpen={openSections.has('navigation')}
        onToggle={toggleSection} sectionRef={navigationRef} isFocused={focusedSection === 'navigation'}>
        <div className="settings-subsection-label">Scroll wheel behavior</div>
        <p className="settings-hint">Drag pills between slots to reassign scroll actions.</p>
        <BoardScrollBindingsEditor twoFingerPan={draft.twoFingerPan} onUpdate={updateDraft} />

        <div className="settings-subsection-label">Zoom</div>
        <Slider label="Wheel Smoothing" value={draft.wheelSmooth} min={1} max={20} step={1} field="wheelSmooth" onUpdate={updateDraft}
          title="Mouse wheel zoom smoothness. 1 = instant snap, higher = smoother animated zoom. Default: 5" />
        <Slider label="Fit Padding" value={draft.fitPadding} min={0} max={200} step={10} field="fitPadding" onUpdate={updateDraft}
          title="Extra padding (screen pixels) added when fitting the board to the viewport (Fit to Screen, double-click zoom). Prevents the board from touching viewport edges" />

        <div className="settings-subsection-label">Pan</div>
        <div className="settings-row settings-toggle-row" title="Continue panning with momentum after releasing a drag gesture. When disabled, panning stops immediately on release. Note: trackpad scroll momentum is controlled by your OS settings and cannot be disabled by the app">
          <label className="settings-label">Inertia</label>
          <input type="checkbox" checked={!draft.disableInertia}
            onChange={(e) => updateDraft({ disableInertia: !e.target.checked })} />
        </div>

        <div className="settings-subsection-label">Click</div>
        <Slider label="Pin Click Radius" value={draft.clickThreshold} min={5} max={100} step={5} field="clickThreshold" onUpdate={updateDraft}
          title="Maximum distance (screen pixels) from a pin center that counts as a click on that pin. Larger = easier to click small or densely packed pins" />
      </CollapsibleSection>

      <CollapsibleSection id="performance" title="Performance & Debug" isOpen={openSections.has('performance')}
        onToggle={toggleSection} sectionRef={performanceRef} isFocused={focusedSection === 'performance'}>
        <Toggle label="Hide Text During Zoom" value={draft.hideTextDuringZoom} field="hideTextDuringZoom" onUpdate={updateDraft}
          title="Temporarily hide all text labels while zooming or panning for smoother performance. Labels reappear when interaction stops" />
        <Toggle label="[Debug] Pad Vertex Crosshairs" value={draft.showPadVertices} field="showPadVertices" onUpdate={updateDraft}
          title="Draw magenta crosshair markers at each pin's exact coordinate from the board file. Useful for verifying parser accuracy" />
        <Toggle label="[Debug] Outline Vertex Numbers" value={draft.showVertexNumbers} field="showVertexNumbers" onUpdate={updateDraft}
          title="Show numbered markers at each board outline vertex. Yellow = unique, orange = duplicate coordinates. Works for all board formats" />
        <Toggle label="[Debug] Label Size Tiers" value={draft.showLabelSizeDebug} field="showLabelSizeDebug" onUpdate={updateDraft}
          title="Color part labels by their computed font-size tier: blue = small, yellow = medium, green = large. Useful for tuning the Small/Medium/Large size thresholds" />
      </CollapsibleSection>

      <CollapsibleSection id="formats" title="Supported Formats" isOpen={openSections.has('formats')}
        onToggle={toggleSection} sectionRef={formatsRef} isFocused={focusedSection === 'formats'}>
        <FormatSettingsTable />
      </CollapsibleSection>

      <CollapsibleSection id="pdf" title="PDF Viewer" isOpen={openSections.has('pdf')}
        onToggle={toggleSection} sectionRef={pdfRef} isFocused={focusedSection === 'pdf'}>
        <div className="settings-subsection-label">Render quality</div>
        <PdfQualitySelector />
        <div className="settings-subsection-label">Navigation</div>
        <PdfInertiaToggle />
        <div className="settings-subsection-label">Shortcuts (when PDF panel is active)</div>
        <div className="pdf-shortcuts-list">
          {shortcuts.filter(s => s.category === 'pdf').map(s => (
            <div key={s.id} className="shortcuts-row">
              <span className="shortcuts-label" title={s.description}>{s.label}</span>
              <kbd className="shortcuts-key">{formatShortcut(s.id)}</kbd>
            </div>
          ))}
        </div>
        <div className="settings-subsection-label">Scroll wheel behavior</div>
        <p className="settings-hint">Drag pills between slots to reassign scroll actions.</p>
        <ScrollBindingsEditor />
      </CollapsibleSection>

      <CollapsibleSection id="server" title="Server / Library" isOpen={openSections.has('server')}
        onToggle={toggleSection} sectionRef={serverRef} isFocused={focusedSection === 'server'}>
        <LibraryFolderSetting />
        <AutoScanToggle />
        <DatabaseInfoSection />
      </CollapsibleSection>

      <CollapsibleSection id="shortcuts" title="Keyboard Shortcuts" isOpen={openSections.has('shortcuts')}
        onToggle={toggleSection} sectionRef={shortcutsRef} isFocused={focusedSection === 'shortcuts'}>
        {(['file', 'view', 'navigation', 'pdf'] as const).map(cat => (
          <div key={cat} className="shortcuts-category">
            <div className="shortcuts-category-title">{cat[0].toUpperCase() + cat.slice(1)}</div>
            {shortcuts.filter(s => s.category === cat).map(s => (
              <div key={s.id} className="shortcuts-row">
                <span className="shortcuts-label" title={s.description}>{s.label}</span>
                <kbd className="shortcuts-key">{formatShortcut(s.id)}</kbd>
              </div>
            ))}
          </div>
        ))}
      </CollapsibleSection>

      <button className="settings-reset-btn" onClick={handleReset}
        title={isBoardMode ? 'Clear all board overrides — revert to global settings' : 'Reset all settings to defaults'}>
        {isBoardMode ? 'Reset to Global' : 'Reset to Defaults'}
      </button>
      </div>
      </OverrideContext.Provider>
    </div>
  );
}
