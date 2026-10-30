/**
 * The board legend — a half-transparent reference card over the board,
 * opened by the ribbon's "?" slot (hidden by default; switch it on from the
 * ribbon's right-click menu or Settings ▸ Board overlay). It explains what
 * the board is showing, in modes: pin colours (with this board's pin count
 * per rule), component colours, diode reading colours, net line and
 * selection colours, and the board keys. Everything is read from the
 * effective settings and the active theme, so a rule the user edited, or a
 * colour scheme, is shown as it is drawn.
 *
 * It sits in the board panel's lower right, clear of the HUD and the slide
 * guide on the left, and moves left of the board sidebar while that is open.
 */
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import { IconX } from '@tabler/icons-react';
import { useBoardStore } from '../hooks/useBoardStore';
import { useRenderSettings } from '../hooks/useRenderSettings';
import { themeStore } from '../store/themes';
import { boardLegendStore, useBoardLegend } from '../store/board-legend-store';
import {
  LEGEND_KEY_IDS, LEGEND_MODES, READING_BANDS,
  partTypeCounts, pinLegend, readingCounts,
} from '../store/board-legend';
import { formatShortcut, getShortcut } from '../store/keyboard-shortcuts';
import { showSidebarTab } from './Sidebar.utils';

const hex = (n: number) => '#' + n.toString(16).padStart(6, '0');
const num = (n: number) => n.toLocaleString('en-US');

function Swatch({ color, outline, shape = 'dot' }: { color: string; outline?: boolean; shape?: 'dot' | 'box' | 'line' }) {
  return <span className={`lg-sw lg-sw-${shape}${outline ? ' outline' : ''}`} style={{ ['--c' as string]: color }} aria-hidden />;
}

function Row({ swatch, name, sub, count, testId }: { swatch: ReactNode; name: ReactNode; sub?: ReactNode; count?: number; testId?: string }) {
  return (
    <div className="lg-row" data-testid={testId}>
      {swatch}
      <span className="lg-name">{name}{sub && <span className="lg-sub">{sub}</span>}</span>
      {count !== undefined && <span className="lg-n">{num(count)}</span>}
    </div>
  );
}

function openSettingsSection(id: string) {
  showSidebarTab('settings');
  window.dispatchEvent(new CustomEvent('settings-focus-section', { detail: id }));
}

export function BoardLegend({ tabId, sidebarOpen, rootRef }: {
  tabId: number;
  sidebarOpen: boolean;
  rootRef: RefObject<HTMLDivElement | null>;
}) {
  const { open, mode } = useBoardLegend();
  const { tabs } = useBoardStore();
  const settings = useRenderSettings();
  useSyncExternalStore(cb => themeStore.subscribe(cb), () => themeStore.activeId);
  const board = tabs.find(t => t.id === tabId)?.board ?? null;

  // Stay clear of the board sidebar: it overlays the panel's right edge.
  const [sidebarW, setSidebarW] = useState(0);
  useEffect(() => {
    if (!open || !sidebarOpen) { setSidebarW(0); return; }
    const el = rootRef.current?.querySelector<HTMLElement>('.board-sidebar');
    if (!el) return;
    const measure = () => setSidebarW(el.offsetWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, sidebarOpen, rootRef]);

  const pins = useMemo(() => (board ? pinLegend(board, settings.pinGroups ?? []) : null), [board, settings.pinGroups]);
  const parts = useMemo(() => (board && mode === 'parts' ? partTypeCounts(board, settings) : null), [board, settings, mode]);
  const readings = useMemo(() => (board && mode === 'readings' ? readingCounts(board) : null), [board, mode]);

  if (!open || !board) return null;
  const theme = themeStore.activeTheme().board;

  let body: ReactNode = null;
  if (mode === 'pins' && pins) {
    body = (
      <>
        {(settings.pinGroups ?? []).filter(g => g.rules.length > 0).map(g => (
          <div key={g.id} className="lg-group">
            <div className="lg-cap">{g.label}{g.outlineOnly ? ' · outline only' : ''}</div>
            {g.rules.map(r => (
              <Row key={r.id} testId={`legend-pin-${r.id}`}
                swatch={<Swatch color={r.color} outline={g.outlineOnly} />}
                name={<span className="lg-mono" translate="no">{r.keywords}</span>}
                count={pins.byRule.get(r.id) ?? 0} />
            ))}
          </div>
        ))}
        <div className="lg-group">
          <div className="lg-cap">No rule matched</div>
          <Row testId="legend-pin-unmatched-top" swatch={<Swatch color={settings.defaultPinColorTop} />} name="Top side" count={pins.unmatchedTop} />
          <Row testId="legend-pin-unmatched-bottom" swatch={<Swatch color={settings.defaultPinColorBottom} />} name="Bottom side" count={pins.unmatchedBottom} />
        </div>
        <button type="button" className="lg-link" onClick={() => openSettingsSection('netColors')}>Edit rules in Settings ▸ Pin Color Rules</button>
      </>
    );
  } else if (mode === 'parts' && parts) {
    const types = settings.partTypes.filter(t => t.color && (parts.get(t.id) ?? 0) > 0);
    body = !settings.showComponentColors ? (
      <p className="lg-note">Component colours are off, so every body is drawn in the board's own colour.</p>
    ) : types.length === 0 ? (
      <p className="lg-note">No part on this board matches a coloured component type.</p>
    ) : (
      <div className="lg-group">
        {types.map(t => (
          <Row key={t.id} testId={`legend-part-${t.id}`}
            swatch={<Swatch color={t.color} shape="box" />}
            name={t.label}
            sub={<span className="lg-mono" translate="no">{t.prefixes.join(' ')}{t.hidden ? ' · hidden' : ''}</span>}
            count={parts.get(t.id) ?? 0} />
        ))}
      </div>
    );
  } else if (mode === 'readings' && readings) {
    const total = [...readings.values()].reduce((a, b) => a + b, 0);
    body = (
      <>
        <div className="lg-group">
          {READING_BANDS.map(b => (
            <Row key={b.id} testId={`legend-reading-${b.id}`}
              swatch={<span className="lg-reading" style={{ color: hex(b.color) }}>{b.id === 'open' ? 'OL' : b.id === 'short' ? '0.012' : b.id === 'junction' ? '0.335' : '0.612'}</span>}
              name={b.label} sub={b.range}
              count={total > 0 ? readings.get(b.id) ?? 0 : undefined} />
          ))}
        </div>
        <p className="lg-note">{total > 0
          ? 'Counts are the readings this file carries. OpenBoardData readings use the same colours.'
          : 'This file carries no readings. OpenBoardData readings use these colours.'}</p>
      </>
    );
  } else if (mode === 'lines') {
    body = (
      <div className="lg-group">
        <Row testId="legend-line-net" swatch={<Swatch color={hex(settings.netLineColor)} shape="line" />} name="Net lines" sub="the lit net, pin to pin" />
        <Row testId="legend-line-adjacent" swatch={<Swatch color={hex(settings.adjacentNetLineColor)} shape="line" />} name="Next nets" sub="one part away, hierarchical net lines" />
        <Row swatch={<Swatch color={theme.selection} />} name="Lit net" sub="its pins on the board" />
        <Row swatch={<Swatch color={theme.butterflySelection} />} name="Lit net, other half" sub="in Butterfly" />
        <Row swatch={<Swatch color={theme.selectedPart ?? '#ffffff'} shape="box" outline />} name="Selected part" />
        <Row swatch={<Swatch color={theme.partOutlineTop ?? '#336633'} shape="box" outline />} name="Part outline" sub="top side" />
        <Row swatch={<Swatch color={theme.partOutlineBottom ?? '#663333'} shape="box" outline />} name="Part outline" sub="bottom side" />
      </div>
    );
  } else if (mode === 'keys') {
    const pan = ['panBoardUp', 'panBoardLeft', 'panBoardDown', 'panBoardRight'].map(id => formatShortcut(id)).join(' ');
    body = (
      <div className="lg-group">
        {LEGEND_KEY_IDS.map(id => {
          const s = getShortcut(id);
          if (!s) return null;
          const isPan = id === 'panBoardUp';
          return (
            <div key={id} className="lg-row lg-key" data-testid={`legend-key-${id}`}>
              <span className="lg-name">{isPan ? 'Pan' : s.label}</span>
              <kbd>{isPan ? pan : formatShortcut(id)}</kbd>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="board-legend" data-testid="board-legend" style={{ right: 8 + sidebarW }}>
      <div className="lg-head">
        <div className="lg-modes" role="tablist" aria-label="Legend">
          {LEGEND_MODES.map(m => (
            <button key={m.id} type="button" role="tab" aria-selected={mode === m.id}
              className={mode === m.id ? 'on' : ''} data-testid={`legend-mode-${m.id}`} title={m.title}
              onClick={() => boardLegendStore.setMode(m.id)}>{m.label}</button>
          ))}
        </div>
        <button type="button" className="lg-close" aria-label="Close legend" title="Close" onClick={() => boardLegendStore.close()}>
          <IconX size={13} stroke={2} />
        </button>
      </div>
      <div className="lg-body">{body}</div>
    </div>
  );
}
