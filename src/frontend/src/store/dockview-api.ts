import type { DockviewApi } from 'dockview-react';

let _api: DockviewApi | null = null;

export function setDockviewApi(api: DockviewApi) {
  _api = api;
}

export function getDockviewApi(): DockviewApi | null {
  return _api;
}
