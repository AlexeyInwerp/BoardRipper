import { describe, it, expect } from 'vitest';
import { partOnRootSide } from './minimap-sides';

describe('partOnRootSide', () => {
  it('single root: follows the raw side flags on an ordinary board', () => {
    expect(partOnRootSide('top', 'all', false, true, false)).toBe(true);
    expect(partOnRootSide('bottom', 'all', false, true, false)).toBe(false);
  });

  it('single root: the user’s Top on a primary-bottom board shows the file’s bottom parts', () => {
    // selectTop() on such a board sets showTop=false, showBottom=true.
    expect(partOnRootSide('bottom', 'all', true, false, true)).toBe(true);
    expect(partOnRootSide('top', 'all', true, false, true)).toBe(false);
  });

  it('butterfly roots are the user’s sides', () => {
    expect(partOnRootSide('top', 'top', false, true, true)).toBe(true);
    expect(partOnRootSide('bottom', 'top', true, true, true)).toBe(true);
    expect(partOnRootSide('top', 'bottom', true, true, true)).toBe(true);
    expect(partOnRootSide('top', 'top', true, true, true)).toBe(false);
  });

  it('a through-board part shows on both', () => {
    expect(partOnRootSide('both', 'top', true, false, true)).toBe(true);
    expect(partOnRootSide('both', 'all', false, false, true)).toBe(true);
  });
});
