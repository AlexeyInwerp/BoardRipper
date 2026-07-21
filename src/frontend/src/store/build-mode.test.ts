import { describe, it, expect, afterEach, vi } from 'vitest';
import { isLiteBuild } from './build-mode';

afterEach(() => vi.unstubAllEnvs());

describe('isLiteBuild', () => {
  it('is false outside the lite build (NAS / Electron / tests)', () => {
    expect(isLiteBuild()).toBe(false);
  });

  it('is true under --mode lite', () => {
    vi.stubEnv('MODE', 'lite');
    expect(isLiteBuild()).toBe(true);
  });
});
