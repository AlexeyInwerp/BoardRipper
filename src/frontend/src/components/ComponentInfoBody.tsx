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
 *   - WHERE that tree is mounted. Small nets hang inline as a row inside the
 *     pin table directly under the pin they belong to; nets with more than
 *     NET_TREE_INLINE_MAX other components move below the table so a power
 *     rail can never bury the pinout. The two placements deliberately differ
 *     in their header — see NetBranchSection.
 *   - The --nw colour scope every net tint derives from. Read the comment at
 *     the declaration below before moving it: the derived ladder in index.css
 *     only works while it sits on the same element as --nw.
 */
import { Fragment, useEffect } from 'react';
import { bomReasonLabel, type BoardData, type BomAlternateCluster } from '../parsers';
import type { SelectionState } from '../store/board-store';
import { boardStore, bomClusterSig } from '../store/board-store';
import { obdStore, useObdNetLookup } from '../store/obd-store';
import { formatDiode } from '../store/diode-readings';
import { useRenderSettings } from '../hooks/useRenderSettings';
import { colorToHex } from '../store/layer-store';
import { accentTextColor } from '../store/color-math';
import { DiagnosisNotes } from './DiagnosisNotes';
import { NetBranchSection, countNetComponents, NET_TREE_INLINE_MAX } from './NetBranchSection';
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

  // Auto-load matches + cached data when the active board changes. Cheap:
  // hits the backend's match endpoint once per board, and the per-bpath
  // cache loaders are short-circuited if already in memory.
  useEffect(() => {
    if (boardNumber) obdStore.loadMatches(boardNumber);
  }, [boardNumber]);

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

  // The net branch section is pin-scoped, not part-scoped: a part-only
  // selection derives `highlightedNet` from an arbitrary pin (or none at
  // all), so a branch shown there would be a guess. Component selected →
  // component only; pin selected → component + its net.
  const selectedPin =
    selection.pinIndex !== null ? selectedPart.pins[selection.pinIndex] ?? null : null;
  const branchNet = selectedPin?.net || null;

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

  // Placement: a big rail must not bury the pinout. Small nets hang inline
  // under their own pin row (the link is unmissable at that distance); larger
  // ones move below the table, where the pin list stays scannable end to end.
  const otherCount = branchNet ? countNetComponents(board, branchNet, selection.partIndex) : 0;
  const netPlacement: 'inline' | 'below' = otherCount <= NET_TREE_INLINE_MAX ? 'inline' : 'below';
  const inlineNet = branchNet !== null && netPlacement === 'inline';
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
              const isResume = inlineNet && selection.pinIndex === idx - 1;
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
                      boardStore.highlightNet(
                        selection.highlightedNet === pin.net ? null : pin.net,
                      );
                    }}
                  >
                    {pin.net}
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
                {/* Small net: the tree hangs from the pin row it belongs to,
                    so the link is a few pixels rather than a page. */}
                {inlineNet && isSelected && branchNet && (
                  <tr className="net-slot">
                    <td colSpan={pinColumns}>
                      <NetBranchSection
                        key={branchNet}
                        board={board}
                        net={branchNet}
                        selection={selection}
                        obd={obd}
                        placement="inline"
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

      {/* Big net: below the pin table, so a 400-component rail can't bury the
          pinout. Keyed by net so each net switch starts with all spoilers
          closed. */}
      {branchNet && !inlineNet && (
        <NetBranchSection
          key={branchNet}
          board={board}
          net={branchNet}
          selection={selection}
          obd={obd}
          placement="below"
        />
      )}

      {/* Structured DIAGNOSIS_DATA from openboarddata.org — power sequencing,
          repair notes, etc. Each fetched variant rendered sequentially. */}
      {obdNotes}
    </div>
  );
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
