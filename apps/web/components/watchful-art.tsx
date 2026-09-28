/** Decorative cut-paper artwork, independent of live monitoring status. */
export function WatchfulArt({ className = '' }: { className?: string }) {
  return (
    <div className={`watchful-art ${className}`} aria-hidden="true">
      <svg viewBox="0 0 480 240" fill="none">
        <path fill="#ef87aa" d="M0 0h280v240H0z" />
        <path fill="#f5ce49" d="M280 0h200v120H280z" />
        <path fill="#68bba6" d="M280 120h200v120H280z" />
        <path d="M24 119Q140-25 257 119Q142 267 24 119Z" fill="#fff7df" />
        <ellipse cx="142" cy="119" rx="48" ry="70" fill="#172e3b" />
        <ellipse cx="157" cy="94" rx="11" ry="15" fill="#fff7df" />
        <path
          d="m52 45 15 20m72-47 1 29m77-4-16 23M53 193l16-21m72 46v-27m77 1-18-20"
          stroke="#172e3b"
          strokeWidth="7"
          strokeLinecap="round"
        />
        <path
          d="m380 13 8 29 27-15-15 26 29 8-29 8 15 27-27-16-8 29-8-29-27 16 15-27-29-8 29-8-15-26 27 15Z"
          fill="#172e3b"
        />
        <path
          d="M303 183h29l15-32 24 65 20-49 13 16h53"
          stroke="#172e3b"
          strokeWidth="8"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <path d="M280 0v240m0-120h200" stroke="#172e3b" strokeWidth="3" />
      </svg>
    </div>
  );
}
