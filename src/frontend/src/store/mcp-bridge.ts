// MCP live-board bridge client.
//
// Opens a WebSocket to the backend (/api/mcp/bridge). The backend forwards
// live-board MCP tool calls here; this module answers from the in-memory
// BoardData (reads) or drives the existing stores (drive-UI). It is started
// only when the MCP server is enabled (see startMcpBridgeIfEnabled).

import { boardStore } from './board-store';
import { pdfStore } from './pdf-store';
import { worklistStore } from './worklist-store';
import { computeAdjacentNets, type BoardData } from '../parsers/types';
import { log } from './log-store';
import { classifyNetName, buildOverview, pageText, searchTextPages } from './mcp-bridge-helpers';
import { renderPdfPageToPng } from './pdf-render';
import { getActiveApp } from '../renderer/renderer-registry';
import { openLibraryFileById } from './file-actions';

type Frame = { id: number; op: string; params: any };

let socket: WebSocket | null = null;
let sessionId = '';
let started = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let focusHandler: (() => void) | null = null;
let visHandler: (() => void) | null = null;
let boardUnsub: (() => void) | null = null;
let lastBoardGen = '';
/** Cached per-install MCP bearer secret. `null` = not yet successfully fetched
 *  (so the next connect re-fetches); a string (possibly '') = fetched. */
let mcpSecret: string | null = null;
let secretInFlight: Promise<string> | null = null;

/** Fetch (and cache) the per-install MCP bearer secret from /api/mcp/token so
 *  the bridge handshake can authenticate (M14). Returns '' when the token can't
 *  be fetched yet — the caller sends an empty secret, the backend rejects it,
 *  and the reconnect loop retries once the token is reachable. On a fetch error
 *  `mcpSecret` stays null so the next connect re-fetches. */
function fetchMcpSecret(): Promise<string> {
  if (mcpSecret !== null) return Promise.resolve(mcpSecret);
  if (secretInFlight) return secretInFlight;
  secretInFlight = fetch('/api/mcp/token')
    .then((r) => (r.ok ? r.json() : null))
    .then((j: { token?: unknown } | null) => {
      if (j && typeof j.token === 'string') mcpSecret = j.token;
      return mcpSecret ?? '';
    })
    .catch(() => '')
    .finally(() => { secretInFlight = null; });
  return secretInFlight;
}

function boardDescriptor() {
  const b = boardStore.board;
  const tab = boardStore.activeTab;
  return {
    session: sessionId,
    name: tab?.fileName ?? null,
    parts: b ? b.parts.length : 0,
    nets: b ? b.nets.size : 0,
    pdfs: pdfStore.openPdfEntries().map((e) => ({
      name: e.fileName, page: pdfStore.pageOf(e.fileName), pageCount: pdfStore.pageCountOf(e.fileName), fileId: e.fileId ?? null,
    })),
    // Changes iff the active board changes; the helper re-reads when it differs.
    generation: `${boardStore.activeTabId ?? ''}:${tab?.fileName ?? ''}`,
  };
}

/** Apply substring filter + limit/offset pagination, returning a page envelope. */
function paginate<T>(items: T[], limit: number, offset: number) {
  const total = items.length;
  const lim = limit > 0 && limit <= 1000 ? limit : 200;
  const off = offset > 0 ? offset : 0;
  const page = items.slice(off, off + lim);
  return { total, offset: off, has_more: off + page.length < total, page };
}

function send(obj: any) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(obj));
}

/** Start the bridge once. Safe to call multiple times. */
export function startMcpBridge() {
  if (started) return;
  started = true;
  sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  focusHandler = () => send({ type: 'focus', session: sessionId });
  visHandler = () => { if (!document.hidden) send({ type: 'focus', session: sessionId }); };
  window.addEventListener('focus', focusHandler);
  document.addEventListener('visibilitychange', visHandler);
  // Push a fresh board descriptor whenever the active board changes (M13) so
  // board_sessions / board_active never report a stale or empty descriptor.
  // Track the last-sent generation string and push only on change to avoid spam.
  lastBoardGen = boardDescriptor().generation;
  boardUnsub = boardStore.subscribe(() => {
    const gen = boardDescriptor().generation;
    if (gen === lastBoardGen) return;
    lastBoardGen = gen;
    notifyBoardChanged();
  });
  connect();
}

/** Stop the bridge for good: cancel any pending reconnect, close the socket
 *  without re-opening, and drop listeners. Idempotent. Call when MCP is
 *  disabled so a disconnected bridge stays gone instead of retrying forever. */
export function stopMcpBridge() {
  if (!started && socket === null && reconnectTimer === null) return;
  started = false;
  if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (focusHandler) { window.removeEventListener('focus', focusHandler); focusHandler = null; }
  if (visHandler) { document.removeEventListener('visibilitychange', visHandler); visHandler = null; }
  if (boardUnsub) { boardUnsub(); boardUnsub = null; }
  if (socket) {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;  // critical: stop onclose from scheduling a reconnect
    socket.onerror = null;
    try { socket.close(); } catch { /* ignore */ }
    socket = null;
  }
  log.mcp.log('bridge stopped (MCP disabled)');
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
    // Authenticate the handshake (M14): the backend requires the per-install MCP
    // secret in the first frame. Fetch it (cached), then send hello. `send`
    // no-ops if the socket already closed; if the token wasn't reachable we send
    // an empty secret and the reconnect loop retries once it is.
    void fetchMcpSecret().then((secret) => {
      send({ type: 'hello', session: sessionId, secret, board: boardDescriptor() });
    });
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
    socket = null;
    if (!started) return; // intentional stop — do not reconnect
    log.mcp.warn('bridge closed; re-checking MCP status before reconnect');
    scheduleReconnect();
  };
  socket.onerror = () => socket?.close();
}

/** Reconnect after a delay, but first re-verify MCP is still enabled. If it was
 *  disabled (toggled off / removed) we stop for good rather than looping. Only a
 *  genuinely unreachable status endpoint (e.g. server restart) keeps retrying. */
function scheduleReconnect() {
  if (!started || reconnectTimer !== null) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!started) return;
    fetch('/api/mcp/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => {
        if (!started) return;
        if (s && s.enabled) connect();
        else stopMcpBridge();
      })
      .catch(() => { if (started) connect(); });
  }, 3000);
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

/** Resolve the board to inspect for a read tool: a specific tab when `tab` is
 *  given (numeric id or file-name substring, from board_tabs), else the active
 *  tab. Lets the agent query a background tab (e.g. compare a part across two
 *  boards) without switch_tab flipping the user's view. */
function boardForTab(tab: unknown): BoardData {
  if (tab === undefined || tab === null || tab === '') return requireBoard();
  const tabs = boardStore.tabs;
  const s = String(tab);
  let t = /^\d+$/.test(s) ? tabs.find((x) => x.id === Number(s)) : undefined;
  if (!t) {
    const want = s.toLowerCase();
    t = tabs.find((x) => x.fileName.toLowerCase() === want)
      ?? tabs.find((x) => x.fileName.toLowerCase().includes(want));
  }
  if (!t) throw new Error(`tab not found: ${s}`);
  if (!t.board) throw new Error(`tab has no board loaded: ${t.fileName}`);
  return t.board;
}

/** The focused PDF document, or throw — used by pdf_page_text / pdf_search_open,
 *  which read the OPEN PDF's cached text layer (distinct from the library-wide
 *  pdf_search tool, which is backend-native and works with no PDF open). */
function activePdf() {
  const d = pdfStore.activeDoc;
  if (!d) throw new Error('no PDF open in BoardRipper');
  return d;
}

function findPart(b: BoardData, refdes: string) {
  const want = String(refdes).toLowerCase();
  return b.parts.find((pt) => pt.name.toLowerCase() === want);
}

// Compact part row including the descriptive metadata (value/serial often hold
// the real part name/number) — used by list_parts and find_parts.
function partSummary(pt: BoardData['parts'][number]) {
  return {
    refdes: pt.name,
    side: pt.side,
    value: pt.meta?.value ?? null,
    serial: pt.meta?.serial ?? null,
    package: pt.meta?.package ?? null,
    part_type: pt.meta?.partType ?? null,
  };
}

/** Cap a canvas to `maxPx` on its longest side (MCP image-payload constraint:
 *  images ≤2000px longest side). Retina board snapshots commonly extract at
 *  2400–4000px; downscaling here also keeps the WS/base64 payload bounded.
 *  Mirrors the cap style in pdf-render.ts's renderPdfPageToPng. Returns the
 *  source canvas unchanged when already within budget. */
function capCanvasSize(src: HTMLCanvasElement, maxPx: number): HTMLCanvasElement {
  const longest = Math.max(src.width, src.height);
  if (longest <= maxPx) return src;
  const scale = maxPx / longest;
  const w = Math.round(src.width * scale);
  const h = Math.round(src.height * scale);
  const dst = document.createElement('canvas');
  dst.width = w;
  dst.height = h;
  const ctx = dst.getContext('2d')!;
  ctx.drawImage(src, 0, 0, w, h);
  return dst;
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

// Full component info incl. pins + descriptive metadata. Shared by part_info
// (by refdes) and selected_part (the currently-selected component).
function partInfo(part: BoardData['parts'][number]) {
  return {
    refdes: part.name,
    side: part.side,
    type: part.type,
    // Descriptive metadata the boardview carried. value/serial frequently
    // hold the real part name/number — invaluable when no schematic exists.
    value: part.meta?.value ?? null,
    serial: part.meta?.serial ?? null,
    package: part.meta?.package ?? null,
    part_type: part.meta?.partType ?? null,
    height_mils: part.meta?.heightMils ?? null,
    angle_deg: part.meta?.angleDeg ?? null,
    mechanical: !!part.mechanical,
    pin_count: part.pins.length,
    pins: part.pins.map((pn) => ({ name: pn.name, number: pn.number, net: pn.net })),
  };
}

async function dispatch(op: string, p: any): Promise<any> {
  switch (op) {
    case 'board_active': {
      requireBoard();
      return boardDescriptor();
    }
    case 'board_snapshot': {
      requireBoard();
      const app = getActiveApp();
      if (!app) throw new Error('board renderer not ready');
      const out = app.renderer.extract.canvas({ target: app.stage }) as HTMLCanvasElement;
      const canvas = capCanvasSize(out, 2000);
      const base64 = canvas.toDataURL('image/png').split(',')[1];
      return { base64, mime: 'image/png', w: canvas.width, h: canvas.height };
    }
    case 'board_overview': {
      const b = boardStore.board;
      const selPart = boardStore.selectedPart;
      return {
        ...boardDescriptor(),
        board: b ? {
          parts: b.parts.length,
          nets: b.nets.size,
          side: boardStore.showTop ? 'top' : 'bottom',
          // What the user currently has selected on the board (null if nothing).
          selected: selPart ? { refdes: selPart.name, pin: boardStore.selectedPin?.name ?? null } : null,
          tab_count: boardStore.tabs.length,
        } : null,
        worklist: buildOverview(worklistStore.aiSnapshot() as any, worklistStore.peekUnreadUserMessages()),
      };
    }
    case 'list_nets': {
      const b = boardForTab(p.tab);
      const f = (p.filter ?? '').toLowerCase();
      const names = Array.from(b.nets.keys());
      const out = f ? names.filter((n) => n.toLowerCase().includes(f)) : names;
      const { total, offset, has_more, page } = paginate(out, p.limit, p.offset);
      return { nets: page.map((n) => ({ name: n, reliability: classifyNetName(n) })), total, offset, has_more };
    }
    case 'list_parts': {
      const b = boardForTab(p.tab);
      const f = (p.filter ?? '').toLowerCase();
      const side = (p.side ?? '').toLowerCase();
      const out = b.parts
        .filter((pt) => (side ? pt.side === side : true))
        .filter((pt) => (f ? pt.name.toLowerCase().includes(f) : true))
        .map(partSummary);
      const { total, offset, has_more, page } = paginate(out, p.limit, p.offset);
      return { parts: page, total, offset, has_more };
    }
    case 'net_info': {
      const b = boardForTab(p.tab);
      const pins = netPins(b, p.net);
      if (!pins) throw new Error(`net not found: ${p.net}`);
      const parts = Array.from(new Set(pins.map((x) => x.part).filter(Boolean)));
      return { net: p.net, pin_count: pins.length, pins, parts, reliability: classifyNetName(p.net) };
    }
    case 'net_neighbors': {
      const b = boardForTab(p.tab);
      const depth = p.depth && p.depth > 0 ? p.depth : 1;
      const set = computeAdjacentNets(b, p.net, depth);
      return {
        net: p.net,
        depth,
        neighbors: Array.from(set).map((name) => ({ name, reliability: classifyNetName(name) })),
      };
    }
    case 'pin_connectivity': {
      const b = boardForTab(p.tab);
      const part = findPart(b, p.part);
      if (!part) throw new Error(`part not found: ${p.part}`);
      const pin = part.pins.find((pn) => String(pn.name) === String(p.pin) || String(pn.number) === String(p.pin));
      if (!pin) throw new Error(`pin not found: ${p.pin} on ${p.part}`);
      const connected = pin.net ? netPins(b, pin.net) ?? [] : [];
      return {
        part: part.name,
        pin: p.pin,
        net: pin.net || null,
        connected,
        net_reliability: pin.net ? classifyNetName(pin.net) : null,
      };
    }
    case 'part_info': {
      const b = boardForTab(p.tab);
      const part = findPart(b, p.refdes);
      if (!part) throw new Error(`part not found: ${p.refdes}`);
      return partInfo(part);
    }
    case 'selected_part': {
      requireBoard();
      const part = boardStore.selectedPart;
      if (!part) return { selected: false };
      const pin = boardStore.selectedPin;
      return {
        selected: true,
        ...partInfo(part),
        selected_pin: pin ? { name: pin.name, number: pin.number, net: pin.net } : null,
      };
    }
    case 'board_tabs': {
      const tabs = boardStore.tabs.map((t) => ({
        id: t.id,
        name: t.fileName,
        active: t.id === boardStore.activeTabId,
        fileId: t.fileId ?? null,
        parts: t.board ? t.board.parts.length : 0,
        nets: t.board ? t.board.nets.size : 0,
      }));
      return { tabs, active_id: boardStore.activeTabId };
    }
    case 'find_parts': {
      const b = boardForTab(p.tab);
      const q = String(p.query ?? '').toLowerCase().trim();
      if (!q) throw new Error('find_parts: query required');
      const hits = b.parts.filter((pt) => {
        const hay = [pt.name, pt.meta?.value, pt.meta?.serial, pt.meta?.package, pt.meta?.partType]
          .filter(Boolean).join(' ').toLowerCase();
        return hay.includes(q);
      }).map(partSummary);
      const { total, offset, has_more, page } = paginate(hits, p.limit, p.offset);
      return { query: p.query, parts: page, total, offset, has_more };
    }
    // ── worklist read ops (AI-mode feedback loop) ──
    case 'worklist_get': {
      const s = worklistStore.aiSnapshot();
      if (!s) throw new Error('no active worklist (open a board)');
      return s;
    }
    case 'get_measurements': {
      const s = worklistStore.aiSnapshot();
      const netEntries = (s?.netEntries ?? []) as Array<{
        netName: string;
        measurements?: Array<{
          kind: string;
          value?: string;
          unit?: string;
          status: string;
          prompt?: string;
          expected?: string;
          source: string;
        }>;
      }>;
      // One row per (net, kind) — a net can carry up to three readings.
      let ms = netEntries.flatMap((n) =>
        (n.measurements ?? []).map((m) => ({
          netName: n.netName,
          kind: m.kind,
          status: m.status,
          value: m.value ?? null,
          unit: m.unit ?? null,
          expected: m.expected ?? null,
          source: m.source,
        })),
      );
      const statusFilter = String(p.status ?? '');
      const sourceFilter = String(p.source ?? '');
      if (statusFilter) ms = ms.filter((m) => m.status === statusFilter);
      if (sourceFilter) ms = ms.filter((m) => m.source === sourceFilter);
      return { measurements: ms };
    }
    case 'get_user_messages': {
      const msgs = worklistStore.consumeUserMessages(p.only_unread !== false);
      return { messages: msgs.map((m) => ({ text: m.text, at: m.at })) };
    }
    // ── open-PDF text ops (read the OPEN doc's cached text layer; distinct
    // from the library-wide pdf_search tool) ──
    case 'pdf_page_text': {
      const d = activePdf();
      const page = typeof p.page === 'number' && p.page > 0 ? p.page : d.currentPage;
      return { page, text: pageText(d.textPages, page) };
    }
    case 'pdf_search_open': {
      const d = activePdf();
      const matches = searchTextPages(d.textPages, String(p.query ?? ''), p.limit);
      return { matches, total: matches.length };
    }
    case 'pdf_page_image': {
      const d = activePdf();
      const page = typeof p.page === 'number' && p.page > 0 ? p.page : d.currentPage;
      // Use the clean-aware proxy (returns strippedDoc when cleanMode is on and
      // available) so a watermark-stripped page is what MCP callers see too.
      const doc = pdfStore.getDocProxy(d.fileName) ?? d.doc;
      const { base64, w, h } = await renderPdfPageToPng(doc, page, { rotation: d.rotation, mirror: d.mirror });
      return { base64, mime: 'image/png', page, w, h };
    }
    case 'pdf_download': {
      const d = activePdf();
      const bytes = new Uint8Array(d.originalBuffer);
      const MAX = 50 * 1024 * 1024;
      if (bytes.byteLength > MAX) throw new Error(`PDF too large (${bytes.byteLength} bytes) to download over MCP`);
      // btoa needs a binary string; build in chunks to avoid call-stack limits.
      let bin = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
      return { base64: btoa(bin), mime: 'application/pdf', name: d.fileName, size: bytes.byteLength };
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
    case 'open_file': {
      const fileId = Number(p.file_id ?? p.id);
      if (!fileId) throw new Error('open_file: file_id required');
      const res = await openLibraryFileById(fileId, typeof p.page === 'number' ? p.page : undefined);
      toast(`Agent opened ${res.name}`);
      return { ok: true, ...res };
    }
    case 'switch_tab': {
      const tabs = boardStore.tabs;
      let target = typeof p.id === 'number' ? tabs.find((t) => t.id === p.id) : undefined;
      if (!target && p.name) {
        const want = String(p.name).toLowerCase();
        target = tabs.find((t) => t.fileName.toLowerCase() === want)
          ?? tabs.find((t) => t.fileName.toLowerCase().includes(want));
      }
      if (!target) throw new Error(`tab not found: ${p.id ?? p.name}`);
      boardStore.switchTab(target.id);
      toast(`Agent switched to board tab ${target.fileName}`);
      return { ok: true, id: target.id, name: target.fileName };
    }
    case 'highlight_net': {
      const board = requireBoard();
      boardStore.highlightNet(p.net);
      const pins = netPins(board, p.net) ?? [];
      const parts = Array.from(new Set(pins.map((x) => x.part).filter(Boolean)));
      toast(`Agent highlighted net ${p.net}`);
      return { ok: true, net: p.net, pins_highlighted: pins.length, parts };
    }
    case 'clear_highlight': {
      boardStore.highlightNet(null);
      toast('Agent cleared highlight');
      return { ok: true };
    }
    case 'select_part': {
      const board = requireBoard();
      const part = findPart(board, p.refdes);
      boardStore.focusPart(p.refdes);
      toast(`Agent selected ${p.refdes}`);
      return { ok: true, refdes: p.refdes, found: !!part, side: part?.side ?? null, centered: !!part };
    }
    case 'set_side': {
      requireBoard();
      const side = String(p.side).toLowerCase() === 'bottom' ? 'bottom' : 'top';
      if (side === 'bottom') boardStore.selectBottom(); else boardStore.selectTop();
      toast(`Agent set side: ${side}`);
      return { ok: true, side };
    }
    case 'pdf_goto': {
      if (p.term) pdfStore.searchText(String(p.term), 'lookup');
      if (typeof p.page === 'number' && p.page > 0) pdfStore.goToPage(p.page);
      toast(`Agent navigated PDF${p.page ? ` to page ${p.page}` : ''}`);
      return { ok: true, page: p.page ?? null };
    }
    // ── worklist write ops (AI-mode feedback loop; gated on mcp_drive_ui backend-side) ──
    case 'worklist_add':
    case 'worklist_update': {
      requireBoard();
      const ok = p.kind === 'net'
        ? worklistStore.aiAddNet(String(p.id), p.mark, p.note)
        : worklistStore.aiAddPart(String(p.id), p.mark, p.note);
      if (!ok) throw new Error('could not write worklist (no board?)');
      toast(`Agent ${op === 'worklist_add' ? 'added' : 'updated'} ${p.id} in the worklist`);
      return { ok: true };
    }
    case 'worklist_set_list_note': {
      requireBoard();
      worklistStore.aiSetListNote(String(p.note ?? ''));
      toast('Agent updated the worklist note');
      return { ok: true };
    }
    case 'request_measurement': {
      requireBoard();
      const target = String(p.target ?? '');
      const kind = String(p.kind ?? '');
      const prompt = String(p.prompt ?? '');
      const expected = p.expected != null ? String(p.expected) : undefined;
      const NET_KINDS = new Set(['voltage', 'diode', 'resistance']);
      // Resolve target against the board's nets case-insensitively (mirror
      // board-store focusNet): try exact, else scan keys for a toUpperCase match
      // and rebind to the canonical key. A case-mismatched net must create the
      // inline field, not fall through to the relay transcript.
      const board = boardStore.board;
      let netTarget: string | null = null;
      if (board) {
        if (board.nets.has(target)) netTarget = target;
        else {
          const upper = target.toUpperCase();
          for (const k of board.nets.keys()) {
            if (k.toUpperCase() === upper) { netTarget = k; break; }
          }
        }
      }
      if (netTarget && NET_KINDS.has(kind)) {
        const ok = worklistStore.requestNetMeasurement(netTarget, {
          kind: kind as 'voltage' | 'diode' | 'resistance',
          prompt,
          expected,
        });
        if (!ok) throw new Error('could not add measurement request (no board?)');
        toast(`Agent requested ${kind} measurement on net ${netTarget}`);
        return { ok: true, routed: 'net' };
      } else {
        // Genuine part/pin targets, truly-unknown nets, or non-net kinds → relay
        const relayText = `Measure ${kind} on ${target}${prompt ? ': ' + prompt : ''}`;
        worklistStore.addMessage('agent', relayText);
        toast(`Agent posted measurement request for ${target} to relay`);
        return { ok: true, routed: 'relay' };
      }
    }
    case 'post_message': {
      requireBoard();
      worklistStore.addMessage('agent', String(p.text ?? ''));
      toast('Agent posted a message to the worklist');
      return { ok: true };
    }
    default:
      throw new Error(`unknown op: ${op}`);
  }
}

// Exposed so Playwright can drive `dispatch` directly against real stores
// (bypassing the WebSocket bridge) to prove the frontend answers each op
// correctly from a loaded board. Dev-only on window — never present in a
// production build.
export { dispatch as __dispatchForTest };
if (import.meta.env.DEV) {
  (window as unknown as { __brBridgeDispatch?: unknown }).__brBridgeDispatch =
    (op: string, params: unknown) => dispatch(op, (params ?? {}) as any);
}
