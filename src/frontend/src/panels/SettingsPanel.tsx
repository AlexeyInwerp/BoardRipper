import { useState, useCallback, useRef, useMemo } from 'react';
import { renderSettingsStore } from '../store/render-settings';
import type { RenderSettings, LabelSize, NetColorRule } from '../store/render-settings';
import { SettingsMockup } from './SettingsMockup';

// ---- Draft helpers ----
// All edits go to a local draft. The real store is only touched on Apply/Preview.

type DraftUpdater = (partial: Partial<RenderSettings>) => void;
type RuleUpdater = {
  add: (pattern: string, color: string) => void;
  update: (id: string, updates: Partial<NetColorRule>) => void;
  remove: (id: string) => void;
};

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  field: keyof RenderSettings;
  onUpdate: DraftUpdater;
}

function Slider({ label, value, min, max, step, field, onUpdate }: SliderProps) {
  return (
    <div className="settings-row">
      <label className="settings-label">
        {label}
        <span className="settings-value">{Number(value.toFixed(2))}</span>
      </label>
      <input
        type="range"
        className="settings-slider"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onUpdate({ [field]: parseFloat(e.target.value) })}
      />
    </div>
  );
}

interface ToggleProps {
  label: string;
  value: boolean;
  field: keyof RenderSettings;
  onUpdate: DraftUpdater;
}

function Toggle({ label, value, field, onUpdate }: ToggleProps) {
  return (
    <div className="settings-row settings-toggle-row">
      <label className="settings-label">{label}</label>
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onUpdate({ [field]: e.target.checked })}
      />
    </div>
  );
}

function LabelSizeSelector({ draft, onUpdate }: { draft: RenderSettings; onUpdate: DraftUpdater }) {
  const sizes: LabelSize[] = ['small', 'medium', 'large'];
  const fields: Record<LabelSize, keyof RenderSettings> = {
    small: 'labelSizeSmall',
    medium: 'labelSizeMedium',
    large: 'labelSizeLarge',
  };
  return (
    <>
      <div className="settings-row">
        <label className="settings-label">Active Size</label>
        <div className="settings-btn-group">
          {sizes.map((size) => (
            <button
              key={size}
              className={`settings-btn-option ${draft.labelSize === size ? 'active' : ''}`}
              onClick={() => onUpdate({ labelSize: size })}
            >
              {size[0].toUpperCase() + size.slice(1)}
            </button>
          ))}
        </div>
      </div>
      {sizes.map((size) => (
        <Slider
          key={size}
          label={`${size[0].toUpperCase() + size.slice(1)} Size`}
          value={draft[fields[size]] as number}
          min={1}
          max={30}
          step={1}
          field={fields[size]}
          onUpdate={onUpdate}
        />
      ))}
    </>
  );
}

function NetColorRuleRow({ rule, rules: ruleActions }: { rule: NetColorRule; rules: RuleUpdater }) {
  return (
    <div className="color-rule-row">
      <input
        type="checkbox"
        checked={rule.enabled}
        onChange={(e) => ruleActions.update(rule.id, { enabled: e.target.checked })}
        title="Enable/disable"
      />
      <input
        type="text"
        className="color-rule-pattern"
        value={rule.pattern}
        onChange={(e) => ruleActions.update(rule.id, { pattern: e.target.value })}
        placeholder="Keyword"
      />
      <input
        type="color"
        className="color-rule-color"
        value={rule.color}
        onChange={(e) => ruleActions.update(rule.id, { color: e.target.value })}
      />
      <button
        className="color-rule-remove"
        onClick={() => ruleActions.remove(rule.id)}
        title="Remove rule"
      >
        ×
      </button>
    </div>
  );
}

function NetColorRulesSection({ rules, ruleActions }: { rules: NetColorRule[]; ruleActions: RuleUpdater }) {
  const [newPattern, setNewPattern] = useState('');
  const [newColor, setNewColor] = useState('#ff6600');

  const addRule = () => {
    const trimmed = newPattern.trim();
    if (!trimmed) return;
    ruleActions.add(trimmed, newColor);
    setNewPattern('');
  };

  return (
    <div className="settings-section">
      <h4 className="settings-section-title">Pin Colors by Net</h4>
      <div className="color-rules-list">
        {rules.map((rule) => (
          <NetColorRuleRow key={rule.id} rule={rule} rules={ruleActions} />
        ))}
      </div>
      <div className="color-rule-add">
        <input
          type="text"
          className="color-rule-pattern"
          value={newPattern}
          onChange={(e) => setNewPattern(e.target.value)}
          placeholder="Keyword (e.g. SDA)"
          onKeyDown={(e) => { if (e.key === 'Enter') addRule(); }}
        />
        <input
          type="color"
          className="color-rule-color"
          value={newColor}
          onChange={(e) => setNewColor(e.target.value)}
        />
        <button className="color-rule-add-btn" onClick={addRule}>+</button>
      </div>
      <div className="color-rule-hint">
        First matching rule wins. Case-insensitive substring match.
      </div>
    </div>
  );
}

export function SettingsPanel() {
  // Snapshot of settings when panel mounts (for Cancel)
  const baselineRef = useRef<RenderSettings>(renderSettingsStore.snapshot());
  const [draft, setDraft] = useState<RenderSettings>(() => renderSettingsStore.snapshot());
  const [previewing, setPreviewing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const previewingRef = useRef(previewing);
  previewingRef.current = previewing;

  const updateDraft: DraftUpdater = useCallback((partial) => {
    setDraft(prev => {
      const next = { ...prev, ...partial };
      if (previewingRef.current) renderSettingsStore.applySettings(next);
      return next;
    });
    setDirty(true);
  }, []);

  const ruleActions: RuleUpdater = useMemo(() => ({
    add(pattern, color) {
      setDraft(prev => {
        const next = {
          ...prev,
          netColorRules: [...prev.netColorRules, { id: `rule_${Date.now()}`, pattern, color, enabled: true }],
        };
        if (previewingRef.current) renderSettingsStore.applySettings(next);
        return next;
      });
      setDirty(true);
    },
    update(id, updates) {
      setDraft(prev => {
        const next = {
          ...prev,
          netColorRules: prev.netColorRules.map(r => r.id === id ? { ...r, ...updates } : r),
        };
        if (previewingRef.current) renderSettingsStore.applySettings(next);
        return next;
      });
      setDirty(true);
    },
    remove(id) {
      setDraft(prev => {
        const next = {
          ...prev,
          netColorRules: prev.netColorRules.filter(r => r.id !== id),
        };
        if (previewingRef.current) renderSettingsStore.applySettings(next);
        return next;
      });
      setDirty(true);
    },
  }), []);

  const handleApply = () => {
    renderSettingsStore.applySettings(draft);
    baselineRef.current = structuredClone(draft);
    setDirty(false);
    setPreviewing(false);
  };

  const handleCancel = () => {
    renderSettingsStore.applySettings(baselineRef.current);
    setDraft(structuredClone(baselineRef.current));
    setDirty(false);
    setPreviewing(false);
  };

  const handlePreview = () => {
    if (previewing) {
      // Turn off preview — revert to baseline
      renderSettingsStore.applySettings(baselineRef.current);
      setPreviewing(false);
    } else {
      // Turn on preview — apply draft to live board
      renderSettingsStore.applySettings(draft);
      setPreviewing(true);
    }
  };

  const handleReset = () => {
    const defaults = renderSettingsStore.defaults;
    setDraft(defaults);
    setDirty(true);
    if (previewing) {
      renderSettingsStore.applySettings(defaults);
    }
  };

  return (
    <div className="panel-content settings-panel" data-testid="settings-panel">
      <SettingsMockup settings={draft} />

      <div className="settings-actions">
        <button
          className={`settings-action-btn ${previewing ? 'active' : ''}`}
          onClick={handlePreview}
          disabled={!dirty}
          title={previewing ? 'Stop preview, revert board to saved' : 'Preview changes on the board'}
        >
          {previewing ? 'Stop Preview' : 'Preview'}
        </button>
        <button
          className="settings-action-btn settings-apply-btn"
          onClick={handleApply}
          disabled={!dirty}
        >
          Apply
        </button>
        <button
          className="settings-action-btn"
          onClick={handleCancel}
          disabled={!dirty}
        >
          Cancel
        </button>
      </div>

      <div className="settings-section">
        <h4 className="settings-section-title">Outline</h4>
        <Slider label="Width" value={draft.outlineWidth} min={0.5} max={20} step={0.5} field="outlineWidth" onUpdate={updateDraft} />
        <Slider label="Opacity" value={draft.outlineAlpha} min={0} max={1} step={0.05} field="outlineAlpha" onUpdate={updateDraft} />
      </div>

      <div className="settings-section">
        <h4 className="settings-section-title">Parts</h4>
        <Slider label="Border Width" value={draft.partBorderWidth} min={0.1} max={10} step={0.1} field="partBorderWidth" onUpdate={updateDraft} />
        <Slider label="Border Opacity" value={draft.partBorderAlpha} min={0} max={1} step={0.05} field="partBorderAlpha" onUpdate={updateDraft} />
        <Slider label="Padding" value={draft.partPadding} min={0} max={30} step={1} field="partPadding" onUpdate={updateDraft} />
        <Toggle label="Show Labels" value={draft.showPartLabels} field="showPartLabels" onUpdate={updateDraft} />
        <Slider label="Label Hide Threshold" value={draft.labelHideThreshold} min={0} max={10} step={0.5} field="labelHideThreshold" onUpdate={updateDraft} />
        <LabelSizeSelector draft={draft} onUpdate={updateDraft} />
      </div>

      <div className="settings-section">
        <h4 className="settings-section-title">Pins</h4>
        <Slider label="Min Radius" value={draft.pinMinRadius} min={1} max={20} step={0.5} field="pinMinRadius" onUpdate={updateDraft} />
        <Slider label="Max Radius" value={draft.pinMaxRadius} min={5} max={100} step={1} field="pinMaxRadius" onUpdate={updateDraft} />
        <Slider label="Scale Factor" value={draft.pinScaleFactor} min={0} max={3} step={0.1} field="pinScaleFactor" onUpdate={updateDraft} />
        <Slider label="Opacity" value={draft.pinAlpha} min={0} max={1} step={0.05} field="pinAlpha" onUpdate={updateDraft} />
      </div>

      <NetColorRulesSection rules={draft.netColorRules} ruleActions={ruleActions} />

      <div className="settings-section">
        <h4 className="settings-section-title">Selection</h4>
        <Slider label="Border Width" value={draft.selectionWidth} min={0.5} max={10} step={0.5} field="selectionWidth" onUpdate={updateDraft} />
        <Slider label="Padding" value={draft.selectionPadding} min={0} max={30} step={1} field="selectionPadding" onUpdate={updateDraft} />
        <Slider label="Net Highlight Grow" value={draft.netHighlightGrow} min={0} max={20} step={0.5} field="netHighlightGrow" onUpdate={updateDraft} />
        <Slider label="Net Highlight Opacity" value={draft.netHighlightAlpha} min={0} max={1} step={0.05} field="netHighlightAlpha" onUpdate={updateDraft} />
      </div>

      <div className="settings-section">
        <h4 className="settings-section-title">Interaction</h4>
        <Slider label="Click Threshold" value={draft.clickThreshold} min={5} max={100} step={5} field="clickThreshold" onUpdate={updateDraft} />
        <Slider label="Fit Padding" value={draft.fitPadding} min={0} max={200} step={10} field="fitPadding" onUpdate={updateDraft} />
      </div>

      <button className="settings-reset-btn" onClick={handleReset}>
        Reset to Defaults
      </button>
    </div>
  );
}
