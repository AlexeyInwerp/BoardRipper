import React from 'react';

/** Hand-drawn outline multimeter (digital handheld DMM: body + display + rotary
 *  selector dial + two probe leads splaying out the bottom) for the worklist
 *  net-measurement readings. Drawn on the 24×24 Tabler grid with the Tabler
 *  outline stroke conventions so it matches the diode / V / Ω glyphs it sits
 *  beside. Original work (no third-party SVG). */
interface IconProps extends Omit<React.SVGAttributes<SVGSVGElement>, 'stroke'> {
  size?: string | number;
  stroke?: string | number;
  title?: string;
}

export const IconMultimeter = React.forwardRef<SVGSVGElement, IconProps>(
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
      <rect x="6" y="2.5" width="12" height="13" rx="2" />
      <path d="M9 6h6" />
      <circle cx="12" cy="10.8" r="2.4" />
      <path d="M12 10.8l1.5 -1.5" />
      <path d="M9.8 15.5c-1.3 1.6 -3.3 2.4 -3.8 5" />
      <path d="M14.2 15.5c1.3 1.6 3.3 2.4 3.8 5" />
    </svg>
  ),
);
IconMultimeter.displayName = 'IconMultimeter';
