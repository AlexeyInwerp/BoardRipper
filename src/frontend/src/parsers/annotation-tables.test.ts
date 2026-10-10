import { describe, it, expect } from 'vitest';
import { buildAnnotations, collectAnnotationLabels, rowGapThreshold } from './annotation-tables';
import type { BoardText } from './types';

const t = (text: string, x: number, y: number, size = 60): BoardText =>
  ({ text, x, y, size, layer: 17, rotationDeg: 0 });

/** A 3-column fault table shaped like iPhoneXSMAX's: a caption, a header, and
 *  rows ~170 mils apart whose cells hold one or two lines ~60 mils apart. */
function faultTable(x0 = 0): BoardText[] {
  return [
    t('通病', x0 + 15, 1400, 200),
    t('故障现象', x0, 1180, 100), t('故障点', x0 + 620, 1175, 100), t('处理方法', x0 + 1520, 1190, 100),
    t('卡机', x0, 1000), t('尾插接触不良', x0 + 610, 1020), t('测试功能又正常', x0 + 610, 960), t('更换尾插', x0 + 1500, 1005),
    t('跳卡', x0, 830), t('搬下层后出现跳卡', x0 + 600, 830), t('刷机解决', x0 + 1510, 820),
    t('无电池数据', x0, 660), t('座子塌陷', x0 + 620, 680), t('I2C0_SMC_TO_GG_SCL_CONN', x0 + 620, 620), t('更换', x0 + 1520, 670), t('J3200', x0 + 1520, 610),
    t('重摔', x0, 490), t('空焊', x0 + 620, 500), t('刷机', x0 + 1510, 495),
  ];
}

describe('rowGapThreshold', () => {
  it('splits intra-row jitter from row pitch', () => {
    const th = rowGapThreshold([2, 5, 8, 60, 3, 170, 165, 175, 4, 58]);
    expect(th).toBeGreaterThan(8);
    expect(th).toBeLessThan(165);
  });
});

describe('collectAnnotationLabels', () => {
  it('admits ASCII cells at table size but not silkscreen designators under the table', () => {
    const silk = Array.from({ length: 50 }, (_, i) => t(`C${i}`, 100 + i * 20, 900, 1));
    const labels = collectAnnotationLabels([...faultTable(), ...silk]);
    expect(labels.map(l => l.text)).toContain('J3200');
    expect(labels.some(l => /^C\d+$/.test(l.text))).toBe(false);
  });
});

describe('buildAnnotations', () => {
  it('recovers caption, header and multi-line cells', () => {
    const a = buildAnnotations(faultTable())!;
    expect(a.tables).toHaveLength(1);
    const [tbl] = a.tables;
    expect(tbl.caption).toBe('通病');
    expect(tbl.header).toEqual(['故障现象', '故障点', '处理方法']);
    expect(tbl.rows).toEqual([
      [['卡机'], ['尾插接触不良', '测试功能又正常'], ['更换尾插']],
      [['跳卡'], ['搬下层后出现跳卡'], ['刷机解决']],
      [['无电池数据'], ['座子塌陷', 'I2C0_SMC_TO_GG_SCL_CONN'], ['更换', 'J3200']],
      [['重摔'], ['空焊'], ['刷机']],
    ]);
    expect(a.notes).toEqual([]);
  });

  it('splits side-by-side tables instead of merging their columns', () => {
    const a = buildAnnotations([...faultTable(0), ...faultTable(4800)])!;
    expect(a.tables).toHaveLength(2);
    expect(a.tables.every(tb => tb.header.length === 3)).toBe(true);
    expect(a.tables[0].rawBounds.maxX).toBeLessThan(a.tables[1].rawBounds.minX);
  });

  it('keeps designator-size board notes out of the table and returns them as notes', () => {
    // Three legend labels just above the header; at table size they would
    // become the caption and header, and their x positions the column anchors.
    const legend = [t('黑OL红654', 300, 1300, 2), t('黑表笔', 900, 1300, 2), t('红表笔', 1300, 1300, 2)];
    const a = buildAnnotations([...faultTable(), ...legend])!;
    expect(a.tables[0].header).toEqual(['故障现象', '故障点', '处理方法']);
    expect(a.notes.map(n => n.text).sort()).toEqual(['红表笔', '黑OL红654', '黑表笔'].sort());
  });

  it('rejects a flowchart and hands every label back as a note', () => {
    const boxes = Array.from({ length: 10 }, (_, i) => t(`步骤${i}`, i * 300, 500 + (i % 2) * 5));
    const extra = [t('开始', 0, 1000), t('结束', 0, 0)];
    const a = buildAnnotations([...boxes, ...extra])!;
    expect(a.tables).toEqual([]);
    expect(a.notes).toHaveLength(12);
  });

  it('rejects a two-column layout, which no real table has', () => {
    // Shaped like the iPhoneXS repair flowchart: an instruction and a
    // designator side by side on top, then yes/no branches under each.
    const flow = [
      t('请点击下列零件编号', 0, 1000, 100), t('J6400', 900, 1000, 100),
      t('先更换尾插排线', 0, 800), t('结束维修', 900, 800),
      t('否', 0, 600), t('测量尾插座子', 0, 400), t('正常', 0, 200), t('异常', 900, 200),
    ];
    const a = buildAnnotations(flow)!;
    expect(a.tables).toEqual([]);
    // J6400 is ASCII, and only annotation-language text is kept as a note.
    expect(a.notes).toHaveLength(7);
  });

  it('is undefined on a board with no annotation-language text', () => {
    expect(buildAnnotations([t('U1', 0, 0, 1), t('C2', 10, 0, 1)])).toBeUndefined();
  });
});
