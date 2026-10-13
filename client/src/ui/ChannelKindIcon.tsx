// The icon for a kind of channel, the same everywhere (channel list, quick switcher, server settings).
import type { Channel } from '../core/protocol'
import { Hash, Volume } from './icons'
import { ForumIcon } from './forums/icons'
import { DocsIcon } from './docs/icons'
import { StageIcon } from './stage/stageIcons'

export function ChannelKindIcon({ kind, size = 16 }: { kind: Channel['kind']; size?: number }) {
  switch (kind) {
    case 'voice': return <Volume size={size} />
    case 'stage': return <StageIcon size={size} />
    case 'forum': return <ForumIcon size={size} />
    case 'docs': return <DocsIcon size={size} />
    default: return <Hash size={size} />
  }
}
