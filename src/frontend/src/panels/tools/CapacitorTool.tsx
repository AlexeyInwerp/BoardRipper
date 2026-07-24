import { useState } from 'react';
import { decodeCapacitor } from '../../tools/capacitor';
import { trimNum } from '../../tools/format';

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
                {trimNum(r.pF)} pF · {trimNum(r.nF)} nF · {trimNum(r.uF)} µF
                {r.tolerancePct !== undefined ? ` · ±${r.tolerancePct}%` : ''}
              </div>
            </>
          )}
      </div>
    </div>
  );
}

