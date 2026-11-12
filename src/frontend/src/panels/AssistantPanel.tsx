/**
 * The Assistant destination: a chat about the open board, answered by a model
 * the user chose (their own API key, or a model on their network) with the
 * same tools BoardRipper's MCP server offers.
 *
 * Two views: setup (pick a provider, key, model) and chat. Before a tool
 * changes what the board shows, or writes to the worklist, the chat asks.
 * Subscriptions (Claude Pro/Max, ChatGPT Plus, Google AI Pro) are not offered
 * here — those vendors allow them only in their own apps, which connect
 * through Settings ▸ Integrations instead. Design:
 * docs/specs/2026-11-11-ai-toolkit.html (Part B).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { IconPlayerStopFilled, IconSend2, IconSettings, IconPlus } from '@tabler/icons-react';
import { assistantStore, useAssistant, takePendingDraft, type AssistantProvider, type PendingApproval, type ChatMessage } from '../store/assistant-store';
import { NoteBody } from '../components/DiagnosisNotes';
import { useBoardStore } from '../hooks/useBoardStore';
import { boardStore } from '../store/board-store';
import { hasBackend, isElectron } from '../store/databank-store';
import { showSidebarTab } from '../components/Sidebar.utils';
import { startMcpBridge } from '../store/mcp-bridge';
import type { BoardData } from '../parsers';

const SUGGESTIONS = [
  'Summarise this board: what device, which board, the main power rails.',
  'What does the selected part do, and what should I measure on it?',
  'Where does the main power rail come from, and what is on it?',
];

// ---- text rendering: short paragraphs, bullets, **bold**, `code`, chips ----

function Inline({ text, board }: { text: string; board: BoardData | null }) {
  const out: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let cursor = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > cursor) out.push(<NoteBody key={k++} body={text.slice(cursor, m.index)} board={board} />);
    const tok = m[0];
    if (tok.startsWith('**')) out.push(<strong key={k++}><NoteBody body={tok.slice(2, -2)} board={board} /></strong>);
    else out.push(<code key={k++}>{tok.slice(1, -1)}</code>);
    cursor = m.index + tok.length;
  }
  if (cursor < text.length) out.push(<NoteBody key={k++} body={text.slice(cursor)} board={board} />);
  return <>{out}</>;
}

function RichText({ text, board }: { text: string; board: BoardData | null }) {
  const blocks: React.ReactNode[] = [];
  let list: string[] = [];
  let k = 0;
  const flush = () => {
    if (list.length) {
      blocks.push(<ul key={k++}>{list.map((l, i) => <li key={i}><Inline text={l} board={board} /></li>)}</ul>);
      list = [];
    }
  };
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const bullet = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) { list.push(bullet[1]); continue; }
    flush();
    if (!line.trim()) continue;
    const head = /^#{1,4}\s+(.*)$/.exec(line);
    if (head) blocks.push(<p key={k++} className="asst-head"><Inline text={head[1]} board={board} /></p>);
    else blocks.push(<p key={k++}><Inline text={line} board={board} /></p>);
  }
  flush();
  return <>{blocks}</>;
}

// ---- approvals -----------------------------------------------------------

function describe(a: PendingApproval): string {
  const s = (k: string) => String(a.args[k] ?? '');
  switch (a.tool) {
    case 'highlight_net': return `Highlight net ${s('net')} on the board?`;
    case 'clear_highlight': return 'Clear the highlighted net?';
    case 'select_part': return `Select ${s('part') || s('refdes') || 'a part'} on the board?`;
    case 'set_side': return `Show the ${s('side') || 'other'} side of the board?`;
    case 'pdf_goto': return `Turn the PDF to page ${s('page')}${s('query') ? ` (${s('query')})` : ''}?`;
    case 'switch_tab': return `Switch to the board tab ${s('name') || s('id')}?`;
    case 'open_file': return `Open library file #${s('file_id')}?`;
    case 'worklist_add':
    case 'worklist_update': return `${a.tool === 'worklist_add' ? 'Add' : 'Update'} ${s('id')} on the worklist${s('mark') ? ` as ${s('mark')}` : ''}${s('note') ? `: “${s('note')}”` : ''}?`;
    case 'worklist_set_list_note': return `Set the worklist’s diagnosis note to “${s('note')}”?`;
    case 'request_measurement': return `Add a measurement request for ${s('target')} to the worklist?`;
  }
  return `Run ${a.tool}?`;
}

function ApprovalCard({ a }: { a: PendingApproval }) {
  return (
    <div className="asst-approval" data-testid="assistant-approval" role="group" aria-label="The assistant asks for permission">
      <div className="asst-approval-q" translate="no">{describe(a)}</div>
      <div className="asst-approval-actions">
        <button type="button" className="ai-btn ai-btn-primary" data-testid="assistant-allow" onClick={() => assistantStore.approve('once')}>Allow</button>
        {a.kind === 'drive' && (
          <button type="button" className="ai-btn" data-testid="assistant-allow-always" onClick={() => assistantStore.approve('always')}
            title="Let the assistant highlight, select and turn pages without asking. Change it in Settings ▸ Integrations ▸ Connected assistants.">
            Always allow board control
          </button>
        )}
        <button type="button" className="ai-btn" data-testid="assistant-deny" onClick={() => assistantStore.approve('deny')}>Don’t</button>
      </div>
    </div>
  );
}

// ---- setup ------------------------------------------------------------------

function Setup({ onDone }: { onDone: () => void }) {
  const a = useAssistant();
  const cfg = a.config!;
  const [pid, setPid] = useState(cfg.active || 'anthropic');
  const p = cfg.providers.find(x => x.id === pid) as AssistantProvider;
  const [key, setKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(p.base_url);
  const [model, setModel] = useState(p.model);
  const [models, setModels] = useState<string[]>([]);
  const [modelsError, setModelsError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { setBaseUrl(p.base_url); setModel(p.model); setKey(''); setModels([]); setModelsError(''); setError(''); }, [pid]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadModels = async () => {
    const r = await assistantStore.models(pid);
    setModels(r.models ?? []);
    setModelsError(r.error ?? '');
    if (!model && r.models?.length) setModel(r.models[0]);
  };
  useEffect(() => { if (!p.needs_key || p.has_key) void loadModels(); }, [pid, p.has_key]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setBusy(true); setError('');
    const err = await assistantStore.saveConfig({
      provider: pid, api_key: key || undefined, base_url: baseUrl !== p.base_url ? baseUrl : undefined,
      model: model || undefined, activate: true,
    });
    setBusy(false);
    if (err) { setError(err); return; }
    setKey('');
    if (assistantStore.ready) onDone(); else void loadModels();
  };

  return (
    <div className="asst-setup" data-testid="assistant-setup">
      <p className="settings-hint">
        The assistant answers with a model you choose: your own API key, billed to you by that provider,
        or a model running on your network. What you ask about (board data, PDF text) goes to that provider.
      </p>
      <div className="ai-group-label">Model provider</div>
      <div className="ai-tiles">
        {cfg.providers.map(x => (
          <button key={x.id} type="button" className="ai-tile" aria-pressed={x.id === pid} data-provider={x.id} onClick={() => setPid(x.id)}>
            <span className="ai-tile-name" translate="no">{x.has_key && <span className="ai-dot" aria-label="key saved" />}{x.label}</span>
            <span className="ai-tile-sub">{x.local ? 'on your network' : 'your API key'}</span>
          </button>
        ))}
      </div>

      {p.needs_key && (
        <label className="asst-field">
          <span>API key</span>
          <input type="password" autoComplete="off" spellCheck={false} data-testid="assistant-key" value={key}
            placeholder={p.has_key ? `Saved, ends in ${p.key_hint ?? '…'}. Paste a new one to replace it.` : 'Paste your API key'}
            onChange={e => setKey(e.target.value)} />
          <span className="asst-field-note">
            Stored on the BoardRipper server for this browser only, never shown again.{' '}
            {p.key_url && <a href={p.key_url} target="_blank" rel="noreferrer">Get a key</a>}
            {p.has_key && <> · <button type="button" className="asst-link" onClick={() => assistantStore.saveConfig({ provider: pid, clear_key: true })}>Remove the saved key</button></>}
          </span>
        </label>
      )}
      {p.local && (
        <label className="asst-field">
          <span>Address</span>
          <input type="text" spellCheck={false} value={baseUrl} onChange={e => setBaseUrl(e.target.value)} />
          <span className="asst-field-note">As the BoardRipper server reaches it. On a NAS, use the computer’s network address, not localhost.</span>
        </label>
      )}
      <label className="asst-field">
        <span>Model</span>
        {models.length > 0
          ? <select value={model} data-testid="assistant-model" onChange={e => setModel(e.target.value)}>
              {!models.includes(model) && model && <option value={model}>{model}</option>}
              {models.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          : <input type="text" spellCheck={false} data-testid="assistant-model" value={model} placeholder="model id" onChange={e => setModel(e.target.value)} />}
        {modelsError && <span className="asst-field-note">{modelsError}</span>}
      </label>
      {p.kind === 'anthropic' && (
        <label className="settings-row settings-toggle-row">
          <span className="settings-label">Search the web for datasheets</span>
          <input type="checkbox" checked={cfg.web_search} onChange={e => assistantStore.saveConfig({ web_search: e.target.checked })} />
        </label>
      )}
      {error && <p className="ai-error">{error}</p>}
      <div className="asst-setup-actions">
        <button type="button" className="ai-btn ai-btn-primary" disabled={busy} data-testid="assistant-save" onClick={save}>
          {busy ? 'Saving…' : 'Save and use'}
        </button>
        {assistantStore.ready && <button type="button" className="ai-btn" onClick={onDone}>Back to the chat</button>}
      </div>
      <p className="settings-hint asst-sub-note">
        Have Claude Pro or Max, ChatGPT Plus or Pro, or Google AI Pro? Those plans are for the vendors’ own apps.
        Connect Claude Code, Claude Desktop or Codex to BoardRipper instead:{' '}
        <button type="button" className="asst-link" onClick={() => showSidebarTab('settings')}>Settings ▸ Integrations</button>.
      </p>
    </div>
  );
}

// ---- chat -------------------------------------------------------------------

function Message({ m, board }: { m: ChatMessage; board: BoardData | null }) {
  if (m.role === 'user') return <div className="asst-msg asst-user">{m.text}</div>;
  if (m.role === 'notice') return <div className="asst-msg asst-notice">{m.text}</div>;
  if (m.role === 'error') return <div className="asst-msg asst-error" data-testid="assistant-error">{m.text}</div>;
  return (
    <div className="asst-msg asst-bot" data-testid="assistant-answer">
      {m.tools.length > 0 && (
        <div className="asst-tools">
          {m.tools.map((t, i) => (
            <span key={i} className={`asst-tool asst-tool-${t.status}`} title={t.summary} translate="no">
              {t.status === 'running' ? '…' : t.status === 'done' ? '✓' : t.status === 'declined' ? '×' : '!'} {t.tool.replace(/_/g, ' ')}
            </span>
          ))}
        </div>
      )}
      {m.text && <RichText text={m.text} board={board} />}
    </div>
  );
}

export function AssistantPanel() {
  const a = useAssistant();
  useBoardStore();
  const board = boardStore.activeTab?.board ?? null;
  const [setupOpen, setSetupOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [serverOn, setServerOn] = useState<boolean | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const backend = hasBackend();

  useEffect(() => {
    if (!backend) return;
    void assistantStore.loadConfig();
    fetch('/api/mcp/status').then(r => r.ok ? r.json() : null).then(s => setServerOn(!!s?.enabled)).catch(() => setServerOn(null));
  }, [backend]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [a.messages, a.approval]);

  useEffect(() => {
    if (a.pendingDraft) setDraft(takePendingDraft());
  }, [a.pendingDraft]);

  const showSetup = setupOpen || (a.config !== null && !a.ready);
  const active = useMemo(() => a.config?.providers.find(p => p.id === a.config?.active), [a.config]);

  if (!backend) {
    return (
      <div className="asst-panel">
        <p className="settings-hint" style={{ padding: 12 }}>
          The assistant runs on the BoardRipper server.{' '}
          {isElectron() ? 'Turn the AI server on in Settings ▸ Integrations to use it.' : 'This version has no server.'}
        </p>
      </div>
    );
  }

  const send = () => {
    const t = draft.trim();
    if (!t) return;
    setDraft('');
    void assistantStore.send(t);
  };

  return (
    <div className="asst-panel" data-testid="assistant-panel">
      <div className="asst-header">
        <span className="asst-title">Assistant</span>
        {active && !showSetup && (
          <span className="asst-model" translate="no" title={`${active.label} · ${active.model}`}>{active.label} · {active.model}</span>
        )}
        <span className="asst-header-actions">
          {!showSetup && a.messages.length > 0 && (
            <button type="button" className="asst-icon-btn" title="New chat" aria-label="New chat" data-testid="assistant-new" onClick={() => assistantStore.newChat()}><IconPlus size={16} /></button>
          )}
          <button type="button" className="asst-icon-btn" title="Assistant settings" aria-label="Assistant settings" aria-pressed={showSetup}
            data-testid="assistant-settings" onClick={() => setSetupOpen(v => !v)}><IconSettings size={16} /></button>
        </span>
      </div>

      {serverOn === false && (
        <div className="asst-banner">
          The assistant reaches the board through the AI server, which is off.{' '}
          {isElectron()
            ? 'Turn it on in Settings ▸ Integrations.'
            : <button type="button" className="asst-link" onClick={async () => {
                await fetch('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'mcp_enabled', value: 'true' }) }).catch(() => null);
                startMcpBridge(); setServerOn(true);
              }}>Turn it on</button>}
        </div>
      )}
      {a.configError && <p className="ai-error" style={{ padding: '0 12px' }}>{a.configError}</p>}
      {a.config === null && !a.configError && <p className="settings-hint" style={{ padding: 12 }}>Loading…</p>}

      {a.config && showSetup && <Setup onDone={() => setSetupOpen(false)} />}

      {a.config && !showSetup && (
        <>
          <div className="asst-list" ref={listRef} data-testid="assistant-messages">
            {a.messages.length === 0 && (
              <div className="asst-empty">
                <p className="settings-hint">Ask about the open board and its schematic. For example:</p>
                {SUGGESTIONS.map(s => (
                  <button key={s} type="button" className="asst-suggestion" onClick={() => assistantStore.send(s)}>{s}</button>
                ))}
              </div>
            )}
            {a.messages.map(m => <Message key={m.id} m={m} board={board} />)}
            {a.running && a.messages[a.messages.length - 1]?.role === 'assistant' && !a.messages[a.messages.length - 1].text && !a.approval && (
              <div className="asst-thinking"><span className="ai-pulse" />Working…</div>
            )}
            {a.approval && <ApprovalCard a={a.approval} />}
          </div>
          <div className="asst-composer">
            <textarea rows={2} value={draft} data-testid="assistant-input" placeholder="Ask about this board…"
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (!a.running) send(); }
                e.stopPropagation(); // keep board shortcuts out of the text field
              }} />
            {a.running
              ? <button type="button" className="asst-send" title="Stop" aria-label="Stop" data-testid="assistant-stop" onClick={() => assistantStore.stop()}><IconPlayerStopFilled size={16} /></button>
              : <button type="button" className="asst-send" title="Send (Enter)" aria-label="Send" data-testid="assistant-send" disabled={!draft.trim()} onClick={send}><IconSend2 size={16} /></button>}
          </div>
        </>
      )}
    </div>
  );
}
