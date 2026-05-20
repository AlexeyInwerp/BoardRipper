// Wire-format contract: see docs/PDF_VIEWER.md#api
// State machine: see docs/PDF_VIEWER.md#state-machine
import { log } from '../store/log-store';
import {
  isPdfWatermarkText,
  getActiveWatermarkFilter,
  renderSettingsStore,
} from '../store/render-settings';

export interface IndexStatus {
  status: 'pending' | 'indexing' | 'indexed' | 'empty' | 'failed' | '';
  source?: string;
  page_count?: number;
}

export interface PdfIndexProgress {
  running: boolean;
  total: number;
  done: number;
  errors: number;
  current_file: string;
  started_at: string;
}

export interface PdfIndexStats {
  indexed: number;
  empty: number;
  failed: number;
  pending: number;
  indexing: number;
  pages: number;
}

export interface PdfIndexFailedEntry {
  file_id: number;
  status: string;
  error: string;
}

async function jfetch<T>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(url, init);
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export const pdfIndexClient = {
  status: (fileId: number) => jfetch<IndexStatus>(`/api/pdfindex/status/${fileId}`),
  run: () => jfetch(`/api/pdfindex/run`, { method: 'POST' }),
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
  failed: () => jfetch<PdfIndexFailedEntry[]>(`/api/pdfindex/failed`),
  priorityIndex: (fileId: number) =>
    jfetch(`/api/pdfindex/files/${fileId}/index`, { method: 'POST' }),
};

// In-flight dedup so two panels opening the same PDF kick off only one extract.
const inflight = new Map<number, Promise<void>>();

/**
 * ensureIndexed: the automatic on-open fast-path. Extracts the already-loaded
 * pdf.js doc text (passed in via getTextPages) and uploads it. Falls back to
 * backend priority extraction only if pdf.js extraction throws. Idempotent per
 * fileId via the inflight map.
 */
export function ensureIndexed(fileId: number, getTextPages: () => string[][]): Promise<void> {
  const existing = inflight.get(fileId);
  if (existing) return existing;

  const task = (async () => {
    const st = await pdfIndexClient.status(fileId);
    if (st && (st.status === 'indexed' || st.status === 'empty' || st.status === 'indexing')) {
      return;
    }
    const begin = await fetch(`/api/pdfindex/files/${fileId}/begin`, { method: 'POST' });
    if (begin.status === 409) return;
    if (!begin.ok) return;

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
        await fetch(`/api/pdfindex/files/${fileId}/pages`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pages: batch.splice(0, batch.length) }),
        });
      };
      for (let i = 0; i < pages.length; i++) {
        const joined = (pages[i] || [])
          .filter((s) => !(enabled && isPdfWatermarkText(s, terms)))
          .join(' ')
          .trim();
        if (joined) batch.push({ n: i + 1, text: joined });
        if (batch.length >= 50) await flush();
      }
      await flush();
      await fetch(`/api/pdfindex/files/${fileId}/finalize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ total_pages: pages.length }),
      });
    } catch (err) {
      log.pdf.warn(`fast-path extract failed for ${fileId}, falling back to backend: ${err}`);
      await fetch(`/api/pdfindex/files/${fileId}/fail`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: String(err) }),
      });
      await pdfIndexClient.priorityIndex(fileId);
    }
  })();

  inflight.set(fileId, task);
  task.finally(() => inflight.delete(fileId));
  return task;
}
