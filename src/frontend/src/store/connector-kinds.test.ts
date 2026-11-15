import { describe, expect, it } from 'vitest';
import { classifyConnector, isConnectorRef, kindFromName, looksLikeUsbC, type ConnectorGeometry } from './connector-kinds';

const g = (o: Partial<ConnectorGeometry>): ConnectorGeometry => ({ n: 10, rows: 1, perRow: 10, pitch: 0.5, spanL: 4.5, spanW: 0, bigPads: 0, drilled: 0, ...o });

describe('connector semantics', () => {
  it('a J designator is a connector, an IC prefix is not', () => {
    for (const r of ['J1', 'JDDRH', 'JUSB2', 'CN12', 'P3', 'X1', 'JP4']) expect(isConnectorRef(r), r).toBe(true);
    for (const r of ['U1', 'PU2001', 'PQ4002', 'PR5301', 'Q3', 'SW1', 'PC1']) expect(isConnectorRef(r), r).toBe(false);
  });
  it('keywords name the kind, digits included', () => {
    expect(kindFromName('JDDRH')).toBe('sodimm'); expect(kindFromName('JRJ45')).toBe('rj45'); expect(kindFromName('JM2_1')).toBe('m2');
    expect(kindFromName('JUC1')).toBe('usb-c'); expect(kindFromName('JUA3')).toBe('usb-a'); expect(kindFromName('JEDP1')).toBe('fpc');
    expect(kindFromName('JFAN2')).toBe('fan'); expect(kindFromName('JBATT1')).toBe('battery'); expect(kindFromName('CN12')).toBeNull();
  });
  it('a SODIMM socket is never a USB-C port, whatever the pads look like', () => {
    const sodimm = g({ n: 264, rows: 2, perRow: 132, pitch: 0.5, spanL: 68.8, spanW: 16.1, bigPads: 4 });
    expect(looksLikeUsbC(sodimm)).toBe(false);
    expect(classifyConnector('JDDRH', sodimm).kind).toBe('sodimm');
    expect(classifyConnector('CN7', sodimm).kind).toBe('sodimm'); // by pattern when the name says nothing
  });
  it('USB-C by pattern needs two short rows at 0.5 mm plus shell tabs', () => {
    expect(classifyConnector('CN3', g({ n: 28, rows: 2, perRow: 12, pitch: 0.5, spanL: 5.5, spanW: 1.2, bigPads: 4 })).kind).toBe('usb-c');
    expect(classifyConnector('CN3', g({ n: 52, rows: 2, perRow: 26, pitch: 0.5, spanL: 12.5, spanW: 1.0, bigPads: 2 })).kind).not.toBe('usb-c'); // eDP
  });
  it('a named kind with an impossible pin count falls back to the pattern', () => {
    expect(classifyConnector('JDDR1', g({ n: 12, rows: 1, perRow: 12, pitch: 1.0, spanL: 11 })).kind).toBe('wire');
  });
  it('an unknown J part becomes a generic connector, never an IC family', () => {
    const r = classifyConnector('J9', g({ n: 79, rows: 4, perRow: 20, pitch: 0.65, spanL: 44, spanW: 3 }));
    expect(r.kind).toBe('generic'); expect(r.L).toBeGreaterThan(44);
  });
});
