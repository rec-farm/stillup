/**
 * REC StillUp illustration in both colorways: the Paper art on light surfaces and the
 * Dark art (cream line work, one Sun accent) everywhere else. CSS shows the one that matches
 * the surface; both are decorative.
 */
export function Illustration({
  name,
  className = '',
  width,
  height,
}: {
  name: 'header-stillup' | 'empty-state-stillup';
  className?: string;
  width: number;
  height: number;
}) {
  return (
    <span className={`illustration ${className}`} aria-hidden="true">
      {(['light', 'dark'] as const).map((tone) => (
        <img
          key={tone}
          className={`illustration-${tone}`}
          src={`/illustrations/${name}-${tone}.svg`}
          width={width}
          height={height}
          alt=""
        />
      ))}
    </span>
  );
}

/** Page-header illustration (240×140 slot), hidden below 768px via CSS. */
export function WatchfulArt({ className = '' }: { className?: string }) {
  return (
    <Illustration
      name="header-stillup"
      className={`watchful-art ${className}`}
      width={240}
      height={140}
    />
  );
}
