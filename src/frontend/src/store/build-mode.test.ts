import { describe, it, expect, afterEach, vi } from 'vitest';
import { isLiteBuild, isOfflineBuild } from './build-mode';

afterEach(() => vi.unstubAllEnvs());

describe('isLiteBuild', () => {
  it('is false outside the backend-free builds (NAS / Electron / tests)', () => {
    expect(isLiteBuild()).toBe(false);
  });

  it('is true under --mode lite', () => {
    vi.stubEnv('MODE', 'lite');
    expect(isLiteBuild()).toBe(true);
  });

  it('is true under --mode offline (offline is also backend-free)', () => {
    vi.stubEnv('MODE', 'offline');
    expect(isLiteBuild()).toBe(true);
  });
});

describe('isOfflineBuild', () => {
  it('is false by default and under --mode lite', () => {
    expect(isOfflineBuild()).toBe(false);
    vi.stubEnv('MODE', 'lite');
    expect(isOfflineBuild()).toBe(false);
  });

  it('is true only under --mode offline', () => {
    vi.stubEnv('MODE', 'offline');
    expect(isOfflineBuild()).toBe(true);
  });
});
