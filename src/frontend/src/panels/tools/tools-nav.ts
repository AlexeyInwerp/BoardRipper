/**
 * Which tool the Tools sidebar is showing.
 *
 * Lifted out of `ToolsPanel`'s local `useState` so something outside the
 * component can navigate to a tool — the board right-click menu opens Part
 * comparison directly. Same shape as `Sidebar.utils.ts`: module state plus a
 * listener set, read through a `useSyncExternalStore` hook.
 */

import { useSyncExternalStore } from 'react';

export type ToolId = 'resistor' | 'smd' | 'capacitor' | 'worklists' | 'partcompare';

let _activeTool: ToolId | null = null;
const _listeners = new Set<() => void>();

export function getActiveTool(): ToolId | null { return _activeTool; }

export function setActiveTool(tool: ToolId | null): void {
  if (_activeTool === tool) return;
  _activeTool = tool;
  _listeners.forEach(fn => fn());
}

function subscribe(fn: () => void): () => void {
  _listeners.add(fn);
  return () => { _listeners.delete(fn); };
}

export function useActiveTool(): ToolId | null {
  return useSyncExternalStore(subscribe, getActiveTool);
}
