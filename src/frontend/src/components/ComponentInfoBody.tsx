/**
 * ComponentInfoBody — the source of truth for the component-inspection UI.
 * It has a single live surface: the board sidebar's Info tab
 * (`components/BoardSidebar.tsx` → InfoTab).
 *
 * It was extracted to unify two near-duplicate copies that had functionally
 * diverged (one lacked the BOM-alternates switcher, they disagreed on whether
 * to show board-level OBD diagnosis when nothing is selected, and they carried
 * two slightly-different copies of the OBD cell). The second surface (a
 * standalone Component Info panel) has since been removed, but keep all
 * inspection logic HERE, not in the call site, so the sidebar stays the
 * single owner and can't drift.
 *
 * Behavior owned here:
 *   - The BOM-alternates switcher (BomClusterSection).
 *   - Board-level OBD DIAGNOSIS notes render regardless of whether a part is
 *     selected (they are board-scoped, not pin-scoped).
 *   - A single ObdCell renders the per-pin diode/V/Ω readings (the cell now
 *     lives in ./ObdCell and is re-exported here for existing call sites).
 *   - Which selection gets the net branch: component selected → component
 *     only; pin selected → component + NetBranchSection for the pin's net.
 *   - WHERE that tree is mounted: always a row inside the pin table, directly
 *     under the pin it belongs to. It stays short whatever the net's size —
 *     NetBranchSection previews a few components and hides the rest behind a
 *     spoiler — so the pinout is never buried.
 *   - Which nets get one at all: ground rails are skipped, since "everything
 *     touching GND" is most of the board.
 *   - The --nw colour scope every net tint derives from. Read the comment at
 *     the declaration below before moving it: the derived ladder in index.css
 *     only works while it sits on the same element as --nw.
 */
import { Fragment, useEffect, useMemo, useState } from 'react';
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import { bomReasonLabel, type BoardData, type BomAlternateCluster } from '../parsers';
import type { SelectionState } from '../store/board-store';
import { boardStore, bomClusterSig } from '../store/board-store';
import { obdStore, useObdNetLookup } from '../store/obd-store';
import { formatDiode } from '../store/diode-readings';
import { useRenderSettings } from '../hooks/useRenderSettings';
import { isGroundNet } from '../store/render-settings';
import { colorToHex } from '../store/layer-store';
import { accentTextColor } from '../store/color-math';
import { DiagnosisNotes } from './DiagnosisNotes';
import { NetBranchSection } from './NetBranchSection';
import { ObdCell } from './ObdCell';

// Re-exported so existing `import { ObdCell } from './ComponentInfoBody'`
// call sites keep working after the cell moved to its own module (it had to,
// or NetBranchSection ↔ ComponentInfoBody would be an import cycle).
export { ObdCell };

export interface ComponentInfoBodyProps {
  board: BoardData;
  selection: SelectionState;
  /** Board number extracted from the file name, for OpenBoardData lookup. */
  boardNumber?: string;
  /** When true, every BOM-cluster member is rendered (X-ray); when false only
   *  the chosen primary is. Drives the BomClusterSection copy + click behavior. */
  showBomAlternates: boolean;
  bomClusterSelections: ReadonlyMap<string, string>;
}

export function ComponentInfoBody({
  board,
  selection,
  boardNumber,
  showBomAlternates,
  bomClusterSelections,
}: ComponentInfoBodyProps) {
  const obd = useObdNetLookup(boardNumber);
  const settings = useRenderSettings();
  /** Which net the user has collapsed, rather than a bare boolean. Landing on
   *  a different net is then open by construction — collapsing is "get this
   *  out of my way for now", not a preference that follows you to the next
   *  net — and it needs no effect to reset. Lives here, not in
   *  NetBranchSection, because the caret that drives it is now part of the
   *  selected pin row's net cell. */
  const [collapsedNet, setCollapsedNet] = useState<string | null>(null);

  // Auto-load matches + cached data when the active board changes. Cheap:
  // hits the backend's match endpoint once per board, and the per-bpath
  // cache loaders are short-circuited if already in memory.
  useEffect(() => {
    if (boardNumber) obdStore.loadMatches(boardNumber);
  }, [boardNumber]);

  // The net the tree fans out, resolved before any early return so the hooks
  // below stay unconditional. Ground rails are excluded on purpose: "every
  // component touching GND" is most of the board, so the fan-out costs a
  // screen and answers nothing. Membership comes from the user's Ground pin
  // group, not a hardcoded pattern, so an unusual ground name is taught once
  // in Settings and every consumer follows.
  const pinNet = selectedPinNet(board, selection);
  const branchNet = pinNet && !isGroundNet(settings, pinNet) ? pinNet : null;
  const netOpen = branchNet !== null && collapsedNet !== branchNet;

  // Counts for the selected row's net cell. They live there rather than in a
  // bar of their own: a dedicated row cost a full line to restate the net and
  // re-print the OBD reading the pin's own OBD column already shows.
  const netStats = useMemo(() => {
    if (!branchNet) return null;
    const entry = board.nets.get(branchNet);
    if (!entry) return null;
    const parts = new Set<number>();
    for (const { partIndex } of entry.pinIndices) {
      if (partIndex !== selection.partIndex && board.parts[partIndex]) parts.add(partIndex);
    }
    return { pins: entry.pinIndices.length, comps: parts.size };
  }, [board, branchNet, selection.partIndex]);

  const selectedPart =
    selection.partIndex !== null ? board.parts[selection.partIndex] ?? null : null;

  // DIAGNOSIS_DATA notes from openboarddata.org are board-level (not pin-
  // specific), so render them regardless of whether a component is selected.
  const obdNotes = obd.loadedVariants
    .filter(v => v.sections && v.sections.length > 0)
    .map(v => <DiagnosisNotes key={v.bpath} sections={v.sections!} board={board} />);

  if (!selectedPart) {
    return (
      <div className="panel-content component-info" data-testid="component-info">
        <div className="panel-empty">Click a component to inspect</div>
        {obdNotes}
      </div>
    );
  }

  // Look up the BOM-alternate cluster the selected part belongs to (if any).
  // Matched by refdes so it survives the parts-array filtering done by
  // `buildRenderedBoard` when alternates are hidden.
  const cluster: BomAlternateCluster | null =
    board.bomClusters?.find(c => c.memberRefdes.includes(selectedPart.name)) ?? null;

  // ── Net-tree colour scope ────────────────────────────────────────────
  // Everything the tree tints — the selected pin row, the strip, the rails,
  // the previewed row — derives from ONE value: renderSettings.netLineColor,
  // the colour the board draws this net's connection lines in. The panel path
  // and the lit net on the canvas are then visibly the same object.
  //
  // The derived ladder (--nw-rail, --nw-probe, …) lives in index.css under
  // `.net-scope`, which is applied to THIS element — the one carrying --nw.
  // It cannot live on :root: a custom property is substituted at
  // computed-value time on the element where it is declared, so a ladder
  // declared at :root would freeze against :root's --nw and never follow an
  // override. Keep the class and the inline --nw on the same node.
  const netWire = colorToHex(settings.netLineColor);
  const netScope = branchNet
    ? ({
        '--nw': netWire,
        // The raw colour is the wire; it is not necessarily readable as text.
        // A dark netLineColor still reads as a 1px line on black but not as a
        // net name, so the ink goes through the same luminance correction that
        // already produces --accent-text.
        '--nw-ink': accentTextColor(netWire, '#0f0f18'),
      } as React.CSSProperties)
    : undefined;

  /** Pin-table column count — the inline net row spans all of it. */
  const pinColumns = 3 + (board.diodeReference ? 1 : 0) + (obd.hasData ? 1 : 0);

  const meta = selectedPart.meta;
  const metaRows: Array<[string, string]> = [];
  if (meta?.partType) metaRows.push(['Type', meta.partType]);
  if (meta?.value) metaRows.push(['Value', meta.value]);
  if (meta?.package) metaRows.push(['Package', meta.package]);
  if (meta?.serial) metaRows.push(['Serial', meta.serial]);
  if (meta?.heightMils != null) metaRows.push(['Height', `${meta.heightMils.toFixed(2)} mils`]);
  if (meta?.angleDeg != null) metaRows.push(['Rotation', `${meta.angleDeg}°`]);

  return (
    <div
      className={`panel-content component-info ${branchNet ? 'component-info--with-net net-scope' : ''}`}
      style={netScope}
      data-testid="component-info"
    >
      <div className="info-header">
        <h3>{selectedPart.name}</h3>
        <div className="info-meta">
          <span className={`badge badge-${selectedPart.side}`}>{selectedPart.side}</span>
          <span className="badge">{selectedPart.type}</span>
          <span className="badge">{selectedPart.pins.length} pins</span>
          {obd.hasData && (
            <span
              className="badge"
              data-testid="obd-badge"
              title={`OpenBoardData loaded: ${obd.variantCount} variant(s)`}
              style={{ background: '#3a5', color: '#fff' }}
            >
              OBD ×{obd.variantCount}
            </span>
          )}
        </div>
      </div>

      {metaRows.length > 0 && (
        <table className="part-meta-table" data-testid="part-meta">
          <tbody>
            {metaRows.map(([k, v]) => (
              <tr key={k}>
                <th>{k}</th>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {cluster && (
        <BomClusterSection
          cluster={cluster}
          selectedRefdes={selectedPart.name}
          showAll={showBomAlternates}
          selections={bomClusterSelections}
        />
      )}

      <div className="pin-table-container">
        <table className="pin-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Name</th>
              <th>Net</th>
              {board.diodeReference && <th title="diode-mode reference reading baked into the board file (volts)">Diode</th>}
              {obd.hasData && <th title="diode / V / Ω from OpenBoardData">OBD</th>}
            </tr>
          </thead>
          <tbody>
            {selectedPart.pins.map((pin, idx) => {
              const isSelected = selection.pinIndex === idx;
              const isNetHighlighted = selection.highlightedNet === pin.net && pin.net !== '';
              const obdNets = obd.hasData ? obd.lookup(pin.net) : [];
              // This part's OTHER contacts on the same net. Marked so you can
              // see them without opening anything — the fact the old duplicate
              // "● this" row used to carry as "pins 3, 7".
              const isEcho = branchNet !== null && !isSelected && pin.net === branchNet;
              // The row where the pin list resumes after an inline net block:
              // it takes a hairline so the block's end is unambiguous.
              const isResume = branchNet !== null && selection.pinIndex === idx - 1;
              return (
                <Fragment key={idx}>
                <tr
                  className={[
                    isSelected ? 'pin-selected' : '',
                    isNetHighlighted ? 'pin-net-highlight' : '',
                    isEcho ? 'pin-echo' : '',
                    isResume ? 'pin-resume' : '',
                  ].join(' ')}
                  onClick={() => {
                    if (selection.partIndex !== null) {
                      boardStore.selectPin(selection.partIndex, idx);
                    }
                  }}
                >
                  <td>{pin.number}</td>
                  <td>{pin.name}</td>
                  <td
                    className="pin-net"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (isSelected) {
                        // Already the subject: the cell toggles the board highlight.
                        boardStore.highlightNet(
                          selection.highlightedNet === pin.net ? null : pin.net,
                        );
                      } else if (selection.partIndex !== null) {
                        // A different net: move the subject to this pin so the
                        // tree re-roots on it and opens, rather than merely
                        // lighting a net whose components stay out of view.
                        boardStore.selectPin(selection.partIndex, idx);
                      }
                    }}
                  >
                    {isSelected && branchNet && (
                      <span
                        className="pin-net-caret"
                        data-testid="net-caret"
                        role="button"
                        tabIndex={0}
                        aria-expanded={netOpen}
                        onClick={(e) => { e.stopPropagation(); setCollapsedNet(netOpen ? branchNet : null); }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.stopPropagation(); e.preventDefault();
                            setCollapsedNet(netOpen ? branchNet : null);
                          }
                        }}
                        title={netOpen ? 'Collapse the net' : 'Expand the net'}
                      >
                        {netOpen ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
                      </span>
                    )}
                    {pin.net}
                    {isSelected && branchNet && netStats && (
                      <span className="pin-net-counts" data-testid="net-counts">
                        {' · '}{netStats.pins} pin{netStats.pins === 1 ? '' : 's'}
                        {' · '}{netStats.comps} comp{netStats.comps === 1 ? '' : 's'}
                      </span>
                    )}
                  </td>
                  {board.diodeReference && (
                    <td className="pin-diode" data-testid="pin-diode-cell"
                        style={{ fontSize: 11, fontFamily: 'monospace',
                                 color: pin.diode?.kind === 'open' ? '#f87171'
                                      : pin.diode?.kind === 'value' ? '#4ade80' : '#666' }}>
                      {pin.diode && pin.diode.kind !== 'none'
                        ? formatDiode(pin.diode)
                        : <span style={{ color: '#666' }}>—</span>}
                    </td>
                  )}
                  {obd.hasData && (
                    <td className="pin-obd" data-testid="pin-obd-cell">
                      <ObdCell nets={obdNets} />
                    </td>
                  )}
                </tr>
                {/* The tree hangs from the pin row it belongs to, so the link
                    is a few pixels rather than a page. It stays short whatever
                    the net's size: NetBranchSection shows the first few and
                    puts the rest behind "+N more". Keyed by net so each net
                    switch starts with every spoiler closed. */}
                {isSelected && branchNet && netOpen && (
                  <tr className="net-slot">
                    <td colSpan={pinColumns}>
                      <NetBranchSection
                        key={branchNet}
                        board={board}
                        net={branchNet}
                        selection={selection}
                        obd={obd}
                      />
                    </td>
                  </tr>
                )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Structured DIAGNOSIS_DATA from openboarddata.org — power sequencing,
          repair notes, etc. Each fetched variant rendered sequentially. */}
      {obdNotes}
    </div>
  );
}

/** The selected pin's net, or null when no pin is selected. Used as the reset
 *  key for the tree's open state. */
function selectedPinNet(board: BoardData, selection: SelectionState): string | null {
  if (selection.partIndex === null || selection.pinIndex === null) return null;
  return board.parts[selection.partIndex]?.pins[selection.pinIndex]?.net || null;
}

function BomClusterSection({
  cluster,
  selectedRefdes,
  showAll,
  selections,
}: {
  cluster: BomAlternateCluster;
  selectedRefdes: string;
  showAll: boolean;
  selections: ReadonlyMap<string, string>;
}) {
  const sig = bomClusterSig(cluster.memberRefdes);
  const chosenRefdes = selections.get(sig) ?? cluster.defaultPrimaryRefdes;
  const reasonLabel = bomReasonLabel(cluster.reason);

  return (
    <div className="bom-cluster-section" data-testid="bom-cluster-section">
      <div
        className="bom-cluster-header"
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          marginTop: 8,
          padding: '4px 6px',
          background: 'rgba(120,80,200,0.12)',
          borderRadius: 4,
        }}
      >
        <strong style={{ fontSize: 12 }}>BOM alternates ({cluster.memberRefdes.length})</strong>
        <span style={{ fontSize: 11, color: '#888' }} title={`Auto-pick reason: ${reasonLabel}`}>
          auto: {reasonLabel}
        </span>
      </div>
      <div style={{ fontSize: 11, color: '#888', padding: '2px 6px' }}>
        Only one is fitted per BOM.{' '}
        {showAll ? 'All shown (X-ray).' : 'Click a row to switch which member is rendered.'}
      </div>
      <table
        className="bom-cluster-table"
        data-testid="bom-cluster-table"
        style={{ width: '100%', fontSize: 11, marginTop: 4 }}
      >
        <tbody>
          {cluster.memberRefdes.map((refdes, i) => {
            const isChosen = refdes === chosenRefdes;
            const isSelected = refdes === selectedRefdes;
            const memberIdx = cluster.memberIndices[i];
            const statusLabel = memberStatusLabel(isChosen, isSelected);
            let rowBackground: string | undefined;
            if (isSelected) rowBackground = 'rgba(120,80,200,0.22)';
            else if (isChosen) rowBackground = 'rgba(120,80,200,0.10)';
            return (
              <tr
                key={refdes}
                style={{
                  cursor: showAll ? 'default' : 'pointer',
                  background: rowBackground,
                }}
                onClick={() => {
                  if (showAll) {
                    // Show-all mode: clicking a row jumps the selection to that member.
                    boardStore.selectPart(memberIdx);
                  } else {
                    // Hidden mode: clicking sets the active primary.
                    boardStore.selectBomClusterPrimary(sig, refdes);
                  }
                }}
                title={showAll ? `Select ${refdes}` : `Render ${refdes} as the primary`}
              >
                <td style={{ padding: '2px 6px', width: 18 }}>
                  {isChosen ? '●' : <span style={{ color: '#666' }}>○</span>}
                </td>
                <td style={{ padding: '2px 6px', fontWeight: isSelected ? 700 : 400 }}>{refdes}</td>
                <td style={{ padding: '2px 6px', color: '#888' }}>{statusLabel}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Suffix shown next to a BOM-cluster member: marks the rendered primary, the
 *  currently-selected member, or both. */
function memberStatusLabel(isChosen: boolean, isSelected: boolean): string {
  if (isChosen && isSelected) return '(primary, selected)';
  if (isChosen) return '(primary)';
  if (isSelected) return '(selected)';
  return '';
}
