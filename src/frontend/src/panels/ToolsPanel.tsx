import { useState } from 'react';
import { useDatabank } from '../hooks/useDatabank';
import { ensureDatabaseEditorPanel } from '../store/dockview-api';
import { ResistorColorTool } from './tools/ResistorColorTool';
import { SmdResistorTool } from './tools/SmdResistorTool';
import { CapacitorTool } from './tools/CapacitorTool';

type ToolId = 'resistor' | 'smd' | 'capacitor' | 'worklists';

const CALCULATORS: { id: ToolId; name: string; hint: string }[] = [
  { id: 'resistor', name: 'Resistor color-band', hint: '4 / 5 / 6-band to ohms' },
  { id: 'smd', name: 'SMD resistor code', hint: '103, 4R7, 01C to ohms' },
  { id: 'capacitor', name: 'Capacitor converter', hint: '104 to pF / nF / µF' },
];

/** Title shown in the back link for tools that are not calculators. */
const TOOL_TITLES: Record<ToolId, string> = {
  resistor: 'Resistor color-band',
  smd: 'SMD resistor code',
  capacitor: 'Capacitor converter',
  worklists: 'Worklists',
};

export function ToolsPanel() {
  const [activeTool, setActiveTool] = useState<ToolId | null>(null);
  const { backendAvailable } = useDatabank();

  if (activeTool) {
    return (
      <div className="tools-panel" data-testid="tools-panel">
        <button
          className="tools-back"
          data-testid="tools-back"
          onClick={() => setActiveTool(null)}
        >
          ← Tools / {TOOL_TITLES[activeTool]}
        </button>
        <div className="tools-tool-body">
          {activeTool === 'resistor' && <ResistorColorTool />}
          {activeTool === 'smd' && <SmdResistorTool />}
          {activeTool === 'capacitor' && <CapacitorTool />}
        </div>
      </div>
    );
  }

  return (
    <div className="tools-panel" data-testid="tools-panel">
      <div className="tools-group-label">Calculators</div>
      {CALCULATORS.map(c => (
        <button
          key={c.id}
          className="tools-entry"
          data-testid={`tools-entry-${c.id}`}
          onClick={() => setActiveTool(c.id)}
        >
          <span className="tools-entry-text">
            {c.name}
            <small>{c.hint}</small>
          </span>
        </button>
      ))}

      <div className="tools-group-label">Workbench</div>
      <button
        className="tools-entry"
        data-testid="tools-entry-worklists"
        onClick={() => setActiveTool('worklists')}
      >
        <span className="tools-entry-text">
          Worklists
          <small>every worklist stored on this device</small>
        </span>
      </button>
      {backendAvailable && (
        <button
          className="tools-entry"
          data-testid="tools-entry-dbeditor"
          onClick={ensureDatabaseEditorPanel}
        >
          <span className="tools-entry-text">Database Editor</span>
          <span className="tools-entry-status">opens panel</span>
        </button>
      )}
      <div className="tools-entry tools-entry-soon" aria-disabled="true">
        <span className="tools-entry-text">Wiki</span>
        <span className="tools-entry-status">soon</span>
      </div>
    </div>
  );
}
