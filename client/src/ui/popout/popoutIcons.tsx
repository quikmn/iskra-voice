// Pop-out icons, drawn like ui/icons.tsx (Lucide-style lines, 24×24, stroke = currentColor).
import type { ReactNode } from 'react'

function Svg({ size = 18, children }: { size?: number; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  )
}

type P = { size?: number }

/** A small window coming out of a big one. */
export const PopOutIcon = (p: P) => (
  <Svg {...p}>
    <path d="M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6" />
    <rect x="13" y="3" width="8" height="6" rx="1" />
  </Svg>
)

/** Back into the big window. */
export const PopInIcon = (p: P) => (
  <Svg {...p}>
    <path d="M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6" />
    <path d="M20 4 13 11" />
    <path d="M13 6v5h5" />
  </Svg>
)

/** Always on top. */
export const PinIcon = (p: P) => (
  <Svg {...p}>
    <path d="M12 17v5" />
    <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1Z" />
  </Svg>
)

/** Clicks go through: a pointer with a dashed box. */
export const ClickThroughIcon = (p: P) => (
  <Svg {...p}>
    <path d="M14 4.1 12 6" />
    <path d="m5.1 8-2.9-.8" />
    <path d="m6 12-1.9 2" />
    <path d="M7.2 2.2 8 5.1" />
    <path d="M9.04 9.24a.5.5 0 0 1 .7-.7l11.02 4.33a.5.5 0 0 1-.04.94l-4.2 1.3a1 1 0 0 0-.66.66l-1.3 4.2a.5.5 0 0 1-.94.04Z" />
  </Svg>
)
