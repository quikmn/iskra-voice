// Icons for saved messages, reminders, scheduling and the inbox (same style as ui/icons.tsx).
import type { ReactNode } from 'react'

function Svg({ size = 18, children, fill = 'none' }: { size?: number; children: ReactNode; fill?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  )
}

type P = { size?: number }

export const Bookmark = ({ size, filled }: P & { filled?: boolean }) => (
  <Svg size={size} fill={filled ? 'currentColor' : 'none'}><path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2Z" /></Svg>
)

export const Bell = ({ size }: P) => (
  <Svg size={size}><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></Svg>
)

export const Clock = ({ size }: P) => (
  <Svg size={size}><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></Svg>
)

export const AlarmClock = ({ size }: P) => (
  <Svg size={size}><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2 2" /><path d="M5 3 2 6" /><path d="m22 6-3-3" /></Svg>
)

export const CheckAll = ({ size }: P) => (
  <Svg size={size}><path d="M18 6 7 17l-5-5" /><path d="m22 10-7.5 7.5L13 16" /></Svg>
)

export const More = ({ size = 15 }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden><circle cx="5" cy="12" r="2" fill="currentColor" /><circle cx="12" cy="12" r="2" fill="currentColor" /><circle cx="19" cy="12" r="2" fill="currentColor" /></svg>
)
