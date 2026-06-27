import React from 'react';

/** Hand-drawn outline multimeter / meter icons for the worklist net-measurement
 *  readings — drawn on the 24×24 Tabler grid with the Tabler outline stroke
 *  conventions so they match the diode / V / Ω glyphs they sit beside. Original
 *  work (no third-party SVG); SVGRepo / Noun Project sources were unreachable
 *  (bot-protected) and Noun Project requires attribution anyway. */
interface IconProps extends Omit<React.SVGAttributes<SVGSVGElement>, 'stroke'> {
  size?: string | number;
  stroke?: string | number;
  title?: string;
}

function makeIcon(displayName: string, paths: React.ReactNode) {
  const Comp = React.forwardRef<SVGSVGElement, IconProps>(
    ({ size = 24, stroke = 2, color, title, ...rest }, ref) => (
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke={(color as string | undefined) ?? 'currentColor'}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeLinejoin="round"
        {...rest}
      >
        {title && <title>{title}</title>}
        {paths}
      </svg>
    ),
  );
  Comp.displayName = displayName;
  return Comp;
}

/** A — digital handheld DMM: body + display + rotary selector dial + probe lead. */
export const IconMultimeterDmm = makeIcon('IconMultimeterDmm', (
  <>
    <rect x="3.5" y="3" width="11" height="18" rx="2" />
    <path d="M6 7h6" />
    <circle cx="9" cy="14.5" r="2.6" />
    <path d="M9 14.5l1.5 -1.5" />
    <path d="M14.5 9c3.5 .5 5 2.8 5 5.5v2.5" />
    <path d="M19.5 19v2" />
  </>
));

/** B — simple DMM: body + display + dial (no probe). */
export const IconMultimeterSimple = makeIcon('IconMultimeterSimple', (
  <>
    <rect x="5" y="3" width="10.5" height="18" rx="2" />
    <path d="M7.6 7h5.3" />
    <circle cx="10.2" cy="14.5" r="3" />
    <path d="M10.2 14.5l1.8 -1.8" />
  </>
));

/** C — analog needle meter: face + gauge arc + needle + terminals. */
export const IconMeterGauge = makeIcon('IconMeterGauge', (
  <>
    <rect x="3" y="4.5" width="18" height="15" rx="2" />
    <path d="M7.5 15a4.5 4.5 0 0 1 9 0" />
    <path d="M12 15l3.2 -2.6" />
    <path d="M8 18.5h2M14 18.5h2" />
  </>
));
