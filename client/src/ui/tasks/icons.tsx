// Icons for task boards (same Lucide-style line icons as ../icons).
import type { ReactNode } from 'react'

type P = { size?: number }

function Svg({ size = 18, children }: { size?: number; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  )
}

/** A board with three columns of different heights. */
export const TasksIcon = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M8 7v7" />
    <path d="M12 7v4" />
    <path d="M16 7v9" />
  </Svg>
)

export const ArchiveIcon = (p: P) => (
  <Svg {...p}>
    <rect x="2" y="3" width="20" height="5" rx="1" />
    <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
    <path d="M10 12h4" />
  </Svg>
)

/** Lines of text: the task has a description. */
export const TextIcon = (p: P) => (
  <Svg {...p}>
    <path d="M15 12H3" />
    <path d="M17 18H3" />
    <path d="M21 6H3" />
  </Svg>
)

export const ArrowUp = (p: P) => (
  <Svg {...p}>
    <path d="m5 12 7-7 7 7" />
    <path d="M12 19V5" />
  </Svg>
)

export const ArrowDown = (p: P) => (
  <Svg {...p}>
    <path d="M12 5v14" />
    <path d="m19 12-7 7-7-7" />
  </Svg>
)

export const Undo = (p: P) => (
  <Svg {...p}>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </Svg>
)
