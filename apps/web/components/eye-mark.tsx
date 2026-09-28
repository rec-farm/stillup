/** Single-color StillUp mark. The pupil is transparent at every size. */
export function EyeMark({ className = '' }: { className?: string }) {
  return (
    <svg
      className={className}
      width="40"
      height="40"
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
    >
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M3 32C17 8 47 8 61 32C47 56 17 56 3 32ZM32 20C27 20 24 25 24 32S27 44 32 44S40 39 40 32S37 20 32 20Z"
        clipRule="evenodd"
      />
    </svg>
  );
}
