import { useSyncExternalStore } from 'react';
import { IconMap2, IconPresentation } from '@tabler/icons-react';
import { renderSettingsStore } from '../../../store/render-settings';
import { useRenderSettings } from '../../../hooks/useRenderSettings';
import { slideStore } from '../../../store/slide-store';

/** Minimap that fades in while panning (third gesture in a row). */
export function MinimapButton() {
  const on = useRenderSettings().minimapOnPan;
  return (
    <button
      className={`board-netlines-toggle ${on ? 'active' : ''}`}
      data-testid="minimap-toggle"
      aria-pressed={on}
      onClick={() => renderSettingsStore.setMinimapOnPan(!on)}
      title={on ? 'Minimap while panning: on (click to turn off)' : 'Minimap while panning: off (click to turn on)'}
    >
      <IconMap2 size={16} />
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
