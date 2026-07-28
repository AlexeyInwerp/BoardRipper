/**
 * ObdCell — the single shared renderer for an OpenBoardData pin cell
 * (deduped diode / voltage / resistance readings plus a comments tooltip).
 *
 * It lives in its own module because two component-inspection surfaces need
 * it — `ComponentInfoBody` (the selected part's pin table) and
 * `NetBranchSection` (the per-component spoilers under a net) — and the
 * latter is imported BY the former, so keeping the cell in ComponentInfoBody
 * would make the import cycle.
 */
import type { ObdNet } from '../store/obd-store';

export function ObdCell({ nets }: { nets: ObdNet[] }) {
  if (nets.length === 0) return <span style={{ color: '#666' }}>—</span>;
  // Defensive against null arrays (older cached payloads, future API drift).
  const dedupe = (xs: (string | null | undefined)[]) =>
    Array.from(new Set(xs.filter((v): v is string => typeof v === 'string' && v.length > 0)));
  const diodes = dedupe(nets.map(n => n.diode));
  const volts = dedupe(nets.map(n => n.voltage));
  const ohms = dedupe(nets.map(n => n.resistance));
  const allComments = Array.from(
    new Set(
      nets
        .flatMap(n => (Array.isArray(n.comments) ? n.comments : []))
        .filter((c): c is string => typeof c === 'string' && c.trim().length > 0),
    ),
  );
  const parts: string[] = [];
  if (diodes.length) parts.push(`d ${diodes.join('/')}`);
  if (volts.length) parts.push(`${volts.join('/')} V`);
  if (ohms.length) parts.push(`${ohms.join('/')} Ω`);
  return (
    <span style={{ fontSize: 11, fontFamily: 'monospace' }}>
      {parts.length > 0 ? parts.join(' · ') : <span style={{ color: '#666' }}>—</span>}
      {allComments.length > 0 && (
        <span title={allComments.join('\n')} style={{ marginLeft: 4, cursor: 'help' }}>
          📝
        </span>
      )}
    </span>
  );
}
