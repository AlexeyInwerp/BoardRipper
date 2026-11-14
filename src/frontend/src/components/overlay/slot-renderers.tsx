// src/frontend/src/components/overlay/slot-renderers.tsx
import { Fragment, type ReactNode } from 'react';
import { type OverlaySlotId, isSeparatorId } from '../../store/overlay-layout';
import type { SlotCtx } from './slot-ctx';
import { PdfFollowButton }  from './slots/PdfFollowButton';
import { ScrollModeButton } from './slots/ScrollModeButton';
import { FitBoardButton }   from './slots/FitBoardButton';
import { HoverInfoButton }  from './slots/HoverInfoButton';
import { NetDimButton }     from './slots/NetDimButton';
import { NetLinesButton }   from './slots/NetLinesButton';
import { GhostsButton }     from './slots/GhostsButton';
import { DiodeValuesButton } from './slots/DiodeValuesButton';
import { Separator }        from './slots/Separator';
import { PartsDropdown }    from './slots/PartsDropdown';
import { NetsDropdown }     from './slots/NetsDropdown';
import { SideSwitch }       from './slots/SideSwitch';
import { HistoryButtons }   from './slots/HistoryButtons';
import { MinimapButton, SlideModeButton } from './slots/SlideButtons';
import { ButterflyButton, RotateCcwButton, RotateCwButton, TracesButton, TransformMenuButton } from './slots/TransformButtons';
import { LegendButton } from './slots/LegendButton';
import { View3DButton, View3DSideSwitch, View3DFitButton } from './slots/View3DButton';

/**
 * Returns the rendered ReactNode for a given slot id. Any `sep${number}`
 * id renders as a <Separator/>; named slots route through the switch.
 * Used by both the live overlay walker and the Settings customizer.
 */
/** Slots that mean something in the 3D view. The rest act on the 2D renderer
 *  (transforms, butterfly, slides, the 2D-only view aids) and hide in 3D. */
const SLOTS_3D: ReadonlySet<OverlaySlotId> = new Set<OverlaySlotId>(['sideSwitch', 'history', 'view3d', 'pdfFollow', 'scrollMode', 'fitBoard', 'partsDropdown', 'netsDropdown']);

export function renderOverlaySlot(id: OverlaySlotId, ctx: SlotCtx): ReactNode {
  if (isSeparatorId(id)) return <Separator />;
  if (ctx.is3d) {
    if (!SLOTS_3D.has(id)) return null;
    if (id === 'sideSwitch') return <View3DSideSwitch ctx={ctx} />;
    if (id === 'fitBoard') return <View3DFitButton ctx={ctx} />;
  }
  switch (id) {
    case 'sideSwitch':    return <SideSwitch ctx={ctx} />;
    case 'butterfly':     return <ButterflyButton ctx={ctx} />;
    case 'rotateCCW':     return <RotateCcwButton />;
    case 'rotateCW':      return <RotateCwButton />;
    case 'transformMenu': return <TransformMenuButton ctx={ctx} />;
    case 'history':       return <HistoryButtons />;
    case 'traces':        return <TracesButton ctx={ctx} />;
    case 'pdfFollow':     return <PdfFollowButton  ctx={ctx} />;
    case 'scrollMode':    return <ScrollModeButton ctx={ctx} />;
    case 'fitBoard':      return <FitBoardButton   ctx={ctx} />;
    case 'minimap':       return <MinimapButton />;
    case 'slides':        return <SlideModeButton />;
    case 'hoverInfo':     return <HoverInfoButton  ctx={ctx} />;
    case 'netDim':        return <NetDimButton     ctx={ctx} />;
    case 'netLines':      return <NetLinesButton   ctx={ctx} />;
    case 'ghosts':        return <GhostsButton     ctx={ctx} />;
    case 'diodeValues':   return <DiodeValuesButton ctx={ctx} />;
    case 'partsDropdown': return <PartsDropdown ctx={ctx} />;
    case 'netsDropdown':  return <NetsDropdown ctx={ctx} />;
    case 'sideFlipAxis':  return null;               // drawn inside SideSwitch
    case 'legendHelp':    return <LegendButton />;
    case 'view3d':        return <View3DButton ctx={ctx} />;
  }
}

export function renderOverlayLayout(
  layout: ReadonlyArray<{ id: OverlaySlotId; visible: boolean }>,
  ctx: SlotCtx,
): ReactNode[] {
  const shown = layout.filter(s => s.visible && (!ctx.is3d || isSeparatorId(s.id) || SLOTS_3D.has(s.id)));
  // in 3D whole groups disappear: drop separators left leading, trailing or doubled
  const tidy = ctx.is3d ? shown.filter((s, i) => !isSeparatorId(s.id) || (i > 0 && i < shown.length - 1 && !isSeparatorId(shown[i - 1].id))) : shown;
  return tidy.map(s => <Fragment key={s.id}>{renderOverlaySlot(s.id, ctx)}</Fragment>);
}
