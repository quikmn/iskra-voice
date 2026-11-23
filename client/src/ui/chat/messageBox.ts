// The message box grows with its text, and a message list that shows its newest message keeps showing it. Shared by
// channels, threads, direct messages and groups.
import { useEffect, useRef, type RefObject } from 'react'

/** The tallest a message box gets before it scrolls inside. */
export const MESSAGE_BOX_MAX = 240

/**
 * Fits a message box to its text. Measuring needs the box collapsed for a moment. Collapsed plainly, the message list
 * above it is taller for that moment, the browser moves the list's scroll position to fit, and a list that was at its
 * newest message no longer is (ChatView stops following; the sent message lands below the fold). A bottom margin as
 * tall as the box keeps the row from getting shorter while measuring, so the list never notices.
 */
export function fitMessageBox(el: HTMLTextAreaElement, max = MESSAGE_BOX_MAX): void {
  el.style.marginBottom = `${el.offsetHeight}px`
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, max)}px`
  el.style.marginBottom = ''
}

/** Within this many px of the end, a list counts as showing its newest message. */
const AT_BOTTOM = 40

/**
 * A message list that is at its newest message stays there when it gets shorter (the phone keyboard opens, the message
 * box grows) or its content grows after being drawn (pictures, embeds). Scrolled up, it is left alone. `key` is the
 * conversation: a new one starts at the bottom.
 */
export function useFollowNewest(scroller: RefObject<HTMLElement | null>, key: string): void {
  const atBottom = useRef(true)
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    atBottom.current = true
    // The list's height as last handled below. A scroll event that comes while it has just changed is the browser
    // fitting the position, not the person scrolling away.
    let height: number | null = null
    const onScroll = () => {
      if (height === null || el.clientHeight === height) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    if (typeof ResizeObserver === 'undefined') return () => el.removeEventListener('scroll', onScroll)
    const sizes = new ResizeObserver(() => {
      height = el.clientHeight
      if (atBottom.current) el.scrollTop = el.scrollHeight
    })
    sizes.observe(el)
    for (const child of el.children) sizes.observe(child)
    const added = new MutationObserver((changes) => {
      for (const change of changes) for (const node of change.addedNodes) if (node instanceof Element) sizes.observe(node)
    })
    added.observe(el, { childList: true })
    return () => { el.removeEventListener('scroll', onScroll); sizes.disconnect(); added.disconnect() }
  }, [scroller, key])
}
