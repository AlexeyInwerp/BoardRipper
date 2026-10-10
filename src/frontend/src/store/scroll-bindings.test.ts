import { describe, it, expect } from 'vitest';
import {
  toggleBareAction, boardScrollBindings, boardScrollSettings, nextAction,
  DEFAULT_SCROLL_BINDINGS, LEGACY_SCROLL_BINDINGS, DEFAULT_BOARD_SCROLL_BINDINGS,
  SCROLL_ACTIONS, BOARD_SCROLL_ACTIONS,
} from './scroll-bindings';

describe('toggleBareAction', () => {
  it('is a pure toggle on the default layout: Shift stays Pan both ways', () => {
    const once = toggleBareAction(DEFAULT_SCROLL_BINDINGS);
    expect(once).toEqual({ bare: 'zoom', shift: 'pan', meta: 'zoom' });
    expect(toggleBareAction(once)).toEqual(DEFAULT_SCROLL_BINDINGS);
  });

  it('moves a displaced action to Shift only when no other slot has it', () => {
    // Legacy PDF layout: pan is displaced from bare and nothing else pans.
    expect(toggleBareAction(LEGACY_SCROLL_BINDINGS)).toEqual({ bare: 'zoom', shift: 'pan', meta: 'switch' });
    // Coming back, zoom is displaced but Shift... no: bare=zoom, shift=pan, meta=switch
    // → bare becomes pan, zoom is reachable nowhere → Shift takes it.
    expect(toggleBareAction({ bare: 'zoom', shift: 'pan', meta: 'switch' })).toEqual(LEGACY_SCROLL_BINDINGS);
  });

  it('never touches a ⌘ slot', () => {
    expect(toggleBareAction({ bare: 'pan', shift: 'switch', meta: 'zoom' })).toEqual({ bare: 'zoom', shift: 'pan', meta: 'zoom' });
  });

  it('a bare Page slot flips to Pan', () => {
    expect(toggleBareAction({ bare: 'switch', shift: 'pan', meta: 'zoom' }).bare).toBe('pan');
  });

  it('works on the board bindings too', () => {
    const legacyBoard = { bare: 'pan', shift: 'zoom', meta: 'zoom' } as const;
    expect(toggleBareAction(legacyBoard)).toEqual({ bare: 'zoom', shift: 'pan', meta: 'zoom' });
  });
});

describe('board bindings ⇄ settings', () => {
  it('round-trips through the three render-settings keys', () => {
    const s = { twoFingerPan: false, wheelShiftAction: 'pan', wheelMetaAction: 'pan' } as const;
    expect(boardScrollSettings(boardScrollBindings(s))).toEqual(s);
    expect(boardScrollBindings(boardScrollSettings(DEFAULT_BOARD_SCROLL_BINDINGS))).toEqual(DEFAULT_BOARD_SCROLL_BINDINGS);
  });
});

describe('nextAction', () => {
  it('cycles through every action and wraps', () => {
    expect(nextAction(SCROLL_ACTIONS, 'zoom')).toBe('pan');
    expect(nextAction(SCROLL_ACTIONS, 'pan')).toBe('switch');
    expect(nextAction(SCROLL_ACTIONS, 'switch')).toBe('zoom');
    expect(nextAction(BOARD_SCROLL_ACTIONS, 'zoom')).toBe('pan');
  });
});
