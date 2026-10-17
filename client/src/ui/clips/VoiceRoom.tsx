// A voice or stage call with its text chat beside it (full screen on phones), plus the chat button for the call header.
import { useEffect, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { loadHistory, type ServerState } from '../../state/store'
import { useServerRoles } from '../../state/roles'
import { canSendIn } from '../../state/permissions'
import { channelConv, useRead } from '../../state/readState'
import { useNotifyFor } from '../../state/organize'
import { channelBadges } from '../../state/organizeLogic'
import { setVoiceChatOpen, showVoiceChat, toggleVoiceChat, useVoiceChat } from '../../state/voiceChat'
import { useVoice } from '../../state/voice'
import { useEscapeLayer } from '../layers'
import { Composer, MessageList, TypingLine } from '../ChatView'
import { Close } from '../icons'
import { ArrowLeft } from '../chat/extraIcons'
import { ChatIcon } from './clipIcons'
import '../chat/chat-extras.css'
import './clips.css'
import { ActivityChatStrip } from '../activities/Activities'

/** Wraps the call screen of a voice or stage channel, with the chat panel beside it when open. */
export function VoiceRoom({ server, children }: { server: ServerState; children: ReactNode }) {
  const channelId = useVoice((s) => s.session?.channelId ?? null)
  const open = useVoiceChat((s) => s.open) && channelId !== null
  useEffect(() => {
    showVoiceChat(open ? server.key : null, open ? channelId : null)
    return () => showVoiceChat(null, null)
  }, [open, server.key, channelId])
  return (
    <div className={`chat-area voice-room ${open ? 'has-panel' : ''}`}>
      {children}
      {open && <VoiceChatPanel key={channelId} server={server} channelId={channelId} />}
    </div>
  )
}

function VoiceChatPanel({ server, channelId }: { server: ServerState; channelId: number }) {
  const { t } = useTranslation()
  const channel = server.channels.find((c) => c.id === channelId)
  const roles = useServerRoles(server.key)
  const canWrite = !!channel && canSendIn(server.me, channel, roles)
  const online = server.status.state === 'online'
  const close = () => setVoiceChatOpen(false)
  useEscapeLayer(close)

  useEffect(() => {
    if (online) void loadHistory(server.key, channelId)
  }, [server.key, channelId, online])

  return (
    <section
      className="side-panel voice-chat-panel"
      aria-label={t('clips.chat.label', { name: channel?.name ?? '' })}
      onDragOver={(e) => {
        if (canWrite && e.dataTransfer.types.includes('Files')) e.preventDefault()
      }}
      onDrop={(e) => {
        if (!canWrite || e.dataTransfer.files.length === 0) return
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('iskra:attach-thread', { detail: [...e.dataTransfer.files] }))
      }}
    >
      <header className="side-panel-header">
        <button className="icon-button panel-back" onClick={close} aria-label={t('clips.chat.back')}><ArrowLeft /></button>
        <span className="panel-icon"><ChatIcon /></span>
        <div className="panel-title">
          <h2>{t('clips.chat.title')}</h2>
          {channel && <span className="muted">{channel.name}</span>}
        </div>
        <span className="spacer" />
        <button className="icon-button panel-close" onClick={close} aria-label={t('clips.chat.close')} title={t('common.close')}><Close /></button>
      </header>
      <ActivityChatStrip server={server} channelId={channelId} />
      {/* The thread flavour of the list and composer: their events don't clash with a channel chat elsewhere. */}
      <MessageList key={channelId} server={server} channelId={channelId} thread header={<ChatStart name={channel?.name ?? ''} />} />
      <TypingLine server={server} channelId={channelId} />
      {canWrite && channel ? (
        <Composer server={server} channelId={channelId} channelName={channel.name} thread placeholder={t('clips.chat.placeholder', { name: channel.name })} />
      ) : (
        <div className="composer read-only">{t('chat.view.readOnly')}</div>
      )}
    </section>
  )
}

function ChatStart({ name }: { name: string }) {
  const { t } = useTranslation()
  return (
    <div className="channel-start voice-chat-start">
      <span className="channel-start-icon" aria-hidden><ChatIcon size={28} /></span>
      <p className="channel-start-title">{t('clips.chat.welcome', { name })}</p>
      <p>{t('clips.chat.start')}</p>
    </div>
  )
}

/** The call header's chat button, with the unread count (mentions as a badge, like a channel row). */
export function VoiceChatButton({ server, channelId }: { server: ServerState; channelId: number }) {
  const { t } = useTranslation()
  const open = useVoiceChat((s) => s.open)
  const read = useRead(channelConv(server.key, channelId))
  const notify = useNotifyFor(server.key, channelId)
  const shown = channelBadges(read.unread, read.mentions, notify)
  const count = shown.pings || (shown.unread ? read.unread : 0)
  const label = count > 0 ? t('clips.chat.openUnread', { n: count }) : open ? t('clips.chat.close') : t('clips.chat.open')
  return (
    <button className={`icon-button voice-chat-toggle ${open ? 'on' : ''}`} onClick={toggleVoiceChat} aria-pressed={open} aria-label={label} title={label}>
      <ChatIcon />
      {!open && count > 0 && <span className={`chat-count ${shown.pings ? 'ping' : ''}`}>{count > 99 ? '99+' : count}</span>}
    </button>
  )
}
