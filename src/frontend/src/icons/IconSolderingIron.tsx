import React from 'react';

/** Hand-composed soldering-iron icon for the Worklist's "rework" mark.
 *
 *  Iron silhouette: `mdi:soldering-iron` (Material Design Icons, Apache 2.0),
 *  with the cord subpath dropped and the remaining handle + heating-element
 *  paths mirrored horizontally + scaled to 0.92 for breathing room.
 *
 *  Smoke wisp: an original hand-traced tapered shape inspired by the smoke
 *  curl in `game-icons:soldering-iron` (Game Icons, CC BY 3.0), redrawn from
 *  scratch with explicit pointy endpoints.
 *
 *  Attribution lives in THIRD_PARTY.md. */
interface IconProps extends Omit<React.SVGAttributes<SVGSVGElement>, 'stroke'> {
  size?: string | number;
  stroke?: string | number;
  title?: string;
}

export const IconSolderingIron = React.forwardRef<SVGSVGElement, IconProps>(
  ({ size = 24, stroke: _stroke, color, title, ...rest }, ref) => (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={(color as string | undefined) ?? 'currentColor'}
      {...rest}
    >
      {title && <title>{title}</title>}
      <g transform="translate(12 12) scale(-0.92 0.92) translate(-12 -12)">
        <path d="M4.86 4.03L2.03 6.86l3.18 3.18v2.83l1.42 1.41l5.65-5.65l-1.41-1.42H8.04z" />
        <path d="M11.93 11.1L9.1 13.93l4.95 4.95l.71-.71l2.12 2.12L19 21l-.71-2.12l-2.12-2.12l.71-.71z" />
      </g>
      <path
        transform="translate(1 0)"
        d="M5.4 3.4C4 5 2 6.6 2.3 8.8C2.6 10.7 5.6 11 5.6 13C5.6 14.9 2.6 15.6 3 17.4C3.3 18.8 3.9 19.4 4.2 20.6C3.3 20.1 2.4 19.4 2.2 17.7C1.9 15.6 4.6 15 4.6 13C4.6 11 1.6 10.8 1.5 8.8C1.3 6.4 3.5 4.8 5.4 3.4Z"
      />
    </svg>
  ),
);
IconSolderingIron.displayName = 'IconSolderingIron';
