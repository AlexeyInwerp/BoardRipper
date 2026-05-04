import { renderSettingsStore, DEFAULTS } from '../../store/render-settings';
import { useRenderSettings } from '../../hooks/useRenderSettings';

const ON_SELECT_MODES = [
  { v: 'highlight'      as const, label: 'Just highlight' },
  { v: 'panIfOffscreen' as const, label: 'Pan if off-screen' },
  { v: 'panZoomFit'     as const, label: 'Pan & zoom to fit' },
];

export function OverlayCustomizer() {
  const s = useRenderSettings();

  // Defensive defaults — guard against missing fields from stale localStorage
  const showSelectionOverlay = s.showSelectionOverlay ?? DEFAULTS.showSelectionOverlay;
  const overlayPartsOnSelect = s.overlayPartsOnSelect ?? DEFAULTS.overlayPartsOnSelect;
  const overlayNetsOnSelect  = s.overlayNetsOnSelect  ?? DEFAULTS.overlayNetsOnSelect;
  const overlayPosition      = s.overlayPosition      ?? DEFAULTS.overlayPosition;
  const searchAutoDim        = s.searchAutoDim        ?? DEFAULTS.searchAutoDim;

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
            checked={showSelectionOverlay}
            onChange={e => { try { renderSettingsStore.setShowSelectionOverlay(e.target.checked); } catch { /* ignore */ } }}
          />
          {' '}Show selected component name below overlay
        </label>
      </div>

      <div className="settings-subsection-label">Overlay row position</div>
      <div className="settings-row" role="radiogroup" aria-label="Overlay row position">
        {(['left', 'center'] as const).map(pos => (
          <label key={pos} style={{ marginRight: 12 }}>
            <input
              type="radio"
              name="overlay-position"
              checked={overlayPosition === pos}
              onChange={() => { try { renderSettingsStore.setOverlayPosition(pos); } catch { /* ignore */ } }}
            />
            {' '}{pos === 'left' ? 'Left' : 'Centered'}
          </label>
        ))}
      </div>

      <div className="settings-subsection-label">When you pick a part</div>
      <div className="settings-row" role="radiogroup" aria-label="On-select behavior for parts">
        {ON_SELECT_MODES.map(m => (
          <label key={m.v} style={{ marginRight: 12 }}>
            <input
              type="radio"
              name="overlay-parts-on-select"
              checked={overlayPartsOnSelect === m.v}
              onChange={() => { try { renderSettingsStore.setOverlayPartsOnSelect(m.v); } catch { /* ignore */ } }}
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
              checked={overlayNetsOnSelect === m.v}
              onChange={() => { try { renderSettingsStore.setOverlayNetsOnSelect(m.v); } catch { /* ignore */ } }}
            />
            {' '}{m.label}
          </label>
        ))}
      </div>

      <div className="settings-subsection-label">Selection visibility</div>

      <div className="settings-row">
        <label>
          <input
            type="checkbox"
            checked={searchAutoDim}
            onChange={e => { try { renderSettingsStore.setSearchAutoDim(e.target.checked); } catch { /* tolerate stale store */ } }}
          />
          {' '}Auto-dim while a searched part/net is selected
        </label>
      </div>

      <button
        className="settings-reset-btn"
        onClick={() => { try { renderSettingsStore.resetOverlayDefaults(); } catch { /* ignore */ } }}
        data-testid="overlay-reset-btn"
      >
        &#x21BA; Reset to defaults
      </button>
    </div>
  );
}
