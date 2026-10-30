import { describe, it, expect } from 'vitest';
import { looseKey, looseMatcher } from './loose-match';

describe('looseMatcher', () => {
  const net = 'PP1V25_AWAKE_NAND';

  it('keeps every plain substring hit as direct', () => {
    const m = looseMatcher('1v25');
    expect(m.classify(net)).toBe('direct');
    expect(looseMatcher('PP1V25_AW').classify(net)).toBe('direct');
  });

  it('ignores separators and case', () => {
    expect(looseMatcher('pp_1v25').classify(net)).toBe('loose');
    expect(looseMatcher('1v25awake').classify(net)).toBe('loose');
    expect(looseMatcher('pp-1v25.awake').classify(net)).toBe('loose');
  });

  it('matches several words in any order', () => {
    expect(looseMatcher('nand 1v25').classify(net)).toBe('loose');
    expect(looseMatcher('awake  pp1v25 ').classify(net)).toBe('loose');
  });

  it('needs every word', () => {
    expect(looseMatcher('nand 1v8').classify(net)).toBeNull();
    expect(looseMatcher('ppbus').classify(net)).toBeNull();
  });

  it('an empty or blank query matches nothing', () => {
    expect(looseMatcher('').test(net)).toBe(false);
    expect(looseMatcher('   ').test(net)).toBe(false);
    expect(looseMatcher('__').test(net)).toBe(false);
  });

  it('keeps letters of any script and the plus sign', () => {
    expect(looseKey('电源_3V3')).toBe('电源3v3');
    expect(looseMatcher('电源 3v3').classify('电源_3V3')).toBe('loose');
    expect(looseKey('+3V3_S5')).toBe('+3v3s5');
  });
});
