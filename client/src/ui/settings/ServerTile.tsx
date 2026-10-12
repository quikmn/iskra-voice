// A server's initials tile in its own colour (the same initials as its icon in the rail): the server room's band,
// its slim phone band, and the server menu's title.
import type { ServerState } from '../../state/store'
import { initials } from '../format'
import { serverColor } from '../serverColor'

export function ServerTile({ server, size = 'large' }: { server: Pick<ServerState, 'key' | 'name'>; size?: 'large' | 'small' }) {
  return <span className={`room-tile ${size}`} style={{ background: serverColor(server.key).tile }} aria-hidden>{initials(server.name)}</span>
}
