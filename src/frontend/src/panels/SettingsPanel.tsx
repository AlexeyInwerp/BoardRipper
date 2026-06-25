import { useState, useCallback, useRef, useMemo, useEffect, useSyncExternalStore, createContext, useContext } from 'react';
import { themeStore, THEMES, ACCENT_PRESETS } from '../store/themes';
import type { Theme } from '../store/themes';
import { renderSettingsStore, DEFAULTS, computeOverrides } from '../store/render-settings';
import { colorToHex, hexToColor } from '../store/layer-store';
import { StandaloneCollapsibleSection } from './settings/StandaloneCollapsibleSection';
import {
  SettingsSearchProvider,
  SettingsSearchBar,
  useFieldSearchState,
  useSectionSearchState,
  useSettingsSearch,
  recordRenderedField,
} from './settings/SettingsSearch';
import type { RenderSettings, PartType, PadShape, BodyShape, PinGroup, PinGroupRule } from '../store/render-settings';
import { SettingsMockup } from './SettingsMockup';
import { InterfaceScaleSlider } from '../components/InterfaceScaleSlider';
import type { MockupSectionId } from './SettingsMockup';
import { shortcuts, formatShortcut } from '../store/keyboard-shortcuts';
import { useBoardStore } from '../hooks/useBoardStore';
import { boardStore } from '../store/board-store';
import { startMcpBridge, stopMcpBridge } from '../store/mcp-bridge';
import { useDatabank } from '../hooks/useDatabank';
import { databankStore } from '../store/databank-store';
import { SCROLL_BINDINGS_KEY, SCROLL_ACTIONS, DEFAULT_SCROLL_BINDINGS, loadScrollBindings, PDF_QUALITY_KEY, PDF_RENDER_QUALITY_OPTIONS, loadPdfQuality, getPdfQualityConfig, PDF_INERTIA_KEY, loadPdfInertia } from './PdfViewerPanel';
import type { ScrollAction, ScrollBindings, PdfRenderQuality } from './PdfViewerPanel';
import { getDockviewApi } from '../store/dockview-api';
import { log } from '../store/log-store';
import { useObdForBoard } from '../store/obd-store';
import { LibrarySyncSection, SoftwareUpdateSection } from './LibrarySyncSection';
import { welcomeStore } from '../store/welcome-store';
import { OverlayCustomizer } from './settings/OverlayCustomizer';
import { pdfIndexClient } from '../pdf/pdf-index-client';
import { fmtIndexEta } from './LibraryPanel';
import { isElectron } from '../store/databank-store';

/** Silently disable the SettingsMockup render preview without removing
 *  it from the tree. Flip to true to bring the preview back in one line. */
const SHOW_MOCKUP_PREVIEW = false;

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

type SectionId = MockupSectionId | 'zoomLod' | 'netLines' | 'navigation' | 'performance' | 'shortcuts' | 'partTypeOverrides' | 'server' | 'dbinfo' | 'pdf' | 'boardOverlay';

export type SettingsTabId = 'theme' | 'board' | 'input' | 'library' | 'system' | 'integrations';

const TAB_ORDER: SettingsTabId[] = ['theme', 'board', 'input', 'library', 'system', 'integrations'];

const TAB_LABELS: Record<SettingsTabId, string> = {
  theme:        'Theme',
  board:        'Board',
  input:        'Input',
  library:      'Library',
  system:       'System',
  integrations: 'Integrations',
};

/** Maps each section id to the tab that owns it. Used by focusSection deep-links. */
export const SECTION_TO_TAB: Record<SectionId, SettingsTabId> = {
  // Board tab
  outline:           'board',
  parts:             'board',
  pins:              'board',
  partTypeOverrides: 'board',
  netColors:         'board',
  selection:         'board',
  netLines:          'board',
  boardOverlay:      'board',
  // Input tab
  zoomLod:    'input',
  navigation: 'input',
  shortcuts:  'input',
  // System tab
  performance: 'system',
  pdf:         'system',
  // Library folder + auto-scan + scan/index controls live on the Library tab.
  // The internal section id is still `server` for localStorage continuity
  // (`boardripper-settings-open-sections-*`) and focus refs. `dbinfo` is the
  // split-out database stats / dedup / reset block.
  server:      'library',
  dbinfo:      'library',
};

const ACTIVE_TAB_KEY = 'boardripper-settings-active-tab';

function loadActiveTab(): SettingsTabId {
  try {
    const raw = localStorage.getItem(ACTIVE_TAB_KEY);
    if (raw && TAB_ORDER.includes(raw as SettingsTabId)) return raw as SettingsTabId;
  } catch { /* ignore */ }
  return 'board';
}

function saveActiveTab(id: SettingsTabId) {
  try { localStorage.setItem(ACTIVE_TAB_KEY, id); } catch { /* ignore */ }
}

function openSectionsKey(tab: SettingsTabId): string {
  return `boardripper-settings-open-sections-${tab}`;
}

function loadOpenSections(tab: SettingsTabId): Set<SectionId> {
  // First visit to the Library tab: the everyday section (Scanning & Indexing)
  // starts open instead of a wall of collapsed headers.
  const fallback = (): Set<SectionId> =>
    tab === 'library' ? new Set<SectionId>(['server']) : new Set();
  try {
    const raw = localStorage.getItem(openSectionsKey(tab));
    if (!raw) return fallback();
    const parsed = JSON.parse(raw) as SectionId[];
    return new Set(parsed);
  } catch {
    return fallback();
  }
}

function saveOpenSections(tab: SettingsTabId, sections: Set<SectionId>) {
  try {
    localStorage.setItem(openSectionsKey(tab), JSON.stringify(Array.from(sections)));
  } catch { /* ignore */ }
}

type DraftUpdater = (partial: Partial<RenderSettings>) => void;

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
  // Section IDs are typed as SectionId but the search index uses the same
  // string set (plus a few extras for non-main-tab sections). Cast is safe
  // because the section ids are the same strings.
  const { hidden, forceOpen } = useSectionSearchState(id as Parameters<typeof useSectionSearchState>[0]);
  if (hidden) return null;
  const effectiveOpen = forceOpen || isOpen;
  return (
    <div
      ref={sectionRef}
      className={`settings-section${isFocused ? ' settings-section-focused' : ''}`}
    >
      <button className="settings-section-header" onClick={() => onToggle(id)}>
        <span className="settings-section-title">{title}</span>
        <span className="settings-section-chevron">{effectiveOpen ? '▾' : '▸'}</span>
      </button>
      {effectiveOpen && <div className="settings-section-body">{children}</div>}
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
  useEffect(() => { recordRenderedField(field); }, [field]);
  const { hidden, matched } = useFieldSearchState(field);
  if (hidden) return null;
  return (
    <div className={`settings-row${isOverride ? ' settings-override' : ''}${matched ? ' settings-search-match' : ''}`} title={title}>
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
  useEffect(() => { recordRenderedField(field); }, [field]);
  const { hidden, matched } = useFieldSearchState(field);
  if (hidden) return null;
  return (
    <div className={`settings-row settings-toggle-row${isOverride ? ' settings-override' : ''}${matched ? ' settings-search-match' : ''}`} title={title}>
      <label className="settings-label">{label}</label>
      <input type="checkbox" checked={value}
        onChange={(e) => onUpdate({ [field]: e.target.checked })}
        onDoubleClick={() => { const rv = ovReset ?? DEFAULTS[field] as boolean; onUpdate({ [field]: rv }); }}
      />
    </div>
  );
}


// ---- Part types (grouped component categories, issue #10) ----

type PartTypeActions = {
  update: (id: string, patch: Partial<PartType>) => void;
};

const PAD_SHAPES: PadShape[]  = ['natural', 'round', 'square'];
const BODY_SHAPES: BodyShape[] = ['natural', 'rect', 'square'];

function PartTypeRow({ type: t, actions, hideShapes }: { type: PartType; actions: PartTypeActions; hideShapes?: boolean }) {
  // Track the prefix text locally so the user can type commas/spaces freely.
  const [editPrefixes, setEditPrefixes] = useState(t.prefixes.join(', '));

  // Keep local text in sync if the parent list changes (e.g. reset). This is
  // the "Storing information from previous renders" pattern from the React
  // docs (https://react.dev/reference/react/useState#storing-information-from-previous-renders):
  // calling setState during render with a different value is allowed and
  // causes React to discard this render before commit — strictly better than
  // either an effect (cascading render) or a ref read (forbidden by R19).
  const joined = t.prefixes.join(', ');
  const [prevJoined, setPrevJoined] = useState(joined);
  if (prevJoined !== joined) {
    setPrevJoined(joined);
    setEditPrefixes(joined);
  }

  const commitPrefixes = () => {
    const parsed = editPrefixes
      .split(/[\s,]+/)
      .map(p => p.trim().toUpperCase())
      .filter(p => p.length > 0);
    // Deduplicate while preserving order.
    const seen = new Set<string>();
    const unique = parsed.filter(p => seen.has(p) ? false : (seen.add(p), true));
    if (unique.join(',') !== t.prefixes.join(',')) {
      actions.update(t.id, { prefixes: unique });
    }
    setEditPrefixes(unique.join(', '));
  };

  return (
    <div className="part-type-row">
      <span className="pt-label" title={t.id}>{t.label}</span>
      <input
        className="pt-prefixes-input"
        value={editPrefixes}
        onChange={e => setEditPrefixes(e.target.value)}
        onBlur={commitPrefixes}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        title="Comma-separated prefixes (e.g. R, PR, PH)"
        placeholder="R, PR, PH"
      />
      {!hideShapes && (
      <div className="pt-col-pad settings-btn-group">
        {PAD_SHAPES.map(shape => (
          <button key={shape}
            className={`settings-btn-option${t.padShape === shape ? ' active' : ''}`}
            onClick={() => actions.update(t.id, { padShape: shape })}
            title={shape}
          >
            {shape === 'natural' ? '~' : shape === 'round' ? '●' : '■'}
          </button>
        ))}
      </div>
      )}
      {!hideShapes && (
      <div className="pt-col-body settings-btn-group">
        {BODY_SHAPES.map(shape => (
          <button key={shape}
            className={`settings-btn-option${t.bodyShape === shape ? ' active' : ''}`}
            onClick={() => actions.update(t.id, { bodyShape: shape })}
            title={shape}
          >
            {shape === 'natural' ? '~' : shape === 'rect' ? '▭' : '□'}
          </button>
        ))}
      </div>
      )}
      <span className="pt-col-color">
        <input type="color" className="pto-color-input"
          value={t.color || '#000000'}
          onChange={e => actions.update(t.id, { color: e.target.value })}
        />
      </span>
      <span className="pt-col-hide">
        <input type="checkbox" checked={t.hidden}
          onChange={e => actions.update(t.id, { hidden: e.target.checked })}
        />
      </span>
      <span className="pt-col-bridge" title="Bridge nets through this type in hierarchical (chain + adjacent) net lines, even with more than 2 pins — e.g. 4-pin current-sense resistors, transistors.">
        <input type="checkbox" checked={t.hierarchyBridge}
          onChange={e => actions.update(t.id, { hierarchyBridge: e.target.checked })}
        />
      </span>
    </div>
  );
}

function PartTypesSection({ types, actions, hideShapes }: { types: PartType[]; actions: PartTypeActions; hideShapes?: boolean }) {
  return (
    <div className={`part-types${hideShapes ? ' compact' : ''}`}>
      <div className="part-types-header">
        <span>Type</span>
        <span>Prefixes</span>
        {!hideShapes && <span>Pads</span>}
        {!hideShapes && <span>Body</span>}
        <span>Fill</span>
        <span>Hide</span>
        <span title="Bridge nets through this type in hierarchical net lines, even with >2 pins.">Bridge</span>
      </div>
      {types.map(t => (
        <PartTypeRow key={t.id} type={t} actions={actions} hideShapes={hideShapes} />
      ))}
      <div className="color-rule-hint">Longest prefix wins across all types (e.g. FB beats F for FB1).</div>
      <div className="color-rule-hint">Bridge: carry hierarchical (chain + adjacent) net lines through &gt;2-pin parts of this type (e.g. current-sense resistors, transistors).</div>
    </div>
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

interface McpActivity { last_tool: string; last_tool_at_ms: number; total_calls: number; }
interface McpStatus { enabled: boolean; drive_ui: boolean; clients: number; activity?: McpActivity; auth_mode?: string; }

type McpClientId = 'claude-code' | 'claude-desktop' | 'cursor' | 'other';
const MCP_CLIENTS: { id: McpClientId; label: string; paste: string }[] = [
  { id: 'claude-code', label: 'Claude Code', paste: 'Run this in your terminal.' },
  { id: 'claude-desktop', label: 'Claude Desktop', paste: 'Add to claude_desktop_config.json, then restart Claude Desktop.' },
  { id: 'cursor', label: 'Cursor', paste: 'Add to ~/.cursor/mcp.json (or .cursor/mcp.json in your project).' },
  { id: 'other', label: 'Other', paste: 'Any MCP client over Streamable HTTP.' },
];

// oauth=true drops the bearer header — the client discovers the auth server and
// the user approves in the browser the first time (no token to copy).
function mcpSnippet(client: McpClientId, url: string, token: string, oauth: boolean): string {
  const t = token || '<enable the server to reveal the token>';
  switch (client) {
    case 'claude-code':
      return oauth
        ? `claude mcp add --transport http boardripper ${url}`
        : `claude mcp add --transport http boardripper ${url} --header "Authorization: Bearer ${t}"`;
    case 'claude-desktop':
      return JSON.stringify({
        mcpServers: {
          boardripper: oauth
            ? { command: 'npx', args: ['-y', 'mcp-remote', url] }
            : { command: 'npx', args: ['-y', 'mcp-remote', url, '--header', `Authorization: Bearer ${t}`] },
        },
      }, null, 2);
    case 'cursor':
      return JSON.stringify({
        mcpServers: { boardripper: oauth ? { url } : { url, headers: { Authorization: `Bearer ${t}` } } },
      }, null, 2);
    case 'other':
      return oauth
        ? `URL: ${url}\nAuth: OAuth 2.1 (the client discovers the auth server; approve in browser)`
        : `URL:    ${url}\nHeader: Authorization: Bearer ${t}`;
  }
}

function CopyButton({ text, disabled }: { text: string; disabled?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" className="library-tab" disabled={disabled}
      style={{ padding: '3px 10px', fontSize: 11 }}
      onClick={async () => {
        try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }
        catch { /* clipboard blocked */ }
      }}>
      {copied ? 'Copied ✓' : 'Copy'}
    </button>
  );
}

function McpLiveStatus({ status }: { status: McpStatus }) {
  const [test, setTest] = useState<{ ok: boolean; count?: number; error?: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const act = status.activity;
  const ago = act && act.last_tool_at_ms
    ? `${Math.max(0, Math.round((Date.now() - act.last_tool_at_ms) / 1000))}s ago`
    : null;
  return (
    <div style={{ marginTop: 8 }}>
      <div className="settings-row">
        <span className="settings-label">Connected pages</span>
        <span>{status.clients}</span>
      </div>
      <div className="settings-row">
        <span className="settings-label">Tool calls</span>
        <span>{act?.total_calls ?? 0}{act?.last_tool ? ` · last: ${act.last_tool}${ago ? ` (${ago})` : ''}` : ''}</span>
      </div>
      <div className="settings-row settings-toggle-row">
        <button type="button" className="library-tab" disabled={testing}
          onClick={async () => {
            setTesting(true);
            try {
              const r = await fetch('/api/mcp/selftest', { method: 'POST' });
              setTest(await r.json());
            } catch (e: any) { setTest({ ok: false, error: String(e?.message ?? e) }); }
            setTesting(false);
          }}>
          {testing ? 'Testing…' : 'Test connection'}
        </button>
        {test && (
          <span style={{ fontSize: 12, color: test.ok ? 'var(--accent, #4ade80)' : '#f87171' }}>
            {test.ok ? `✓ responding · ${test.count} tools` : `✗ ${test.error ?? 'failed'}`}
          </span>
        )}
      </div>
    </div>
  );
}

function IntegrationsSection() {
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [token, setToken] = useState('');
  const [client, setClient] = useState<McpClientId>('claude-code');

  const refresh = useCallback(() => {
    fetch('/api/mcp/status')
      .then(r => r.ok ? r.json() : null)
      .then((s: McpStatus | null) => setStatus(s))
      .catch(() => setStatus(null));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (!status?.enabled) { setToken(''); return; }
    fetch('/api/mcp/token')
      .then(r => r.ok ? r.json() : { token: '' })
      .then((d: { token?: string }) => setToken(d.token ?? ''))
      .catch(() => setToken(''));
  }, [status?.enabled]);

  // Poll status while enabled so connected pages + tool activity update live.
  useEffect(() => {
    if (!status?.enabled) return;
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [status?.enabled, refresh]);

  const setFlag = async (key: 'mcp_enabled' | 'mcp_drive_ui', on: boolean) => {
    setStatus(s => s ? { ...s, [key === 'mcp_enabled' ? 'enabled' : 'drive_ui']: on } : s);
    try {
      await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value: on ? 'true' : '' }),
      });
    } catch { /* ignore */ }
    if (key === 'mcp_enabled') {
      if (on) startMcpBridge();
      else stopMcpBridge(); // tear the bridge down immediately; don't reconnect
    }
    refresh();
  };

  const setAuthMode = async (mode: 'token' | 'oauth') => {
    setStatus(s => s ? { ...s, auth_mode: mode } : s);
    try {
      await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'mcp_auth_mode', value: mode }),
      });
    } catch { /* ignore */ }
    refresh();
  };

  const enabled = !!status?.enabled;
  const oauth = status?.auth_mode === 'oauth';
  const url = `${location.protocol}//${location.host}/api/mcp`;
  const snippet = mcpSnippet(client, url, token, oauth);
  const activeClient = MCP_CLIENTS.find(c => c.id === client)!;

  return (
    <div className="settings-tab-body">
      <StandaloneCollapsibleSection title="MCP server (AI agents)" defaultOpen storageKey="mcp">
        <p className="settings-hint">
          Let an AI agent (Claude Code, Claude Desktop, Cursor, or any MCP client) query
          this BoardRipper — PDF full-text search, OpenBoardData readings, the board
          reference DB, and the live connectivity of whatever board you have open — and
          drive the view. Off by default.
        </p>
        <div className="settings-row settings-toggle-row">
          <label className="settings-label">Enable MCP server</label>
          <input type="checkbox" checked={enabled}
            onChange={e => setFlag('mcp_enabled', e.target.checked)} />
        </div>
        <div className="settings-row settings-toggle-row">
          <label className="settings-label" title="Lets agents highlight nets, select parts, change side, and navigate PDFs on the open board">
            Allow agents to control the UI
          </label>
          <input type="checkbox" checked={!!status?.drive_ui} disabled={!enabled}
            onChange={e => setFlag('mcp_drive_ui', e.target.checked)} />
        </div>

        {enabled && (
          <>
            <McpLiveStatus status={status!} />

            <p className="settings-hint" style={{ margin: '12px 0 4px' }}>Authentication:</p>
            <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
              <button type="button" className={`library-tab ${!oauth ? 'active' : ''}`}
                onClick={() => setAuthMode('token')}>Token</button>
              <button type="button" className={`library-tab ${oauth ? 'active' : ''}`}
                onClick={() => setAuthMode('oauth')}>OAuth (no token)</button>
            </div>
            <p className="settings-hint" style={{ margin: '0 0 8px' }}>
              {oauth
                ? 'Clients connect with just the URL and approve access in the browser the first time — no token to copy.'
                : 'Clients authenticate with the bearer token below.'}
            </p>

            <p className="settings-hint" style={{ margin: '12px 0 4px' }}>Connect a client:</p>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 }}>
              {MCP_CLIENTS.map(c => (
                <button key={c.id} type="button"
                  className={`library-tab ${client === c.id ? 'active' : ''}`}
                  onClick={() => setClient(c.id)}>{c.label}</button>
              ))}
            </div>
            <p className="settings-hint" style={{ margin: '0 0 4px' }}>{activeClient.paste}</p>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
              <pre className="mcp-connect-cmd" style={{
                whiteSpace: 'pre-wrap', wordBreak: 'break-all', userSelect: 'all',
                fontSize: 11, padding: '8px 10px', borderRadius: 6, margin: 0, flex: 1,
                background: 'var(--panel-alt, rgba(0,0,0,0.25))',
              }}>{snippet}</pre>
              <CopyButton text={snippet} />
            </div>
          </>
        )}
      </StandaloneCollapsibleSection>
    </div>
  );
}

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
  const { stats, scanStatus, backendAvailable, electronMode, pdfIndexStats, pdfIndexProgress, dedupProgress, dedupStats } = useDatabank();
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    if (!electronMode && backendAvailable) {
      databankStore.fetchStats();
      // Refresh PDF-index stats + progress on open (one-shot stats at boot go
      // stale otherwise). fetchPdfIndexStats also starts the 1.5s poll if a
      // bulk index is currently running, so the indicator stays live.
      databankStore.fetchPdfIndexStats();
      // Same for dedup: refresh stats on open and resume polling if a pass is
      // already running so the panel re-attaches to live progress.
      databankStore.fetchDedupStats();
    }
  }, [backendAvailable, electronMode]);

  if (electronMode || !backendAvailable) return null;

  const isRunning = scanStatus?.running;

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
            <span>{pdfIndexStats?.pages ?? 0}</span>
          </div>
          <div className="settings-row settings-toggle-row">
            <label className="settings-label">PDF index status</label>
            <span>
              {pdfIndexProgress?.running
                ? `Indexing ${pdfIndexProgress.done}/${pdfIndexProgress.total}`
                  + (pdfIndexProgress.workers > 0 ? ` · ${pdfIndexProgress.active_workers}/${pdfIndexProgress.workers} threads` : '')
                  + (pdfIndexProgress.errors > 0 ? ` (${pdfIndexProgress.errors} err)` : '')
                  + (fmtIndexEta(pdfIndexProgress) ? ` · ${fmtIndexEta(pdfIndexProgress)}` : '')
                : pdfIndexStats
                  ? `Idle — ${pdfIndexStats.indexed} indexed, ${pdfIndexStats.pending} pending`
                  : '—'}
            </span>
          </div>
          {pdfIndexProgress?.running && pdfIndexProgress.current_file && (
            <div className="settings-row settings-toggle-row">
              <label className="settings-label">Current file</label>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '60%', direction: 'rtl' }} title={pdfIndexProgress.current_file}>
                {pdfIndexProgress.current_file}
              </span>
            </div>
          )}
          {(pdfIndexStats?.failed ?? 0) > 0 && (
            <div className="settings-row settings-toggle-row">
              <label className="settings-label">PDF index errors</label>
              <span>{pdfIndexStats!.failed}</span>
            </div>
          )}
          <div className="settings-row settings-toggle-row">
            <label className="settings-label">Duplicate content</label>
            <span>
              {dedupProgress?.running
                ? `Finding duplicates ${dedupProgress.done}/${dedupProgress.total}`
                  + (dedupProgress.errors > 0 ? ` (${dedupProgress.errors} err)` : '')
                : dedupStats
                  ? `${dedupStats.groups} duplicate group${dedupStats.groups === 1 ? '' : 's'} · ${dedupStats.duplicate_files} redundant cop${dedupStats.duplicate_files === 1 ? 'y' : 'ies'}`
                  : '—'}
            </span>
          </div>
          <div className="settings-row settings-toggle-row">
            <label className="settings-label">Database size</label>
            <span>{formatBytes(stats.db_size_bytes)}</span>
          </div>
          <div className="settings-row settings-toggle-row">
            <label className="settings-label">Last file scan</label>
            <span>{formatDate(stats.last_file_scan_at)}</span>
          </div>
        </>
      )}
      <div className="settings-db-actions" style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          className="settings-action-btn"
          onClick={openDatabaseEditor}
          title="Open the read-only Database Editor in a Dockview panel"
        >
          Open Database Editor
        </button>
        {dedupProgress?.running ? (
          <button
            className="settings-action-btn"
            onClick={() => databankStore.stopDedup()}
            title="Stop the duplicate-finding pass"
          >
            Stop ({dedupProgress.done}/{dedupProgress.total})
          </button>
        ) : (
          <button
            className="settings-action-btn"
            onClick={() => databankStore.runDedup()}
            disabled={!!isRunning}
            title="Hash size-colliding files and group byte-identical duplicates"
          >
            Find duplicates
          </button>
        )}
        <button
          className="settings-action-btn"
          onClick={handleResetPdf}
          disabled={resetting}
          title="Wipe extracted PDF text — keeps file index and bindings. Independent of the file scan; the backend stops the indexer before wiping."
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

/** Open (or focus, if already open) the read-only Database Editor panel.
 *  Uses a stable id so repeated clicks reactivate instead of stacking duplicates. */
function openDatabaseEditor(): void {
  try {
    const api = getDockviewApi();
    if (!api) return;
    const id = 'database-editor';
    const existing = api.getPanel(id);
    if (existing) {
      existing.api.setActive();
      return;
    }
    api.addPanel({
      id,
      component: 'databaseEditor',
      title: 'Database Editor',
    });
  } catch (err) {
    log.ui.error('Failed to open Database Editor panel:', err);
  }
}

// ---- Library settings (auto-pdf, history depth, clear history) ----

function LibrarySettingsSection() {
  const { autoPdf, historyDepth, recentItems, scanStatus, pdfIndexProgress, pdfIndexStats } = useDatabank();
  const [depthDraft, setDepthDraft] = useState<string>(String(historyDepth));
  const scanRunning = scanStatus?.running ?? false;
  const pdfIndexRunning = pdfIndexProgress?.running ?? false;
  const [forcing, setForcing] = useState(false);

  // Live indexer numbers. `pdfIndexProgress` is the running snapshot
  // (done/total/active workers/current file/started_at); `pdfIndexStats`
  // is the steady-state aggregate (indexed/pages/failed/pending). Show
  // both depending on running state.
  const indexPct = pdfIndexProgress && pdfIndexProgress.total > 0
    ? Math.round((pdfIndexProgress.done / pdfIndexProgress.total) * 100)
    : 0;
  const indexEta = pdfIndexProgress ? fmtIndexEta(pdfIndexProgress) : '';

  const handleForceReindex = useCallback(async () => {
    if (forcing) return;
    if (!confirm(
      'Force re-index ALL PDFs?\n\n' +
      'This resets every status row (indexed / empty / failed) back to "pending" and re-extracts text from scratch. ' +
      'Use this only after changing the watermark term list or upgrading the indexer. ' +
      'It takes hours on a large library and is NOT what you want for a regular rescan — for that, "Index all PDFs" is already additive.',
    )) return;
    setForcing(true);
    try {
      await pdfIndexClient.reindex('all');
      databankStore.startPdfIndexPolling();
    } finally {
      setForcing(false);
    }
  }, [forcing]);

  // Keep local draft in sync when the stored value changes externally
  useEffect(() => {
    setDepthDraft(String(historyDepth));
  }, [historyDepth]);

  const commitDepth = () => {
    const n = Math.floor(Number(depthDraft));
    if (!Number.isFinite(n) || n < 1) { setDepthDraft(String(historyDepth)); return; }
    databankStore.setHistoryDepth(n);
  };

  return (
    <div className="settings-subsection">
      <div className="settings-subsection-label">Library</div>

      {/* Scan / index actions — moved from the Library panel statsbar so the
       *  panel chrome stays focused on browsing. */}
      <div className="settings-row-field">
        <span>Scan boards & PDFs</span>
        {scanRunning ? (
          <button
            className="settings-action-btn"
            onClick={() => databankStore.stopScan()}
          >
            Stop scan
          </button>
        ) : (
          <button
            className="settings-action-btn"
            onClick={() => databankStore.triggerFileScan()}
          >
            Scan now
          </button>
        )}
      </div>

      {/* PDF text indexing — verbose status when running, summary when idle.
       *  The "Index all PDFs" trigger is additive (processes only `pending`
       *  rows); the separate Force row below resets every row first. */}
      <div className="settings-pdfindex-card">
        <div className="settings-pdfindex-header">
          <span className="settings-pdfindex-label">PDF text indexing</span>
          {pdfIndexRunning ? (
            <button
              className="settings-action-btn settings-pdfindex-stop"
              onClick={() => pdfIndexClient.stop()}
              title="Stop the indexer. Files already in progress finish their current page; the rest stay as pending and resume on the next run."
            >
              Stop
            </button>
          ) : (
            <button
              className="settings-action-btn"
              onClick={() => { void pdfIndexClient.run(); databankStore.startPdfIndexPolling(); }}
            >
              Index all PDFs
            </button>
          )}
        </div>

        {pdfIndexRunning && pdfIndexProgress ? (
          <>
            <div className="settings-pdfindex-bar">
              <div className="settings-pdfindex-fill" style={{ width: `${indexPct}%` }} />
            </div>
            <div className="settings-pdfindex-stats">
              <span>{pdfIndexProgress.done.toLocaleString()} / {pdfIndexProgress.total.toLocaleString()} ({indexPct}%)</span>
              {pdfIndexProgress.workers > 0 && (
                <span> · {pdfIndexProgress.active_workers}/{pdfIndexProgress.workers} threads</span>
              )}
              {pdfIndexProgress.errors > 0 && (
                <span className="settings-pdfindex-err"> · {pdfIndexProgress.errors} err</span>
              )}
              {indexEta && <span> · {indexEta}</span>}
            </div>
            {pdfIndexProgress.current_file && (
              <div className="settings-pdfindex-file" title={pdfIndexProgress.current_file}>
                {pdfIndexProgress.current_file}
              </div>
            )}
          </>
        ) : pdfIndexStats ? (
          <div className="settings-pdfindex-stats">
            <span>{pdfIndexStats.indexed.toLocaleString()} indexed</span>
            <span> · {pdfIndexStats.pages.toLocaleString()} pages</span>
            {pdfIndexStats.pending > 0 && <span> · {pdfIndexStats.pending.toLocaleString()} pending</span>}
            {pdfIndexStats.failed > 0 && (
              <span className="settings-pdfindex-err"> · {pdfIndexStats.failed} failed</span>
            )}
          </div>
        ) : null}
      </div>

      <div className="settings-row-field">
        <span title="Resets every PDF status row back to pending and re-extracts text from scratch. Hours on a large library — use only after changing the watermark term list or upgrading the indexer.">
          Force re-index everything
        </span>
        <button
          className="settings-action-btn settings-action-danger"
          disabled={forcing || pdfIndexRunning}
          onClick={handleForceReindex}
        >
          {forcing ? '…' : 'Force re-index'}
        </button>
      </div>

      <label className="settings-row-toggle">
        <input
          type="checkbox"
          checked={autoPdf}
          onChange={(e) => databankStore.setAutoPdf(e.target.checked)}
        />
        <span>Auto-load bound PDFs when opening a board</span>
      </label>

      <label className="settings-row-field">
        <span>Recent history depth</span>
        <input
          type="number"
          min={1}
          max={100}
          step={1}
          value={depthDraft}
          onChange={(e) => setDepthDraft(e.target.value)}
          onBlur={commitDepth}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        />
      </label>

      <div className="settings-row-field">
        <span>Recent history ({recentItems.length} item{recentItems.length === 1 ? '' : 's'})</span>
        <button
          className="settings-action-btn"
          disabled={recentItems.length === 0}
          onClick={() => databankStore.clearHistory()}
        >
          Clear
        </button>
      </div>
    </div>
  );
}

// ---- PDF Scroll Bindings Editor (drag-and-drop) ----

// PDF scroll bindings editor. Mirrored on the home dashboard in
// components/home/HomeBackdrop.tsx (PdfScrollBindings). Keep labels
// and colors identical across both surfaces.
const MODIFIER_KEYS: (keyof ScrollBindings)[] = ['bare', 'shift', 'meta'];
const MODIFIER_LABELS: Record<keyof ScrollBindings, React.ReactNode> = {
  bare: 'Scroll',
  shift: <>Shift + Scroll<br/>Ctrl + Scroll (fast)</>,
  meta: navigator.platform?.includes('Mac') ? '⌘ + Scroll' : 'Ctrl + Scroll',
};
const ACTION_LABELS: Record<ScrollAction, string> = { zoom: 'Zoom', pan: 'Pan', switch: 'Page' };
const ACTION_COLORS: Record<ScrollAction, string> = { zoom: '#00d4ff', pan: '#ffd93d', switch: '#ff6b9d' };

function ScrollBindingsEditor() {
  const [bindings, setBindings] = useState<ScrollBindings>(loadScrollBindings);
  const [dragging, setDragging] = useState<ScrollAction | null>(null);
  const [dragOver, setDragOver] = useState<keyof ScrollBindings | null>(null);

  // Re-sync when any other surface (HomeBackdrop, WelcomeSetup, DebugPanel,
  // PDF toolbar swap) changes the bindings while this editor is mounted —
  // otherwise the pills show stale state and a drag persists wrong swaps.
  useEffect(() => {
    const onChange = () => setBindings(loadScrollBindings());
    window.addEventListener('pdf-scroll-bindings-changed', onChange);
    return () => window.removeEventListener('pdf-scroll-bindings-changed', onChange);
  }, []);

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
      {(bindings.bare !== DEFAULT_SCROLL_BINDINGS.bare
        || bindings.shift !== DEFAULT_SCROLL_BINDINGS.shift
        || bindings.meta !== DEFAULT_SCROLL_BINDINGS.meta) && (
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

// Derived from QUALITY_CONFIGS so the copy can't drift from the real caps.
function qualityDescription(q: PdfRenderQuality): string {
  const t = getPdfQualityConfig(q).maxMainTier;
  switch (q) {
    case 'max':    return `Pixel-perfect up to ${t}× zoom. High GPU usage. Desktop with dedicated GPU.`;
    case 'high':   return `Crisp text up to ${t}× zoom. Good for modern laptops.`;
    case 'medium': return `Softens above ${t}× zoom. Smooth on integrated GPUs and tablets.`;
    case 'low':    return `Softens above ${t}× zoom. Best for older machines or battery saving.`;
  }
}

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
            title={qualityDescription(q)}
          >
            {QUALITY_LABELS[q]}
          </button>
        ))}
      </div>
      <p className="settings-hint">{qualityDescription(quality)}</p>
      <div className="pdf-quality-details">
        <span>Main tier: {cfg.maxMainTier}× | Adj tier: {cfg.maxAdjTier}× | Cache: {cfg.cacheMaxEntries} pages / {Math.round(cfg.cacheMaxPixels / 1_000_000)}MP</span>
      </div>
    </div>
  );
}

// ---- PDF render mode selector ----

const RENDER_MODE_LABELS: Record<'auto' | 'standard' | 'always-tile', string> = {
  auto: 'Auto',
  standard: 'Standard',
  'always-tile': 'Always tile',
};

const RENDER_MODE_DESCRIPTIONS: Record<'auto' | 'standard' | 'always-tile', string> = {
  auto: 'Tile above 1.05× zoom for crisp text at deep zoom. Full page below.',
  standard: 'Always render the full page into one canvas (Firefox-style). Smoother during pinch/zoom; pixels go soft past ~5–6× zoom on A4. Default.',
  'always-tile': 'Always tile. Mostly an escape hatch for debugging — rarely useful.',
};

function PdfRenderModeSelector() {
  const mode = useSyncExternalStore(
    cb => renderSettingsStore.subscribe(cb),
    () => renderSettingsStore.settings.pdfRenderMode,
  );

  const handleChange = useCallback((next: 'auto' | 'standard' | 'always-tile') => {
    renderSettingsStore.setPdfRenderMode(next);
  }, []);

  return (
    <div className="pdf-quality-selector">
      <div className="settings-btn-group">
        {(['auto', 'standard', 'always-tile'] as const).map(m => (
          <button
            key={m}
            className={`settings-btn-option${mode === m ? ' active' : ''}`}
            onClick={() => handleChange(m)}
            title={RENDER_MODE_DESCRIPTIONS[m]}
          >
            {RENDER_MODE_LABELS[m]}
          </button>
        ))}
      </div>
      <p className="settings-hint">{RENDER_MODE_DESCRIPTIONS[mode]}</p>
    </div>
  );
}

/** Format the stored filter array into a textarea-friendly string (one term per line). */
function formatWatermarkFilter(terms: string[]): string {
  return terms.join('\n');
}

/** Parse a textarea value into normalised filter terms (split on newline OR comma). */
function parseWatermarkFilter(raw: string): string[] {
  return raw.split(/[\n,]/).map(t => t.trim()).filter(t => t.length > 0);
}

/** Push the current watermark term list to the backend config endpoint.
 *  No-op in Electron mode (no backend available). Fire-and-forget — errors
 *  are silently dropped (the backend key is advisory for the pdfium indexer). */
function pushWatermarkTermsToBackend(terms: string[]): void {
  if (isElectron()) return;
  void fetch('/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'pdf_watermark_terms', value: JSON.stringify(terms) }),
  }).catch(() => { /* best-effort */ });
}

function PdfWatermarkFilterEditor() {
  const storedTerms = renderSettingsStore.globalSettings.pdfWatermarkFilter;
  const [value, setValue] = useState(() => formatWatermarkFilter(storedTerms));
  // Track the terms that were committed while this editor instance was mounted.
  // Used to detect when the list changed so we can surface the reindex prompt.
  const committedRef = useRef<string[]>(storedTerms);
  const [showReindex, setShowReindex] = useState(false);
  const [reindexing, setReindexing] = useState(false);

  // Dirty when the textarea would commit to a different terms list than what's stored.
  const pendingTerms = parseWatermarkFilter(value);
  const dirty =
    pendingTerms.length !== storedTerms.length ||
    pendingTerms.some((t, i) => t !== storedTerms[i]);

  const commit = useCallback(() => {
    const current = renderSettingsStore.globalSnapshot();
    const next = parseWatermarkFilter(value);
    renderSettingsStore.applyGlobal({ ...current, pdfWatermarkFilter: next });
    // Normalise the textarea to the canonical form so the dirty flag clears.
    setValue(formatWatermarkFilter(next));

    // Push to backend so the pdfium indexer uses the same terms.
    pushWatermarkTermsToBackend(next);

    // Detect whether the committed terms changed vs the last commit.
    const prev = committedRef.current;
    const changed = next.length !== prev.length || next.some((t, i) => t !== prev[i]);
    committedRef.current = next;
    if (changed) setShowReindex(true);
  }, [value]);

  const revert = useCallback(() => {
    setValue(formatWatermarkFilter(storedTerms));
  }, [storedTerms]);

  const handleReindex = useCallback(async () => {
    setReindexing(true);
    try {
      await pdfIndexClient.reindexWatermark();
      databankStore.startPdfIndexPolling();
      boardStore.addToast('Re-indexing PDFs with updated watermark terms…', 'info');
    } catch {
      boardStore.addToast('Failed to start reindex — check backend connection.', 'error');
    } finally {
      setReindexing(false);
      setShowReindex(false);
    }
  }, []);

  return (
    <div className="pdf-watermark-filter">
      <textarea
        className="settings-text-input pdf-watermark-textarea"
        rows={4}
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => {
          // Ctrl / Cmd + Enter = save (plain Enter inserts a newline)
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            commit();
          }
        }}
        placeholder={'One term per line\n(commas also accepted)'}
        spellCheck={false}
      />
      <div className="pdf-watermark-actions">
        <button
          type="button"
          className="settings-btn-option pdf-watermark-save"
          onClick={commit}
          disabled={!dirty}
          title={dirty ? 'Save watermark filter (Ctrl/Cmd + Enter)' : 'No unsaved changes'}
        >
          {dirty ? 'Save' : 'Saved'}
        </button>
        {dirty && (
          <button
            type="button"
            className="settings-btn-option pdf-watermark-revert"
            onClick={revert}
            title="Discard changes"
          >
            Revert
          </button>
        )}
      </div>
      {showReindex && !isElectron() && (
        <div className="pdf-watermark-reindex-prompt">
          <span className="pdf-watermark-reindex-hint">
            Watermark terms changed — reindex PDFs to apply?
          </span>
          <button
            type="button"
            className="settings-btn-option pdf-watermark-reindex-btn"
            onClick={handleReindex}
            disabled={reindexing}
            title="Reset and re-run PDF text indexing with the new watermark terms"
          >
            {reindexing ? 'Starting…' : 'Reindex PDFs'}
          </button>
          <button
            type="button"
            className="settings-btn-option pdf-watermark-reindex-dismiss"
            onClick={() => setShowReindex(false)}
            title="Dismiss — reindex later"
          >
            Dismiss
          </button>
        </div>
      )}
      <p className="settings-hint">
        One term per line (or comma-separated). Matches ignore case and whitespace,
        so "www.chinafix.com" catches "w w w . c h i n a f i x . c o m". Matching
        text is erased before rendering. Press Ctrl/Cmd + Enter to save.
      </p>
    </div>
  );
}

// ---- Board scroll bindings editor (drag-and-drop pills) ----
//
// ⚠ Keep labels / colors / actions in sync with the home dashboard
//   editors in src/frontend/src/components/home/HomeBackdrop.tsx
//   (PillSwap + DragBindings + ScrollBindings + PdfScrollBindings).
//   Both surfaces render the same state and must show identical pills.

type BoardScrollAction = 'zoom' | 'pan';
const BOARD_ACTIONS: BoardScrollAction[] = ['zoom', 'pan'];
const BOARD_ACTION_LABELS: Record<BoardScrollAction, string> = { zoom: 'Zoom', pan: 'Pan' };
const BOARD_ACTION_COLORS: Record<BoardScrollAction, string> = { zoom: '#00d4ff', pan: '#ffd93d' };

const BOARD_MODIFIER_KEYS = ['bare', 'shift'] as const;
type BoardModifier = typeof BOARD_MODIFIER_KEYS[number];
const BOARD_MODIFIER_LABELS: Record<BoardModifier, React.ReactNode> = {
  bare: 'Scroll',
  shift: <>Shift + Scroll<br/>Ctrl + Scroll (fast)</>,
};

function BoardScrollBindingsEditor({ twoFingerPan, onUpdate }: { twoFingerPan: boolean; onUpdate: DraftUpdater }) {
  // Derive bindings from twoFingerPan: bare=pan when twoFingerPan, else bare=zoom.
  // Memoized on the primitive `twoFingerPan` so handleDrop's useCallback below
  // (which closes over `bindings`) keeps a stable identity across renders.
  const bindings = useMemo<Record<BoardModifier, BoardScrollAction>>(() => ({
    bare: twoFingerPan ? 'pan' : 'zoom',
    shift: twoFingerPan ? 'zoom' : 'pan',
  }), [twoFingerPan]);

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
    </div>
  );
}

// ---- Board drag bindings editor ----

type BoardDragAction = 'pan' | 'zoom';
const BOARD_DRAG_ACTIONS: BoardDragAction[] = ['pan', 'zoom'];

const BOARD_DRAG_MODIFIER_KEYS = ['bare', 'shift'] as const;
type BoardDragModifier = typeof BOARD_DRAG_MODIFIER_KEYS[number];
const BOARD_DRAG_MODIFIER_LABELS: Record<BoardDragModifier, React.ReactNode> = {
  bare: 'Left-drag',
  shift: 'Shift + Left-drag',
};

function BoardDragBindingsEditor({ dragToZoom, onUpdate }: { dragToZoom: boolean; onUpdate: DraftUpdater }) {
  // Derive bindings: bare=zoom when dragToZoom, else bare=pan
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const bindings: Record<BoardDragModifier, BoardDragAction> = {
    bare: dragToZoom ? 'zoom' : 'pan',
    shift: dragToZoom ? 'pan' : 'zoom',
  };

  const [dragging, setDragging] = useState<BoardDragAction | null>(null);
  const [dragOver, setDragOver] = useState<BoardDragModifier | null>(null);

  const handleDragStart = useCallback((e: React.DragEvent, action: BoardDragAction) => {
    setDragging(action);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', action);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, slot: BoardDragModifier) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOver(slot);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, targetSlot: BoardDragModifier) => {
    e.preventDefault();
    setDragOver(null);
    setDragging(null);
    const action = e.dataTransfer.getData('text/plain') as BoardDragAction;
    if (!BOARD_DRAG_ACTIONS.includes(action)) return;
    const sourceSlot = BOARD_DRAG_MODIFIER_KEYS.find(k => bindings[k] === action);
    if (!sourceSlot || sourceSlot === targetSlot) return;
    // Swapping bare and shift means toggling dragToZoom
    onUpdate({ dragToZoom: targetSlot === 'bare' && action === 'zoom' });
  }, [bindings, onUpdate]);

  const handleDragEnd = useCallback(() => { setDragging(null); setDragOver(null); }, []);

  return (
    <div className="scroll-bindings-editor">
      <div className="scroll-bindings-grid">
        {BOARD_DRAG_MODIFIER_KEYS.map(slot => {
          const action = bindings[slot];
          const isOver = dragOver === slot;
          return (
            <div key={slot} className={`scroll-binding-slot${isOver ? ' drag-over' : ''}`}
              onDragOver={e => handleDragOver(e, slot)}
              onDragLeave={() => setDragOver(null)}
              onDrop={e => handleDrop(e, slot)}>
              <span className="scroll-binding-modifier">{BOARD_DRAG_MODIFIER_LABELS[slot]}</span>
              <span
                className={`scroll-binding-pill${dragging === action ? ' dragging' : ''}`}
                style={{ '--pill-color': BOARD_ACTION_COLORS[action as BoardScrollAction] } as React.CSSProperties}
                draggable onDragStart={e => handleDragStart(e, action)} onDragEnd={handleDragEnd}>
                {BOARD_ACTION_LABELS[action as BoardScrollAction]}
              </span>
            </div>
          );
        })}
      </div>
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

type SettingsMode = 'global' | 'board';

/**
 * Prominent cache-control bar at the top of the Settings panel. Three
 * scoped actions so the user doesn't have to wipe the whole database to
 * see the effect of a parser fix or a stale render.
 */
function CacheControlBar({ hasBoard }: { hasBoard: boolean }) {
  const [busy, setBusy] = useState<null | 'reparse' | 'boards' | 'pdf'>(null);

  const run = async (tag: 'reparse' | 'boards' | 'pdf', fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(tag);
    try { await fn(); } finally { setBusy(null); }
  };

  return (
    <div className="settings-cache-bar" role="group" aria-label="Cache control">
      <div className="settings-cache-bar-title">Cache</div>
      <div className="settings-cache-bar-buttons">
        <button
          className="settings-cache-btn"
          onClick={() => run('reparse', () => boardStore.reparseActiveBoard())}
          disabled={!hasBoard || busy !== null}
          title="Delete the cache entry for the current board and re-run the parser on it. Fastest way to pick up a parser fix on the file you're looking at."
        >
          {busy === 'reparse' ? 'Re-parsing…' : 'Re-parse current'}
        </button>
        <button
          className="settings-cache-btn"
          onClick={() => run('boards', () => boardStore.resetBoardCaches())}
          disabled={busy !== null}
          title="Clear all cached parsed boards from IndexedDB and re-parse every open tab. PDF caches are left alone."
        >
          {busy === 'boards' ? 'Clearing…' : 'Reset board caches'}
        </button>
        <button
          className="settings-cache-btn"
          onClick={() => run('pdf', () => boardStore.resetPdfCaches())}
          disabled={busy !== null}
          title="Clear cached PDF text, tile bitmaps, font glyphs, and watermark skip sets. Board parses are left alone."
        >
          {busy === 'pdf' ? 'Clearing…' : 'Reset PDF caches'}
        </button>
      </div>
    </div>
  );
}

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

  // Tabs + collapsible sections
  const [activeTab, setActiveTabState] = useState<SettingsTabId>(() => loadActiveTab());
  const [openSections, setOpenSections] = useState<Set<SectionId>>(() => loadOpenSections(loadActiveTab()));

  // Persist open sections per tab whenever they change.
  useEffect(() => {
    saveOpenSections(activeTab, openSections);
  }, [activeTab, openSections]);

  const setActiveTab = useCallback((id: SettingsTabId) => {
    setActiveTabState(id);
    saveActiveTab(id);
    setOpenSections(loadOpenSections(id));
  }, []);

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
  const partTypeOverridesRef = useRef<HTMLDivElement>(null);
  const zoomLodRef = useRef<HTMLDivElement>(null);
  const serverRef = useRef<HTMLDivElement>(null);
  const dbinfoRef = useRef<HTMLDivElement>(null);
  const pdfRef = useRef<HTMLDivElement>(null);
  const boardOverlayRef = useRef<HTMLDivElement>(null);

  const sectionRefsMapRef = useRef<Record<SectionId, React.RefObject<HTMLDivElement | null>>>({
    outline: outlineRef, parts: partsRef, pins: pinsRef,
    netColors: netColorsRef, selection: selectionRef, zoomLod: zoomLodRef, netLines: netLinesRef, navigation: navigationRef,
    performance: performanceRef, shortcuts: shortcutsRef,
    partTypeOverrides: partTypeOverridesRef, server: serverRef, dbinfo: dbinfoRef, pdf: pdfRef,
    boardOverlay: boardOverlayRef,
  });

  const toggleSection = useCallback((id: SectionId) => {
    setOpenSections(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const focusSection = useCallback((id: SectionId) => {
    const targetTab = SECTION_TO_TAB[id];
    if (targetTab && targetTab !== activeTab) {
      setActiveTab(targetTab);
    }
    setOpenSections(prev => { const next = new Set(prev); next.add(id); return next; });
    requestAnimationFrame(() => {
      sectionRefsMapRef.current[id]?.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    if (focusTimerRef.current) clearTimeout(focusTimerRef.current);
    setFocusedSection(id);
    focusTimerRef.current = setTimeout(() => setFocusedSection(null), 1400);
  }, [activeTab, setActiveTab]);

  // External deep-link: other panels dispatch 'settings-focus-section' with a
  // SectionId (e.g. the Library empty state pointing at the scan controls).
  // The sidebar tab itself is switched by the caller via showSidebarTab.
  useEffect(() => {
    const onFocus = (e: Event) => {
      const id = (e as CustomEvent<SectionId>).detail;
      if (id && SECTION_TO_TAB[id]) focusSection(id);
    };
    window.addEventListener('settings-focus-section', onFocus);
    return () => window.removeEventListener('settings-focus-section', onFocus);
  }, [focusSection]);

  const updateDraft: DraftUpdater = useCallback((partial) => {
    setDraft(prev => {
      const next = { ...prev, ...partial };
      if (previewingRef.current) renderSettingsStore.applySettings(next);
      return next;
    });
    setDirty(true);
  }, []);

  // Immediate global commit for input-behavior / system fields (Input +
  // System tabs). No draft, no Apply — matches what QuickSettings on the
  // home screen already does for the same fields. The draft + Apply
  // pipeline is reserved for the Board tab (visual render settings +
  // per-board overrides). Baseline is advanced too so these edits never
  // show up in the board-tab dirty diff.
  // applyGlobal notifies synchronously, which fires the re-sync subscriber
  // below. In Board mode that subscriber would rebuild the draft from the
  // *effective* (global+override) snapshot and corrupt the baselines of
  // other override-carrying global-only fields. Guard against our own notify.
  const selfUpdateRef = useRef(false);
  const updateGlobal: DraftUpdater = useCallback((partial) => {
    selfUpdateRef.current = true;
    try {
      renderSettingsStore.applyGlobal({ ...renderSettingsStore.globalSettings, ...partial });
    } finally {
      selfUpdateRef.current = false;
    }
    baselineRef.current = { ...baselineRef.current, ...partial };
    setDraft(prev => ({ ...prev, ...partial }));
  }, []);

  // Re-sync draft + baseline when the store changes underneath us (e.g.
  // QuickSettings on the home screen, theme poke) while nothing is being
  // edited here — otherwise a later Apply would clobber those changes with
  // a stale snapshot. Skipped while dirty, previewing, or for our own
  // updateGlobal-originated notifies.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    return renderSettingsStore.subscribe(() => {
      if (selfUpdateRef.current || dirtyRef.current || previewingRef.current) return;
      const snap = isBoardMode ? renderSettingsStore.snapshot() : renderSettingsStore.globalSnapshot();
      baselineRef.current = structuredClone(snap);
      setDraft(structuredClone(snap));
    });
  }, [isBoardMode]);

  // Pin-colour rules, NC patterns and component fills moved to the Theme tab
  // (carried by the theme), so their Board-tab edit handlers were removed.

  const handleApply = () => {
    if (isBoardMode) {
      // Compute sparse diff against global and store as board overrides
      const global = renderSettingsStore.globalSettings;
      const overrides = computeOverrides(global, draft);
      renderSettingsStore.setBoardOverrides(activeFileName, overrides);
    } else {
      // Surgical apply: merge only the fields the user actually edited
      // (diff vs baseline) onto the CURRENT global settings, so changes
      // made elsewhere while this panel was open are never clobbered.
      const changed = computeOverrides(baselineRef.current, draft);
      renderSettingsStore.applyGlobal({ ...renderSettingsStore.globalSettings, ...changed });
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
    <SettingsSearchProvider>
    <div className="panel-content settings-panel" data-testid="settings-panel" ref={panelRef}>
      <div className="settings-top">
        {/* ── Search bar — type or press / to focus, Esc to clear ── */}
        <SettingsSearchBar />

        {/* Tab strip — reuses LibraryPanel's library-tab CSS for visual consistency */}
        <div className="library-tabs-row settings-tabs-row">
          <div className="library-tabs">
            {TAB_ORDER.map(tab => (
              <TabPill key={tab} tab={tab} activeTab={activeTab} setActiveTab={setActiveTab} />
            ))}
          </div>
        </div>

        {/* Mode switch + draft footer govern ONLY the Board tab — every other
            tab commits immediately (updateGlobal / own stores), so rendering
            Apply/Cancel there would act on invisible state. */}
        {activeTab === 'board' && (
          <>
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

            {/* Render preview (SettingsMockup) is silently disabled for now —
                kept in the tree via the import so we can flip it back quickly
                by toggling SHOW_MOCKUP_PREVIEW to true. */}
            {SHOW_MOCKUP_PREVIEW && <SettingsMockup settings={draft} onElementClick={focusSection} />}
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
          </>
        )}
      </div>
      <OverrideContext.Provider value={overrideCtx}>
      <div className="settings-scroll">

      <SearchEmptyState activeTab={activeTab} goTab={setActiveTab} />

      {activeTab === 'theme' && (
        <ThemeTab />
      )}

      {activeTab === SECTION_TO_TAB.outline && (
      <CollapsibleSection id="outline" title="Board Outline" isOpen={openSections.has('outline')}
        onToggle={toggleSection} sectionRef={outlineRef} isFocused={focusedSection === 'outline'}>
        <Slider label="Stroke Width" value={draft.outlineWidth} min={0.5} max={20} step={0.5} field="outlineWidth" onUpdate={updateDraft}
          title="Thickness of the PCB board outline stroke (mils)" />
        <Slider label="Stroke Opacity" value={draft.outlineAlpha} min={0} max={1} step={0.05} field="outlineAlpha" onUpdate={updateDraft}
          title="Transparency of the board outline. 0 = invisible, 1 = fully opaque" />
        <Slider label="Board Fill" value={draft.boardFillAlpha} min={0} max={0.5} step={0.01} field="boardFillAlpha" onUpdate={updateDraft}
          title="Semi-transparent fill inside the board outline. Helps distinguish the PCB area from the background" />
        <Toggle label="Use board metadata color" value={draft.useMetadataBoardColor} field="useMetadataBoardColor" onUpdate={updateDraft}
          title="When on, boards with a known PCB color (Apple → black, Dell → blue, etc.) render with that tint instead of the theme default. Boards without a metadata match silently fall back to the theme default. Intensity is the Board Fill slider above." />
      </CollapsibleSection>
      )}

      {activeTab === SECTION_TO_TAB.parts && (
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
        <Toggle label="Pin Label Shadow" value={draft.pinLabelShadow} field="pinLabelShadow" onUpdate={updateDraft}
          title="Add a dark shadow halo behind on-pin labels (pin numbers and net names) for readability. Net names were previously always shadowed; turn this off for crisp, shadow-free pin text." />
        <Toggle label="Hide Mechanical Fills" value={draft.autoMarkMechanical} field="autoMarkMechanical" onUpdate={updateDraft}
          title="Auto-detect EMI shields, heatsink frames and oversized through-hole connector shadows (footprint contains ≥5 other component origins, or description contains SHIELD/HEATSINK/FRAME, or trailing-dot duplicates). Detected parts render without a body fill — border outline and pins still draw — so smaller components beneath stay visible. Right-click any part for a per-component override." />
        <Slider label="Min Label Size" value={draft.labelMinSize} min={1} max={30} step={1} field="labelMinSize" onUpdate={updateDraft}
          title="Minimum font size (board mils) for part / pin / net-name labels. Acts as a floor on the auto-computed size, so tiny components still get a readable label. Labels smaller than the Zoom LOD thresholds are still hidden." />
      </CollapsibleSection>
      )}

      {activeTab === SECTION_TO_TAB.pins && (
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
        <Toggle label="Show Diode Values" value={draft.showDiodeValues} field="showDiodeValues" onUpdate={updateDraft}
          title="Draw diode-mode reference readings on pins (XZZ-baked values + OpenBoardData). Only visible on boards that carry readings; also toggleable from the board sidebar's View tab" />
        <Toggle label="Pin 1 Marker" value={draft.showPin1Marker} field="showPin1Marker" onUpdate={updateDraft}
          title="Highlight pin 1 with red color and a triangle indicator on multi-pin parts" />
        <Toggle label="Pin Label Background" value={draft.pinNetLabelBg} field="pinNetLabelBg" onUpdate={updateDraft}
          title="Draw a dark background plate behind net name labels on circle pins. Improves readability when labels overflow beyond the pin area" />
        <Toggle label="2-Pin Label Background" value={draft.twoPinNetLabelBg} field="twoPinNetLabelBg" onUpdate={updateDraft}
          title="Draw a dark background plate behind net name labels on 2-pin rectangular pads" />
        <Slider label="BGA Label Gap" value={draft.bgaLabelGapFactor} min={0} max={1} step={0.05} field="bgaLabelGapFactor" onUpdate={updateDraft}
          title="Visible vertical gap between pin number and net name labels on dense BGA parts, as a fraction of pin radius. On BGAs, pin numbers and net names alternate above/below the pin center to avoid overlap. 0 = labels meet at the pin center; larger = more visible separation" />
      </CollapsibleSection>
      )}

      {/* Navigation first — gesture/scroll setup is the most important thing a
          new user configures, so it leads the Input tab. */}
      {activeTab === SECTION_TO_TAB.navigation && (
      <CollapsibleSection id="navigation" title="Navigation" isOpen={openSections.has('navigation')}
        onToggle={toggleSection} sectionRef={navigationRef} isFocused={focusedSection === 'navigation'}>
        <div className="settings-row settings-toggle-row" title="Re-open the first-run gesture wizard: do the gesture you want for each pan/zoom action and it configures the bindings for you.">
          <label className="settings-label">Interactive gesture setup</label>
          <button
            className="settings-action-btn"
            style={{ marginLeft: 'auto' }}
            onClick={() => welcomeStore.show()}
          >
            Re-run setup…
          </button>
        </div>
        <div className="settings-subsection-label">Scroll wheel behavior</div>
        <p className="settings-hint">Drag pills between slots to reassign scroll actions.</p>
        <BoardScrollBindingsEditor twoFingerPan={draft.twoFingerPan} onUpdate={updateGlobal} />
        <Toggle
          label="Mouse wheel detection"
          value={draft.wheelDetection}
          field="wheelDetection"
          onUpdate={updateGlobal}
          title="When scroll is set to pan, classic mouse-wheel events override to zoom instead — avoids jerky pan with a physical scroll wheel. Trackpads and fine-grained wheels are unaffected."
        />

        <div className="settings-subsection-label">Trackpad/Mouse drag behavior</div>
        <p className="settings-hint">Drag pills between slots to swap left-drag and Shift+left-drag actions.</p>
        <BoardDragBindingsEditor dragToZoom={draft.dragToZoom} onUpdate={updateGlobal} />

        <div className="settings-subsection-label">Keyboard pan / zoom</div>
        <div className="settings-row" title="Fraction of screen dimension panned per WSAD or Alt+Arrow keypress. Default: 10% of screen width/height per press.">
          <label className="settings-label">
            Keyboard Pan Step
            <span className="settings-value">{Math.round(draft.keyboardPanFraction * 100)}%</span>
          </label>
          <div className="settings-slider-wrap">
            <input
              type="range" className="settings-slider"
              min={2} max={30} step={1}
              value={Math.round(draft.keyboardPanFraction * 100)}
              onChange={(e) => updateGlobal({ keyboardPanFraction: parseFloat(e.target.value) / 100 })}
              onDoubleClick={() => updateGlobal({ keyboardPanFraction: DEFAULTS.keyboardPanFraction })}
            />
          </div>
        </div>
        <Slider
          label="Keyboard Zoom Step"
          value={draft.keyboardZoomDelta}
          min={50} max={400} step={10}
          field="keyboardZoomDelta" onUpdate={updateGlobal}
          title={`Raw zoom delta per Shift+W / Shift+S keypress. Applies to both board and PDF. Current: ×${Math.pow(2, 1.3 * (draft.keyboardZoomDelta / 500)).toFixed(2)} per press. Default: 100 (≈×1.32).`}
        />

        <div className="settings-subsection-label">Zoom</div>
        <Slider label="Wheel Smoothing" value={draft.wheelSmooth} min={1} max={20} step={1} field="wheelSmooth" onUpdate={updateGlobal}
          title="Mouse wheel zoom smoothness. 1 = instant snap, higher = smoother animated zoom. Default: 5" />
        <Slider label="Fit Padding" value={draft.fitPadding} min={0} max={200} step={10} field="fitPadding" onUpdate={updateGlobal}
          title="Extra padding (screen pixels) added when fitting the board to the viewport (Fit to Screen, double-click zoom). Prevents the board from touching viewport edges" />

        <div className="settings-subsection-label">Navigate-to-component</div>
        <Slider label="Component Size" value={draft.navTargetSize} min={0.05} max={0.90} step={0.05} field="navTargetSize" onUpdate={updateGlobal}
          title="Target on-screen size of a component after navigating to it from search / NetList / Worklist. Expressed as a fraction of the smaller viewport dimension. Default 0.25 (~25%)." />
        <div className="settings-row" data-test="nav-zoom-mode" title="How navigation should treat zoom level.">
          <label className="settings-label">Zoom Mode</label>
          <div className="settings-btn-group" style={{ marginLeft: 'auto' }}>
            <button
              className={`settings-btn-option${draft.navZoomMode === 'auto' ? ' active' : ''}`}
              onClick={() => updateGlobal({ navZoomMode: 'auto' })}
              title="Auto — keep current zoom when the part is in the comfortable band (1.5%–70% of screen). Snap to Component Size only when extreme."
              data-test="nav-zoom-auto"
            >Auto</button>
            <button
              className={`settings-btn-option${draft.navZoomMode === 'keep' ? ' active' : ''}`}
              onClick={() => updateGlobal({ navZoomMode: 'keep' })}
              title="Keep — never change zoom, just pan to the part. Component Size is ignored."
              data-test="nav-zoom-keep"
            >Keep</button>
            <button
              className={`settings-btn-option${draft.navZoomMode === 'always' ? ' active' : ''}`}
              onClick={() => updateGlobal({ navZoomMode: 'always' })}
              title="Always — every navigation snaps to Component Size. Pre-v0.31.4 behavior."
              data-test="nav-zoom-always"
            >Always</button>
          </div>
        </div>

        <div className="settings-subsection-label">Pan</div>
        <div className="settings-row settings-toggle-row" title="Continue panning with momentum after releasing a drag gesture. When disabled, panning stops immediately on release. Note: trackpad scroll momentum is controlled by your OS settings and cannot be disabled by the app">
          <label className="settings-label">Inertia</label>
          <input type="checkbox" checked={!draft.disableInertia}
            onChange={(e) => updateGlobal({ disableInertia: !e.target.checked })} />
        </div>

        <div className="settings-subsection-label">Click</div>
        <Slider label="Pin Click Radius" value={draft.clickThreshold} min={5} max={100} step={5} field="clickThreshold" onUpdate={updateGlobal}
          title="Maximum distance (screen pixels) from a pin center that counts as a click on that pin. Larger = easier to click small or densely packed pins" />
      </CollapsibleSection>
      )}

      {activeTab === SECTION_TO_TAB.zoomLod && (
      <CollapsibleSection id="zoomLod" title="Zoom Level of Detail" isOpen={openSections.has('zoomLod')}
        onToggle={toggleSection} sectionRef={zoomLodRef} isFocused={focusedSection === 'zoomLod'}>
        <div className="color-rule-hint" style={{ marginBottom: 6 }}>Controls when text labels appear/disappear as you zoom. Higher = must zoom in more. At 100% zoom: 1 mil = 1 screen pixel.</div>
        <Slider label="Part Labels" value={draft.labelMinScreenPx} min={0} max={50} step={1} field="labelMinScreenPx" onUpdate={updateGlobal}
          title="Part name labels (R1, U1, C42) appear when they reach this many screen pixels. At 100% zoom a medium (8 mil) label = 8px. Set to 10 to hide them below 125% zoom." />
        <Slider label="Pin Labels" value={draft.circleLabelMinScreenPx} min={0} max={50} step={1} field="circleLabelMinScreenPx" onUpdate={updateGlobal}
          title="Pin numbers and net names on ICs/BGAs appear when they reach this many screen pixels. At 100% zoom a 6-mil pin label = 6px." />
        <Slider label="2-Pin Net Names" value={draft.twoPinLabelMinScreenPx} min={0} max={50} step={1} field="twoPinLabelMinScreenPx" onUpdate={updateGlobal}
          title="Net names on resistors/capacitors (2-pin parts) appear when they reach this many screen pixels." />
        <Slider label="Label Cull (mils)" value={draft.labelHideThreshold} min={0} max={20} step={0.5} field="labelHideThreshold" onUpdate={updateGlobal}
          title="Labels smaller than this (in board mils) are permanently removed from the scene — never drawn at any zoom. Saves GPU memory on dense boards." />
        <Slider label="Global Zoom Floor" value={draft.labelZoomHide} min={0} max={10} step={0.01} field="labelZoomHide" onUpdate={updateGlobal}
          title="Hard minimum zoom level to show ANY text. 0 = disabled. All labels vanish below this zoom level." />
      </CollapsibleSection>
      )}

      {activeTab === SECTION_TO_TAB.partTypeOverrides && (
      <CollapsibleSection id="partTypeOverrides" title="Part properties" isOpen={openSections.has('partTypeOverrides')}
        onToggle={toggleSection} sectionRef={partTypeOverridesRef} isFocused={focusedSection === 'partTypeOverrides'}>
        <Slider label="Hierarchy Depth" value={draft.hierarchyDepth} min={1} max={4} step={1} field="hierarchyDepth" onUpdate={updateDraft}
          title="How many hops the hierarchical (chain + adjacent) net-line mode follows through bridging parts. 1 = immediate neighbours; up to 4 follows longer series chains." />
        <div className="color-rule-hint" style={{ padding: '4px 0' }}>
          Component fill colours &amp; prefixes are carried by the theme — edit
          them under <strong>Settings ▸ Theme ▸ Board &amp; pin colours</strong>.
        </div>
      </CollapsibleSection>
      )}

      {activeTab === SECTION_TO_TAB.netColors && (
      <CollapsibleSection id="netColors" title="Pin Color Rules" isOpen={openSections.has('netColors')}
        onToggle={toggleSection} sectionRef={netColorsRef} isFocused={focusedSection === 'netColors'}>
        <div className="color-rule-hint" style={{ padding: '4px 0' }}>
          Pin colours are now grouped by net class (Power / Ground / Datalines /
          Logical / Misc) and carried by the theme. Edit them under{' '}
          <strong>Settings ▸ Theme ▸ Board &amp; pin colours</strong>.
        </div>
      </CollapsibleSection>
      )}

      {activeTab === SECTION_TO_TAB.selection && (
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
      </CollapsibleSection>
      )}

      {activeTab === SECTION_TO_TAB.boardOverlay && (
      <CollapsibleSection id="boardOverlay" title="Board overlay" isOpen={openSections.has('boardOverlay')}
        onToggle={toggleSection} sectionRef={boardOverlayRef} isFocused={focusedSection === 'boardOverlay'}>
        <OverlayCustomizer />
      </CollapsibleSection>
      )}

      {activeTab === SECTION_TO_TAB.netLines && (
      <CollapsibleSection id="netLines" title="Net Lines" isOpen={openSections.has('netLines')}
        onToggle={toggleSection} sectionRef={netLinesRef} isFocused={focusedSection === 'netLines'}>
        <div className="settings-row" title="Colour of net connection lines. Left: the selected net (primary). Right: chain-adjacent nets reached through 2-pin bridge components in hierarchical highlight mode.">
          <label className="settings-label">Line colours</label>
          <div className="net-line-color-chain">
            <input
              type="color"
              className="color-rule-color"
              value={colorToHex(draft.netLineColor)}
              onChange={(e) => updateDraft({ netLineColor: hexToColor(e.target.value) })}
              title="Primary net line colour (the selected net)"
            />
            <span className="net-line-color-chain-link" aria-hidden="true">→</span>
            <input
              type="color"
              className="color-rule-color"
              value={colorToHex(draft.adjacentNetLineColor)}
              onChange={(e) => updateDraft({ adjacentNetLineColor: hexToColor(e.target.value) })}
              title="Adjacent (chain-propagated) net line colour, used when Hierarchy Depth > 1"
            />
          </div>
        </div>
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
      )}

      {activeTab === SECTION_TO_TAB.performance && (
      <CollapsibleSection id="performance" title="Performance & Debug" isOpen={openSections.has('performance')}
        onToggle={toggleSection} sectionRef={performanceRef} isFocused={focusedSection === 'performance'}>
        <Toggle label="Show Perf Overlay" value={draft.showPerfOverlay} field="showPerfOverlay" onUpdate={updateGlobal}
          title="Show per-phase frame-time stats (frame / lod / sel / net / gpu) on each board panel. Same toggle as the small 'i' button at the bottom-left of a panel" />
        <Toggle label="Cap to 60 FPS" value={draft.cap60Fps} field="cap60Fps" onUpdate={updateGlobal}
          title="Limit the renderer to 60 frames per second. Disable to let the ticker run at the display refresh rate (120/144/240 Hz) — smoother but more CPU/GPU work" />
        <Slider label="Label Atlas Resolution" value={draft.labelAtlasResolution} min={4} max={24} step={1} field="labelAtlasResolution" onUpdate={updateGlobal}
          title="Pixel multiplier for the BitmapFont atlases used by pin/net/part labels. Higher = sharper labels at deep zoom; texture memory grows ~quadratically. Default 8. Triggers a scene rebuild." />
        <Toggle label="Hide Text During Zoom" value={draft.hideTextDuringZoom} field="hideTextDuringZoom" onUpdate={updateGlobal}
          title="Temporarily hide all text labels while zooming or panning for smoother performance. Labels reappear when interaction stops" />
        <Toggle label="[Debug] Pad Vertex Crosshairs" value={draft.showPadVertices} field="showPadVertices" onUpdate={updateGlobal}
          title="Draw magenta crosshair markers at each pin's exact coordinate from the board file. Useful for verifying parser accuracy" />
        <Toggle label="[Debug] Outline Vertex Numbers" value={draft.showVertexNumbers} field="showVertexNumbers" onUpdate={updateGlobal}
          title="Show numbered markers at each board outline vertex. Yellow = unique, orange = duplicate coordinates. Works for all board formats" />
      </CollapsibleSection>
      )}

      {activeTab === SECTION_TO_TAB.pdf && (
      <CollapsibleSection id="pdf" title="PDF Viewer" isOpen={openSections.has('pdf')}
        onToggle={toggleSection} sectionRef={pdfRef} isFocused={focusedSection === 'pdf'}>
        <div className="settings-subsection-label">Render quality</div>
        <PdfQualitySelector />
        <div className="settings-subsection-label">Render mode</div>
        <PdfRenderModeSelector />
        <div className="settings-subsection-label">Watermark filter</div>
        <PdfWatermarkFilterEditor />
        <div className="settings-subsection-label">Navigation</div>
        <PdfInertiaToggle />
        <Toggle label="Pan Boundaries" value={draft.pdfEnableBoundaries} field="pdfEnableBoundaries" onUpdate={updateGlobal}
          title="Clamp PDF pan to page edges: prevents scrolling off the document at the first/last page and centers horizontally when the page fits the viewport. Page-flip thresholds still fire as you cross them either way. Zoom range stays at 0.5×–10× regardless." />
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
      )}

      {activeTab === 'system' && (
        <>
          <SoftwareUpdateSection />
          {/* Cache/render resets are troubleshooting tools, not everyday
              controls — demoted from the panel header into their own block. */}
          <StandaloneCollapsibleSection title="Troubleshooting" defaultOpen={false}
            storageKey="troubleshooting" searchSectionId="troubleshooting">
            <CacheControlBar hasBoard={hasBoard} />
          </StandaloneCollapsibleSection>
        </>
      )}

      {activeTab === SECTION_TO_TAB.server && (
      <>
      {/* The everyday section first (scan/index controls); database stats,
          dedup and the destructive resets live in their own block below. */}
      <CollapsibleSection id="server" title="Scanning & Indexing" isOpen={openSections.has('server')}
        onToggle={toggleSection} sectionRef={serverRef} isFocused={focusedSection === 'server'}>
        <LibraryFolderSetting />
        <AutoScanToggle />
        <LibrarySettingsSection />
      </CollapsibleSection>
      <CollapsibleSection id="dbinfo" title="Database info" isOpen={openSections.has('dbinfo')}
        onToggle={toggleSection} sectionRef={dbinfoRef} isFocused={focusedSection === 'dbinfo'}>
        <DatabaseInfoSection />
      </CollapsibleSection>
      </>
      )}

      {activeTab === SECTION_TO_TAB.shortcuts && (
      <CollapsibleSection id="shortcuts" title="Keyboard Shortcuts" isOpen={openSections.has('shortcuts')}
        onToggle={toggleSection} sectionRef={shortcutsRef} isFocused={focusedSection === 'shortcuts'}>
        {(['file', 'view', 'wsad', 'navigation', 'pdf'] as const).map(cat => (
          <div key={cat} className="shortcuts-category">
            <div className="shortcuts-category-title">{
              cat === 'wsad' ? 'WSAD Navigation' :
              cat === 'pdf' ? 'PDF' :
              cat[0].toUpperCase() + cat.slice(1)
            }</div>
            {shortcuts.filter(s => s.category === cat && !s.hideInList).map(s => (
              <div key={s.id} className="shortcuts-row">
                <span className="shortcuts-label" title={s.description}>{s.label}</span>
                <kbd className="shortcuts-key">{formatShortcut(s.id)}</kbd>
              </div>
            ))}
          </div>
        ))}
      </CollapsibleSection>
      )}

      {activeTab === 'library' && (
        <LibraryTab />
      )}

      {activeTab === 'integrations' && (
        <IntegrationsSection />
      )}

      {activeTab === 'board' && (
        <button className="settings-reset-btn" onClick={handleReset}
          title={isBoardMode ? 'Clear all board overrides — revert to global settings' : 'Reset all settings to defaults (board render + input behavior)'}>
          {isBoardMode ? 'Reset to Global' : 'Reset to Defaults'}
        </button>
      )}
      </div>
      </OverrideContext.Provider>
    </div>
    </SettingsSearchProvider>
  );
}

// ---- Tab pill with match-count badge + search-clear-on-switch helpers ----

function TabPill({ tab, activeTab, setActiveTab }: {
  tab: SettingsTabId;
  activeTab: SettingsTabId;
  setActiveTab: (t: SettingsTabId) => void;
}) {
  const { active, matches } = useSettingsSearch();
  const count = matches.perTabCount.get(tab) ?? 0;
  return (
    <button
      type="button"
      className={`library-tab ${activeTab === tab ? 'active' : ''}${active && count > 0 ? ' settings-tab-has-match' : ''}`}
      onClick={() => setActiveTab(tab)}
    >
      {TAB_LABELS[tab]}
      {active && count > 0 && <span className="settings-tab-match-badge">{count}</span>}
    </button>
  );
}

/** Inline note when a search has zero matches on the ACTIVE tab — names the
 *  tabs that do match instead of leaving the body silently empty. Deliberately
 *  does NOT auto-switch tabs; moving the user without asking is worse. */
function SearchEmptyState({ activeTab, goTab }: {
  activeTab: SettingsTabId;
  goTab: (t: SettingsTabId) => void;
}) {
  const { active, matches } = useSettingsSearch();
  if (!active) return null;
  if ((matches.perTabCount.get(activeTab) ?? 0) > 0) return null;
  const others = TAB_ORDER.filter(t => t !== activeTab && (matches.perTabCount.get(t) ?? 0) > 0);
  return (
    <div className="settings-search-empty">
      {others.length === 0 ? (
        'No settings match this search.'
      ) : (
        <>
          No matches on this tab —{' '}
          {others.map((t, i) => (
            <span key={t}>
              {i > 0 && ', '}
              <button type="button" className="settings-search-empty-link" onClick={() => goTab(t)}>
                {matches.perTabCount.get(t)} on {TAB_LABELS[t]}
              </button>
            </span>
          ))}
        </>
      )}
    </div>
  );
}


function useThemeId(): string {
  return useSyncExternalStore(
    (cb) => themeStore.subscribe(cb),
    () => themeStore.activeId,
  );
}

// Module-level cache so the snapshot reference stays stable across calls
// within the same render pass — useSyncExternalStore requires this. The
// cache is invalidated on every themeStore notify so reads after a mutation
// pick up fresh values. Same pattern as in components/home/HomeBackdrop.tsx.
let _themeOverridesCache: { accent: string | null; background: string | null; chrome: string | null } | null = null;
themeStore.subscribe(() => { _themeOverridesCache = null; });
function _getThemeOverridesSnapshot() {
  if (!_themeOverridesCache) {
    _themeOverridesCache = {
      accent: themeStore.accentOverride,
      background: themeStore.backgroundOverride,
      chrome: themeStore.chromeOverride,
    };
  }
  return _themeOverridesCache;
}

function useThemeOverrides() {
  return useSyncExternalStore(
    (cb) => themeStore.subscribe(cb),
    _getThemeOverridesSnapshot,
  );
}

interface TokenPickerBlockProps {
  /** Section heading (uppercase). */
  title: string;
  /** Tooltip / description shown beneath the picker. */
  hint: React.ReactNode;
  /** Currently effective hex (override if set, else theme default). */
  effective: string;
  /** Override hex if user has set one, else null. */
  override: string | null;
  /** Called when the user picks a colour. */
  onChange: (hex: string) => void;
  /** Called when the user clicks "Reset". */
  onReset: () => void;
  /** Optional preset swatches. */
  presets?: ReadonlyArray<{ hex: string; label: string }>;
}

/** A single row block in the ThemeTab: title (with Reset button on the
 *  right when an override is active) → colour input + hex readout →
 *  optional preset swatches → hint text. */
function TokenPickerBlock({
  title,
  hint,
  effective,
  override,
  onChange,
  onReset,
  presets,
}: TokenPickerBlockProps) {
  const eff = effective.toLowerCase();
  return (
    <div>
      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-secondary)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span>{title}</span>
        {override && (
          <button
            type="button"
            onClick={onReset}
            style={{
              marginLeft: 'auto',
              background: 'none',
              border: '1px solid var(--border)',
              color: 'var(--text-secondary)',
              fontSize: 10,
              padding: '2px 8px',
              borderRadius: 3,
              cursor: 'pointer',
              textTransform: 'none',
              letterSpacing: 0,
            }}
            title="Revert to the active theme's default"
          >
            Reset
          </button>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px 8px' }}>
        <input
          type="color"
          value={eff}
          onChange={(e) => onChange(e.target.value.toLowerCase())}
          title={`Pick a ${title.toLowerCase()} colour`}
          style={{
            width: 36,
            height: 24,
            padding: 0,
            border: '1px solid var(--border)',
            borderRadius: 3,
            background: 'transparent',
            cursor: 'pointer',
          }}
        />
        <code style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'ui-monospace, Menlo, Consolas, monospace' }}>
          {eff.toUpperCase()}
          {override == null && <span style={{ opacity: 0.6, marginLeft: 6 }}>(theme default)</span>}
        </code>
      </div>
      {presets && presets.length > 0 && (
        <div role="listbox" aria-label={`${title} presets`} style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '0 8px' }}>
          {presets.map((p) => {
            const active = p.hex.toLowerCase() === eff;
            return (
              <button
                key={p.hex}
                type="button"
                onClick={() => onChange(p.hex)}
                title={`${p.label} · ${p.hex.toUpperCase()}`}
                aria-label={p.label}
                aria-pressed={active}
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 4,
                  background: p.hex,
                  border: active ? '2px solid var(--text-primary)' : '1px solid var(--border)',
                  cursor: 'pointer',
                  padding: 0,
                  outline: 'none',
                }}
              />
            );
          })}
        </div>
      )}
      <div style={{ fontSize: 11, color: 'var(--text-secondary)', padding: '6px 8px 0' }}>
        {hint}
      </div>
    </div>
  );
}

const MONO = 'ui-monospace, Menlo, Consolas, monospace';

/** Compact one-line colour control: label, swatch input, hex readout, and an
 *  optional clear (×) button when the value is an active override. */
function MiniColorRow({
  label,
  value,
  onChange,
  onClear,
  note,
}: {
  label: string;
  value: string;
  onChange: (hex: string) => void;
  onClear?: () => void;
  note?: React.ReactNode;
}) {
  const v = (value || '#000000').toLowerCase();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
      <span style={{ fontSize: 11, color: 'var(--text-secondary)', minWidth: 104 }}>{label}</span>
      <input
        type="color"
        value={v}
        onChange={(e) => onChange(e.target.value.toLowerCase())}
        title={`Pick ${label.toLowerCase()}`}
        style={{ width: 30, height: 22, padding: 0, border: '1px solid var(--border)', borderRadius: 3, background: 'transparent', cursor: 'pointer' }}
      />
      <code style={{ fontSize: 10.5, color: 'var(--text-secondary)', fontFamily: MONO }}>{v.toUpperCase()}</code>
      {note && <span style={{ fontSize: 10, color: 'var(--text-secondary)', opacity: 0.7 }}>{note}</span>}
      {onClear && (
        <button
          type="button"
          onClick={onClear}
          title="Clear this override — fall back to the global setting"
          style={{ marginLeft: 'auto', background: 'none', border: '1px solid var(--border)', color: 'var(--text-secondary)', fontSize: 10, lineHeight: 1, padding: '2px 6px', borderRadius: 3, cursor: 'pointer' }}
        >
          ×
        </button>
      )}
    </div>
  );
}

const GROUP_LABEL: React.CSSProperties = { fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-secondary)', margin: '8px 0 2px' };

/**
 * Custom theme editor — the single user-editable theme. Edits its interface
 * baseline (ui) + board palette directly, and exposes pin colours as
 * *overrides* over the global render settings (set = override, × = inherit),
 * exactly the "global settings + overrides if set" model. Lives at the bottom
 * of the Theme tab; creating it adds a "Custom" entry to the board-theme list.
 */
/** Board-canvas colour editor (Theme tab). Reads the active theme's board
 *  palette; edits route through the copy-to-custom gate. */
function ThemeBoardColorsEditor() {
  useThemeId();
  const board = themeStore.activeTheme().board;
  const setBoard = (k: keyof Theme['board'], hex: string) => {
    if (gateThemeEdit()) themeStore.updateCustom({ board: { [k]: hex } });
  };
  return (
    <div>
      <div style={GROUP_LABEL}>Board canvas</div>
      <MiniColorRow label="Canvas" value={board.canvasBackground} onChange={(h) => setBoard('canvasBackground', h)} />
      <MiniColorRow label="Board fill" value={board.boardFill} onChange={(h) => setBoard('boardFill', h)} />
      <MiniColorRow label="Outline" value={board.outline} onChange={(h) => setBoard('outline', h)} />
      <MiniColorRow label="Selection" value={board.selection} onChange={(h) => setBoard('selection', h)} />
      <MiniColorRow label="Butterfly" value={board.butterflySelection} onChange={(h) => setBoard('butterflySelection', h)} />
      <MiniColorRow label="Pin labels" value={board.labelText} onChange={(h) => setBoard('labelText', h)} />
      <MiniColorRow label="Part labels" value={board.labelPart} onChange={(h) => setBoard('labelPart', h)} />
      <div style={{ fontSize: 10.5, color: 'var(--text-secondary)', opacity: 0.7, padding: '2px 0' }}>
        Net-label colours are under “Net labels” below. Body text and the
        secondary surface/border tiers are derived automatically for contrast.
      </div>
    </div>
  );
}

/** Component fill-colour editor (Theme tab) — the part-type list with
 *  per-type fill colour, carried by the theme. Pad/Body shape columns are
 *  hidden (rarely used; data + code retained). Edits route through the gate. */
function ThemeComponentFillsEditor() {
  useThemeId();
  const settings = useEffectiveSettings();
  const types = settings.partTypes;
  // PartTypeActions only exposes update — the theme editor retints / re-prefixes
  // the standard type set; add/remove of types isn't offered here.
  const actions: PartTypeActions = {
    update: (id, patch) => {
      if (!gateThemeEdit()) return;
      themeStore.setCustomOverride('partTypes', renderSettingsStore.settings.partTypes.map(t => t.id === id ? { ...t, ...patch } : t));
    },
  };
  return (
    <div>
      <div style={GROUP_LABEL}>Component fills</div>
      <PartTypesSection types={types} actions={actions} hideShapes />
    </div>
  );
}

/** Custom-theme management strip — delete the single custom slot. Shown only
 *  when a custom theme exists. Creation happens implicitly on first edit. */
function CustomThemeStrip() {
  useThemeId();
  if (!themeStore.customTheme) return null;
  return (
    <div style={{ ...GROUP_LABEL, display: 'flex', alignItems: 'center', gap: 8 }}>
      <span>Custom theme {themeStore.isCustomActive ? '(active)' : ''}</span>
      <button
        type="button"
        onClick={() => { if (confirm('Delete the custom theme? This reverts to BoardRipper Default.')) themeStore.resetCustom(); }}
        style={{ marginLeft: 'auto', background: 'none', border: '1px solid var(--border)', color: 'var(--danger)', fontSize: 10, padding: '2px 8px', borderRadius: 3, cursor: 'pointer', textTransform: 'none', letterSpacing: 0 }}
        title="Delete the custom theme"
      >
        Delete custom
      </button>
    </div>
  );
}

/** Live effective render settings (global ⊕ board ⊕ theme overrides). */
function useEffectiveSettings(): RenderSettings {
  return useSyncExternalStore(
    (cb) => renderSettingsStore.subscribe(cb),
    () => renderSettingsStore.settings,
  );
}

/**
 * Gate a theme-colour edit. If the custom theme is already active, runs the
 * edit directly. Otherwise asks once to fork the current theme into the
 * single custom slot (overwriting it if one exists) and switches to it, then
 * runs the edit. Returns true if the edit should proceed. Editing built-in
 * themes is never destructive — it always forks to custom first.
 */
function gateThemeEdit(): boolean {
  if (themeStore.isCustomActive) return true;
  const had = !!themeStore.customTheme;
  const ok = confirm(
    had
      ? 'Editing colours here will overwrite your existing custom theme with the current theme + this change, and switch to it. Continue?'
      : 'Editing colours here will create a custom theme from the current one and switch to it. Continue?',
  );
  if (!ok) return false;
  // Fork the currently-active theme (preserving its palette) into the custom
  // slot and switch to it.
  themeStore.forkToCustom();
  return true;
}

/** Pin-group colour editor (Theme tab). Reads the effective pinGroups and
 *  writes the whole array to the active theme via the copy-to-custom gate. */
function ThemePinGroupsEditor() {
  useThemeId(); // re-render on theme switch
  const settings = useEffectiveSettings();
  const groups = settings.pinGroups ?? [];

  // Commit a transformed copy of the groups through the gate.
  const commit = (next: PinGroup[]) => {
    if (!gateThemeEdit()) return;
    themeStore.setCustomOverride('pinGroups', next);
  };
  const editRule = (gi: number, ri: number, patch: Partial<PinGroupRule>) =>
    commit(groups.map((g, i) => i !== gi ? g : { ...g, rules: g.rules.map((r, j) => j !== ri ? r : { ...r, ...patch }) }));
  const removeRule = (gi: number, ri: number) =>
    commit(groups.map((g, i) => i !== gi ? g : { ...g, rules: g.rules.filter((_, j) => j !== ri) }));
  const addRule = (gi: number) =>
    commit(groups.map((g, i) => i !== gi ? g : { ...g, rules: [...g.rules, { id: `r${Date.now()}`, keywords: '', color: '#888888' }] }));
  const setOutline = (gi: number, on: boolean) =>
    commit(groups.map((g, i) => i !== gi ? g : { ...g, outlineOnly: on }));

  return (
    <div>
      <div style={GROUP_LABEL}>Pin colours (by net group)</div>
      <div style={{ fontSize: 10.5, color: 'var(--text-secondary)', opacity: 0.75, padding: '0 0 6px' }}>
        Keywords are comma-separated, matched case-insensitively (substring; <code style={{ fontFamily: MONO }}>*</code> = wildcard, <code style={{ fontFamily: MONO }}>#</code> = digits). First match across groups wins, in order.
      </div>
      {groups.map((g, gi) => (
        <div key={g.id} style={{ marginBottom: 8, border: '1px solid var(--border)', borderRadius: 5, padding: '6px 8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)' }}>{g.label}</span>
            <label style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'var(--text-secondary)', cursor: 'pointer' }}
              title="Render matching pins as outline-only circles (no fill / no labels) — e.g. no-connect pins.">
              <input type="checkbox" checked={g.outlineOnly} onChange={(e) => setOutline(gi, e.target.checked)} />
              outline-only
            </label>
          </div>
          {g.rules.map((r, ri) => (
            <PinGroupRuleRow key={r.id} rule={r}
              onKeywords={(kw) => editRule(gi, ri, { keywords: kw })}
              onColor={(c) => editRule(gi, ri, { color: c })}
              onRemove={() => removeRule(gi, ri)} />
          ))}
          <button type="button" className="color-rule-add-btn" style={{ marginTop: 2 }} onClick={() => addRule(gi)} title="Add a keyword→colour rule to this group">+ rule</button>
        </div>
      ))}
      <div style={GROUP_LABEL}>Default pin colour (no group matched)</div>
      <MiniColorRow label="Top side" value={settings.defaultPinColorTop}
        onChange={(h) => { if (gateThemeEdit()) themeStore.setCustomOverride('defaultPinColorTop', h); }} />
      <MiniColorRow label="Bottom side" value={settings.defaultPinColorBottom}
        onChange={(h) => { if (gateThemeEdit()) themeStore.setCustomOverride('defaultPinColorBottom', h); }} />

      <ThemeNetLabelEditor />
    </div>
  );
}

/** Net-name label styling — font colour + background colour & opacity. Lives
 *  with the net colours (Pin colours section). Font is theme.board.labelNet;
 *  the background box (shown when the per-side bg toggle is on) is
 *  theme.board.netLabelBg / netLabelBgOpacity. All route through the gate. */
function ThemeNetLabelEditor() {
  useThemeId();
  const board = themeStore.activeTheme().board;
  const opacity = board.netLabelBgOpacity ?? 0.6;
  return (
    <div>
      <div style={GROUP_LABEL}>Net labels</div>
      <MiniColorRow label="Font" value={board.labelNet}
        onChange={(h) => { if (gateThemeEdit()) themeStore.updateCustom({ board: { labelNet: h } }); }} />
      <MiniColorRow label="Background" value={board.netLabelBg ?? '#000000'}
        onChange={(h) => { if (gateThemeEdit()) themeStore.updateCustom({ board: { netLabelBg: h } }); }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
        <span style={{ fontSize: 11, color: 'var(--text-secondary)', minWidth: 104 }}>Bg opacity</span>
        <input type="range" min={0} max={1} step={0.05} value={opacity}
          onChange={(e) => { if (gateThemeEdit()) themeStore.updateCustom({ board: { netLabelBgOpacity: parseFloat(e.target.value) } }); }}
          style={{ flex: 1, accentColor: 'var(--accent)' }} />
        <code style={{ fontSize: 10.5, color: 'var(--text-secondary)', fontFamily: MONO, minWidth: 28, textAlign: 'right' }}>{Math.round(opacity * 100)}%</code>
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--text-secondary)', opacity: 0.7, padding: '2px 0' }}>
        The background box appears when net-label backgrounds are enabled (Board ▸ Labels).
      </div>
    </div>
  );
}

/** One pin-group rule row: keywords (commit on blur) + colour (live) + remove. */
function PinGroupRuleRow({ rule, onKeywords, onColor, onRemove }: {
  rule: PinGroupRule;
  onKeywords: (kw: string) => void;
  onColor: (c: string) => void;
  onRemove: () => void;
}) {
  const [text, setText] = useState(rule.keywords);
  const [prev, setPrev] = useState(rule.keywords);
  if (prev !== rule.keywords) { setPrev(rule.keywords); setText(rule.keywords); }
  const commit = () => { if (text !== rule.keywords) onKeywords(text); };
  return (
    <div className="color-rule-row">
      <input type="text" className="color-rule-pattern" value={text}
        onChange={(e) => setText(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        placeholder="VCC, 3V3, …" title="Comma-separated keywords" />
      <input type="color" className="color-rule-color" value={rule.color} onChange={(e) => onColor(e.target.value)} />
      <button className="color-rule-remove" onClick={onRemove} title="Remove rule">×</button>
    </div>
  );
}

function ThemeTab() {
  const activeId = useThemeId();
  const themes: Theme[] = themeStore.list();
  const overrides = useThemeOverrides();
  const activeTheme = themes.find((t) => t.id === activeId);
  const effectiveAccent = overrides.accent ?? activeTheme?.ui.accent ?? '#4a9eff';
  const effectiveBackground = overrides.background ?? activeTheme?.ui.bgPrimary ?? '#08080c';
  const effectiveChrome = overrides.chrome ?? activeTheme?.ui.bgTertiary ?? '#0c1424';

  return (
    <div className="settings-section-body" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-secondary)', marginBottom: 6 }}>
          Board theme
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', padding: '0 8px 6px' }}>
          Picks the canvas / board-side colour set (background, fill, outline,
          selection accent) and any per-theme settings overlays. Light themes
          also set a light interface baseline; text auto-adjusts for contrast.
          The colour pickers below override the chosen theme's chrome.
        </div>
        <div role="radiogroup" aria-label="Board theme" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {themes.map(t => (
            <label
              key={t.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 8px',
                borderRadius: 4,
                cursor: 'pointer',
                background: activeId === t.id ? 'var(--bg-secondary)' : 'transparent',
              }}
            >
              <input
                type="radio"
                name="theme-picker"
                value={t.id}
                checked={activeId === t.id}
                onChange={() => themeStore.setTheme(t.id)}
              />
              <span>{t.label}</span>
              <span
                style={{
                  marginLeft: 'auto',
                  width: 14,
                  height: 14,
                  borderRadius: 3,
                  background: t.board.canvasBackground,
                  border: `1px solid ${t.ui.border}`,
                  boxShadow: `inset 0 0 0 1px ${t.board.boardFill}`,
                }}
                aria-hidden="true"
              />
            </label>
          ))}
        </div>
      </div>

      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-secondary)' }}>
        Interface colours
      </div>

      <TokenPickerBlock
        title="Accent"
        effective={effectiveAccent}
        override={overrides.accent}
        onChange={(h) => themeStore.setAccent(h)}
        onReset={() => themeStore.setAccent(null)}
        presets={ACCENT_PRESETS}
        hint={
          <>
            Drives <code style={{ fontFamily: 'ui-monospace, Menlo, Consolas, monospace' }}>--accent</code>{' '}
            (focus, active states, links) and{' '}
            <code style={{ fontFamily: 'ui-monospace, Menlo, Consolas, monospace' }}>--accent-hover</code>{' '}
            (derived in CSS via <code style={{ fontFamily: 'ui-monospace, Menlo, Consolas, monospace' }}>color-mix</code>).
            Pill colours and selection (yellow) are independent.
          </>
        }
      />

      <TokenPickerBlock
        title="Background"
        effective={effectiveBackground}
        override={overrides.background}
        onChange={(h) => themeStore.setBackground(h)}
        onReset={() => themeStore.setBackground(null)}
        hint={
          <>
            The canvas + interactive surface tier. Drives{' '}
            <code style={{ fontFamily: 'ui-monospace, Menlo, Consolas, monospace' }}>--bg-primary</code>;{' '}
            <code style={{ fontFamily: 'ui-monospace, Menlo, Consolas, monospace' }}>--bg-secondary</code>{' '}
            (cards, button surfaces) cascades 6% lighter.
          </>
        }
      />

      <TokenPickerBlock
        title="Chrome"
        effective={effectiveChrome}
        override={overrides.chrome}
        onChange={(h) => themeStore.setChrome(h)}
        onReset={() => themeStore.setChrome(null)}
        hint={
          <>
            Toolbar, status bar, and tab strip surfaces. Drives{' '}
            <code style={{ fontFamily: 'ui-monospace, Menlo, Consolas, monospace' }}>--bg-tertiary</code>;{' '}
            <code style={{ fontFamily: 'ui-monospace, Menlo, Consolas, monospace' }}>--border</code>{' '}
            (panel boundaries) cascades 12% lighter.
          </>
        }
      />

      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-secondary)' }}>
        Interface scale
      </div>
      <InterfaceScaleSlider />

      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-secondary)', borderTop: '1px solid var(--border)', paddingTop: 12 }}>
        Board & pin colours
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-secondary)', padding: '0 0 2px' }}>
        These are carried by the theme. Editing any of them copies the current
        theme into your custom theme (one slot) and switches to it.
      </div>
      <CustomThemeStrip />
      <ThemeBoardColorsEditor />
      <ThemePinGroupsEditor />
      <ThemeComponentFillsEditor />

    </div>
  );
}

// Suppress unused-warning when THEMES is only referenced indirectly via themeStore.list().
void THEMES;

function LibraryTab() {
  const obd = useObdForBoard(undefined);
  const [confirming, setConfirming] = useState(false);

  // Cold-start: when the user opens this tab, refresh the index status
  // from disk so "Last synced: ..." reflects index.json without waiting
  // for the user to view a board first.
  useEffect(() => { obd.refreshStatus(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="settings-tab-body" data-testid="settings-library-tab">
      <LibrarySyncSection />

      <StandaloneCollapsibleSection title="OpenBoardData" storageKey="obd" searchSectionId="obd">
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.4, margin: '0 0 12px' }}>
          Per-net diagnostic measurements (diode / voltage / resistance) and repair notes from{' '}
          <a href="https://openboarddata.org" target="_blank" rel="noopener noreferrer">openboarddata.org</a>.
          Data is community-contributed under the <strong>ODbL 1.0</strong> license. BoardRipper does not bundle this data;
          you fetch it on demand. Re-distribution requires keeping the same license — see{' '}
          <a href="https://opendatacommons.org/licenses/odbl/1-0/" target="_blank" rel="noopener noreferrer">
            the license terms
          </a>.
        </p>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <button
            onClick={() => obd.syncIndex()}
            disabled={obd.syncing}
            data-testid="obd-sync-btn"
          >
            {obd.syncing ? 'Syncing…' : 'Sync OBD index'}
          </button>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            {obd.indexSynced
              ? `Last synced: ${obd.indexSyncedAt} · ${obd.indexBoardCount} boards`
              : 'Never synced'}
          </span>
        </div>
        {obd.error && (
          <div style={{ color: '#c33', fontSize: 12, marginBottom: 8 }}>{obd.error}</div>
        )}

        <div style={{ marginTop: 12 }}>
          {!confirming ? (
            <button onClick={() => setConfirming(true)}>Delete all OBD data</button>
          ) : (
            <span>
              <strong>Are you sure?</strong>{' '}
              <button onClick={async () => { await obd.clearCache(); setConfirming(false); }}>
                Yes, delete
              </button>{' '}
              <button onClick={() => setConfirming(false)}>Cancel</button>
            </span>
          )}
        </div>
      </StandaloneCollapsibleSection>
    </div>
  );
}
