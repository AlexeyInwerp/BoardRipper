import { describe, it, expect } from 'vitest';
import { localSettingsKeys } from './reset-local-settings';

describe('localSettingsKeys', () => {
  it('removes preferences and keeps the user\'s own data', () => {
    const keys = [
      'boardripper-render-settings', 'boardripper-board-overrides', 'boardripper-theme',
      'boardripper-sidebar-width', 'boardripper-pinlabel-floor-8',
      'boardripper-history', 'boardripper-favorites', 'boardripper-nav-history', 'boardripper-session',
      'boardripper-pdf-bookmarks-schematic.pdf', 'boardripper-fz-key', 'boardripper-update-in-flight',
      'br-mcp-client-id', 'some-other-app',
    ];
    expect(localSettingsKeys(keys).sort()).toEqual([
      'boardripper-board-overrides', 'boardripper-pinlabel-floor-8', 'boardripper-render-settings',
      'boardripper-sidebar-width', 'boardripper-theme',
    ]);
  });
});
