/**
 * ReleaseNotes — the single renderer for a manifest's `notes` payload.
 *
 * The notes are a slice of CHANGELOG.md embedded in the signed manifest by
 * scripts/release.sh, so this is a deliberately small markdown subset:
 * `## heading`, `### heading`, `- bullet`, everything else a paragraph. Table
 * rows and horizontal rules are dropped — they carry no meaning once the
 * pipes are gone.
 *
 * It lives here, not inline in Toolbar, because two surfaces render the same
 * payload — the update badge dropdown and the start page's "Latest update"
 * card. Keeping one renderer is what stops them drifting the way the two
 * component-info copies did before ComponentInfoBody unified them.
 */
import { useState } from 'react';

export interface ReleaseNotesProps {
  /** Raw notes text from the manifest. */
  notes: string;
  /** When set, clip to this many lines behind a "Show all" toggle. Omitted =
   *  render everything (the dropdown's behaviour, where the surrounding
   *  <details> is already the disclosure). */
  maxLines?: number;
}

export function ReleaseNotes({ notes, maxLines }: ReleaseNotesProps) {
  const [expanded, setExpanded] = useState(false);
  // Blank lines are structure, not content — they render to nothing, so
  // counting them would make a clipped preview look arbitrarily short.
  const lines = notes.split('\n').filter(l => l.trim().length > 0);
  const clipped = maxLines != null && !expanded && lines.length > maxLines;
  const shown = clipped ? lines.slice(0, maxLines) : lines;

  return (
    <div className="release-notes" data-testid="release-notes">
      {shown.map((line, i) => renderLine(line, i))}
      {maxLines != null && lines.length > maxLines && (
        <button
          type="button"
          className="release-notes-toggle"
          onClick={() => setExpanded(v => !v)}
        >
          {clipped ? `Show all (${lines.length} lines)` : 'Show less'}
        </button>
      )}
    </div>
  );
}

function renderLine(line: string, i: number) {
  if (line.startsWith('## ')) return <h3 key={i}>{line.slice(3)}</h3>;
  if (line.startsWith('### ')) return <h4 key={i}>{line.slice(4)}</h4>;
  if (line.startsWith('- ')) return <li key={i}>{stripEmphasis(line.slice(2))}</li>;
  if (line.startsWith('| ') || line.startsWith('---')) return null;
  return <p key={i}>{stripEmphasis(line)}</p>;
}

/** The changelog leads bullets with `**bold**` labels. Rendering the asterisks
 *  literally reads worse than dropping them, and a full inline parser is more
 *  machinery than one emphasis style is worth. */
function stripEmphasis(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
}
