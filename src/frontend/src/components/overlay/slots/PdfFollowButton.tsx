import { boardStore } from '../../../store/board-store';
import type { SlotCtx } from '../slot-ctx';

export function PdfFollowButton({ ctx }: { ctx: SlotCtx }) {
  const { followPdf, pdfFileNames } = ctx.thisTab;
  return (
    <button
      className={`board-netlines-toggle ${followPdf ? 'active' : ''}`}
      onClick={() => boardStore.toggleFollowPdf()}
      disabled={pdfFileNames.length === 0}
      title={pdfFileNames.length === 0
        ? "PDF follow needs a linked PDF — use the ∞ button on this board's tab (or the PDF toolbar) to link one"
        : followPdf ? 'PDF follow: ON' : 'PDF follow: OFF'}
    >
      ⇶
    </button>
  );
}
