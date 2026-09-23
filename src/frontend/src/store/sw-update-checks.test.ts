import { describe, it, expect, vi } from 'vitest';
import { scheduleSwUpdateChecks } from './sw-update-checks';

/** A document/window pair whose events the test fires by hand. */
function fakeHost(visibility: DocumentVisibilityState = 'visible') {
  const docListeners = new Map<string, Set<() => void>>();
  const winListeners = new Map<string, Set<() => void>>();
  const doc = {
    visibilityState: visibility,
    addEventListener: (t: string, fn: () => void) => { (docListeners.get(t) ?? docListeners.set(t, new Set()).get(t)!).add(fn); },
    removeEventListener: (t: string, fn: () => void) => { docListeners.get(t)?.delete(fn); },
  };
  const win = {
    addEventListener: (t: string, fn: () => void) => { (winListeners.get(t) ?? winListeners.set(t, new Set()).get(t)!).add(fn); },
    removeEventListener: (t: string, fn: () => void) => { winListeners.get(t)?.delete(fn); },
  };
  const fire = (target: 'doc' | 'win', type: string) => {
    for (const fn of (target === 'doc' ? docListeners : winListeners).get(type) ?? []) fn();
  };
  return { doc, win, fire, listeners: { docListeners, winListeners } };
}

describe('scheduleSwUpdateChecks', () => {
  it('re-checks when the page becomes visible again — the iPad resume', () => {
    const host = fakeHost('hidden');
    const reg = { update: vi.fn(() => Promise.resolve()) };
    scheduleSwUpdateChecks(reg, { doc: host.doc, win: host.win, timers: { setInterval: vi.fn() as never, clearInterval: vi.fn() as never } });

    host.doc.visibilityState = 'visible';
    host.fire('doc', 'visibilitychange');
    expect(reg.update).toHaveBeenCalledTimes(1);
  });

  it('does not check a page the user cannot see', () => {
    const host = fakeHost('hidden');
    const reg = { update: vi.fn(() => Promise.resolve()) };
    scheduleSwUpdateChecks(reg, { doc: host.doc, win: host.win, timers: { setInterval: vi.fn() as never, clearInterval: vi.fn() as never } });

    host.fire('doc', 'visibilitychange');   // still hidden
    host.fire('win', 'online');
    expect(reg.update).not.toHaveBeenCalled();
  });

  it('re-checks when the network comes back', () => {
    const host = fakeHost('visible');
    const reg = { update: vi.fn(() => Promise.resolve()) };
    scheduleSwUpdateChecks(reg, { doc: host.doc, win: host.win, timers: { setInterval: vi.fn() as never, clearInterval: vi.fn() as never } });

    host.fire('win', 'online');
    expect(reg.update).toHaveBeenCalledTimes(1);
  });

  it('re-checks on the interval while visible', () => {
    vi.useFakeTimers();
    try {
      const host = fakeHost('visible');
      const reg = { update: vi.fn(() => Promise.resolve()) };
      scheduleSwUpdateChecks(reg, { doc: host.doc, win: host.win, intervalMs: 1000 });
      vi.advanceTimersByTime(3500);
      expect(reg.update).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failed check is reported, never thrown', async () => {
    const host = fakeHost('visible');
    const onError = vi.fn();
    const reg = { update: vi.fn(() => Promise.reject(new Error('offline'))) };
    scheduleSwUpdateChecks(reg, { doc: host.doc, win: host.win, onError, timers: { setInterval: vi.fn() as never, clearInterval: vi.fn() as never } });

    host.fire('win', 'online');
    await Promise.resolve(); await Promise.resolve();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('stop() removes every trigger', () => {
    vi.useFakeTimers();
    try {
      const host = fakeHost('visible');
      const reg = { update: vi.fn(() => Promise.resolve()) };
      const stop = scheduleSwUpdateChecks(reg, { doc: host.doc, win: host.win, intervalMs: 1000 });
      stop();
      vi.advanceTimersByTime(5000);
      host.fire('doc', 'visibilitychange');
      host.fire('win', 'online');
      expect(reg.update).not.toHaveBeenCalled();
      expect(host.listeners.docListeners.get('visibilitychange')?.size ?? 0).toBe(0);
      expect(host.listeners.winListeners.get('online')?.size ?? 0).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
