import { useState, useCallback, useRef, useMemo } from 'react';
import { renderSettingsStore } from '../store/render-settings';
import type { RenderSettings, LabelSize, NetColorRule } from '../store/render-settings';
import { SettingsMockup } from './SettingsMockup';
import type { MockupSectionId } from './SettingsMockup';

type SectionId = MockupSectionId | 'interaction';

type DraftUpdater = (partial: Partial<RenderSettings>) => void;
type RuleUpdater = {
  add: (pattern: string, color: string) => void;
  update: (id: string, updates: Partial<NetColorRule>) => void;
  remove: (id: string) => void;
};

// ---- Collapsible section ----

function CollapsibleSection({
  id, title, children, isOpen, onToggle, sectionRef, isFocused,
}: {
  id: SectionId;
  title: string;
  children: React.ReactNode;
  isOpen: boolean;
  onToggle: (id: SectionId) => void;
  sectionRef: React.RefObject<HTMLDivElement>;
  isFocused: boolean;
}) {
  return (
    <div
      ref={sectionRef}
      className={`settings-section${isFocused ? ' settings-section-focused' : ''}`}
    >
      <button className="settings-section-header" onClick={() => onToggle(id)}>
        <span className="settings-section-title">{title}</span>
        <span className="settings-section-chevron">{isOpen ? '▾' : '▸'}</span>
      </button>
      {isOpen && <div className="settings-section-body">{children}</div>}
    </div>
  );
}

// ---- Primitive controls ----

interface SliderProps {
  label: string; value: number; min: number; max: number; step: number;
  field: keyof RenderSettings; onUpdate: DraftUpdater;
}

function Slider({ label, value, min, max, step, field, onUpdate }: SliderProps) {
  return (
    <div className="settings-row">
      <label className="settings-label">
        {label}
        <span className="settings-value">{Number(value.toFixed(2))}</span>
      </label>
      <input
        type="range" className="settings-slider"
        min={min} max={max} step={step} value={value}
        onChange={(e) => onUpdate({ [field]: parseFloat(e.target.value) })}
      />
    </div>
  );
}

interface ToggleProps {
  label: string; value: boolean; field: keyof RenderSettings; onUpdate: DraftUpdater;
}

function Toggle({ label, value, field, onUpdate }: ToggleProps) {
  return (
    <div className="settings-row settings-toggle-row">
      <label className="settings-label">{label}</label>
      <input type="checkbox" checked={value} onChange={(e) => onUpdate({ [field]: e.target.checked })} />
    </div>
  );
}

function LabelSizeSelector({ draft, onUpdate }: { draft: RenderSettings; onUpdate: DraftUpdater }) {
  const sizes: LabelSize[] = ['small', 'medium', 'large'];
  const fields: Record<LabelSize, keyof RenderSettings> = {
    small: 'labelSizeSmall', medium: 'labelSizeMedium', large: 'labelSizeLarge',
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
          min={1} max={30} step={1}
          field={fields[size]} onUpdate={onUpdate}
        />
      ))}
    </>
  );
}

// ---- Net color rules ----

function NetColorRuleRow({ rule, rules: ruleActions }: { rule: NetColorRule; rules: RuleUpdater }) {
  return (
    <div className="color-rule-row">
      <input
        type="checkbox" checked={rule.enabled}
        onChange={(e) => ruleActions.update(rule.id, { enabled: e.target.checked })}
        title="Enable/disable"
      />
      <input
        type="text" className="color-rule-pattern" value={rule.pattern}
        onChange={(e) => ruleActions.update(rule.id, { pattern: e.target.value })}
        placeholder="Keyword"
      />
      <input
        type="color" className="color-rule-color" value={rule.color}
        onChange={(e) => ruleActions.update(rule.id, { color: e.target.value })}
      />
      <button className="color-rule-remove" onClick={() => ruleActions.remove(rule.id)} title="Remove rule">×</button>
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
    <>
      <div className="color-rules-list">
        {rules.map((rule) => <NetColorRuleRow key={rule.id} rule={rule} rules={ruleActions} />)}
      </div>
      <div className="color-rule-add">
        <input
          type="text" className="color-rule-pattern" value={newPattern}
          onChange={(e) => setNewPattern(e.target.value)}
          placeholder="Keyword (e.g. SDA)"
          onKeyDown={(e) => { if (e.key === 'Enter') addRule(); }}
        />
        <input type="color" className="color-rule-color" value={newColor} onChange={(e) => setNewColor(e.target.value)} />
        <button className="color-rule-add-btn" onClick={addRule}>+</button>
      </div>
      <div className="color-rule-hint">First matching rule wins. Case-insensitive substring match.</div>
    </>
  );
}

// ---- Main panel ----

const ALL_SECTIONS: SectionId[] = ['outline', 'parts', 'pins', 'netColors', 'selection', 'interaction'];

export function SettingsPanel() {
  const baselineRef = useRef<RenderSettings>(renderSettingsStore.snapshot());
  const [draft, setDraft] = useState<RenderSettings>(() => renderSettingsStore.snapshot());
  const [previewing, setPreviewing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const previewingRef = useRef(previewing);
  previewingRef.current = previewing;

  // Collapsible sections
  const [openSections, setOpenSections] = useState<Set<SectionId>>(new Set(ALL_SECTIONS));
  const [focusedSection, setFocusedSection] = useState<SectionId | null>(null);
  const focusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Section scroll refs
  const outlineRef = useRef<HTMLDivElement>(null);
  const partsRef = useRef<HTMLDivElement>(null);
  const pinsRef = useRef<HTMLDivElement>(null);
  const netColorsRef = useRef<HTMLDivElement>(null);
  const selectionRef = useRef<HTMLDivElement>(null);
  const interactionRef = useRef<HTMLDivElement>(null);

  const sectionRefsMapRef = useRef<Record<SectionId, React.RefObject<HTMLDivElement>>>({
    outline: outlineRef, parts: partsRef, pins: pinsRef,
    netColors: netColorsRef, selection: selectionRef, interaction: interactionRef,
  });
  // keep in sync each render
  sectionRefsMapRef.current = {
    outline: outlineRef, parts: partsRef, pins: pinsRef,
    netColors: netColorsRef, selection: selectionRef, interaction: interactionRef,
  };

  const toggleSection = useCallback((id: SectionId) => {
    setOpenSections(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const focusSection = useCallback((id: SectionId) => {
    setOpenSections(prev => { const next = new Set(prev); next.add(id); return next; });
    requestAnimationFrame(() => {
      sectionRefsMapRef.current[id]?.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    if (focusTimerRef.current) clearTimeout(focusTimerRef.current);
    setFocusedSection(id);
    focusTimerRef.current = setTimeout(() => setFocusedSection(null), 1400);
  }, []);

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
        const next = { ...prev, netColorRules: [...prev.netColorRules, { id: `rule_${Date.now()}`, pattern, color, enabled: true }] };
        if (previewingRef.current) renderSettingsStore.applySettings(next);
        return next;
      });
      setDirty(true);
    },
    update(id, updates) {
      setDraft(prev => {
        const next = { ...prev, netColorRules: prev.netColorRules.map(r => r.id === id ? { ...r, ...updates } : r) };
        if (previewingRef.current) renderSettingsStore.applySettings(next);
        return next;
      });
      setDirty(true);
    },
    remove(id) {
      setDraft(prev => {
        const next = { ...prev, netColorRules: prev.netColorRules.filter(r => r.id !== id) };
        if (previewingRef.current) renderSettingsStore.applySettings(next);
        return next;
      });
      setDirty(true);
    },
  }), []);

  const handleApply = () => {
    renderSettingsStore.applySettings(draft);
    baselineRef.current = structuredClone(draft);
    setDirty(false); setPreviewing(false);
  };
  const handleCancel = () => {
    renderSettingsStore.applySettings(baselineRef.current);
    setDraft(structuredClone(baselineRef.current));
    setDirty(false); setPreviewing(false);
  };
  const handlePreview = () => {
    if (previewing) {
      renderSettingsStore.applySettings(baselineRef.current);
      setPreviewing(false);
    } else {
      renderSettingsStore.applySettings(draft);
      setPreviewing(true);
    }
  };
  const handleReset = () => {
    const defaults = renderSettingsStore.defaults;
    setDraft(defaults);
    setDirty(true);
    if (previewing) renderSettingsStore.applySettings(defaults);
  };

  const panelRef = useRef<HTMLDivElement>(null);

  return (
    <div className="panel-content settings-panel" data-testid="settings-panel" ref={panelRef}>
      <SettingsMockup settings={draft} onElementClick={focusSection} />

      <div className="settings-actions">
        <button
          className={`settings-action-btn ${previewing ? 'active' : ''}`}
          onClick={handlePreview} disabled={!dirty}
          title={previewing ? 'Stop preview, revert board to saved' : 'Preview changes on the board'}
        >
          {previewing ? 'Stop Preview' : 'Preview'}
        </button>
        <button className="settings-action-btn settings-apply-btn" onClick={handleApply} disabled={!dirty}>Apply</button>
        <button className="settings-action-btn" onClick={handleCancel} disabled={!dirty}>Cancel</button>
      </div>

      <CollapsibleSection id="outline" title="Outline" isOpen={openSections.has('outline')}
        onToggle={toggleSection} sectionRef={outlineRef} isFocused={focusedSection === 'outline'}>
        <Slider label="Width" value={draft.outlineWidth} min={0.5} max={20} step={0.5} field="outlineWidth" onUpdate={updateDraft} />
        <Slider label="Opacity" value={draft.outlineAlpha} min={0} max={1} step={0.05} field="outlineAlpha" onUpdate={updateDraft} />
        <Slider label="Board Fill" value={draft.boardFillAlpha} min={0} max={0.5} step={0.01} field="boardFillAlpha" onUpdate={updateDraft} />
      </CollapsibleSection>

      <CollapsibleSection id="parts" title="Parts" isOpen={openSections.has('parts')}
        onToggle={toggleSection} sectionRef={partsRef} isFocused={focusedSection === 'parts'}>
        <Slider label="Border Width" value={draft.partBorderWidth} min={0.1} max={10} step={0.1} field="partBorderWidth" onUpdate={updateDraft} />
        <Slider label="Border Opacity" value={draft.partBorderAlpha} min={0} max={1} step={0.05} field="partBorderAlpha" onUpdate={updateDraft} />
        <Slider label="Padding" value={draft.partPadding} min={0} max={30} step={1} field="partPadding" onUpdate={updateDraft} />
        <Toggle label="Show Labels" value={draft.showPartLabels} field="showPartLabels" onUpdate={updateDraft} />
        <Slider label="Label Hide Threshold" value={draft.labelHideThreshold} min={0} max={10} step={0.5} field="labelHideThreshold" onUpdate={updateDraft} />
        <LabelSizeSelector draft={draft} onUpdate={updateDraft} />
      </CollapsibleSection>

      <CollapsibleSection id="pins" title="Pins / Pads" isOpen={openSections.has('pins')}
        onToggle={toggleSection} sectionRef={pinsRef} isFocused={focusedSection === 'pins'}>
        <Slider label="Min Radius" value={draft.pinMinRadius} min={1} max={20} step={0.5} field="pinMinRadius" onUpdate={updateDraft} />
        <Slider label="Max Radius" value={draft.pinMaxRadius} min={5} max={100} step={1} field="pinMaxRadius" onUpdate={updateDraft} />
        <Slider label="Scale Factor" value={draft.pinScaleFactor} min={0} max={3} step={0.1} field="pinScaleFactor" onUpdate={updateDraft} />
        <Slider label="Opacity" value={draft.pinAlpha} min={0} max={1} step={0.05} field="pinAlpha" onUpdate={updateDraft} />
      </CollapsibleSection>

      <CollapsibleSection id="netColors" title="Pin Colors by Net" isOpen={openSections.has('netColors')}
        onToggle={toggleSection} sectionRef={netColorsRef} isFocused={focusedSection === 'netColors'}>
        <NetColorRulesSection rules={draft.netColorRules} ruleActions={ruleActions} />
      </CollapsibleSection>

      <CollapsibleSection id="selection" title="Selection" isOpen={openSections.has('selection')}
        onToggle={toggleSection} sectionRef={selectionRef} isFocused={focusedSection === 'selection'}>
        <Slider label="Border Width" value={draft.selectionWidth} min={0.5} max={10} step={0.5} field="selectionWidth" onUpdate={updateDraft} />
        <Slider label="Fill Brightness" value={draft.selectionFillAlpha} min={0} max={0.5} step={0.01} field="selectionFillAlpha" onUpdate={updateDraft} />
        <Slider label="Padding" value={draft.selectionPadding} min={0} max={30} step={1} field="selectionPadding" onUpdate={updateDraft} />
        <Slider label="Net Highlight Grow" value={draft.netHighlightGrow} min={0} max={20} step={0.5} field="netHighlightGrow" onUpdate={updateDraft} />
        <Slider label="Net Highlight Opacity" value={draft.netHighlightAlpha} min={0} max={1} step={0.05} field="netHighlightAlpha" onUpdate={updateDraft} />
      </CollapsibleSection>

      <CollapsibleSection id="interaction" title="Interaction" isOpen={openSections.has('interaction')}
        onToggle={toggleSection} sectionRef={interactionRef} isFocused={focusedSection === 'interaction'}>
        <Slider label="Click Threshold" value={draft.clickThreshold} min={5} max={100} step={5} field="clickThreshold" onUpdate={updateDraft} />
        <Slider label="Fit Padding" value={draft.fitPadding} min={0} max={200} step={10} field="fitPadding" onUpdate={updateDraft} />
      </CollapsibleSection>

      <button className="settings-reset-btn" onClick={handleReset}>Reset to Defaults</button>
    </div>
  );
}
