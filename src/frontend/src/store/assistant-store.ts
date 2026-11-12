/**
 * The built-in assistant's client state: settings (which provider, which
 * model, whether a key is stored), the running chat and its stream.
 *
 * The backend (src/backend/assistant) runs the conversation and the tools;
 * this store only sends messages and renders the event stream. Keys are sent
 * once on save and never come back. The browser identity is the MCP pairing
 * client id, so one browser's key never answers another browser.
 *
 * Design: docs/specs/2026-11-11-ai-toolkit.html (Part B).
 */
import { createStoreHook } from '../hooks/createStoreHook';
import { getMcpClientIdentity, startMcpBridge } from './mcp-bridge';
import { log } from './log-store';

export interface AssistantProvider {
  id: string;
  label: string;
  kind: 'anthropic' | 'openai';
  base_url: string;
  needs_key: boolean;
  local: boolean;
  images: boolean;
  default: string;
  key_url?: string;
  has_key: boolean;
  key_hint?: string;
  model: string;
}

export interface AssistantConfig {
  active: string;
  web_search: boolean;
  providers: AssistantProvider[];
}

export interface ToolStep {
  tool: string;
  status: 'running' | 'done' | 'failed' | 'declined';
  summary?: string;
}

export interface ChatMessage {
  id: number;
  role: 'user' | 'assistant' | 'notice' | 'error';
  text: string;
  tools: ToolStep[];
}

export interface PendingApproval {
  id: string;
  tool: string;
  kind: 'drive' | 'edit';
  args: Record<string, unknown>;
}

interface State {
  config: AssistantConfig | null;
  configError: string;
  conversation: string;
  messages: ChatMessage[];
  running: boolean;
  approval: PendingApproval | null;
  providerLabel: string;
  model: string;
  /** A question asked before the assistant was set up; the composer takes it. */
  pendingDraft: string;
}

const TRANSCRIPT_KEY = 'boardripper-assistant-chat';

const listeners = new Set<() => void>();
let seq = 1;
let abort: AbortController | null = null;

function loadTranscript(): Pick<State, 'conversation' | 'messages'> {
  try {
    const raw = sessionStorage.getItem(TRANSCRIPT_KEY);
    if (raw) {
      const v = JSON.parse(raw);
      if (Array.isArray(v.messages)) {
        seq = v.messages.reduce((m: number, x: ChatMessage) => Math.max(m, x.id), 0) + 1;
        return { conversation: String(v.conversation ?? ''), messages: v.messages };
      }
    }
  } catch { /* fresh */ }
  return { conversation: '', messages: [] };
}

let state: State = {
  config: null, configError: '', running: false, approval: null, providerLabel: '', model: '', pendingDraft: '',
  ...loadTranscript(),
};

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  if ('messages' in patch || 'conversation' in patch) {
    try {
      sessionStorage.setItem(TRANSCRIPT_KEY, JSON.stringify({ conversation: state.conversation, messages: state.messages.slice(-200) }));
    } catch { /* quota or private mode */ }
  }
  listeners.forEach(fn => fn());
}

function browser(): string { return getMcpClientIdentity().id; }

async function postJSON(path: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: browser(), ...body }),
  });
}

function updateLast(fn: (m: ChatMessage) => ChatMessage) {
  const msgs = state.messages.slice();
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'assistant') { msgs[i] = fn(msgs[i]); break; }
  }
  set({ messages: msgs });
}

function handleEvent(ev: Record<string, unknown>) {
  switch (ev.type) {
    case 'start':
      set({ conversation: String(ev.conversation ?? state.conversation), providerLabel: String(ev.provider ?? ''), model: String(ev.model ?? '') });
      break;
    case 'text':
      updateLast(m => ({ ...m, text: m.text + String(ev.text ?? '') }));
      break;
    case 'tool': {
      const tool = String(ev.tool ?? '');
      const status = ev.status as ToolStep['status'];
      updateLast(m => {
        const tools = m.tools.slice();
        const open = [...tools].reverse().findIndex(t => t.tool === tool && t.status === 'running');
        if (status !== 'running' && open >= 0) {
          const idx = tools.length - 1 - open;
          tools[idx] = { ...tools[idx], status, summary: ev.text ? String(ev.text) : undefined };
        } else {
          tools.push({ tool, status, summary: ev.text ? String(ev.text) : undefined });
        }
        return { ...m, tools };
      });
      if (state.approval?.tool === tool) set({ approval: null });
      break;
    }
    case 'approval':
      set({ approval: { id: String(ev.id), tool: String(ev.tool), kind: ev.kind as 'drive' | 'edit', args: (ev.args ?? {}) as Record<string, unknown> } });
      break;
    case 'notice':
      set({ messages: [...state.messages, { id: seq++, role: 'notice', text: String(ev.message ?? ''), tools: [] }] });
      break;
    case 'error':
      set({ messages: [...state.messages, { id: seq++, role: 'error', text: String(ev.message ?? 'Something went wrong.'), tools: [] }] });
      break;
    case 'done':
      set({ running: false, approval: null });
      break;
  }
}

export const assistantStore = {
  subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  get state() { return state; },

  /** Ready to chat: a provider is active and has what it needs. */
  get ready(): boolean {
    const c = state.config;
    const p = c?.providers.find(x => x.id === c.active);
    return !!p && (!p.needs_key || p.has_key) && !!p.model;
  },

  async loadConfig() {
    try {
      const r = await fetch(`/api/assistant/config?client_id=${encodeURIComponent(browser())}`);
      if (!r.ok) { set({ configError: r.status === 403 ? await r.text() : `The assistant is not available (HTTP ${r.status}).` }); return; }
      set({ config: await r.json(), configError: '' });
    } catch {
      set({ configError: 'Could not reach BoardRipper.' });
    }
  },

  async saveConfig(change: { provider?: string; api_key?: string; clear_key?: boolean; base_url?: string; model?: string; activate?: boolean; web_search?: boolean }): Promise<string | null> {
    try {
      const r = await postJSON('/api/assistant/config', change);
      if (!r.ok) return (await r.text()) || `HTTP ${r.status}`;
      set({ config: await r.json() });
      return null;
    } catch {
      return 'Could not reach BoardRipper.';
    }
  },

  async models(provider: string): Promise<{ models: string[]; error?: string }> {
    try {
      const r = await fetch(`/api/assistant/models?client_id=${encodeURIComponent(browser())}&provider=${encodeURIComponent(provider)}`);
      return await r.json();
    } catch {
      return { models: [], error: 'Could not reach BoardRipper.' };
    }
  },

  async send(text: string) {
    const t = text.trim();
    if (!t || state.running) return;
    startMcpBridge(); // the tools reach the board through it
    set({
      running: true,
      approval: null,
      messages: [...state.messages,
        { id: seq++, role: 'user', text: t, tools: [] },
        { id: seq++, role: 'assistant', text: '', tools: [] }],
    });
    abort = new AbortController();
    try {
      const r = await fetch('/api/assistant/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: browser(), conversation: state.conversation, message: t }),
        signal: abort.signal,
      });
      if (!r.ok || !r.body) {
        handleEvent({ type: 'error', message: r.status === 403 ? await r.text() : `The assistant is not available (HTTP ${r.status}).` });
        handleEvent({ type: 'done' });
        return;
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let cut: number;
        while ((cut = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            try { handleEvent(JSON.parse(line.slice(5).trim())); } catch { /* skip a bad line */ }
          }
        }
      }
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') {
        log.ui.warn('assistant stream failed', e);
        handleEvent({ type: 'error', message: 'The connection to BoardRipper was lost.' });
      }
    } finally {
      abort = null;
      if (state.running) set({ running: false, approval: null });
      // Drop an empty assistant bubble (an error before any text).
      const last = state.messages[state.messages.length - 1];
      const prev = state.messages[state.messages.length - 2];
      if (prev && prev.role === 'assistant' && !prev.text && prev.tools.length === 0 && last?.role !== 'assistant') {
        set({ messages: state.messages.filter(m => m !== prev) });
      } else if (last && last.role === 'assistant' && !last.text && last.tools.length === 0) {
        set({ messages: state.messages.slice(0, -1) });
      }
    }
  },

  async approve(decision: 'once' | 'always' | 'deny') {
    const a = state.approval;
    if (!a) return;
    set({ approval: null });
    await postJSON('/api/assistant/approve', { conversation: state.conversation, id: a.id, decision }).catch(() => null);
  },

  async stop() {
    await postJSON('/api/assistant/stop', { conversation: state.conversation }).catch(() => null);
  },

  async newChat() {
    if (state.running) await this.stop();
    abort?.abort();
    const conv = state.conversation;
    set({ conversation: '', messages: [], approval: null, running: false });
    if (conv) await postJSON('/api/assistant/reset', { conversation: conv }).catch(() => null);
  },
};

export const useAssistant = createStoreHook(assistantStore, () => ({ ...state, ready: assistantStore.ready }));

/** Open the Assistant destination and ask a question (context-menu actions).
 *  Not set up yet: the question waits in the composer while the user picks a
 *  provider. */
export async function askAssistant(text: string) {
  const { showSidebarTab } = await import('../components/Sidebar.utils');
  showSidebarTab('assistant');
  if (!state.config) await assistantStore.loadConfig();
  if (assistantStore.ready && !state.running) void assistantStore.send(text);
  else set({ pendingDraft: text });
}

export function takePendingDraft(): string {
  const d = state.pendingDraft;
  if (d) set({ pendingDraft: '' });
  return d;
}
