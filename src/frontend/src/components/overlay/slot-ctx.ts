// src/frontend/src/components/overlay/slot-ctx.ts
import type React from 'react';
import type { BoardRenderer } from '../../renderer/BoardRenderer';
import type { NetLineMode } from '../../store/board-store';

/**
 * Context handed to every overlay slot renderer. Keep this minimal — slots
 * that need anything else should import directly (stores are global anyway).
 */
export interface SlotCtx {
  tabId: number;
  thisTab: {
    netLineMode: NetLineMode;
    dimMode: 'off' | 'dim' | 'darklight';
    showHoverInfo: boolean;
    ghostMode: 'off' | 'ghosts' | 'disco';
    followPdf: boolean;
    pdfFileNames: readonly string[];
    fileName: string;
  };
  rendererRef: React.RefObject<BoardRenderer | null>;
  bareAction: 'pan' | 'zoom';
}
