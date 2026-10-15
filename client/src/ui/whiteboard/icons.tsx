// Icons for whiteboards (the same Lucide-style line icons as ../icons).
import type { ReactNode } from 'react'

type P = { size?: number }

function Svg({ size = 18, children }: { size?: number; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  )
}

export const BoardIcon = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="13" rx="2" />
    <path d="M8 21l4-4 4 4" />
    <path d="M7 13l3-3 2 2 4-4" />
  </Svg>
)

export const SelectIcon = (p: P) => (
  <Svg {...p}>
    <path d="M5 3l14 8-6 2-3 6z" />
  </Svg>
)

export const HandIcon = (p: P) => (
  <Svg {...p}>
    <path d="M18 11V6a2 2 0 0 0-4 0v5" />
    <path d="M14 10V4a2 2 0 0 0-4 0v6" />
    <path d="M10 10.5V6a2 2 0 0 0-4 0v8" />
    <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-5.9-2.4L3.3 16a2 2 0 0 1 3-2.6L8 15" />
  </Svg>
)

export const PenIcon = (p: P) => (
  <Svg {...p}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
  </Svg>
)

export const HighlighterIcon = (p: P) => (
  <Svg {...p}>
    <path d="M9 11l-6 6v3h9l3-3" />
    <path d="M22 12l-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4" />
  </Svg>
)

export const EraserIcon = (p: P) => (
  <Svg {...p}>
    <path d="M7 21l-4.3-4.3a1 1 0 0 1 0-1.4l10-10a1 1 0 0 1 1.4 0l5.6 5.6a1 1 0 0 1 0 1.4L13 19" />
    <path d="M22 21H7" />
    <path d="M5 11l9 9" />
  </Svg>
)

export const LineIcon = (p: P) => (
  <Svg {...p}>
    <path d="M5 19L19 5" />
  </Svg>
)

export const ArrowIcon = (p: P) => (
  <Svg {...p}>
    <path d="M5 19L19 5" />
    <path d="M10 5h9v9" />
  </Svg>
)

export const RectIcon = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="5" width="18" height="14" rx="1" />
  </Svg>
)

export const EllipseIcon = (p: P) => (
  <Svg {...p}>
    <ellipse cx="12" cy="12" rx="10" ry="7" />
  </Svg>
)

export const TextIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 7V4h16v3" />
    <path d="M9 20h6" />
    <path d="M12 4v16" />
  </Svg>
)

export const NoteIcon = (p: P) => (
  <Svg {...p}>
    <path d="M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V8.5z" />
    <path d="M15 3v6h6" />
  </Svg>
)

export const ImageIcon = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="9" cy="9" r="2" />
    <path d="M21 15l-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
  </Svg>
)

export const UndoIcon = (p: P) => (
  <Svg {...p}>
    <path d="M9 14L4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </Svg>
)

export const RedoIcon = (p: P) => (
  <Svg {...p}>
    <path d="M15 14l5-5-5-5" />
    <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
  </Svg>
)

export const FitIcon = (p: P) => (
  <Svg {...p}>
    <path d="M8 3H5a2 2 0 0 0-2 2v3" />
    <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
    <path d="M3 16v3a2 2 0 0 0 2 2h3" />
    <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
  </Svg>
)

export const ZoomInIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="8" />
    <path d="M21 21l-4.3-4.3" />
    <path d="M11 8v6M8 11h6" />
  </Svg>
)

export const ZoomOutIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="8" />
    <path d="M21 21l-4.3-4.3" />
    <path d="M8 11h6" />
  </Svg>
)

export const DownloadIcon = (p: P) => (
  <Svg {...p}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="M7 10l5 5 5-5" />
    <path d="M12 15V3" />
  </Svg>
)

export const ClearIcon = (p: P) => (
  <Svg {...p}>
    <path d="M3 6h18" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <path d="M10 11v6M14 11v6" />
  </Svg>
)
