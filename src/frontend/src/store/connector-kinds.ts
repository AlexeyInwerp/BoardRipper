/**
 * Connector semantics — what a connector is, from its reference designator,
 * its pin count and its pad pattern, in that order of trust.
 *
 * The designator decides *that* it is a connector: `J…` is a connector by
 * convention on every board (no IC starts with J), as are `CN`, `CON`, `X`,
 * `P<digit>`, `JP`, `SKT`. A keyword in the designator (JDDRH, JUSB2, JFAN1,
 * JEDP1, JSSD1 …) names the *kind*; the pin count checks it; the pad pattern
 * decides when the name says nothing. A connector never falls through to the
 * IC rules — a 264-pin SODIMM socket is not a USB-C port and a 79-pin
 * keyboard ZIF is not a BGA.
 *
 * Pure: no store, no renderer. Dimensions in mm; the body's L runs along the
 * pin row(s). Rules: docs/specs/2026-11-15-cpu-packages.md ▸ Connectors.
 */

export type ConnectorKind =
  | 'sodimm' | 'usb-c' | 'usb-a' | 'hdmi' | 'dp' | 'rj45' | 'm2' | 'fpc' | 'b2b'
  | 'battery' | 'fan' | 'wire' | 'dc-in' | 'audio' | 'header' | 'card' | 'coax' | 'generic';

/** What the estimator measured on the pin field (mm). */
export interface ConnectorGeometry {
  n: number;
  /** Parallel pin rows and pins per row (largest row). */
  rows: number; perRow: number;
  /** Pitch along a row. */
  pitch: number;
  /** Field span along the row (L) and across it (W). */
  spanL: number; spanW: number;
  /** Pads much larger than the signal pads (shell tabs, blade terminals) and drilled pins. */
  bigPads: number; drilled: number;
}

export interface ConnectorKindResult {
  kind: ConnectorKind;
  /** Short label for the Info panel and the model ("SODIMM", "USB-C", "FPC 30"). */
  label: string;
  L: number; W: number; H: number;
  /** Where the body sits across the row: 0 = centred on the field, +1 = extends to +W (mating face) from the row. */
  offsetW: number;
  evidence: 'name' | 'pattern' | 'fallback';
  why: string;
}

/** A reference designator that names a connector. `P` only with a digit after it: Compal/LCFC boards use
 *  `PU…`, `PQ…`, `PR…`, `PC…` for ICs and passives on the power side. */
export function isConnectorRef(ref: string): boolean {
  return /^(J[A-Z0-9_]|CN\d|CON\d?|X\d|P\d|JP\d|SKT|SOCK|JACK)/i.test(ref.trim());
}

/** Keyword table — first match wins. Keys are matched against the designator with its leading J/CN/P and
 *  trailing digits removed (JDDRH1 → DDRH, JUSB2 → USB, JEDP1 → EDP). */
const KEYWORDS: [RegExp, ConnectorKind][] = [
  [/^(DDR|DIMM|SODIMM|MEM|RAM)/, 'sodimm'],
  [/^(TB|TBT|TYPEC|TYPE_?C|USBC|UC|USB_?C)/, 'usb-c'],
  [/^(USB|UA|USBA)/, 'usb-a'],
  [/^HDMI/, 'hdmi'],
  [/^(DP|MDP|DISPLAYPORT)/, 'dp'],
  [/^(EDP|LVDS|LCD|PANEL|DISP|CAM|CCD|KB|KBD|KEYB|TP|TPAD|TOUCH|FP|FPR|FINGER|RGB|KBL|LB|SENS|MIC|SPK_FPC|HALL)/, 'fpc'],
  [/^(RJ45|LAN|ETH|GBE|NIC)/, 'rj45'],
  [/^(SSD|M2|NGFF|WLAN|WWAN|WIFI|PCIE|NVME)/, 'm2'],
  [/^(BAT|BATT|RTC_BAT)/, 'battery'],
  [/^FAN/, 'fan'],
  [/^(SPK|SPEAKER|RTC|CMOS|LED|UL|BL)/, 'wire'],
  [/^(DCIN|DC_?IN|DC|PWR|POWER|ADP|ADAPTER|CHG)/, 'dc-in'],
  [/^(AUDIO|AUD|HP|JACK|HEADPHONE|HS|LINE)/, 'audio'],
  [/^(IO|B2B|BTB|DOCK|SUB|IOB|DB|MB)/, 'b2b'],
  [/^(CDBG|DBG|JTAG|SWD|UART|DEBUG|DEBUG_)/, 'header'],
  [/^(SD|SIM|CARD|TF|MMC|CR)/, 'card'],
  [/^(ANT|RF|COAX|MHF|IPEX|UFL|WL_?ANT)/, 'coax'],
];

/** The keyword part of a designator: JDDRH1 → DDRH, CN12 → '', JUSB2 → USB. */
export function connectorKeyword(ref: string): string {
  return ref.trim().toUpperCase().replace(/^(J|CN|CON|JP|P|X|SKT|SOCK)/, '').replace(/[\d_]+$/, '');
}

export function kindFromName(ref: string): ConnectorKind | null {
  const full = ref.trim().toUpperCase().replace(/^(J|CN|CON|JP|P|X|SKT|SOCK)/, ''), k = connectorKeyword(ref); if (!full) return null;
  for (const [re, kind] of KEYWORDS) if (re.test(full) || (k && re.test(k))) return kind; // RJ45, M2: the digits are part of the word
  return null;
}

/** USB-C receptacle: two rows of 6–14 signal pads at 0.4–0.6 mm inside 9.5 mm, plus shell tabs. Every other
 *  two-row fine-pitch connector (SODIMM, eDP, keyboard FPC) fails one of these. */
export function looksLikeUsbC(g: ConnectorGeometry): boolean {
  return g.rows === 2 && g.perRow >= 6 && g.perRow <= 14 && g.pitch >= 0.4 && g.pitch <= 0.6 && g.spanL <= 9.5 && g.bigPads >= 2 && g.n - g.bigPads <= 30;
}

/** Pin count sanity for a kind named by keyword: a "DDR" part with 12 pins is not a SODIMM socket. */
function countFits(kind: ConnectorKind, n: number): boolean {
  switch (kind) {
    case 'sodimm': return n >= 200;
    case 'usb-c': return n >= 6 && n <= 34;
    case 'usb-a': return n >= 4 && n <= 20;
    case 'hdmi': return n >= 19 && n <= 26;
    case 'dp': return n >= 20 && n <= 26;
    case 'rj45': return n >= 8 && n <= 20;
    case 'm2': return n >= 50 && n <= 80;
    default: return true;
  }
}

/** Body by kind and geometry. L runs along the row; the mating face is at +W. */
function bodyFor(kind: ConnectorKind, g: ConnectorGeometry): { L: number; W: number; H: number; offsetW: number } {
  switch (kind) {
    case 'sodimm': return { L: Math.max(g.spanL + 4, 73), W: Math.max(10, g.spanW + 2), H: g.spanW > 12 ? 9.2 : 5.2, offsetW: 0.6 }; // a stacked dual socket is deeper and taller
    case 'usb-c': return { L: 8.94, W: 7.35, H: 3.26, offsetW: 0.8 };
    case 'usb-a': return { L: 14.5, W: 14.6, H: 7.2, offsetW: 0.5 };
    case 'hdmi': return { L: 15.2, W: 11.7, H: 6.0, offsetW: 0.5 };
    case 'dp': return { L: 17.5, W: 11.0, H: 5.3, offsetW: 0.5 };
    case 'rj45': return { L: 16.2, W: 21.3, H: 13.5, offsetW: 0.5 };
    case 'm2': return { L: Math.max(g.spanL + 2, 21), W: 7.5, H: 4.2, offsetW: 0.5 };
    case 'fpc': return { L: g.spanL + 3, W: g.pitch >= 0.9 ? 6 : 4.8, H: g.pitch >= 0.9 ? 2.6 : 1.7, offsetW: 0.6 };
    case 'b2b': return { L: g.spanL + 1.6, W: Math.max(g.spanW + 1.2, 3.0), H: 1.0, offsetW: 0 };
    case 'battery': return { L: g.spanL + 2.5, W: 6.5, H: 4.5, offsetW: 0.5 };
    case 'fan': return { L: g.spanL + 2.2, W: 4.5, H: 3.6, offsetW: 0.6 };
    case 'wire': return { L: g.spanL + 2.4, W: g.pitch >= 1.9 ? 4.8 : 3.0, H: g.pitch >= 1.9 ? 3.9 : 3.0, offsetW: 0.6 };
    case 'dc-in': return { L: 12, W: 10, H: 7, offsetW: 0.5 };
    case 'audio': return { L: 12, W: 6.2, H: 5, offsetW: 0.5 };
    case 'header': return { L: g.spanL + g.pitch, W: g.spanW + g.pitch, H: 2.5, offsetW: 0 };
    case 'card': return { L: g.spanL + 4, W: Math.max(g.spanW + 6, 16), H: 2.2, offsetW: 0.5 };
    case 'coax': return { L: 2.6, W: 2.6, H: 1.2, offsetW: 0 };
    default: return { L: g.spanL + 2, W: Math.max(g.spanW + 2, 4), H: 4, offsetW: 0.3 };
  }
}

const LABEL: Record<ConnectorKind, string> = { sodimm: 'SODIMM', 'usb-c': 'USB-C', 'usb-a': 'USB-A', hdmi: 'HDMI', dp: 'DisplayPort', rj45: 'RJ45', m2: 'M.2', fpc: 'FPC', b2b: 'board-to-board', battery: 'battery', fan: 'fan', wire: 'wire-to-board', 'dc-in': 'DC-in', audio: 'audio jack', header: 'header', card: 'card slot', coax: 'coax', generic: 'connector' };

/** The kind of a connector, named first, checked by count, else by pattern, else a generic connector. */
export function classifyConnector(ref: string, g: ConnectorGeometry): ConnectorKindResult {
  const named = kindFromName(ref);
  let kind: ConnectorKind, evidence: ConnectorKindResult['evidence'], why: string;
  if (named && countFits(named, g.n)) { kind = named; evidence = 'name'; why = `${ref}: "${connectorKeyword(ref)}" → ${LABEL[kind]}, ${g.n} pins`; }
  else if (looksLikeUsbC(g)) { kind = 'usb-c'; evidence = 'pattern'; why = `${g.n} pins: two rows of ${g.perRow} @ ${g.pitch.toFixed(2)} + ${g.bigPads} shell tabs → USB-C`; }
  else if (g.n >= 200 && g.pitch <= 0.7 && g.spanL >= 55) { kind = 'sodimm'; evidence = 'pattern'; why = `${g.n} pins @ ${g.pitch.toFixed(2)} over ${g.spanL.toFixed(0)} mm → SODIMM socket`; }
  else if (g.n >= 50 && g.n <= 80 && g.rows <= 2 && g.pitch <= 0.65 && g.spanL >= 17 && g.spanL <= 23) { kind = 'm2'; evidence = 'pattern'; why = `${g.n} pins @ ${g.pitch.toFixed(2)} over ${g.spanL.toFixed(1)} mm → M.2 socket`; }
  else if (g.rows === 2 && g.pitch >= 0.3 && g.pitch <= 0.55 && g.spanW <= 4.5 && g.n >= 10) { kind = 'b2b'; evidence = 'pattern'; why = `${g.n} pins in two rows ${g.spanW.toFixed(1)} mm apart @ ${g.pitch.toFixed(2)} → board-to-board`; }
  else if (g.rows === 1 && g.pitch >= 0.3 && g.pitch <= 0.6 && g.n >= 6) { kind = 'fpc'; evidence = 'pattern'; why = `${g.n} pins in one row @ ${g.pitch.toFixed(2)} → FPC`; }
  else if (g.rows === 1 && g.pitch >= 0.9 && g.pitch <= 2.6 && g.n >= 2) { kind = 'wire'; evidence = 'pattern'; why = `${g.n} pins in one row @ ${g.pitch.toFixed(2)} → wire-to-board`; }
  else if (g.drilled >= g.n * 0.8 && g.pitch >= 1.9) { kind = 'header'; evidence = 'pattern'; why = `${g.n} drilled pins @ ${g.pitch.toFixed(2)} → header`; }
  else { kind = named ?? 'generic'; evidence = named ? 'name' : 'fallback'; why = named ? `${ref}: "${connectorKeyword(ref)}" → ${LABEL[kind]} (pin count ${g.n} unusual)` : `${ref}: ${g.n} pins, no known pattern → connector`; }
  const b = bodyFor(kind, g);
  return { kind, label: kind === 'fpc' ? `FPC ${g.n}` : LABEL[kind], ...b, evidence, why };
}
