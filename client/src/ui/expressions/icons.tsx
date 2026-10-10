// Icons for polls, emoji and the soundboard (same Lucide-style line icons as ../icons.tsx).
import type { ReactNode } from 'react'

function Svg({ size = 18, children }: { size?: number; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  )
}

type P = { size?: number }

export const PollIcon = (p: P) => (
  <Svg {...p}>
    <path d="M3 3v18h18" />
    <path d="M7 16h4" />
    <path d="M7 11h9" />
    <path d="M7 6h12" />
  </Svg>
)

export const SoundboardIcon = (p: P) => (
  <Svg {...p}>
    <path d="M11 5 6 9H2v6h4l5 4V5Z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7" />
    <path d="M19 5a10 10 0 0 1 0 14" />
  </Svg>
)

export const Check = (p: P) => (
  <Svg {...p}>
    <polyline points="20 6 9 17 4 12" />
  </Svg>
)

export const Play = (p: P) => (
  <Svg {...p}>
    <polygon points="6 3 20 12 6 21 6 3" />
  </Svg>
)

export const SmilePlus = (p: P) => (
  <Svg {...p}>
    <path d="M22 11v1a10 10 0 1 1-9-10" />
    <path d="M8 14s1.5 2 4 2 4-2 4-2" />
    <line x1="9" x2="9.01" y1="9" y2="9" />
    <line x1="15" x2="15.01" y1="9" y2="9" />
    <path d="M16 5h6" />
    <path d="M19 2v6" />
  </Svg>
)
