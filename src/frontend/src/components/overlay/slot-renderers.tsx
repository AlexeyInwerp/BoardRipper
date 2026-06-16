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

/**
 * Returns the rendered ReactNode for a given slot id. Any `sep${number}`
 * id renders as a <Separator/>; named slots route through the switch.
 * Used by both the live overlay walker and the Settings customizer.
 */
export function renderOverlaySlot(id: OverlaySlotId, ctx: SlotCtx): ReactNode {
  if (isSeparatorId(id)) return <Separator />;
  switch (id) {
    case 'pdfFollow':     return <PdfFollowButton  ctx={ctx} />;
    case 'scrollMode':    return <ScrollModeButton ctx={ctx} />;
    case 'fitBoard':      return <FitBoardButton   ctx={ctx} />;
    case 'hoverInfo':     return <HoverInfoButton  ctx={ctx} />;
    case 'netDim':        return <NetDimButton     ctx={ctx} />;
    case 'netLines':      return <NetLinesButton   ctx={ctx} />;
    case 'ghosts':        return <GhostsButton     ctx={ctx} />;
    case 'diodeValues':   return <DiodeValuesButton ctx={ctx} />;
    case 'partsDropdown': return <PartsDropdown ctx={ctx} />;
    case 'netsDropdown':  return <NetsDropdown ctx={ctx} />;
  }
}

export function renderOverlayLayout(
  layout: ReadonlyArray<{ id: OverlaySlotId; visible: boolean }>,
  ctx: SlotCtx,
): ReactNode[] {
  return layout
    .filter(s => s.visible)
    .map(s => <Fragment key={s.id}>{renderOverlaySlot(s.id, ctx)}</Fragment>);
}
