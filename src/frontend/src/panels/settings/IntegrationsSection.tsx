/**
 * Settings ▸ Integrations: connect an AI assistant to BoardRipper's MCP server.
 *
 * One choice and one action: pick the assistant, and the sheet shows the one
 * thing that installs it (a deep link, a command or a config snippet) with
 * this browser's pairing token already in it. Picking one turns the server on.
 * The sheet then waits for the assistant's first call and lists every
 * connected assistant with its own "can control the board" switch.
 *
 * Recipes live in store/mcp-clients.ts. The shared install token, OAuth and
 * the connection test are under Advanced. Design:
 * docs/specs/2026-11-11-ai-toolkit.html.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { StandaloneCollapsibleSection } from './StandaloneCollapsibleSection';
import { copyText } from '../../clipboard';
import { isElectron, hasBackend } from '../../store/databank-store';
import { startMcpBridge, stopMcpBridge, getMcpClientIdentity, setMcpClientLabel } from '../../store/mcp-bridge';
import { boardStore } from '../../store/board-store';
import { CLIENT_RECIPES, renderRecipe, type ClientRecipe } from '../../store/mcp-clients';

interface McpActivity { last_tool: string; last_tool_at_ms: number; total_calls: number; }
interface McpStatus { enabled: boolean; drive_ui: boolean; clients: number; activity?: McpActivity; auth_mode?: string; }

interface AgentRow {
  key: string;
  name: string;
  client_name: string;
  credential: 'browser' | 'shared' | 'oauth' | 'assistant';
  browser_id?: string;
  browser_label?: string;
  last_seen_ms: number;
  first_seen: string;
  last_tool?: string;
  calls: number;
  drive?: boolean | null;
  blocked?: boolean;
}

const GROUP_LABELS: Record<ClientRecipe['group'], string> = {
  editor: 'Coding agents and editors',
  desktop: 'Desktop apps',
  cloud: 'Cloud chat (needs remote access)',
};

function ago(ms: number): string {
  if (!ms) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

async function putConfig(key: string, value: string) {
  await fetch('/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value }),
  });
}

function CopyButton({ text, label = 'Copy', testId }: { text: string; label?: string; testId?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <button type="button" className="ai-btn" data-testid={testId}
      onClick={async () => {
        try { await copyText(text); setState('copied'); }
        catch { setState('failed'); }
        setTimeout(() => setState('idle'), 1600);
      }}>
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Select the text and copy it' : label}
    </button>
  );
}

function ElectronMcpToggle() {
  const [enabled, setEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    window.electronAPI!.getMcpEnabled().then(v => { setEnabled(v); setLoaded(true); });
  }, []);
  return (
    <div className="settings-row settings-toggle-row">
      <label className="settings-label">AI server on</label>
      <input type="checkbox" checked={enabled} disabled={!loaded || pending}
        onChange={async e => {
          const on = e.target.checked;
          setPending(true); setEnabled(on);
          // Reachable only if the page did NOT navigate (i.e. a failed enable).
          setEnabled(await window.electronAPI!.setMcpEnabled(on));
          setPending(false);
        }} />
    </div>
  );
}

export function IntegrationsSection() {
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [clientId, setClientId] = useState<string>(() => {
    try { return localStorage.getItem('boardripper-ai-client') || 'claude-code'; } catch { return 'claude-code'; }
  });
  const [pickedAt, setPickedAt] = useState(0);
  const [pairToken, setPairToken] = useState('');
  const [pairError, setPairError] = useState('');
  const [pairLabel, setPairLabel] = useState(() => getMcpClientIdentity().label);
  const [advanced, setAdvanced] = useState(false);
  const [useShared, setUseShared] = useState(false);
  const [sharedToken, setSharedToken] = useState('');
  const [test, setTest] = useState<{ ok: boolean; tools?: string[]; error?: string } | null>(null);
  const me = getMcpClientIdentity().id;

  const refresh = useCallback(() => {
    fetch('/api/mcp/status').then(r => r.ok ? r.json() : null)
      .then((s: McpStatus | null) => setStatus(s)).catch(() => setStatus(null));
    fetch('/api/agents').then(r => r.ok ? r.json() : null)
      .then((d: { agents?: AgentRow[] } | null) => setAgents(d?.agents ?? [])).catch(() => { /* keep */ });
  }, []);

  const pair = useCallback((label?: string) => {
    const ident = getMcpClientIdentity();
    fetch('/api/mcp/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: ident.id, label: label ?? ident.label }),
    })
      .then(async r => {
        if (!r.ok) { setPairError(r.status === 403 ? await r.text() : `Could not create this browser's token (HTTP ${r.status}).`); return null; }
        setPairError('');
        return r.json();
      })
      .then((d: { token?: string; label?: string } | null) => {
        if (d?.token) setPairToken(d.token);
        if (d?.label) { setPairLabel(d.label); setMcpClientLabel(d.label); }
      })
      .catch(() => setPairError('Could not reach BoardRipper to create this browser’s token.'));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    if (!status?.enabled) { setPairToken(''); return; }
    pair();
  }, [status?.enabled, pair]);
  useEffect(() => {
    if (!status?.enabled) return;
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [status?.enabled, refresh]);

  const setEnabled = async (on: boolean) => {
    setStatus(s => s ? { ...s, enabled: on } : { enabled: on, drive_ui: false, clients: 0 });
    try { await putConfig('mcp_enabled', on ? 'true' : ''); } catch { /* refresh shows the truth */ }
    if (on) startMcpBridge(); else stopMcpBridge();
    refresh();
  };

  const pick = (r: ClientRecipe) => {
    setClientId(r.id);
    try { localStorage.setItem('boardripper-ai-client', r.id); } catch { /* ignore */ }
    setPickedAt(Date.now());
    if (status && !status.enabled && !isElectron() && r.method !== 'remote') void setEnabled(true);
  };

  const revealShared = () => {
    fetch('/api/mcp/token').then(async r => r.ok ? r.json() : Promise.reject(await r.text()))
      .then((d: { token?: string }) => { setSharedToken(d.token ?? ''); setUseShared(true); })
      .catch((msg) => boardStore.addToast(typeof msg === 'string' && msg ? msg : 'Could not read the shared token.', 'error'));
  };

  const updateAgent = async (key: string, change: Record<string, unknown>) => {
    const r = await fetch('/api/agents/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, ...change }),
    }).catch(() => null);
    if (!r || !r.ok) boardStore.addToast('Could not change that assistant’s settings.', 'error');
    refresh();
  };

  const enabled = !!status?.enabled;
  const oauthMode = status?.auth_mode === 'oauth';
  const recipe = CLIENT_RECIPES.find(r => r.id === clientId) ?? CLIENT_RECIPES[0];
  const baseUrl = `${location.protocol}//${location.host}/api/mcp`;
  const token = useShared ? sharedToken : pairToken;
  const out = useMemo(() => renderRecipe(recipe, { baseUrl, token, oauthMode }), [recipe, baseUrl, token, oauthMode]);

  // The first call after the user picked a tile, from this browser's token
  // (or any token, when the shared one is in use).
  const fresh = pickedAt
    ? agents.find(a => a.last_seen_ms >= pickedAt && (useShared || a.browser_id === me))
    : undefined;
  const connectedIds = new Set(agents.filter(a => a.browser_id === me && !a.blocked).map(a => a.client_name.toLowerCase()));
  const tileConnected = (r: ClientRecipe) =>
    [...connectedIds].some(n => n.includes(r.id.replace('-', ' ')) || n.includes(r.id) || n.includes(r.label.toLowerCase()));

  const credentialText = (a: AgentRow) => {
    if (a.credential === 'browser') return a.browser_id === me ? 'this browser' : (a.browser_label || 'another browser');
    if (a.credential === 'oauth') return 'signed in with OAuth';
    if (a.credential === 'assistant') return 'BoardRipper assistant';
    return 'shared token';
  };

  return (
    <div className="settings-tab-body">
      <StandaloneCollapsibleSection title="AI assistants" defaultOpen storageKey="mcp">
        <p className="settings-hint">
          Let an AI assistant you already use read the open board, its schematic and your library,
          and point things out on the board. It runs under that assistant’s own account; BoardRipper
          never sees your sign-in. Pick yours:
        </p>

        {isElectron()
          ? <ElectronMcpToggle />
          : (
            <div className="settings-row settings-toggle-row">
              <label className="settings-label">AI server on</label>
              <input type="checkbox" data-testid="mcp-enabled" checked={enabled}
                onChange={e => setEnabled(e.target.checked)} />
            </div>
          )}

        <div className="ai-pick" data-testid="ai-client-grid">
          {(['editor', 'desktop', 'cloud'] as const).map(g => (
            <div key={g} className="ai-group">
              <div className="ai-group-label">{GROUP_LABELS[g]}</div>
              <div className="ai-tiles">
                {CLIENT_RECIPES.filter(r => r.group === g).map(r => (
                  <button key={r.id} type="button" className="ai-tile" aria-pressed={r.id === recipe.id}
                    data-ai-client={r.id} onClick={() => pick(r)}>
                    <span className="ai-tile-name" translate="no">
                      {tileConnected(r) && <span className="ai-dot" aria-label="connected" />}
                      {r.label}
                    </span>
                    <span className="ai-tile-sub">{r.sub}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="ai-detail" data-testid="ai-client-detail">
          <div className="ai-detail-name" translate="no">{recipe.label}</div>
          <p className="settings-hint">{recipe.how}</p>
          {recipe.method !== 'remote' && !enabled && !isElectron() && (
            <p className="settings-hint">The AI server is off. Picking an assistant turns it on.</p>
          )}
          {recipe.method !== 'remote' && enabled && (
            <>
              {pairError && <p className="ai-error">{pairError}</p>}
              {out.link && (
                <a className="ai-btn ai-btn-primary" href={out.link} data-testid="ai-open-link"
                  onClick={() => setPickedAt(Date.now())}>{out.action}</a>
              )}
              {out.snippet && (
                <>
                  {out.link && <p className="settings-hint">Or paste this:</p>}
                  <pre className="mcp-connect-cmd ai-snippet" translate="no">{out.snippet}</pre>
                  <CopyButton text={out.snippet} label={out.link ? 'Copy' : out.action} testId="ai-copy" />
                </>
              )}
              {fresh
                ? <div className="ai-status ai-status-ok" data-testid="ai-connected">✓ {fresh.name} is connected.</div>
                : pickedAt > 0 && <div className="ai-status" data-testid="ai-waiting"><span className="ai-pulse" />Waiting for the first call from {recipe.label}…</div>}
              <p className="settings-hint">
                {useShared
                  ? 'Uses the shared token: the assistant can see and control every browser’s boards on this server.'
                  : out.usesOAuth
                    ? 'You approve access in the browser the first time it connects. It sees only the boards open in the browser you approve from.'
                    : 'Sees only the boards open in this browser.'}
                {recipe.tools && ` Offers the board, board-control, PDF and worklist tools only (some editors cap how many tools they pass on).`}
              </p>
            </>
          )}
        </div>

        <div className="ai-agents" data-testid="ai-agents">
          <div className="ai-group-label">Connected assistants</div>
          {agents.length === 0 && <p className="settings-hint">None yet. An assistant appears here after its first request.</p>}
          {agents.map(a => (
            <div key={a.key} className="ai-agent-row" data-agent-key={a.key}>
              <div className="ai-agent-main">
                <span className="ai-agent-name" translate="no">{a.name}</span>
                <span className="ai-agent-sub">
                  {credentialText(a)} · {a.blocked ? 'disconnected' : `last request ${ago(a.last_seen_ms)}`}
                  {a.last_tool ? ` · ${a.last_tool}` : ''} · {a.calls} calls
                </span>
              </div>
              <select className="ai-select" value={a.drive == null ? 'default' : a.drive ? 'on' : 'off'}
                aria-label={`Board control for ${a.name}`} disabled={a.blocked}
                onChange={e => updateAgent(a.key, { drive: e.target.value })}>
                <option value="default">Board control: {status?.drive_ui ? 'on' : 'off'} (default)</option>
                <option value="on">Board control: on</option>
                <option value="off">Board control: off</option>
              </select>
              {a.blocked
                ? <button type="button" className="ai-btn" onClick={() => updateAgent(a.key, { blocked: false })}>Allow again</button>
                : <button type="button" className="ai-btn" onClick={() => updateAgent(a.key, { blocked: true })}>Disconnect</button>}
              <button type="button" className="ai-btn ai-btn-quiet" title="Remove from this list"
                aria-label={`Remove ${a.name} from this list`} onClick={() => updateAgent(a.key, { forget: true })}>×</button>
            </div>
          ))}
        </div>

        <div className="settings-row settings-toggle-row">
          <label className="settings-label" title="Highlight nets, select parts, change side, turn PDF pages, write to the worklist. Each assistant above can override this.">
            Let assistants control the board by default
          </label>
          <input type="checkbox" data-testid="mcp-drive-ui" checked={!!status?.drive_ui} disabled={!enabled}
            onChange={async e => { const on = e.target.checked; setStatus(s => s ? { ...s, drive_ui: on } : s); await putConfig('mcp_drive_ui', on ? 'true' : ''); refresh(); }} />
        </div>

        <button type="button" className="ai-advanced-toggle" aria-expanded={advanced}
          data-testid="ai-advanced" onClick={() => setAdvanced(v => !v)}>
          {advanced ? '▾' : '▸'} Advanced
        </button>
        {advanced && (
          <div className="ai-advanced">
            <div className="settings-row" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <label className="settings-label" title="Shown to assistants in board_sessions so your browser is recognizable">This browser’s name</label>
              <input type="text" data-testid="mcp-pair-label" value={pairLabel} disabled={!enabled}
                style={{ flex: 1, minWidth: 0 }}
                onChange={e => setPairLabel(e.target.value)}
                onBlur={e => { const v = e.target.value.trim(); if (v) { setMcpClientLabel(v); pair(v); } }} />
              <button type="button" className="ai-btn" disabled={!enabled}
                title="Make a new token for this browser; assistants using the old one stop working"
                onClick={() => {
                  fetch('/api/mcp/pair/rotate', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ client_id: getMcpClientIdentity().id }),
                  }).then(r => r.ok ? r.json() : null)
                    .then((d: { token?: string } | null) => { if (d?.token) setPairToken(d.token); })
                    .catch(() => { /* keep the old token visible */ });
                }}>Rotate</button>
            </div>
            <div className="settings-row settings-toggle-row">
              <label className="settings-label" title="Reaches every browser’s boards on this server. Use only for an assistant that has to work across all sessions.">
                Use the shared token (all browsers)
              </label>
              <input type="checkbox" data-testid="mcp-use-shared" checked={useShared} disabled={!enabled}
                onChange={e => e.target.checked ? revealShared() : setUseShared(false)} />
            </div>
            <div className="settings-row settings-toggle-row">
              <label className="settings-label" title="Clients that support it connect with the URL alone and you approve them in the browser. Works on HTTPS or localhost addresses.">
                Offer OAuth sign-in
              </label>
              <input type="checkbox" data-testid="mcp-oauth" checked={oauthMode} disabled={!enabled}
                onChange={async e => { await putConfig('mcp_auth_mode', e.target.checked ? 'oauth' : 'token'); refresh(); }} />
            </div>
            <div className="ai-advanced-actions">
              <button type="button" className="ai-btn" data-testid="mcp-oauth-reset" disabled={!enabled}
                onClick={() => {
                  fetch('/api/mcp/oauth/reset', { method: 'POST' }).then(r => r.ok ? r.json() : null)
                    .then((d: { revoked?: number } | null) => {
                      const n = d?.revoked ?? 0;
                      boardStore.addToast(n > 0 ? `Signed out ${n} OAuth assistant${n === 1 ? '' : 's'}.` : 'No OAuth assistants were signed in.', 'info');
                    })
                    .catch(() => boardStore.addToast('Could not reach BoardRipper.', 'error'));
                }}>Sign out all OAuth assistants</button>
              <button type="button" className="ai-btn" disabled={!enabled} data-testid="mcp-selftest"
                onClick={async () => {
                  try { const r = await fetch('/api/mcp/selftest', { method: 'POST' }); setTest(await r.json()); }
                  catch (e) { setTest({ ok: false, error: String((e as Error)?.message ?? e) }); }
                }}>Test the server</button>
              {test && (
                <span className="settings-hint" style={{ margin: 0 }}>
                  {test.ok ? `Working: ${test.tools?.length ?? 0} tools.` : `Failed: ${test.error ?? 'no answer'}`}
                </span>
              )}
            </div>
            <p className="settings-hint">
              Server address: <code translate="no">{baseUrl}</code>. Add <code>?tools=board,drive,pdf,worklist,library</code> to
              offer fewer tools, or <code>?read_only=1</code> to offer none that change anything.
              {status ? ` Browsers connected to the server: ${status.clients}.` : ''}
            </p>
            {isElectron() && !hasBackend() && (
              <p className="settings-hint">Turn the AI server on to see the address and tokens.</p>
            )}
          </div>
        )}
      </StandaloneCollapsibleSection>
    </div>
  );
}
