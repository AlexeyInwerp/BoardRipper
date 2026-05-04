// src/frontend/src/components/overlay/slot-ctx.ts
import type React from 'react';
import type { BoardRenderer } from '../../renderer/BoardRenderer';

/**
 * Context handed to every overlay slot renderer. Keep this minimal — slots
 * that need anything else should import directly (stores are global anyway).
 */
export interface SlotCtx {
  tabId: number;
  thisTab: {
    netLineMode: 'off' | 'star' | 'chain';
    showNetDim: boolean;
    showHoverInfo: boolean;
    showGhosts: boolean;
    followPdf: boolean;
    pdfFileNames: readonly string[];
    fileName: string;
  };
  rendererRef: React.RefObject<BoardRenderer | null>;
  bareAction: 'pan' | 'zoom';
}
