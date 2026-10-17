import { useTranslation } from 'react-i18next'
import { selectServer, useApp } from '../state/store'
import { hangUp, useCalls } from '../state/calls'
import { nameOf, openConversation } from '../state/dms'
import { leaveGroupCall } from '../state/groupCalls'
import { openGroup, titleOf, useGroups } from '../state/groups'
import { clearVoiceError, leaveVoice, setStageOpen, toggleDeafen, toggleMute, useVoice } from '../state/voice'
import { Close, Headphones, HeadphonesOff, Mic, MicOff, PhoneOff } from './icons'
import { SoundboardButton } from './expressions/Soundboard'
import { VoicePopoutButton } from './popout/PopoutButtons'
import './afk/afk.css'
import { WhisperControls } from './whisper/WhisperControls'
import { RoomButton } from './rooms/RoomBits'

/** Shown above your name while you're in voice (or when joining failed). */
export function VoiceBar() {
  const { t } = useTranslation()
  const session = useVoice((s) => s.session)
  const muted = useVoice((s) => s.muted)
  const deafened = useVoice((s) => s.deafened)
  const error = useVoice((s) => s.error)
  const talking = useVoice((s) => s.localSpeaking)
  const server = useApp((s) => (session ? s.servers[session.serverKey] : null))
  const channel = server?.channels.find((c) => c.id === session?.channelId)
  const call = useCalls((s) => s.call)
  const group = useGroups((s) => (session?.group ? s.groups[session.group.key] : undefined))

  if (!session) {
    return error ? (
      <div className="voice-bar error" role="alert">
        <span>{error}</span>
        <button className="icon-button small" onClick={clearVoiceError} aria-label={t('app.dismiss')}><Close size={14} /></button>
      </div>
    ) : null
  }

  const status = session.group
    ? (session.state === 'reconnecting' ? t('voice.bar.reconnecting') : t('voice.bar.inGroupCall'))
    : session.call
    ? (call?.phase === 'outgoing' ? t('voice.bar.calling') : session.state === 'reconnecting' ? t('voice.bar.reconnecting') : t('voice.bar.inCall'))
    : session.state === 'connected' ? t('voice.bar.connected') : session.state === 'reconnecting' ? t('voice.bar.reconnecting') : t('voice.bar.connecting')
  const peer = session.call?.peer
  return (
    <div className="voice-bar">
      <div className="voice-status">
        <strong className={session.state} role="status">{status}</strong>
        <button
          className="link-like"
          title={t('voice.bar.openCall')}
          onClick={() => {
            if (session.group) return openGroup(session.group.key)
            if (peer) return openConversation(peer)
            selectServer(session.serverKey)
            setStageOpen(true)
          }}
        >
          {session.group ? t('voice.bar.encrypted', { name: group ? titleOf(group) : t('voice.bar.group') })
            : peer ? t('voice.bar.encrypted', { name: nameOf(peer) }) : `${channel?.name ?? t('voice.bar.voice')} · ${server?.name}`}
        </button>
        {session.afk && session.state === 'connected' && <span className="afk-forced" data-testid="afk-forced">{t('afk.forced')}</span>}
        {!session.canSpeak && !session.afk && session.state === 'connected' && <span className="muted">{t('voice.bar.listeningOnly')}</span>}
        {error && <span className="error-text">{error}</span>}
      </div>
      <div className="voice-controls">
        {session.canSpeak && (
          <button
            className={`icon-button ${muted ? 'off' : ''} ${talking && !muted ? 'talking' : ''}`}
            onClick={() => void toggleMute()} aria-pressed={muted} aria-label={muted ? t('voice.unmute') : t('voice.mute')} title={muted ? t('voice.unmute') : t('voice.mute')}
          >
            {muted ? <MicOff /> : <Mic />}
          </button>
        )}
        {session.afk ? (
          <button className="icon-button off" disabled aria-label={t('afk.forced')} title={t('afk.forcedHint')}><HeadphonesOff /></button>
        ) : (
          <button className={`icon-button ${deafened ? 'off' : ''}`} onClick={() => void toggleDeafen()} aria-pressed={deafened} aria-label={deafened ? t('voice.undeafen') : t('voice.deafen')} title={deafened ? t('voice.undeafen') : t('voice.deafen')}>
            {deafened ? <HeadphonesOff /> : <Headphones />}
          </button>
        )}
        <SoundboardButton variant="bar" />
        <RoomButton />
        <VoicePopoutButton />
        <button
          className="icon-button hang-up"
          onClick={() => void (session.group ? leaveGroupCall() : peer ? hangUp() : leaveVoice())}
          aria-label={peer || session.group ? t('voice.hangUp') : t('voice.leave')}
          title={peer || session.group ? t('voice.hangUp') : t('voice.leave')}
        >
          <PhoneOff />
        </button>
      </div>
      <WhisperControls />
    </div>
  )
}
