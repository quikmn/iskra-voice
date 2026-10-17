// Icons for activities (the same Lucide-style line icons as ../icons).
import type { ReactNode } from 'react'

type P = { size?: number }

function Svg({ size = 18, children }: { size?: number; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  )
}

/** A game controller: the activities button. */
export const ActivityIcon = (p: P) => (
  <Svg {...p}>
    <path d="M6 11h4M8 9v4" />
    <path d="M15 12h.01M18 10h.01" />
    <path d="M17.3 5H6.7a4 4 0 0 0-3.98 3.6L2 15.6A2.6 2.6 0 0 0 4.6 18.4c.9 0 1.7-.5 2.2-1.2L8 15h8l1.2 2.2c.5.7 1.3 1.2 2.2 1.2a2.6 2.6 0 0 0 2.6-2.8l-.7-7A4 4 0 0 0 17.3 5z" />
  </Svg>
)

const DrawIcon = (p: P) => (
  <Svg {...p}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
  </Svg>
)

const QuizIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" />
    <path d="M12 17h.01" />
  </Svg>
)

const FourIcon = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="8" cy="8" r="1.5" />
    <circle cx="16" cy="8" r="1.5" />
    <circle cx="8" cy="16" r="1.5" />
    <circle cx="12" cy="12" r="1.5" />
    <circle cx="16" cy="16" r="1.5" />
  </Svg>
)

export function BuiltinIcon({ id, size = 28 }: { id: string; size?: number }) {
  if (id === 'draw') return <DrawIcon size={size} />
  if (id === 'trivia') return <QuizIcon size={size} />
  if (id === 'four') return <FourIcon size={size} />
  return <ActivityIcon size={size} />
}
