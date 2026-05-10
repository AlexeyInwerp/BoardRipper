/**
 * Wraps fetch() to handle the backend's cloud-storage-aware 503 response.
 *
 * When the backend returns 503 with a Retry-After header, the file is being
 * materialized from cloud storage (Google Drive, iCloud, OneDrive, etc.).
 * We retry up to maxAttempts times, waiting Retry-After seconds (or a
 * default delay) between attempts. UI callers pass an optional onRetry
 * callback that gets fired on each retry so they can update a "Downloading
 * from cloud..." spinner.
 *
 * Returns the final Response. Caller checks res.ok / res.status as usual;
 * a 503 here means we exhausted retries.
 *
 * Every attempt is logged via log.cloud so the Debug Panel surfaces the
 * full retry timeline including the backend-supplied X-Boardripper-Cloud-Error
 * code (which identifies which serve-path branch produced the 503).
 */

import { log } from './log-store';

/** Backend-supplied stable error code from X-Boardripper-Cloud-Error.
 *  Documented in src/backend/handlers/serve.go.
 *
 *  Known values:
 *    - 'edeadlk'         — read returned EDEADLK; placeholder unreachable through Docker bind-mount
 *    - 'deadline'        — 30 s read deadline hit (still materializing or hung)
 *    - 'short-read'      — bytes read < stat().Size() (cloud-sync glitch)
 *    - 'read-error:<errno>' — non-EDEADLK read failure with errno tag
 *    - 'open-failed:<errno>' — os.Open returned a non-NotFound error
 *    - 'not-found' / 'is-dir' / 'too-large' — pre-read errors
 */
export const CLOUD_ERROR_HEADER = 'X-Boardripper-Cloud-Error';

interface CloudRetryOptions {
  /** Total max attempts including the first one. Default 6 attempts ≈ 3 min total. */
  maxAttempts?: number;
  /** Default delay (seconds) when Retry-After is missing/unparseable. Default 10. */
  defaultRetrySeconds?: number;
  /** Hard cap on total wall time across all attempts. Default 180 s. */
  maxTotalSeconds?: number;
  /** Called before each retry (NOT before the first attempt). Receives the
   *  upcoming attempt number (≥2), the wait seconds before that attempt,
   *  and the cloud-error code from the just-failed attempt (if any). */
  onRetry?: (attempt: number, waitSeconds: number, cloudErrorCode: string | null) => void;
  /** AbortSignal — passes through to underlying fetch and aborts the wait. */
  signal?: AbortSignal;
  /** Optional human label used in log lines, e.g. the filename being fetched.
   *  Logged as the second column so multiple parallel fetches are easy to tell apart. */
  label?: string;
}

const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_RETRY_SECONDS = 10;
const DEFAULT_MAX_TOTAL_SECONDS = 180;

export async function fetchWithCloudRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  opts: CloudRetryOptions = {},
): Promise<Response> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const defaultRetry = opts.defaultRetrySeconds ?? DEFAULT_RETRY_SECONDS;
  const maxTotal = opts.maxTotalSeconds ?? DEFAULT_MAX_TOTAL_SECONDS;
  const start = performance.now();
  const label = opts.label ?? 'fetch';

  let attempt = 0;
  for (;;) {
    attempt++;
    const reqStart = performance.now();
    const res = await fetch(input, { ...init, signal: opts.signal });
    const reqMs = Math.round(performance.now() - reqStart);
    const cloudCode = res.headers.get(CLOUD_ERROR_HEADER);

    if (res.status !== 503) {
      // Final outcome — log only when something interesting happened (an
      // earlier retry, or the backend tagged the response with a cloud
      // code, or non-2xx status). Steady-state 200s would otherwise spam.
      if (attempt > 1 || cloudCode || !res.ok) {
        log.cloud.log(`${label}: attempt ${attempt} → ${res.status}${cloudCode ? ` cloud=${cloudCode}` : ''} (${reqMs} ms)`);
      }
      return res;
    }

    const retryAfterHeader = res.headers.get('Retry-After');
    const retrySeconds = retryAfterHeader && Number.isFinite(parseInt(retryAfterHeader, 10))
      ? parseInt(retryAfterHeader, 10)
      : defaultRetry;

    const elapsedSeconds = (performance.now() - start) / 1000;
    const wouldExceedBudget = elapsedSeconds + retrySeconds > maxTotal;
    const exhausted = attempt >= maxAttempts || wouldExceedBudget;

    log.cloud.warn(
      `${label}: attempt ${attempt} → 503${cloudCode ? ` cloud=${cloudCode}` : ''}` +
      ` retry-after=${retrySeconds}s elapsed=${elapsedSeconds.toFixed(1)}s` +
      ` (${exhausted ? 'GIVING UP' : `wait ${retrySeconds}s, then attempt ${attempt + 1}`})`,
    );

    if (exhausted) {
      // Out of budget. Return the 503 so the caller can show an error.
      // Caller is responsible for inspecting the response body / cloud
      // header to format an actionable message.
      return res;
    }

    // Drain the response body so the connection can be reused. Stash text
    // first since the caller may want to inspect it for diagnostic context
    // — though in the retry path we throw it away.
    try { await res.text(); } catch { /* swallow */ }

    opts.onRetry?.(attempt + 1, retrySeconds, cloudCode);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, retrySeconds * 1000);
      if (opts.signal) {
        const onAbort = () => {
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        };
        if (opts.signal.aborted) {
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        } else {
          opts.signal.addEventListener('abort', onAbort, { once: true });
        }
      }
    });
  }
}

/** Read both the cloud-error code and the response body so the caller can
 *  surface the actionable backend message. Buffers the body once — caller
 *  must NOT also read res.text() / res.arrayBuffer() afterwards. */
export async function readCloudError(res: Response): Promise<{ code: string | null; message: string }> {
  const code = res.headers.get(CLOUD_ERROR_HEADER);
  let message = '';
  try { message = (await res.text()).trim(); } catch { /* ignore */ }
  return { code, message };
}

/** Format an actionable user-facing message based on the cloud-error code
 *  and the backend's body. The body is the source of truth (tells the user
 *  what to do); the code lets us pick a UI tone (info / warning / error). */
export function formatCloudErrorToast(filename: string, code: string | null, body: string): string {
  if (code === 'edeadlk') {
    // The body already contains the actionable instruction; just prefix
    // the filename so the user knows which file we're talking about.
    return `Couldn't open "${filename}" — ${body || 'file is a cloud-storage placeholder; materialize it on the host first.'}`;
  }
  if (code === 'short-read' || code === 'deadline') {
    return `Couldn't download "${filename}" — cloud storage didn't deliver the full file. Try again in a moment.`;
  }
  if (code && code.startsWith('read-error:')) {
    const errno = code.slice('read-error:'.length);
    return `Couldn't read "${filename}" (${errno || 'unknown error'}). The file may be on cloud storage and unreachable from inside the container.`;
  }
  // Default — preserve the previous generic message.
  return `Couldn't download "${filename}" from cloud storage. Try again in a moment.`;
}
