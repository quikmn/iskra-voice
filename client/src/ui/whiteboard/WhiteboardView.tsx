// A whiteboard channel: the header (who's here now), and the board.
import { useTranslation } from 'react-i18next'
import type { Channel } from '../../core/protocol'
import type { ServerState } from '../../state/store'
import { boardKey, useWhiteboard } from '../../state/whiteboard'
import { Avatar } from '../bits'
import { Menu, Users } from '../icons'
import type { Panel } from '../Shell'
import { EncryptionButton, LockBadge } from '../e2ee/E2ee'
import { useBoardAbilities } from './abilities'
import { BoardIcon } from './icons'
import { Whiteboard } from './Whiteboard'
import { ChannelTopic } from '../chat/ChannelTopic'

const NO_VIEWERS: string[] = []

export function Viewers({ server, viewers }: { server: ServerState; viewers: string[] }) {
  const { t } = useTranslation()
  if (viewers.length === 0) return null
  const shown = viewers.slice(0, 5)
  return (
    <div className="wb-viewers" aria-label={t('whiteboard.hereNow', { count: viewers.length })} title={viewers.map((k) => server.members[k]?.name ?? t('whiteboard.someone')).join(', ')}>
      {shown.map((k) => <Avatar key={k} name={server.members[k]?.name ?? '?'} accountKey={k} size={24} />)}
      {viewers.length > shown.length && <span className="wb-more">+{viewers.length - shown.length}</span>}
    </div>
  )
}

export function WhiteboardView({ server, channel, onToggle }: { server: ServerState; channel: Channel; onToggle: (panel: Panel) => void }) {
  const { t } = useTranslation()
  const viewers = useWhiteboard((s) => s.boards[boardKey(server.key, channel.id)]?.viewers) ?? NO_VIEWERS
  const { canDraw, canClear, blocked } = useBoardAbilities(server, channel)
  return (
    <div className="chat whiteboard-channel">
      <header className="chat-header">
        <button className="icon-button mobile-only" onClick={() => onToggle('nav')} aria-label={t('chat.view.openChannels')}>
          <Menu />
        </button>
        <h1>
          <span className="hash"><BoardIcon size={20} /></span>
          {channel.name}
          <LockBadge channel={channel} size={14} />
        </h1>
        <span className="spacer" />
        <Viewers server={server} viewers={viewers} />
        <EncryptionButton server={server} channel={channel} />
        <button className="icon-button members-toggle" onClick={() => onToggle('members')} aria-label={t('chat.view.members')} title={t('chat.view.members')}>
          <Users />
        </button>
      </header>
      <ChannelTopic channel={channel} />
      {blocked && channel.e2ee && <p className="wb-note muted small-text">{blocked}</p>}
      <Whiteboard key={channel.id} server={server} channel={channel} canDraw={canDraw} canClear={canClear} />
    </div>
  )
}
