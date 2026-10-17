// Icons for media channels (same Lucide-style line icons as ../icons).
import type { ReactNode } from 'react'

type P = { size?: number }

function Svg({ size = 18, children }: { size?: number; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  )
}

/** A picture over another: the channel kind. */
export const MediaIcon = (p: P) => (
  <Svg {...p}>
    <path d="M18 22H4a2 2 0 0 1-2-2V6" />
    <path d="m22 13-1.3-1.3a2.4 2.4 0 0 0-3.4 0L11 18" />
    <circle cx="12" cy="8" r="2" />
    <rect width="16" height="16" x="6" y="2" rx="2" />
  </Svg>
)

export const HeartIcon = (p: P) => (
  <Svg {...p}>
    <path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7Z" />
  </Svg>
)

export const PlayIcon = (p: P) => (
  <Svg {...p}>
    <polygon points="6 3 20 12 6 21 6 3" />
  </Svg>
)

export const StackIcon = (p: P) => (
  <Svg {...p}>
    <rect width="14" height="14" x="8" y="8" rx="2" />
    <path d="M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2" />
  </Svg>
)

export const EyeOffIcon = (p: P) => (
  <Svg {...p}>
    <path d="M10.7 5.1A10.7 10.7 0 0 1 22 12a13 13 0 0 1-1.7 2.7" />
    <path d="M14.1 14.2a3 3 0 0 1-4.2-4.2" />
    <path d="M17.5 17.5A10.7 10.7 0 0 1 2 12a13 13 0 0 1 4.5-5.5" />
    <path d="m2 2 20 20" />
  </Svg>
)
