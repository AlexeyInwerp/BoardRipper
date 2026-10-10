import { describe, it, expect } from 'vitest';
import { flagMechanicalParts, type Part } from './types';

/** A part centred at (cx, cy), `size` mils square, its pins on the given nets
 *  spread along the bottom edge. */
function part(name: string, cx: number, cy: number, size: number, nets: string[]): Part {
  const h = size / 2;
  return {
    name, side: 'top', type: 'smd',
    origin: { x: cx, y: cy },
    bounds: { minX: cx - h, minY: cy - h, maxX: cx + h, maxY: cy + h },
    pins: nets.map((net, i) => ({
      name: String(i + 1), number: String(i + 1),
      position: { x: cx - h + (i + 0.5) * (size / nets.length), y: cy + h },
      radius: 5, side: 'top', net,
    })),
  } as Part;
}

/** Five 2-pin caps inside a 1000-mil square at the origin — enough for the
 *  containment rule to fire on whatever encloses them. */
const caps = () => [0, 1, 2, 3, 4].map(i => part(`C${i}`, -300 + i * 150, 0, 40, ['PP1V8', 'GND']));

describe('flagMechanicalParts', () => {
  it('flags a ground-only frame that encloses other parts', () => {
    const shield = part('SH1', 0, 0, 1000, ['GND', 'GND', 'GND', 'GND']);
    const parts = [shield, ...caps()];
    flagMechanicalParts(parts);
    expect(shield.mechanical).toBe(true);
  });

  it('never flags a part that carries signal, however many parts sit inside it', () => {
    // A CPU with its decoupling field under the package — U1000 on 156 of
    // 349 XZZ files lost every pad and pin label to this.
    const cpu = part('U1000', 0, 0, 1000, ['PCIE_TX_P', 'PCIE_TX_N', 'GND', 'PPVCCIO_S0', 'UNCONNECTED_4']);
    const parts = [cpu, ...caps()];
    flagMechanicalParts(parts);
    expect(cpu.mechanical).toBeFalsy();
  });

  it('recomputes the flag, so a cached board drops a decision an older rule made', () => {
    const cpu = part('U1000', 0, 0, 1000, ['PCIE_TX_P', 'PCIE_TX_N']);
    cpu.mechanical = true;
    flagMechanicalParts([cpu, ...caps()]);
    expect(cpu.mechanical).toBeFalsy();
  });

  it('still flags a keyword-labelled shield whatever its nets', () => {
    const shield = part('SH2', 5000, 5000, 200, ['SIG_A', 'SIG_B']);
    shield.meta = { value: 'EMI SHIELD FRAME' } as Part['meta'];
    flagMechanicalParts([shield]);
    expect(shield.mechanical).toBe(true);
  });
});
