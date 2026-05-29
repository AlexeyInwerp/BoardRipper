import { useState, type DragEvent, type ReactNode } from 'react';
import { renderSettingsStore, DEFAULTS } from '../../store/render-settings';
import { useRenderSettings } from '../../hooks/useRenderSettings';
import type { OverlaySlot, OverlaySlotId } from '../../store/overlay-layout';
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

const ON_SELECT_MODES = [
  { v: 'highlight'      as const, label: 'Just highlight' },
  { v: 'panIfOffscreen' as const, label: 'Pan if off-screen' },
  { v: 'panZoomFit'     as const, label: 'Pan & zoom to fit' },
];

function commitMove(
  layout: OverlaySlot[],
  movedId: OverlaySlotId,
  targetZoneVisible: boolean,
  insertBeforeId: OverlaySlotId | null,
): OverlaySlot[] {
  const without = layout.filter(s => s.id !== movedId);
  const moved: OverlaySlot = { id: movedId, visible: targetZoneVisible };
  if (insertBeforeId === null) {
    if (targetZoneVisible) {
      // Insert after the last currently-visible slot in `without` so it lands at end of visible block
      let lastVisIdx = -1;
      for (let i = 0; i < without.length; i++) if (without[i].visible) lastVisIdx = i;
      const out: OverlaySlot[] = [];
      let placed = false;
      for (let i = 0; i < without.length; i++) {
        out.push(without[i]);
        if (i === lastVisIdx) { out.push(moved); placed = true; }
      }
      if (!placed) out.push(moved);
      return out;
    }
    return [...without, moved];
  }
  const out: OverlaySlot[] = [];
  for (const slot of without) {
    if (slot.id === insertBeforeId) out.push(moved);
    out.push(slot);
  }
  if (!out.includes(moved)) out.push(moved);
  return out;
}

function SlotChip({ slot, ctx, dragging, onDragStart, onDragEnd, onDragOver, onDrop }: {
  slot: OverlaySlot;
  ctx: SlotCtx;
  dragging: boolean;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
}) {
  const inner: ReactNode = renderOverlaySlot(slot.id, ctx);
  return (
    <div
      className={`overlay-customizer-chip-wrap${dragging ? ' dragging' : ''}`}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
      title="Drag to reorder · drag to other zone to hide/show"
      data-slot-id={slot.id}
    >
      <div className="overlay-customizer-chip">
        <div className="overlay-customizer-chip-inner" aria-hidden>{inner}</div>
        <div className="overlay-customizer-chip-mask" />
      </div>
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
  const visibleSlots = layout.filter(x => x.visible);
  const hiddenSlots  = layout.filter(x => !x.visible);

  const handleDragStart = (id: OverlaySlotId) => (e: DragEvent) => {
    e.dataTransfer.setData(DRAG_MIME, id);
    e.dataTransfer.effectAllowed = 'move';
    setDragSlot(id);
  };
  const handleDragEnd = () => setDragSlot(null);
  const handleDragOver = (e: DragEvent) => {
    if (e.dataTransfer.types.includes(DRAG_MIME)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    }
  };
  const handleZoneDrop = (visible: boolean) => (e: DragEvent) => {
    e.preventDefault();
    const movedId = e.dataTransfer.getData(DRAG_MIME) as OverlaySlotId;
    if (!movedId) return;
    const next = commitMove(layout, movedId, visible, null);
    try { renderSettingsStore.setOverlayLayout(next); } catch { /* ignore */ }
  };
  const handleChipDrop = (insertBeforeId: OverlaySlotId, visible: boolean) => (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const movedId = e.dataTransfer.getData(DRAG_MIME) as OverlaySlotId;
    if (!movedId || movedId === insertBeforeId) return;
    const next = commitMove(layout, movedId, visible, insertBeforeId);
    try { renderSettingsStore.setOverlayLayout(next); } catch { /* ignore */ }
  };

  const renderZone = (slots: OverlaySlot[], visible: boolean) => (
    <div
      className={`overlay-customizer-zone ${visible ? 'visible-zone' : 'hidden-zone'}`}
      onDragOver={handleDragOver}
      onDrop={handleZoneDrop(visible)}
      data-testid={visible ? 'overlay-customizer-visible' : 'overlay-customizer-hidden'}
    >
      {slots.length === 0 && (
        <div className="overlay-customizer-empty">
          {visible ? 'All slots are hidden — drag from below to restore' : 'Drag a button here to hide it'}
        </div>
      )}
      {slots.map(slot => (
        <SlotChip
          key={slot.id}
          slot={slot}
          ctx={stubCtx}
          dragging={dragSlot === slot.id}
          onDragStart={handleDragStart(slot.id)}
          onDragEnd={handleDragEnd}
          onDragOver={handleDragOver}
          onDrop={handleChipDrop(slot.id, visible)}
        />
      ))}
    </div>
  );

  return (
    <div className="overlay-customizer">
      <div className="settings-subsection-label">Visible (drag to reorder, drag down to hide)</div>
      {renderZone(visibleSlots, true)}

      <div className="settings-subsection-label">Hidden (drag up to restore)</div>
      {renderZone(hiddenSlots, false)}

      <div className="settings-row">
        <button
          type="button"
          className="settings-reset-btn"
          onClick={() => { try { renderSettingsStore.addOverlaySeparator(); } catch { /* ignore */ } }}
          title="Add a new separator slot to the overlay"
          data-testid="overlay-add-separator-btn"
        >
          + Add separator
        </button>
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
