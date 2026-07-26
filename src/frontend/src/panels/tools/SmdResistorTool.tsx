import { useState } from 'react';
import { decodeSmdResistor } from '../../tools/smd-resistor';

export function SmdResistorTool() {
  const [code, setCode] = useState('103');
  const result = decodeSmdResistor(code);
  return (
    <div className="code-tool">
      <input
        className="code-input"
        data-testid="smd-input"
        value={code}
        placeholder="e.g. 103, 4R7, 01C"
        onChange={e => setCode(e.target.value)}
      />
      <div className="code-readout" data-testid="smd-readout">
        {result.error
          ? <span className="rc-error">{result.error}</span>
          : <div className="rc-value">{result.formatted}</div>}
      </div>
    </div>
  );
}
