import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react'

/**
 * Places a fixed-position panel next to its anchor: above if there's room, otherwise below, kept inside the window.
 * On narrow screens (or without an anchor) it becomes a bottom sheet instead.
 */
export function usePopoverPosition(anchor: HTMLElement | null, panel: RefObject<HTMLElement | null>): { style: CSSProperties; sheet: boolean } {
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' })
  const [sheet, setSheet] = useState(false)

  useLayoutEffect(() => {
    const place = () => {
      const el = panel.current
      if (!el) return
      if (window.innerWidth <= 640 || !anchor) {
        setSheet(true)
        setStyle({})
        return
      }
      setSheet(false)
      const rect = anchor.getBoundingClientRect()
      const { offsetWidth: w, offsetHeight: h } = el
      const margin = 8
      const above = rect.top - h - margin >= margin
      const top = above ? rect.top - h - margin : Math.min(rect.bottom + margin, window.innerHeight - h - margin)
      const left = Math.min(Math.max(margin, rect.right - w), window.innerWidth - w - margin)
      setStyle({ top: Math.max(margin, top), left })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [anchor, panel])

  return { style, sheet }
}
