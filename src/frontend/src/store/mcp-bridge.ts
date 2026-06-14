// MCP live-board bridge client.
//
// Opens a WebSocket to the backend (/api/mcp/bridge). The backend forwards
// live-board MCP tool calls here; this module answers from the in-memory
// BoardData (reads) or drives the existing stores (drive-UI). It is started
// only when the MCP server is enabled (see startMcpBridgeIfEnabled).

import { boardStore } from './board-store';
import { pdfStore } from './pdf-store';
import { computeAdjacentNets, type BoardData } from '../parsers/types';
import { log } from './log-store';

type Frame = { id: number; op: string; params: any };

let socket: WebSocket | null = null;
let sessionId = '';
let started = false;

function boardDescriptor() {
  const b = boardStore.board;
  const tab = boardStore.activeTab;
  return {
    session: sessionId,
    name: tab?.fileName ?? null,
    parts: b ? b.parts.length : 0,
    nets: b ? b.nets.size : 0,
  };
}

function send(obj: any) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(obj));
}

/** Start the bridge once. Safe to call multiple times. */
export function startMcpBridge() {
  if (started) return;
  started = true;
  sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  connect();
  window.addEventListener('focus', () => send({ type: 'focus', session: sessionId }));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) send({ type: 'focus', session: sessionId });
  });
}

/** Check whether MCP is enabled on the backend and, if so, start the bridge. */
export function startMcpBridgeIfEnabled() {
  fetch('/api/mcp/status')
    .then((r) => (r.ok ? r.json() : null))
    .then((s) => {
      if (s && s.enabled) startMcpBridge();
    })
    .catch(() => {});
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  try {
    socket = new WebSocket(`${proto}://${location.host}/api/mcp/bridge`);
  } catch (e) {
    log.mcp.error('bridge connect failed', e);
    return;
  }
  socket.onopen = () => {
    log.mcp.log(`bridge connected (session ${sessionId})`);
    send({ type: 'hello', session: sessionId, board: boardDescriptor() });
  };
  socket.onmessage = (ev) => {
    let frame: Frame;
    try {
      frame = JSON.parse(ev.data);
    } catch {
      return;
    }
    void handle(frame);
  };
  socket.onclose = () => {
    log.mcp.warn('bridge closed; reconnecting in 3s');
    setTimeout(connect, 3000);
  };
  socket.onerror = () => socket?.close();
}

/** Push a fresh board descriptor (call when the active board changes). */
export function notifyBoardChanged() {
  send({ type: 'board_changed', session: sessionId, board: boardDescriptor() });
}

async function handle(frame: Frame) {
  try {
    const result = await dispatch(frame.op, frame.params ?? {});
    send({ type: 'reply', session: sessionId, reply: { id: frame.id, ok: true, result } });
  } catch (e: any) {
    log.mcp.error(`op ${frame.op} failed`, e);
    send({ type: 'reply', session: sessionId, reply: { id: frame.id, ok: false, error: String(e?.message ?? e) } });
  }
}

function requireBoard(): BoardData {
  const b = boardStore.board;
  if (!b) throw new Error('no board open in BoardRipper');
  return b;
}

function findPart(b: BoardData, refdes: string) {
  const want = String(refdes).toLowerCase();
  return b.parts.find((pt) => pt.name.toLowerCase() === want);
}

function netPins(b: BoardData, netName: string) {
  const net = b.nets.get(netName);
  if (!net) return null;
  return net.pinIndices.map((pi) => {
    const part = b.parts[pi.partIndex];
    const pin = part?.pins[pi.pinIndex];
    return { part: part?.name ?? null, pin: pin?.name ?? pin?.number ?? String(pi.pinIndex) };
  });
}

async function dispatch(op: string, p: any): Promise<any> {
  switch (op) {
    case 'board_active': {
      requireBoard();
      return boardDescriptor();
    }
    case 'list_nets': {
      const b = requireBoard();
      const names = Array.from(b.nets.keys());
      const f = (p.filter ?? '').toLowerCase();
      const out = f ? names.filter((n) => n.toLowerCase().includes(f)) : names;
      return { nets: out.slice(0, 5000), total: out.length };
    }
    case 'list_parts': {
      const b = requireBoard();
      const f = (p.filter ?? '').toLowerCase();
      const out = b.parts.map((pt) => pt.name).filter((n) => (f ? n.toLowerCase().includes(f) : true));
      return { parts: out.slice(0, 5000), total: out.length };
    }
    case 'net_info': {
      const b = requireBoard();
      const pins = netPins(b, p.net);
      if (!pins) throw new Error(`net not found: ${p.net}`);
      const parts = Array.from(new Set(pins.map((x) => x.part).filter(Boolean)));
      return { net: p.net, pin_count: pins.length, pins, parts };
    }
    case 'net_neighbors': {
      const b = requireBoard();
      const depth = p.depth && p.depth > 0 ? p.depth : 1;
      const set = computeAdjacentNets(b, p.net, depth);
      return { net: p.net, depth, neighbors: Array.from(set) };
    }
    case 'pin_connectivity': {
      const b = requireBoard();
      const part = findPart(b, p.part);
      if (!part) throw new Error(`part not found: ${p.part}`);
      const pin = part.pins.find((pn) => String(pn.name) === String(p.pin) || String(pn.number) === String(p.pin));
      if (!pin) throw new Error(`pin not found: ${p.pin} on ${p.part}`);
      const connected = pin.net ? netPins(b, pin.net) ?? [] : [];
      return { part: part.name, pin: p.pin, net: pin.net || null, connected };
    }
    case 'part_info': {
      const b = requireBoard();
      const part = findPart(b, p.refdes);
      if (!part) throw new Error(`part not found: ${p.refdes}`);
      return {
        refdes: part.name,
        side: part.side,
        type: part.type,
        value: part.meta?.value ?? null,
        package: part.meta?.package ?? null,
        part_type: part.meta?.partType ?? null,
        pin_count: part.pins.length,
        pins: part.pins.map((pn) => ({ name: pn.name, number: pn.number, net: pn.net })),
      };
    }
    default:
      return dispatchDrive(op, p);
  }
}

function toast(msg: string) {
  boardStore.addToast(msg, 'info');
  log.mcp.log(msg);
}

async function dispatchDrive(op: string, p: any): Promise<any> {
  switch (op) {
    case 'highlight_net': {
      requireBoard();
      boardStore.highlightNet(p.net);
      toast(`Agent highlighted net ${p.net}`);
      return { ok: true, net: p.net };
    }
    case 'clear_highlight': {
      boardStore.highlightNet(null);
      toast('Agent cleared highlight');
      return { ok: true };
    }
    case 'select_part': {
      requireBoard();
      boardStore.focusPart(p.refdes);
      toast(`Agent selected ${p.refdes}`);
      return { ok: true, refdes: p.refdes };
    }
    case 'set_side': {
      requireBoard();
      if (String(p.side).toLowerCase() === 'bottom') boardStore.selectBottom();
      else boardStore.selectTop();
      toast(`Agent set side: ${p.side}`);
      return { ok: true, side: p.side };
    }
    case 'pdf_goto': {
      if (p.term) pdfStore.searchText(String(p.term), 'lookup');
      if (typeof p.page === 'number' && p.page > 0) pdfStore.goToPage(p.page);
      toast(`Agent navigated PDF${p.page ? ` to page ${p.page}` : ''}`);
      return { ok: true, page: p.page ?? null };
    }
    default:
      throw new Error(`unknown op: ${op}`);
  }
}
