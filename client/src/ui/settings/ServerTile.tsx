// A server's tile in its own colour (its icon when it has one, else the same initials as in the rail): the server
// room's band, its slim phone band, and the server menu's title.
import type { ServerState } from '../../state/store'
import { ServerPicture } from '../ServerPicture'
import { serverColor } from '../serverColor'

export function ServerTile({ server, size = 'large' }: { server: Pick<ServerState, 'key' | 'name'>; size?: 'large' | 'small' }) {
  return (
    <span className={`room-tile ${size}`} style={{ background: serverColor(server.key).tile }} aria-hidden>
      <ServerPicture server={server} />
    </span>
  )
}
