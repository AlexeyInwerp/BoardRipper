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
 */

interface CloudRetryOptions {
  /** Total max attempts including the first one. Default 6 attempts ≈ 3 min total. */
  maxAttempts?: number;
  /** Default delay (seconds) when Retry-After is missing/unparseable. Default 10. */
  defaultRetrySeconds?: number;
  /** Hard cap on total wall time across all attempts. Default 180 s. */
  maxTotalSeconds?: number;
  /** Called before each retry (NOT before the first attempt). Receives the
   *  upcoming attempt number (≥2) and the wait seconds before that attempt. */
  onRetry?: (attempt: number, waitSeconds: number) => void;
  /** AbortSignal — passes through to underlying fetch and aborts the wait. */
  signal?: AbortSignal;
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

  let attempt = 0;
  for (;;) {
    attempt++;
    const res = await fetch(input, { ...init, signal: opts.signal });
    if (res.status !== 503) return res;

    const retryAfterHeader = res.headers.get('Retry-After');
    const retrySeconds = retryAfterHeader && Number.isFinite(parseInt(retryAfterHeader, 10))
      ? parseInt(retryAfterHeader, 10)
      : defaultRetry;

    const elapsedSeconds = (performance.now() - start) / 1000;
    if (attempt >= maxAttempts || elapsedSeconds + retrySeconds > maxTotal) {
      // Out of budget. Return the 503 so the caller can show an error.
      return res;
    }

    // Drain the response body so the connection can be reused.
    try { await res.text(); } catch { /* swallow */ }

    opts.onRetry?.(attempt + 1, retrySeconds);
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
