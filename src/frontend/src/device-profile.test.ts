import { describe, it, expect, afterEach, vi } from 'vitest';
import { boardAntialias, boardMaxFps, boardPixelRatio, isTouchPrimary } from './device-profile';

function pretend(pointer: 'coarse' | 'fine', dpr: number, opts: {
  webkit?: boolean; touchPoints?: number;
} = {}) {
  vi.stubGlobal('window', {
    devicePixelRatio: dpr,
    matchMedia: (q: string) => ({ matches: q.includes('coarse') === (pointer === 'coarse') }),
    ...(opts.webkit ? { GestureEvent: class {} } : {}),
  });
  vi.stubGlobal('navigator', { maxTouchPoints: opts.touchPoints ?? 0 });
}

afterEach(() => vi.unstubAllGlobals());

describe('device profile', () => {
  it('reads the primary pointer, not the user agent', () => {
    pretend('coarse', 2);
    expect(isTouchPrimary()).toBe(true);
    pretend('fine', 2);
    expect(isTouchPrimary()).toBe(false);
  });

  it('still knows an iPad with a trackpad attached, which reports a fine pointer', () => {
    pretend('fine', 2, { webkit: true, touchPoints: 5 });
    expect(isTouchPrimary()).toBe(true);
  });

  it('leaves desktop Safari and a Windows touch laptop alone', () => {
    pretend('fine', 2, { webkit: true, touchPoints: 0 });   // Safari on a Mac
    expect(isTouchPrimary()).toBe(false);
    pretend('fine', 2, { webkit: false, touchPoints: 10 }); // Chromium, touchscreen + mouse
    expect(isTouchPrimary()).toBe(false);
  });

  it('spends the full budget on a laptop even with the mode on', () => {
    pretend('fine', 2);
    expect(boardPixelRatio(true)).toBe(2);
    expect(boardAntialias(true)).toBe(true);
    expect(boardMaxFps(false, true)).toBe(0);
  });

  it('trades all three costs on a tablet', () => {
    pretend('coarse', 2);
    expect(boardPixelRatio(true)).toBe(1.5);
    expect(boardAntialias(true)).toBe(false);
    expect(boardMaxFps(false, true)).toBe(60);
  });

  it('leaves a tablet alone when the user turns the mode off', () => {
    pretend('coarse', 2);
    expect(boardPixelRatio(false)).toBe(2);
    expect(boardAntialias(false)).toBe(true);
    expect(boardMaxFps(false, false)).toBe(0);
  });

  it('never raises a device pixel ratio that is already below the ceiling', () => {
    pretend('coarse', 1);
    expect(boardPixelRatio(true)).toBe(1);
  });

  it('keeps the explicit 60 FPS cap winning everywhere', () => {
    pretend('fine', 2);
    expect(boardMaxFps(true, false)).toBe(60);
  });
});
