// Pure, WS-independent helpers for the MCP live-board bridge, split out so they
// are unit-testable without a socket or a live board.

/** Heuristic: does this net name carry semantic meaning, or is it an
 *  auto-generated placeholder the model must not read function into? Tunable —
 *  extend the synthetic patterns as new formats surface (see spec §12.9). */
const SYNTHETIC_PATTERNS: RegExp[] = [
  /^\s*$/,          // empty / whitespace
  /^n\$\d+$/i,      // Altium-style N$123
  /^net\d+$/i,      // NET0042
  /^\$?\d+$/,       // bare number, optional leading $
  /^unnamed/i,      // UNNAMED_*
  /^node\d+$/i,     // NODE12
];

export function classifyNetName(name: string): 'named' | 'synthetic' {
  const n = name ?? '';
  return SYNTHETIC_PATTERNS.some((re) => re.test(n)) ? 'synthetic' : 'named';
}
