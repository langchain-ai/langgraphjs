/**
 * Placeholder art shown while an image is generating or when generation fails.
 * A soft watercolor moon over a pastel wash — no text, no sharp edges.
 */
export function PlaceholderImage({
  muted = false,
  label,
}: {
  muted?: boolean;
  /**
   * Optional caption overlaid at the bottom. Useful for long-running
   * generations where the idle moon alone doesn't convey that anything
   * is happening.
   */
  label?: string;
}) {
  return (
    <svg
      viewBox="0 0 200 200"
      width="100%"
      height="100%"
      role="img"
      aria-label={label ?? "sleeping moon placeholder"}
      style={{ opacity: muted ? 0.55 : 1 }}
    >
      <defs>
        <radialGradient id="sky" cx="50%" cy="40%" r="75%">
          <stop offset="0%" stopColor="#fef6f0" />
          <stop offset="100%" stopColor="#d9c9e6" />
        </radialGradient>
        <radialGradient id="moon" cx="50%" cy="50%" r="60%">
          <stop offset="0%" stopColor="#fff8ec" />
          <stop offset="100%" stopColor="#f2d8b4" />
        </radialGradient>
      </defs>
      <rect width="200" height="200" fill="url(#sky)" />
      <circle cx="118" cy="92" r="44" fill="url(#moon)" />
      <circle cx="135" cy="80" r="14" fill="#fef6f0" opacity="0.55" />
      <g fill="#b584a3" opacity="0.55">
        <circle cx="40" cy="52" r="1.8" />
        <circle cx="62" cy="30" r="1.2" />
        <circle cx="170" cy="44" r="1.2" />
        <circle cx="58" cy="148" r="1.6" />
        <circle cx="160" cy="150" r="1.2" />
        <circle cx="30" cy="100" r="1.2" />
      </g>
      <path
        d="M100 104 Q 110 96 120 104 Q 128 112 118 118 Q 110 122 104 116 Q 96 110 100 104 Z"
        fill="#4a4360"
        opacity="0.35"
      />
      {label != null ? (
        <text
          x="100"
          y="178"
          textAnchor="middle"
          fontSize="11"
          fontFamily="system-ui, sans-serif"
          fill="#4a4360"
          opacity="0.75"
        >
          {label}
        </text>
      ) : null}
    </svg>
  );
}
