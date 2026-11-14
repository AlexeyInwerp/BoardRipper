// Part-by-part review of the render (estimate from package names) against
// Adafruit's product photos 4884-05 (top) and 4884-04 (angled), 2026-11-14.
// [status, note] — ok: same part, size, place and look; warn: right part and
// place, look simplified; bad: wrong. "Pins only:" notes where the plain-
// boardview estimate differs.
window.VERDICT3D = {
  C1: ['ok', '0805 MLCC, place and size match'], C4: ['ok', '0805 MLCC'], C5: ['ok', '0805 MLCC'], C20: ['ok', '0805 MLCC'],
  C2: ['ok', '0603 MLCC'], C3: ['ok', '0603 MLCC'], C6: ['ok', '0603 MLCC'], C7: ['ok', '0603 MLCC'], C8: ['ok', '0603 MLCC'], C9: ['ok', '0603 MLCC'],
  C10: ['ok', '0603 MLCC'], C11: ['ok', '0603 MLCC'], C12: ['ok', '0603 MLCC'], C13: ['ok', '0603 MLCC'], C14: ['ok', '0603 MLCC'], C15: ['ok', '0603 MLCC'], C16: ['ok', '0603 MLCC'],
  R1: ['ok', '0603 resistor'], R2: ['ok', '0603 resistor'], R3: ['ok', '0603 resistor'], R4: ['ok', '0603 resistor'], R5: ['ok', '0603 resistor'], R6: ['ok', '0603 resistor'],
  R7: ['ok', '0603 resistor'], R8: ['ok', '0603 resistor'], R9: ['ok', '0603 resistor'], R10: ['ok', '0603 resistor'], R11: ['ok', '0603 resistor'], R12: ['ok', '0603 resistor'], R13: ['ok', '0603 resistor'],
  L: ['ok', 'red 0603 LED ("13"), lens colour from the value field. Pins only: refdes L reads as an inductor — dark body, no lens'],
  CHG: ['ok', 'orange 0603 LED. Pins only: neutral chip'],
  SW1: ['ok', 'KMR2 tact switch, metal top and grey plunger'],
  SW3: ['warn', 'right-angle BOOTSEL switch, actuator out over the edge as in the photo; body a little tall. Pins only: drawn upright — the pins cannot tell'],
  U2: ['ok', 'SOT-23-5 regulator'], U3: ['ok', 'SOT-23-5 charger'],
  Q3: ['ok', 'SOT-23 P-FET (first cut was turned ~20°: the lone pin skewed the angle; fixed)'],
  D4: ['ok', 'SOD-123 Schottky'], D1: ['ok', 'SOD-323 Schottky'],
  LED1: ['ok', 'WS2812 3535 RGB LED: white body, round lens'],
  U1: ['ok', 'USON-8 4×4 flash ("8MB")'],
  IC1: ['ok', 'RP2040 QFN-56 7×7; the laser marking is the one thing missing'],
  Y1: ['ok', '12 MHz crystal 2.5×2, metal lid'],
  X6: ['warn', 'USB-C: place, size and overhang past the edge match; overhang offset tuned on this board only'],
  X1: ['warn', 'JST PH battery connector: footprint and height right, housing simplified (photo: latch ramp, closed sides)'],
  CONN1: ['ok', 'STEMMA QT (JST SH 4): mouth faces the board edge as in the photo'],
  X2: ['ok', 'SWD 2×5 1.27 "NOCREAM": not fitted, gold pads only — as in the photo. Pins only: a SOIC body is drawn on the pads (wrong)'],
  JP1: ['ok', '16 plated holes; headers ship loose, so "not fitted" by default matches'], JP3: ['ok', '12 plated holes, not fitted'],
  'U$31': ['ok', 'plated mounting hole'], 'U$32': ['ok', 'plated mounting hole'],
  'U$34': ['ok', 'fiducial'], 'U$35': ['ok', 'fiducial'],
  TP1: ['ok', 'bottom test pad'], TP2: ['ok', 'bottom test pad'], TP3: ['ok', 'bottom test pad'],
  'D+1': ['ok', 'bottom USB D+ test pad'], 'D-1': ['ok', 'bottom USB D− test pad'],
};
