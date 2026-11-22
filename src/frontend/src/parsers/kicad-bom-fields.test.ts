import { describe, it, expect } from 'vitest';
import { parseKiCadPCB } from './kicad-parser';

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

function board(props: string): ArrayBuffer {
  return enc(`(kicad_pcb (version 20240108)
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (net 0 "") (net 1 "VCC")
  (footprint "Capacitor_SMD:C_0402" (layer "F.Cu") (at 10 10)
    (property "Reference" "C1") (property "Value" "1u")
    ${props}
    (pad "1" smd rect (at -0.5 0) (size 0.5 0.5) (layers "F.Cu") (net 1 "VCC"))
    (pad "2" smd rect (at 0.5 0) (size 0.5 0.5) (layers "F.Cu") (net 0 "")))
)`);
}

describe('KiCad footprint BOM properties', () => {
  it('reads part number, rating, description and sheet', () => {
    const meta = parseKiCadPCB(board(`(property "mpn" "CL05A105KO5NNNC") (property "Rating" "16V")
      (property "Description" "Ceramic capacitor") (property "Sheetname" "Power")`)).parts[0].meta;
    expect(meta).toMatchObject({ value: '1u 16V', serial: 'CL05A105KO5NNNC', description: 'Ceramic capacitor', sheet: 'Power' });
  });

  it('puts the manufacturer in front of the part number', () => {
    const meta = parseKiCadPCB(board(`(property "Manufacturer" "Samsung") (property "MPN" "CL05A105KO5NNNC")`)).parts[0].meta;
    expect(meta?.serial).toBe('Samsung CL05A105KO5NNNC');
  });

  it('leaves empty properties and a root sheet out', () => {
    const meta = parseKiCadPCB(board(`(property "mpn" "") (property "Sheetname" "")`)).parts[0].meta;
    expect(meta?.serial).toBeUndefined();
    expect(meta?.sheet).toBeUndefined();
    expect(meta?.value).toBe('1u');
  });
});
