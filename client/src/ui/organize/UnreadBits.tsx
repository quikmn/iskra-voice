// The "New messages" divider and the bar that jumps up to it.
import { useEffect, useState, type RefObject } from 'react'
import { loadHistory, useApp, type ServerState } from '../../state/store'
import { markChannelRead, useUnreadMarker } from '../../state/unread'
import { clockTime } from '../format'
import './organize.css'

export function UnreadDivider() {
  return (
    <div className="unread-divider" id="unread-divider" role="separator" aria-label="New messages">
      <span>New messages</span>
    </div>
  )
}

export function UnreadBar({ server, channelId, scroller, onJump }: {
  server: ServerState
  channelId: number
  scroller: RefObject<HTMLDivElement | null>
  onJump: () => void
}) {
  const marker = useUnreadMarker(server.key, channelId)
  const [above, setAbove] = useState(false)

  useEffect(() => {
    const el = scroller.current
    if (!el || !marker) return
    const check = () => {
      const divider = el.querySelector<HTMLElement>('#unread-divider')
      setAbove(!divider || divider.getBoundingClientRect().bottom < el.getBoundingClientRect().top + 4)
    }
    check()
    el.addEventListener('scroll', check, { passive: true })
    const timer = setInterval(check, 500) // new messages and images move things around
    return () => {
      el.removeEventListener('scroll', check)
      clearInterval(timer)
    }
  }, [scroller, marker])

  if (!marker || !above) return null

  async function jump() {
    onJump()
    // Older pages until the first new message is loaded.
    for (let i = 0; i < 20 && !document.getElementById('unread-divider'); i++) {
      const s = useApp.getState().servers[server.key]
      if (!s?.hasMore[channelId]) break
      await loadHistory(server.key, channelId, true)
      await new Promise((r) => setTimeout(r, 30))
    }
    document.getElementById('unread-divider')?.scrollIntoView({ block: 'center' })
  }

  return (
    <div className="unread-bar-wrap"><div className="unread-bar" role="status">
      <button className="unread-bar-jump" onClick={() => void jump()}>
        {marker.count} new message{marker.count === 1 ? '' : 's'}{marker.since ? ` since ${clockTime(marker.since)}` : ''} · Jump to first unread
      </button>
      <button className="unread-bar-read" onClick={() => markChannelRead(server.key, channelId)}>Mark as read</button>
    </div></div>
  )
}
