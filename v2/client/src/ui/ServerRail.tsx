import { selectServer, useApp } from '../state/store'
import { initials } from './format'

export function ServerRail({ onJoin, onNavigate }: { onJoin: () => void; onNavigate: () => void }) {
  const order = useApp((s) => s.order)
  const servers = useApp((s) => s.servers)
  const active = useApp((s) => s.activeServer)

  return (
    <nav className="server-rail" aria-label="Servers">
      {order.map((key) => {
        const server = servers[key]
        if (!server) return null
        const unread = Object.values(server.unread).reduce((a, b) => a + b, 0)
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
            {unread > 0 && key !== active && <span className="badge">{unread > 99 ? '99+' : unread}</span>}
          </button>
        )
      })}
      <button className="server-icon add" title="Join a server" onClick={onJoin} aria-label="Join a server">
        +
      </button>
    </nav>
  )
}
