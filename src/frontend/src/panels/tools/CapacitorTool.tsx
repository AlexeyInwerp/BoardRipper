import { useState } from 'react';
import { decodeCapacitor } from '../../tools/capacitor';

export function CapacitorTool() {
  const [code, setCode] = useState('104');
  const r = decodeCapacitor(code);
  return (
    <div className="code-tool">
      <input
        className="code-input"
        data-testid="cap-input"
        value={code}
        placeholder="e.g. 104, 4n7, 22p"
        onChange={e => setCode(e.target.value)}
      />
      <div className="code-readout" data-testid="cap-readout">
        {r.error
          ? <span className="rc-error">{r.error}</span>
          : (
            <>
              <div className="rc-value">{r.formatted}</div>
              <div className="rc-sub">
                {trim(r.pF)} pF · {trim(r.nF)} nF · {trim(r.uF)} µF
                {r.tolerancePct !== undefined ? ` · ±${r.tolerancePct}%` : ''}
              </div>
            </>
          )}
      </div>
    </div>
  );
}

function trim(v: number): string {
  return v.toFixed(3).replace(/\.?0+$/, '');
}
