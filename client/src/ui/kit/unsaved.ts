// Forms with an unsaved-changes bar (SaveBar): leaving one with changes in it (back, Escape, close, another section)
// points at its bar instead, so nothing typed goes away unnoticed. The bar has Undo and Save.
import { useEffect, useRef } from 'react'

const bars = new Set<() => void>()

/** A SaveBar registers while its form has unsaved changes; `nudge` draws the eye to it. */
export function useUnsavedGuard(dirty: boolean, nudge: () => void): void {
  const latest = useRef(nudge)
  useEffect(() => {
    latest.current = nudge
  })
  useEffect(() => {
    if (!dirty) return
    const bar = () => latest.current()
    bars.add(bar)
    return () => {
      bars.delete(bar)
    }
  }, [dirty])
}

/** True when a form on screen has unsaved changes (its bar is nudged): the caller stays where it is. */
export function holdForUnsaved(): boolean {
  for (const nudge of bars) nudge()
  return bars.size > 0
}
