import { describe, it, expect } from 'vitest';
import type { Pin } from '../parsers';
import { orderPins } from './pin-order';

const pins = [
  { number: '1', name: 'VIN', net: 'PP3V3_S5' },
  { number: '10', name: 'EN', net: 'SMC_PM_EN' },
  { number: '2', name: 'GND', net: 'GND' },
  { number: 'A3', name: 'SW', net: 'PP1V8_S0_SW' },
] as unknown as Pin[];

describe('orderPins', () => {
  it('file order with no query and no sort', () => {
    expect(orderPins(pins, '', null, null)).toEqual([0, 1, 2, 3]);
  });

  it('filters on number, name or net, loosely', () => {
    expect(orderPins(pins, 'gnd', null, null)).toEqual([2]);
    expect(orderPins(pins, 'en', null, null)).toEqual([1]);       // name EN, net SMC_PM_EN
    expect(orderPins(pins, '1v8 sw', null, null)).toEqual([3]);   // loose, words in any order
    expect(orderPins(pins, 'a3', null, null)).toEqual([3]);       // pin number
  });

  it('never hides the selected pin', () => {
    expect(orderPins(pins, 'gnd', null, 0)).toEqual([0, 2]);
  });

  it('sorts naturally, both ways', () => {
    expect(orderPins(pins, '', { col: 'num', dir: 1 }, null)).toEqual([0, 2, 1, 3]);   // 1, 2, 10, A3
    expect(orderPins(pins, '', { col: 'num', dir: -1 }, null)).toEqual([3, 1, 2, 0]);
    expect(orderPins(pins, '', { col: 'net', dir: 1 }, null)).toEqual([2, 3, 0, 1]);   // GND, PP1V8…, PP3V3…, SMC…
  });
});
