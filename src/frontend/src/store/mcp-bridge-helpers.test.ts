import { describe, it, expect } from 'vitest';
import { classifyNetName, buildOverview } from './mcp-bridge-helpers';

describe('classifyNetName', () => {
  it('flags auto-generated names as synthetic', () => {
    for (const n of ['', '   ', 'N$123', 'NET0042', '42', '$77', 'UNNAMED_9', 'NODE12'])
      expect(classifyNetName(n)).toBe('synthetic');
  });
  it('treats real rail/signal names as named', () => {
    for (const n of ['PP3V3_G3H', 'VCC_MAIN', 'USB_DP', 'GND', 'PCIE_TX0'])
      expect(classifyNetName(n)).toBe('named');
  });
});

describe('buildOverview', () => {
  it('summarizes worklist counts', () => {
    const snap = {
      note: 'diag',
      parts: [{ refdes: 'U1' }, { refdes: 'U2' }],
      netEntries: [
        { netName: 'A', measurements: [{ status: 'requested' }] },
        { netName: 'B', measurements: [{ status: 'recorded' }] },
      ],
    };
    const wl = buildOverview(snap, 3);
    expect(wl).toEqual({ parts: 2, nets: 2, pendingMeasurements: 1, unreadUserMessages: 3, hasListNote: true });
  });
  it('handles no worklist', () => {
    expect(buildOverview(null, 0)).toEqual({ parts: 0, nets: 0, pendingMeasurements: 0, unreadUserMessages: 0, hasListNote: false });
  });
});
