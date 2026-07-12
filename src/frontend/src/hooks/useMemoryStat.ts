import { useEffect, useState } from 'react';

/**
 * Live memory usage for the status bar.
 *
 * Source chain:
 * 1. `performance.measureUserAgentSpecificMemory()` — precise, includes
 *    dedicated workers (the parse worker!), but requires cross-origin
 *    isolation (COOP/COEP headers — served by the Go backend and the vite
 *    dev server). Polled every 20 s; the browser may take seconds to
 *    resolve a measurement, which is fine for a status readout.
 * 2. `performance.memory.usedJSHeapSize` — Chrome/Edge/Electron only, and
 *    WITHOUT cross-origin isolation the value is bucketized and updated
 *    only every ~20 minutes, so it's marked `≈` and labelled stale in the
 *    tooltip. Better than nothing (Electron file:// has no headers).
 * 3. Neither available (Firefox/Safari, non-isolated) → null, stat hidden.
 */

interface MemoryStat {
  label: string;
  title: string;
}

interface UAMemoryBreakdownEntry {
  bytes: number;
  types: string[];
}
interface UAMemoryResult {
  bytes: number;
  breakdown: UAMemoryBreakdownEntry[];
}
type MeasureFn = () => Promise<UAMemoryResult>;

function fmt(bytes: number): string {
  const mb = bytes / 1048576;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(0)} MB`;
}

export function useMemoryStat(): MemoryStat | null {
  const [stat, setStat] = useState<MemoryStat | null>(null);

  useEffect(() => {
    const perf = performance as unknown as {
      measureUserAgentSpecificMemory?: MeasureFn;
      memory?: { usedJSHeapSize: number; totalJSHeapSize: number };
    };

    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    if (typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated && perf.measureUserAgentSpecificMemory) {
      // The precise API resolves at the next major GC — potentially tens of
      // seconds on an idle page. Seed the stat from performance.memory (≈)
      // immediately so the bar isn't blank, then upgrade in place.
      if (perf.memory) {
        setStat({
          label: `Mem ≈ ${fmt(perf.memory.usedJSHeapSize)}`,
          title: 'Approximate JS heap — precise measurement pending (resolves at the next GC).',
        });
      }
      const fallbackToHeapPolling = () => {
        // Precise API permanently unavailable (headless shells reject with
        // SecurityError despite isolation) — poll the approximate heap instead.
        if (timer) clearInterval(timer);
        timer = null;
        if (!perf.memory) return;
        const read = () => setStat({
          label: `Mem ≈ ${fmt(perf.memory!.usedJSHeapSize)}`,
          title: 'Approximate JS heap (performance.memory) — precise measurement unavailable in this browser build.',
        });
        read();
        timer = setInterval(read, 5_000);
      };
      const measure = async () => {
        try {
          const res = await perf.measureUserAgentSpecificMemory!();
          if (cancelled) return;
          let workers = 0;
          for (const e of res.breakdown) {
            if (e.types.some(t => t.includes('Worker'))) workers += e.bytes;
          }
          setStat({
            label: `Mem: ${fmt(res.bytes)}`,
            title: `JS memory, precise (cross-origin isolated)\nTotal: ${fmt(res.bytes)}\nWorkers (incl. parse worker): ${fmt(workers)}\nUpdates every ~20 s`,
          });
        } catch (e) {
          if (!cancelled && e instanceof DOMException && e.name === 'SecurityError') fallbackToHeapPolling();
          // other rejections are transient — keep the last value, retry on interval
        }
      };
      // Interval registered BEFORE the first call: measure() may reject fast
      // (SecurityError) and switch `timer` to heap polling — assigning the
      // measure interval afterwards would clobber the fallback's handle.
      timer = setInterval(measure, 20_000);
      void measure();
    } else if (perf.memory) {
      const read = () => {
        const m = perf.memory!;
        setStat({
          label: `Mem ≈ ${fmt(m.usedJSHeapSize)}`,
          title: 'Approximate JS heap (performance.memory).\nWithout cross-origin isolation the browser bucketizes this value and refreshes it only every ~20 minutes — treat as a rough indicator.',
        });
      };
      read();
      timer = setInterval(read, 5_000);
    }

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, []);

  return stat;
}
