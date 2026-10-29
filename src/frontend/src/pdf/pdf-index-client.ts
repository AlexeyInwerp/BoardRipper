// Wire-format contract: see docs/PDF_VIEWER.md#api
// State machine: see docs/PDF_VIEWER.md#state-machine
import { log } from '../store/log-store';
import { hasHttpBackend } from '../store/build-mode';
import {
  isPdfWatermarkText,
  getActiveWatermarkFilter,
  renderSettingsStore,
} from '../store/render-settings';

export interface IndexStatus {
  status: 'pending' | 'indexing' | 'indexed' | 'empty' | 'failed' | 'duplicate' | '';
  source?: string;
  page_count?: number;
}

export interface PdfIndexProgress {
  running: boolean;
  total: number;
  done: number;
  errors: number;
  current_file: string;
  started_at: number; // unix seconds (backend time.Now().Unix())
  workers: number; // configured pool size (max parallel extractors)
  active_workers: number; // workers currently extracting (live)
  /** Set when the server's text extractor failed to initialise: nothing can
   *  be indexed on this server until that is fixed. */
  engine_error?: string;
  /** The running or last compaction of the index file. */
  compact?: {
    running: boolean;
    started_at?: number;
    finished_at?: number;
    size_before?: number;
    size_after?: number;
    error?: string;
  };
}

export interface PdfIndexStats {
  indexed: number;
  empty: number;
  failed: number;
  pending: number;
  indexing: number;
  pages: number;
  /** Failed files the sweeps stopped retrying (part of `failed`). */
  given_up?: number;
}

export interface PdfIndexFailedEntry {
  file_id: number;
  status: string;
  error: string;
  /** Claims since the last success or reset; sweeps stop at 3. */
  attempts?: number;
  /** Joined from databank on the server side. Empty when the row's file
   *  has been deleted from databank since the index attempt. */
  filename?: string;
  path?: string;
}

/** Outcome of one index API call: the parsed JSON, or why there is none.
 *  `status` 0 = no HTTP answer (no server, network error, timeout). A 200 that
 *  is not JSON is a server without PDF-index routes: its SPA fallback answers
 *  every unknown path with index.html. */
export type IndexCall<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; reason: string };

/** One request with a deadline. Without one a call queued behind a slow
 *  search waited for ever, and the 1.5 s progress poll piled requests on top
 *  of it until the browser's per-host connection limit stalled the whole app. */
export async function indexCall<T>(url: string, init?: RequestInit, timeoutMs = 10_000): Promise<IndexCall<T>> {
  if (!hasHttpBackend()) return { ok: false, status: 0, reason: 'no server' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    const ct = res.headers.get('content-type') || '';
    if (!res.ok) {
      const body = ct.includes('html') ? '' : (await res.text().catch(() => '')).trim().slice(0, 200);
      return { ok: false, status: res.status, reason: body ? `HTTP ${res.status}: ${body}` : `HTTP ${res.status}` };
    }
    if (!ct.includes('application/json')) {
      return { ok: false, status: res.status, reason: 'this server has no PDF text index' };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch (err) {
    return { ok: false, status: 0, reason: ctl.signal.aborted ? 'timed out' : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function jfetch<T>(url: string, init?: RequestInit): Promise<T | null> {
  const r = await indexCall<T>(url, init);
  return r.ok ? r.data : null;
}

const JSON_POST = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const pdfIndexClient = {
  status: (fileId: number) => jfetch<IndexStatus>(`/api/pdfindex/status/${fileId}`),
  /** Start a sweep, or schedule one after the running sweep. The outcome says
   *  why nothing started (e.g. 503: the extractor failed to initialise). */
  run: () => indexCall<PdfIndexProgress>(`/api/pdfindex/run`, { method: 'POST' }),
  /** progress/stats with the reason when there is no answer — the poll needs
   *  it to tell "idle" from "lost contact". */
  /** Rewrite the index file into a fresh contiguous copy (no re-extraction).
   *  202 = started; 409 = already running; 507 = not enough free space. */
  compact: () => indexCall<PdfIndexProgress>(`/api/pdfindex/compact`, { method: 'POST' }, 120_000),
  progressCall: () => indexCall<PdfIndexProgress>(`/api/pdfindex/progress`),
  statsCall: () => indexCall<PdfIndexStats>(`/api/pdfindex/stats`),
  stop: () => jfetch(`/api/pdfindex/stop`, { method: 'POST' }),
  progress: () => jfetch<PdfIndexProgress>(`/api/pdfindex/progress`),
  stats: () => jfetch<PdfIndexStats>(`/api/pdfindex/stats`),
  reindex: (scope = 'all') =>
    jfetch(`/api/pdfindex/reindex`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope }),
    }),
  reindexWatermark: () => jfetch(`/api/pdfindex/reindex-watermark`, { method: 'POST' }),
  /** Stop the sweep, requeue in-flight rows, and start a fresh pass over all
   *  pending work (keeps already-indexed files — NOT a hard reset). */
  restart: () => jfetch<PdfIndexProgress>(`/api/pdfindex/restart`, { method: 'POST' }),
  /** Read the background auto-resume toggle (continue indexing on boot / after scans). */
  getAutoResume: () => jfetch<{ enabled: boolean }>(`/api/pdfindex/auto-resume`),
  /** Persist the background auto-resume toggle. Enabling kicks a run immediately. */
  setAutoResume: (enabled: boolean) =>
    jfetch<{ enabled: boolean }>(`/api/pdfindex/auto-resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }),
  failed: () => jfetch<PdfIndexFailedEntry[]>(`/api/pdfindex/failed`),
  priorityIndex: (fileId: number) =>
    jfetch(`/api/pdfindex/files/${fileId}/index`, { method: 'POST' }),
  indexFolder: (path: string) =>
    hasHttpBackend() ? fetch(`/api/pdfindex/index-folder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    }) : Promise.resolve(new Response(null, { status: 503 })),
};

// In-flight dedup so two panels opening the same PDF kick off only one extract.
const inflight = new Map<number, Promise<void>>();

/** Throw unless the call succeeded — an upload step that failed must not be
 *  followed by finalize, which marks the file 'indexed' from whatever pages
 *  happened to land (terminal: never re-indexed, search has holes). */
function must<T>(r: IndexCall<T>, step: string): T {
  if (!r.ok) throw new Error(`${step}: ${r.reason}`);
  return r.data;
}

/**
 * ensureIndexed: the automatic on-open fast-path. Extracts the already-loaded
 * pdf.js doc text (passed in via getTextPages) and uploads it. On any failure
 * after the claim it marks the file failed and hands it to the backend's own
 * extractor. Idempotent per fileId via the inflight map. Never rejects.
 */
export function ensureIndexed(fileId: number, getTextPages: () => string[][]): Promise<void> {
  if (!hasHttpBackend()) return Promise.resolve();
  const existing = inflight.get(fileId);
  if (existing) return existing;

  const task = (async () => {
    const st = await indexCall<IndexStatus>(`/api/pdfindex/status/${fileId}`);
    // 404 = no row yet; anything else that is not JSON means there is no
    // index to upload to (see IndexCall), so stop here quietly.
    if (!st.ok && st.status !== 404) {
      log.pdf.log(`index fast-path skipped for ${fileId}: ${st.reason}`);
      return;
    }
    if (st.ok && ['indexed', 'empty', 'indexing', 'duplicate'].includes(st.data.status)) {
      return; // 'duplicate' is terminal — its text lives under the canonical
    }
    const begin = await indexCall<{ status?: string }>(`/api/pdfindex/files/${fileId}/begin`, { method: 'POST' });
    if (!begin.ok) {
      if (begin.status !== 409) log.pdf.warn(`index fast-path: begin ${fileId} failed: ${begin.reason}`);
      return;
    }
    if (begin.data.status !== 'indexing') return;

    // The claim is ours until finalize or fail. A page closed or discarded in
    // between (tab closed, iPadOS dropping a background tab) used to leave the
    // row 'indexing' for ten minutes, skipped by every sweep and every re-open.
    // 'failed' is claimable again at once, and keepalive lets the request
    // outlive the page.
    let claimed = true;
    const release = () => {
      if (!claimed) return;
      claimed = false;
      void fetch(`/api/pdfindex/files/${fileId}/fail`, {
        ...JSON_POST({ error: 'page closed during upload' }),
        keepalive: true,
      }).catch(() => {});
    };
    window.addEventListener('pagehide', release);
    try {
      const pages = getTextPages();
      // Read the effective watermark filter synchronously from the store.
      // getActiveWatermarkFilter returns [] when the filter is disabled,
      // so we don't need to check pdfWatermarkFilterEnabled separately.
      const terms = getActiveWatermarkFilter(renderSettingsStore.settings);
      const enabled = terms.length > 0;
      const batch: { n: number; text: string }[] = [];
      const flush = async () => {
        if (batch.length === 0) return;
        must(await indexCall(`/api/pdfindex/files/${fileId}/pages`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pages: batch.splice(0, batch.length) }),
        }, 60_000), 'upload pages');
      };
      for (let i = 0; i < pages.length; i++) {
        if (!claimed) return; // page is going away; release() already ran
        const joined = (pages[i] || [])
          .filter((s) => !(enabled && isPdfWatermarkText(s, terms)))
          .join(' ')
          .trim();
        if (joined) batch.push({ n: i + 1, text: joined });
        if (batch.length >= 50) await flush();
      }
      await flush();
      must(await indexCall(`/api/pdfindex/files/${fileId}/finalize`, { method: 'POST' }), 'finalize');
      claimed = false;
    } catch (err) {
      if (!claimed) return;
      claimed = false;
      log.pdf.warn(`index fast-path failed for ${fileId}, handing it to the server's extractor: ${err}`);
      await indexCall(`/api/pdfindex/files/${fileId}/fail`, JSON_POST({ error: String(err) }));
      await pdfIndexClient.priorityIndex(fileId);
    } finally {
      window.removeEventListener('pagehide', release);
    }
  })().catch((err) => {
    log.pdf.warn(`index fast-path for ${fileId}: ${err}`);
  });

  inflight.set(fileId, task);
  void task.finally(() => inflight.delete(fileId));
  return task;
}
