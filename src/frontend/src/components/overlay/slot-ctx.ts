// src/frontend/src/components/overlay/slot-ctx.ts
import type React from 'react';
import type { BoardRenderer } from '../../renderer/BoardRenderer';
import type { NetLineMode, GhostMode } from '../../store/board-store';

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
    ghostMode: GhostMode;
    followPdf: boolean;
    pdfFileNames: readonly string[];
    fileName: string;
    /** Per-tab view state the transform slots read. */
    showTop: boolean;
    showBottom: boolean;
    butterfly: boolean;
    showTraces: boolean;
    rotation: number;
    flipAxis: 'x' | 'y';
    /** 'bottom' when the file's primary side is the bottom (XZZ packs). */
    primarySide: 'top' | 'bottom';
    /** From the format descriptor: layered formats hide butterfly/traces. */
    hasLayers: boolean;
    hasTraces: boolean;
  };
  rendererRef: React.RefObject<BoardRenderer | null>;
  bareAction: 'pan' | 'zoom';
}
