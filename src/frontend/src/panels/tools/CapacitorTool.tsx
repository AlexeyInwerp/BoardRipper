import { useState } from 'react';
import { CAP_UNITS, CAP_UNIT_TO_PF, formatCapValue, type CapUnit } from '../../tools/capacitor';

const UNIT_LABEL: Record<CapUnit, string> = {
  pF: 'Picofarads (pF)',
  nF: 'Nanofarads (nF)',
  'µF': 'Microfarads (µF)',
};

/** ASCII test-id per unit (avoid the µ glyph in attribute selectors). */
const UNIT_TESTID: Record<CapUnit, string> = { pF: 'cap-pf', nF: 'cap-nf', 'µF': 'cap-uf' };

/**
 * Capacitor unit cheatsheet: enter a value in any of pF / nF / µF and the other
 * two convert live. SMD caps are unmarked, so this is a plain unit converter,
 * not a code decoder.
 */
export function CapacitorTool() {
  // Canonical value is held in picofarads. `editing` tracks which field the user
  // is typing in so its raw text shows verbatim while the others show the
  // derived value (otherwise reformatting would fight the cursor).
  const [pF, setPf] = useState<number>(100_000); // 100 nF default
  const [editing, setEditing] = useState<CapUnit>('nF');
  const [rawInput, setRawInput] = useState<string>('100');

  const onEdit = (unit: CapUnit, s: string): void => {
    setEditing(unit);
    setRawInput(s);
    const n = parseFloat(s);
    setPf(Number.isFinite(n) ? n * CAP_UNIT_TO_PF[unit] : NaN);
  };

  const fieldValue = (unit: CapUnit): string =>
    editing === unit ? rawInput : formatCapValue(pF / CAP_UNIT_TO_PF[unit]);

  return (
    <div className="cap-converter">
      <div className="cap-converter-hint">Enter a value in any unit — the others convert live.</div>
      {CAP_UNITS.map(unit => (
        <label key={unit} className="cap-field">
          <span className="cap-field-label">{UNIT_LABEL[unit]}</span>
          <input
            className="code-input cap-field-input"
            data-testid={UNIT_TESTID[unit]}
            inputMode="decimal"
            value={fieldValue(unit)}
            onChange={e => onEdit(unit, e.target.value)}
          />
        </label>
      ))}
      <div className="cap-cheatsheet">1 µF = 1000 nF = 1 000 000 pF</div>
    </div>
  );
}
