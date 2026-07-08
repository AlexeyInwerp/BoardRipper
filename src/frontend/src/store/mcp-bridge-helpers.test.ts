import { describe, it, expect } from 'vitest';
import { classifyNetName } from './mcp-bridge-helpers';

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
