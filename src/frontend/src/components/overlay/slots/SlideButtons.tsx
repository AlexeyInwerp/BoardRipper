import { useSyncExternalStore } from 'react';
import { IconMap, IconMap2, IconPresentation } from '@tabler/icons-react';
import { renderSettingsStore, minimapMode, type MinimapMode } from '../../../store/render-settings';
import { useRenderSettings } from '../../../hooks/useRenderSettings';
import { slideStore } from '../../../store/slide-store';

const NEXT: Record<MinimapMode, MinimapMode> = { off: 'onPan', onPan: 'always', always: 'off' };
const TITLE: Record<MinimapMode, string> = {
  off:    'Minimap: off — click to show it while panning',
  onPan:  'Minimap: while panning — click to keep it on screen',
  always: 'Minimap: always on — click to turn it off',
};

/** Minimap, three states: off → fades in while panning → always on (the map
 *  with a pin). */
export function MinimapButton() {
  const mode = minimapMode(useRenderSettings());
  const Icon = mode === 'always' ? IconMap2 : IconMap;
  return (
    <button
      className={`board-netlines-toggle ${mode !== 'off' ? 'active' : ''}`}
      data-testid="minimap-toggle"
      data-mode={mode}
      aria-pressed={mode !== 'off'}
      onClick={() => renderSettingsStore.setMinimapMode(NEXT[mode])}
      title={TITLE[mode]}
    >
      <Icon size={16} />
    </button>
  );
}

/** Slide mode: arrows, boxes and text over the view, saved as a PNG. */
export function SlideModeButton() {
  const on = useSyncExternalStore(c => slideStore.subscribe(c), () => slideStore.snapshot()).enabled;
  return (
    <button
      className={`board-netlines-toggle ${on ? 'active' : ''}`}
      data-testid="slide-mode-toggle"
      aria-pressed={on}
      onClick={() => slideStore.toggle()}
      title={on ? 'Slide mode: on (click to leave)' : 'Slide mode: mark up the view and save it as a PNG'}
    >
      <IconPresentation size={16} />
    </button>
  );
}
