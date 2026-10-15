// A server's icon where it has one (rail, header, server menu, settings band), its initials otherwise or while the
// picture can't load. The alt text is the server's name. Also its banner, at the top of the channel list.
import { useState } from 'react'
import { useServerImage } from '../state/serverImages'
import { initials } from './format'

export function ServerPicture({ server, className = '', fallback = true }: { server: { key: string; name: string }; className?: string; fallback?: boolean }) {
  const url = useServerImage(server.key, 'icon')
  const [failed, setFailed] = useState<string | null>(null)
  if (!url || failed === url) return fallback ? <>{initials(server.name)}</> : null
  return <img className={`server-picture ${className}`} src={url} alt={server.name} draggable={false} onError={() => setFailed(url)} />
}

/** The banner (wide picture) above the channel list; nothing without one. `collapsed`: folded away while scrolling. */
export function ServerBanner({ server, collapsed }: { server: { key: string; name: string }; collapsed: boolean }) {
  const url = useServerImage(server.key, 'banner')
  const [failed, setFailed] = useState<string | null>(null)
  if (!url || failed === url) return null
  return (
    <div className={`server-banner ${collapsed ? 'collapsed' : ''}`} data-testid="server-banner">
      <img src={url} alt={server.name} draggable={false} onError={() => setFailed(url)} />
    </div>
  )
}
