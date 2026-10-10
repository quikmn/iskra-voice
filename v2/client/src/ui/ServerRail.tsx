import { selectServer, useApp } from '../state/store'
import { openFriends, useDms } from '../state/dms'
import { initials } from './format'
import { Plus } from './icons'

export function ServerRail({ onJoin, onNavigate }: { onJoin: () => void; onNavigate: () => void }) {
  const order = useApp((s) => s.order)
  const servers = useApp((s) => s.servers)
  const active = useApp((s) => s.activeServer)

  const dmUnread = useDms((s) => Object.values(s.conversations).reduce((n, c) => n + c.unread, 0))

  return (
    <nav className="server-rail" aria-label="Servers">
      <button
        className={`server-icon home ${active === null ? 'active' : ''}`}
        title="Direct messages"
        aria-label="Direct messages"
        onClick={() => {
          openFriends()
          onNavigate()
        }}
      >
        <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" fill="currentColor" /></svg>
        {dmUnread > 0 && active !== null && <span className="badge">{dmUnread > 99 ? '99+' : dmUnread}</span>}
      </button>
      <div className="rail-divider" />
      {order.map((key) => {
        const server = servers[key]
        if (!server) return null
        const unread = Object.values(server.unread).reduce((a, b) => a + b, 0)
        const pings = Object.values(server.mentions).reduce((a, b) => a + b, 0)
        const offline = server.status.state !== 'online'
        return (
          <button
            key={key}
            className={`server-icon ${key === active ? 'active' : ''} ${offline ? 'offline' : ''}`}
            title={server.name}
            onClick={() => {
              selectServer(key)
              onNavigate()
            }}
          >
            {initials(server.name)}
            {pings > 0 && key !== active && <span className="badge">{pings > 99 ? '99+' : pings}</span>}
            {pings === 0 && unread > 0 && key !== active && <span className="unread-dot" />}
          </button>
        )
      })}
      <button className="server-icon add" title="Join a server" onClick={onJoin} aria-label="Join a server">
        <Plus size={22} />
      </button>
    </nav>
  )
}
