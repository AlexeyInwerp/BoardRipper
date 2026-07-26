import { useState } from 'react';
import { decodeResistorColor, type BandColor } from '../../tools/resistor-color';

const DIGIT_COLORS: BandColor[] = ['black','brown','red','orange','yellow','green','blue','violet','grey','white'];
const MULT_COLORS: BandColor[] = [...DIGIT_COLORS, 'gold', 'silver'];
const TOL_COLORS: BandColor[] = ['brown','red','green','blue','violet','grey','gold','silver','none'];
const TC_COLORS: BandColor[] = ['brown','red','orange','yellow','blue','violet'];

const SWATCH: Record<BandColor, string> = {
  black:'#000', brown:'#8b4513', red:'#f00', orange:'#ff8c00', yellow:'#ffd700',
  green:'#008000', blue:'#00f', violet:'#8a2be2', grey:'#808080', white:'#fff',
  gold:'#d4af37', silver:'#c0c0c0', none:'transparent',
};

type BandCount = 4 | 5 | 6;

/** Column definitions per band position for a given band count. */
function columns(count: BandCount): { label: string; colors: BandColor[] }[] {
  const digits = count === 4 ? 2 : 3;
  const cols: { label: string; colors: BandColor[] }[] = [];
  for (let i = 0; i < digits; i++) cols.push({ label: `d${i + 1}`, colors: DIGIT_COLORS });
  cols.push({ label: '×', colors: MULT_COLORS });
  cols.push({ label: 'tol', colors: TOL_COLORS });
  if (count === 6) cols.push({ label: 'tc', colors: TC_COLORS });
  return cols;
}

const DEFAULTS: Record<BandCount, BandColor[]> = {
  4: ['brown', 'black', 'red', 'gold'],
  5: ['brown', 'black', 'black', 'red', 'brown'],
  6: ['brown', 'black', 'black', 'red', 'brown', 'red'],
};

export function ResistorColorTool() {
  const [count, setCount] = useState<BandCount>(4);
  const [bands, setBands] = useState<BandColor[]>(DEFAULTS[4]);

  const setCountAndReset = (c: BandCount) => { setCount(c); setBands(DEFAULTS[c]); };
  const setBand = (i: number, color: BandColor) => {
    setBands(prev => prev.map((b, j) => (j === i ? color : b)));
  };

  const result = decodeResistorColor(bands);
  const cols = columns(count);

  return (
    <div className="rc-tool">
      <div className="rc-count">
        {([4, 5, 6] as BandCount[]).map(c => (
          <button
            key={c}
            className={`rc-count-btn${count === c ? ' active' : ''}`}
            onClick={() => setCountAndReset(c)}
          >{c}-band</button>
        ))}
      </div>
      <div className="rc-bands">
        {cols.map((col, i) => (
          <div key={i} className="rc-band">
            <div className="rc-swatch" style={{ background: SWATCH[bands[i]] }} />
            <select
              value={bands[i]}
              data-testid={`rc-band-${i}`}
              onChange={e => setBand(i, e.target.value as BandColor)}
            >
              {col.colors.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        ))}
      </div>
      <div className="rc-readout" data-testid="rc-readout">
        {result.error
          ? <span className="rc-error">{result.error}</span>
          : (
            <>
              <div className="rc-value">{result.formatted}</div>
              <div className="rc-sub">
                ±{result.tolerancePct}%
                {result.tempCoPpm !== undefined ? ` · ${result.tempCoPpm} ppm/K` : ''}
              </div>
            </>
          )}
      </div>
    </div>
  );
}
