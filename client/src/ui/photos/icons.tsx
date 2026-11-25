// Icons for photos channels (same Lucide-style line icons as ../icons).
import type { ReactNode } from 'react'

type P = { size?: number }

function Svg({ size = 18, children }: { size?: number; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  )
}

/** Two pictures, one behind the other. */
export const PhotosIcon = (p: P) => (
  <Svg {...p}>
    <path d="M18 22H4a2 2 0 0 1-2-2V6" />
    <rect x="6" y="2" width="16" height="16" rx="2" />
    <circle cx="11" cy="7.5" r="1.6" />
    <path d="m22 13-2.3-2.3a2 2 0 0 0-2.8 0L10 18" />
  </Svg>
)

/** A book of pictures. */
export const AlbumIcon = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M8 3v18" />
    <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L12 15" />
  </Svg>
)

export const DownloadIcon = (p: P) => (
  <Svg {...p}>
    <path d="M12 3v12" />
    <path d="m7 10 5 5 5-5" />
    <path d="M5 21h14" />
  </Svg>
)

export const UploadIcon = (p: P) => (
  <Svg {...p}>
    <path d="M12 16V4" />
    <path d="m7 9 5-5 5 5" />
    <path d="M5 20h14" />
  </Svg>
)

/** A filled triangle: a video. */
export const PlayGlyph = ({ size = 12 }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z" />
  </svg>
)

/** A cylinder: storage. */
export const StorageIcon = (p: P) => (
  <Svg {...p}>
    <ellipse cx="12" cy="5" rx="8" ry="3" />
    <path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
    <path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
  </Svg>
)

export const FolderMove = (p: P) => (
  <Svg {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    <path d="M9 14h6" />
    <path d="m12.5 11.5 2.5 2.5-2.5 2.5" />
  </Svg>
)

export const ZoomIn = (p: P) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
    <path d="M11 8v6" />
    <path d="M8 11h6" />
  </Svg>
)

export const ZoomOut = (p: P) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
    <path d="M8 11h6" />
  </Svg>
)

/** A circle with a tick, filled when on: a selected photo. */
export const SelectMark = ({ size = 22, on }: P & { on: boolean }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
    <circle cx="12" cy="12" r="10" fill={on ? 'var(--accent)' : 'rgba(0,0,0,0.35)'} stroke="#fff" strokeWidth={1.8} />
    {on && <path d="m7.5 12.5 3 3 6-6.5" fill="none" stroke="#fff" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />}
  </svg>
)
