/**
 * Settings ▸ Board ▸ Board overlay — the editor for the board ribbon.
 *
 * One list, in ribbon order. Each row shows the live button, its name, and
 * the controls that matter: eye (show/hide), ↑ ↓ (order), × on separators.
 * Rows also drag to reorder. The ribbon's own right-click menu offers the
 * same show/hide and position choices; both go through the same store
 * operations, so there is one behaviour, not two.
 *
 * Selection behaviour (what happens when you pick a part or net) lives in
 * its own group below — it is a different question from what is on the bar.
 */
import { useState, type DragEvent, type ReactNode } from 'react';
import { IconEye, IconEyeOff, IconArrowUp, IconArrowDown, IconX, IconGripVertical, IconCircuitDiode, IconCpu, IconTopologyStar } from '@tabler/icons-react';
import type { Icon } from '@tabler/icons-react';
import { renderSettingsStore, DEFAULTS } from '../../store/render-settings';
import { useRenderSettings } from '../../hooks/useRenderSettings';
import { isSeparatorId, slotLabel, type OverlaySlot, type OverlaySlotId } from '../../store/overlay-layout';
import { renderOverlaySlot } from '../../components/overlay/slot-renderers';
import type { SlotCtx } from '../../components/overlay/slot-ctx';

const DRAG_MIME = 'application/x-overlay-slot';

const stubCtx: SlotCtx = {
  tabId: -1,
  thisTab: {
    netLineMode: 'off',
    dimMode: 'off',
    showHoverInfo: false,
    ghostMode: 'off',
    followPdf: false,
    pdfFileNames: [],
    fileName: '',
  },
  rendererRef: { current: null },
  bareAction: 'pan',
};

/* A few slots cannot stand in for themselves in the editor: the diode button
   renders nothing without readings, and the two dropdowns render a word that
   does not fit a 40px cell. These get a fixed glyph instead of the live chip. */
const EDITOR_ICONS: Partial<Record<string, Icon>> = {
  diodeValues:   IconCircuitDiode,
  partsDropdown: IconCpu,
  netsDropdown:  IconTopologyStar,
};

const ON_SELECT_MODES = [
  { v: 'highlight'      as const, label: 'Just highlight' },
  { v: 'panIfOffscreen' as const, label: 'Pan if off-screen' },
  { v: 'panZoomFit'     as const, label: 'Pan & zoom to fit' },
];

function safe(fn: () => void) { try { fn(); } catch { /* tolerate a stale store in tests */ } }

function SlotRow({ slot, index, count, dragging, onDragStart, onDragEnd, onDragOver, onDrop }: {
  slot: OverlaySlot;
  index: number;
  count: number;
  dragging: boolean;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
}) {
  const Glyph = EDITOR_ICONS[slot.id];
  const chip: ReactNode = Glyph ? <Glyph size={16} /> : renderOverlaySlot(slot.id, stubCtx);
  const sep = isSeparatorId(slot.id);
  const label = slotLabel(slot.id);
  return (
    <div
      className={`ovc-row${slot.visible ? '' : ' is-hidden'}${dragging ? ' dragging' : ''}`}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
      data-slot-id={slot.id}
      data-testid={`overlay-slot-row-${slot.id}`}
    >
      <span className="ovc-grip" title="Drag to reorder" aria-hidden><IconGripVertical size={14} /></span>
      <span className="ovc-chip" aria-hidden>{chip}</span>
      <span className="ovc-label">{label}</span>
      <button
        type="button"
        className="ovc-btn"
        aria-pressed={slot.visible}
        aria-label={slot.visible ? `Hide ${label}` : `Show ${label}`}
        title={slot.visible ? 'Shown on the bar — click to hide' : 'Hidden — click to show'}
        data-testid={`overlay-slot-eye-${slot.id}`}
        onClick={() => safe(() => renderSettingsStore.setOverlaySlotVisible(slot.id, !slot.visible))}
      >
        {slot.visible ? <IconEye size={14} /> : <IconEyeOff size={14} />}
      </button>
      <button type="button" className="ovc-btn" aria-label={`Move ${label} up`} title="Move left on the bar" disabled={index === 0}
        data-testid={`overlay-slot-up-${slot.id}`}
        onClick={() => safe(() => renderSettingsStore.moveOverlaySlot(slot.id, -1))}>
        <IconArrowUp size={14} />
      </button>
      <button type="button" className="ovc-btn" aria-label={`Move ${label} down`} title="Move right on the bar" disabled={index === count - 1}
        data-testid={`overlay-slot-down-${slot.id}`}
        onClick={() => safe(() => renderSettingsStore.moveOverlaySlot(slot.id, 1))}>
        <IconArrowDown size={14} />
      </button>
      {sep ? (
        <button type="button" className="ovc-btn ovc-remove" aria-label="Remove separator" title="Remove this separator"
          data-testid={`overlay-slot-remove-${slot.id}`}
          onClick={() => safe(() => renderSettingsStore.removeOverlaySeparator(slot.id))}>
          <IconX size={14} />
        </button>
      ) : <span className="ovc-btn ovc-spacer" aria-hidden />}
    </div>
  );
}

export function OverlayCustomizer() {
  const s = useRenderSettings();
  const [dragSlot, setDragSlot] = useState<OverlaySlotId | null>(null);

  // Defensive defaults — guard against missing fields from stale localStorage
  const showSelectionOverlay = s.showSelectionOverlay ?? DEFAULTS.showSelectionOverlay;
  const overlayPartsOnSelect = s.overlayPartsOnSelect ?? DEFAULTS.overlayPartsOnSelect;
  const overlayNetsOnSelect  = s.overlayNetsOnSelect  ?? DEFAULTS.overlayNetsOnSelect;
  const overlayPosition      = s.overlayPosition      ?? DEFAULTS.overlayPosition;
  const searchAutoDim        = s.searchAutoDim        ?? DEFAULTS.searchAutoDim;
  const layout: OverlaySlot[] = (s.overlayLayout ?? DEFAULTS.overlayLayout) as OverlaySlot[];
  const hiddenCount = layout.filter(x => !x.visible).length;

  const handleDragStart = (id: OverlaySlotId) => (e: DragEvent) => {
    e.dataTransfer.setData(DRAG_MIME, id);
    e.dataTransfer.effectAllowed = 'move';
    setDragSlot(id);
  };
  const handleDragEnd = () => setDragSlot(null);
  const handleDragOver = (e: DragEvent) => {
    if (e.dataTransfer.types.includes(DRAG_MIME)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }
  };
  const handleRowDrop = (beforeId: OverlaySlotId) => (e: DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    const movedId = e.dataTransfer.getData(DRAG_MIME) as OverlaySlotId;
    if (!movedId || movedId === beforeId) return;
    safe(() => renderSettingsStore.moveOverlaySlotBefore(movedId, beforeId));
  };
  const handleListDrop = (e: DragEvent) => {
    e.preventDefault();
    const movedId = e.dataTransfer.getData(DRAG_MIME) as OverlaySlotId;
    if (!movedId) return;
    safe(() => renderSettingsStore.moveOverlaySlotBefore(movedId, null));
  };

  return (
    <div className="overlay-customizer">
      <div className="settings-subsection-label">
        On the bar, in order{hiddenCount > 0 ? ` · ${hiddenCount} hidden` : ''}
      </div>
      <p className="settings-hint" style={{ margin: '0 0 6px' }}>
        Eye shows or hides, arrows move, drag also moves. The same list is one right-click away on the bar itself.
      </p>
      <div className="ovc-list" data-testid="overlay-customizer-list" onDragOver={handleDragOver} onDrop={handleListDrop}>
        {layout.map((slot, i) => (
          <SlotRow
            key={slot.id}
            slot={slot}
            index={i}
            count={layout.length}
            dragging={dragSlot === slot.id}
            onDragStart={handleDragStart(slot.id)}
            onDragEnd={handleDragEnd}
            onDragOver={handleDragOver}
            onDrop={handleRowDrop(slot.id)}
          />
        ))}
      </div>

      <div className="settings-row" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button type="button" className="settings-reset-btn" data-testid="overlay-add-separator-btn"
          title="Add a gap between two groups of buttons"
          onClick={() => safe(() => renderSettingsStore.addOverlaySeparator())}>
          + Separator
        </button>
        <button type="button" className="settings-reset-btn" data-testid="overlay-reset-layout-btn"
          title="Default order and visibility, row on the left. Selection behaviour below is not touched."
          onClick={() => safe(() => renderSettingsStore.resetOverlayLayout())}>
          &#x21BA; Reset layout
        </button>
        <span style={{ flex: 1 }} />
        <span role="radiogroup" aria-label="Overlay row position" style={{ display: 'inline-flex', gap: 10, fontSize: 12 }}>
          {(['left', 'center'] as const).map(pos => (
            <label key={pos}>
              <input type="radio" name="overlay-position" checked={overlayPosition === pos}
                onChange={() => safe(() => renderSettingsStore.setOverlayPosition(pos))} />
              {' '}{pos === 'left' ? 'Left' : 'Centred'}
            </label>
          ))}
        </span>
      </div>

      <div className="settings-subsection-label" style={{ marginTop: 14 }}>When you pick something</div>
      <div className="settings-row" role="radiogroup" aria-label="On-select behavior for parts">
        <span className="settings-label" style={{ display: 'block', marginBottom: 2 }}>A part</span>
        {ON_SELECT_MODES.map(m => (
          <label key={m.v} style={{ marginRight: 12 }}>
            <input type="radio" name="overlay-parts-on-select" checked={overlayPartsOnSelect === m.v}
              onChange={() => safe(() => renderSettingsStore.setOverlayPartsOnSelect(m.v))} />
            {' '}{m.label}
          </label>
        ))}
      </div>
      <div className="settings-row" role="radiogroup" aria-label="On-select behavior for nets">
        <span className="settings-label" style={{ display: 'block', marginBottom: 2 }}>A net</span>
        {ON_SELECT_MODES.map(m => (
          <label key={m.v} style={{ marginRight: 12 }}>
            <input type="radio" name="overlay-nets-on-select" checked={overlayNetsOnSelect === m.v}
              onChange={() => safe(() => renderSettingsStore.setOverlayNetsOnSelect(m.v))} />
            {' '}{m.label}
          </label>
        ))}
      </div>
      <div className="settings-row">
        <label>
          <input type="checkbox" checked={showSelectionOverlay}
            onChange={e => safe(() => renderSettingsStore.setShowSelectionOverlay(e.target.checked))} />
          {' '}Show the selected part's name under the bar
        </label>
      </div>
      <div className="settings-row">
        <label>
          <input type="checkbox" checked={searchAutoDim}
            onChange={e => safe(() => renderSettingsStore.setSearchAutoDim(e.target.checked))} />
          {' '}Auto-dim while a searched part or net is selected
        </label>
      </div>

      <button className="settings-reset-btn" data-testid="overlay-reset-btn"
        title="Layout, position and selection behaviour back to defaults"
        onClick={() => safe(() => renderSettingsStore.resetOverlayDefaults())}>
        &#x21BA; Reset all of the above
      </button>
    </div>
  );
}
