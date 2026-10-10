import { selectServer, useApp } from '../state/store'
import { hangUp, useCalls } from '../state/calls'
import { nameOf, openConversation } from '../state/dms'
import { clearVoiceError, leaveVoice, setStageOpen, toggleDeafen, toggleMute, useVoice } from '../state/voice'
import { Close, Headphones, HeadphonesOff, Mic, MicOff, PhoneOff } from './icons'

/** Shown above your name while you're in voice (or when joining failed). */
export function VoiceBar() {
  const session = useVoice((s) => s.session)
  const muted = useVoice((s) => s.muted)
  const deafened = useVoice((s) => s.deafened)
  const error = useVoice((s) => s.error)
  const server = useApp((s) => (session ? s.servers[session.serverKey] : null))
  const channel = server?.channels.find((c) => c.id === session?.channelId)
  const call = useCalls((s) => s.call)

  if (!session) {
    return error ? (
      <div className="voice-bar error" role="alert">
        <span>{error}</span>
        <button className="icon-button small" onClick={clearVoiceError} aria-label="Dismiss"><Close size={14} /></button>
      </div>
    ) : null
  }

  const status = session.call
    ? (call?.phase === 'outgoing' ? 'Calling…' : session.state === 'reconnecting' ? 'Reconnecting…' : 'In a call')
    : session.state === 'connected' ? 'Voice connected' : session.state === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'
  const peer = session.call?.peer
  return (
    <div className="voice-bar">
      <div className="voice-status">
        <strong className={session.state}>{status}</strong>
        <button
          className="link-like"
          title="Open the call"
          onClick={() => {
            if (peer) return openConversation(peer)
            selectServer(session.serverKey)
            setStageOpen(true)
          }}
        >
          {peer ? `${nameOf(peer)} · end-to-end encrypted` : `${channel?.name ?? 'voice'} · ${server?.name}`}
        </button>
        {!session.canSpeak && session.state === 'connected' && <span className="muted">Listening only</span>}
        {error && <span className="error-text">{error}</span>}
      </div>
      <div className="voice-controls">
        {session.canSpeak && (
          <button className={`icon-button ${muted ? 'off' : ''}`} onClick={() => void toggleMute()} aria-pressed={muted} aria-label={muted ? 'Unmute' : 'Mute'} title={muted ? 'Unmute' : 'Mute'}>
            {muted ? <MicOff /> : <Mic />}
          </button>
        )}
        <button className={`icon-button ${deafened ? 'off' : ''}`} onClick={() => void toggleDeafen()} aria-pressed={deafened} aria-label={deafened ? 'Undeafen' : 'Deafen'} title={deafened ? 'Undeafen' : 'Deafen'}>
          {deafened ? <HeadphonesOff /> : <Headphones />}
        </button>
        <button
          className="icon-button hang-up"
          onClick={() => void (peer ? hangUp() : leaveVoice())}
          aria-label={peer ? 'Hang up' : 'Leave voice'}
          title={peer ? 'Hang up' : 'Leave voice'}
        >
          <PhoneOff />
        </button>
      </div>
    </div>
  )
}
