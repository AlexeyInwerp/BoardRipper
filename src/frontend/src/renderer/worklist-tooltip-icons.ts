/**
 * Static SVG strings for the worklist marks / flags / measurement kinds, so the
 * plain-DOM canvas hover tooltip (BoardRenderer, not React) can show the SAME
 * Tabler icons the worklist panel uses — instead of words. Rendered once at
 * module load via the public `renderToStaticMarkup` (no fragile deep imports).
 * Monochrome: the icons inherit the tooltip's text colour via `currentColor`.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement, type ComponentType } from 'react';
import {
  IconReplace, IconSparkles, IconAlertTriangle, IconCheck, IconUnlink,
  IconDroplet, IconBolt, IconCircuitDiode,
} from '@tabler/icons-react';
import { IconSolderingIron } from '../icons/IconSolderingIron';
import type { WorklistMark, NetWorklistMark, NetMeasurement } from '../store/worklist-store';

type IconC = ComponentType<{ size?: number; stroke?: number }>;
const svg = (C: IconC): string => renderToStaticMarkup(createElement(C, { size: 13, stroke: 2 }));

export const PART_MARK_SVG: Record<Exclude<WorklistMark, 'none'>, string> = {
  replaced: svg(IconReplace),
  reworked: svg(IconSolderingIron as IconC),
  cleaned: svg(IconSparkles),
};
export const NET_MARK_SVG: Record<Exclude<NetWorklistMark, 'none'>, string> = {
  short: svg(IconAlertTriangle),
  solved: svg(IconCheck),
  absent: svg(IconUnlink),
};
export const WATER_SVG = svg(IconDroplet);
export const SURGE_SVG = svg(IconBolt);

/** Measurement kind glyphs: diode has an icon; V / Ω are their own unit letters. */
export const MEAS_SVG: Partial<Record<NetMeasurement['kind'], string>> = { diode: svg(IconCircuitDiode) };
export const MEAS_LETTER: Record<NetMeasurement['kind'], string> = { voltage: 'V', diode: '', resistance: 'Ω' };

/** Escape untrusted text (notes, measurement values) before it goes into the
 *  tooltip via innerHTML alongside the trusted icon SVGs. */
const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => HTML_ESCAPES[c]);
}
