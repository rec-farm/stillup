import { useId } from 'react';

/**
 * REC StillUp mark (Lens + Pulse), transcribed from logos/stillup-mark-*.svg in the
 * REC Design System. Single color via currentColor; the pulse is a knock-out.
 * Use `micro` below 32px. Never redraw or restyle the geometry.
 */
export function EyeMark({
  className = '',
  micro = false,
}: {
  className?: string;
  micro?: boolean;
}) {
  const mask = useId();
  return (
    <svg className={className} width="40" height="40" viewBox="0 0 48 48" aria-hidden="true">
      <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="48" height="48">
        <rect width="48" height="48" fill="#fff" />
        <path
          d={
            micro
              ? 'M2 24H14L22 12L28 35L33 24H46'
              : 'M2 24H13.5L17.5 17L23 31L28.5 13.5L32.5 27.5L35 24H46'
          }
          fill="none"
          stroke="#000"
          strokeWidth={micro ? 5 : 3.6}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </mask>
      <path
        d={
          micro
            ? 'M1 24C9 8 39 8 47 24C39 40 9 40 1 24Z'
            : 'M2 24C10 10 38 10 46 24C38 38 10 38 2 24Z'
        }
        fill="currentColor"
        mask={`url(#${mask})`}
      />
    </svg>
  );
}
