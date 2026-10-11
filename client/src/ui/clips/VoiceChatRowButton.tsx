// The chat button on a voice or stage channel's row: unread dot, mention badge, opens the channel's text chat.
import { useTranslation } from 'react-i18next'
import type { Channel } from '../../core/protocol'
import { activeChannelId, useApp, type ServerState } from '../../state/store'
import { useChannelCounts } from '../../state/unread'
import { useNotifyFor } from '../../state/organize'
import { channelBadges } from '../../state/organizeLogic'
import { openVoiceChannelChat, useVoiceChat } from '../../state/voiceChat'
import { useVoice } from '../../state/voice'
import { ChatIcon } from './clipIcons'
import './clips.css'

export function VoiceChatRowButton({ server, channel, onNavigate }: { server: ServerState; channel: Channel; onNavigate: () => void }) {
  const { t } = useTranslation()
  const counts = useChannelCounts(server.key, channel)
  const shown = channelBadges(counts.unread, counts.mentions, useNotifyFor(server.key, channel.id))
  // Showing now: as the main view, or beside the call.
  const main = useApp((s) => s.activeServer === server.key && activeChannelId(s) === channel.id)
  const callShown = useVoice((s) => s.stageOpen && s.session?.serverKey === server.key && !s.session.call && !s.session.group)
  const here = useVoice((s) => s.session?.channelId === channel.id)
  const panel = useVoiceChat((s) => s.open)
  const active = callShown ? here && panel : main
  const label = shown.pings > 0 ? t('clips.chat.rowMentions', { name: channel.name, n: shown.pings })
    : shown.unread ? t('clips.chat.rowUnread', { name: channel.name }) : t('clips.chat.row', { name: channel.name })
  return (
    <button
      className={`icon-button small voice-chat-row-button ${shown.unread || shown.pings ? 'has-unread' : ''} ${active ? 'active' : ''}`}
      onClick={() => {
        openVoiceChannelChat(server.key, channel.id)
        onNavigate()
      }}
      aria-label={label}
      title={label}
    >
      <ChatIcon size={16} />
      {shown.pings > 0 && <span className="badge">{shown.pings}</span>}
    </button>
  )
}
