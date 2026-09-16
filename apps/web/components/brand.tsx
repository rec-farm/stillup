export function Brand() {
  return (
    <span className="brand">
      {/* The adjacent wordmark supplies the accessible name. */}
      <img className="brand-mark" src="/brand/stillup-mark.svg" width={33} height={33} alt="" />
      StillUp<span className="brand-dot">.</span>
    </span>
  );
}
