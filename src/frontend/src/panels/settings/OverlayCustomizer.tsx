import { renderSettingsStore } from '../../store/render-settings';
import { useRenderSettings } from '../../hooks/useRenderSettings';

const ON_SELECT_MODES = [
  { v: 'highlight'      as const, label: 'Just highlight' },
  { v: 'panIfOffscreen' as const, label: 'Pan if off-screen' },
  { v: 'panZoomFit'     as const, label: 'Pan & zoom to fit' },
];

export function OverlayCustomizer() {
  const s = useRenderSettings();

  return (
    <div className="overlay-customizer">
      {/* Customizer DnD lands in Task 15 — placeholder marker for now */}
      <div className="overlay-customizer-placeholder" data-testid="overlay-customizer-dnd-placeholder">
        Drag-and-drop customizer (coming next task)
      </div>

      <div className="settings-row">
        <label>
          <input
            type="checkbox"
            checked={s.showSelectionOverlay}
            onChange={e => renderSettingsStore.setShowSelectionOverlay(e.target.checked)}
          />
          {' '}Show selected component name below overlay
        </label>
      </div>

      <div className="settings-subsection-label">When you pick a part</div>
      <div className="settings-row" role="radiogroup" aria-label="On-select behavior for parts">
        {ON_SELECT_MODES.map(m => (
          <label key={m.v} style={{ marginRight: 12 }}>
            <input
              type="radio"
              name="overlay-parts-on-select"
              checked={s.overlayPartsOnSelect === m.v}
              onChange={() => renderSettingsStore.setOverlayPartsOnSelect(m.v)}
            />
            {' '}{m.label}
          </label>
        ))}
      </div>

      <div className="settings-subsection-label">When you pick a net</div>
      <div className="settings-row" role="radiogroup" aria-label="On-select behavior for nets">
        {ON_SELECT_MODES.map(m => (
          <label key={m.v} style={{ marginRight: 12 }}>
            <input
              type="radio"
              name="overlay-nets-on-select"
              checked={s.overlayNetsOnSelect === m.v}
              onChange={() => renderSettingsStore.setOverlayNetsOnSelect(m.v)}
            />
            {' '}{m.label}
          </label>
        ))}
      </div>

      <button
        className="settings-reset-btn"
        onClick={() => renderSettingsStore.resetOverlayDefaults()}
        data-testid="overlay-reset-btn"
      >
        &#x21BA; Reset to defaults
      </button>
    </div>
  );
}
