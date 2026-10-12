// DM call UI: the call buttons, the call panel above a conversation, the incoming-call screen and call log rows.
import { useEffect, useState } from 'react'
import { b64u } from '../../core/crypto'
import { asLog, callLogText, endMessage, formatDuration, isBusy } from '../../state/callMachine'
import { acceptCall, callServers, declineCall, hangUp, startCall, useCalls } from '../../state/calls'
import { nameOf } from '../../state/dms'
import { useApp } from '../../state/store'
import { useVoice } from '../../state/voice'
import { Avatar } from '../bits'
import { Lock, Phone, PhoneMissed, PhoneOff, Video } from '../icons'
import { SafetyNumberDialog } from '../Home'
import { CallControls, VideoTile } from '../VoiceStage'
import './calls.css'
import { useTranslation } from 'react-i18next'
import { userMenuProps } from '../people/userMenuProps'

const myKey = () => {
  const identity = useApp.getState().identity
  return identity ? b64u(identity.account.publicKey) : ''
}

/** Voice and video call buttons for a DM header. */
export function CallButtons({ peer }: { peer: string }) {
  const { t } = useTranslation()
  const call = useCalls((s) => s.call)
  useApp((s) => s.servers) // re-check when servers or voice availability change
  const reachable = callServers(peer).length > 0
  const busy = isBusy(call)
  const title = !reachable ? t('calls.noSharedServer') : busy ? t('calls.alreadyInCall') : undefined
  return (
    <>
      <button className="icon-button" disabled={!reachable || busy} title={title ?? t('calls.startVoiceTitle')} aria-label={t('calls.startVoice')} onClick={() => void startCall(peer, false)}>
        <Phone />
      </button>
      <button className="icon-button" disabled={!reachable || busy} title={title ?? t('calls.startVideoTitle')} aria-label={t('calls.startVideo')} onClick={() => void startCall(peer, true)}>
        <Video />
      </button>
    </>
  )
}

function useTicker(on: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [on])
  return now
}

/** The call with this person, above the conversation: who's there, video, status and controls. */
export function CallPanel({ peer }: { peer: string }) {
  const { t } = useTranslation()
  const call = useCalls((s) => s.call)
  const inRoom = useCalls((s) => s.inRoom)
  const session = useVoice((s) => s.session)
  const tiles = useVoice((s) => s.tiles)
  const speaking = useVoice((s) => s.speaking)
  const error = useVoice((s) => s.error)
  const [verify, setVerify] = useState(false)
  const active = call?.phase === 'active'
  const now = useTicker(active)
  if (!call || call.peer !== peer || call.phase === 'incoming') return null

  const me = myKey()
  const inCall = session?.call?.id === call.id
  const encrypted = inCall && !!session.encrypted
  const connected = active && inCall && session.state === 'connected' && inRoom.includes(peer)
  const status =
    call.phase === 'outgoing' ? t('calls.calling')
    : call.phase === 'ended' ? endMessage(call)
    : connected ? formatDuration(now - (call.answeredAt ?? now))
    : session?.state === 'reconnecting' ? t('calls.reconnecting')
    : t('calls.connecting')
  const withVideo = new Set(tiles.map((t) => t.accountKey))
  const people = [peer, me].filter((k) => !withVideo.has(k))

  return (
    <section className={`call-panel ${tiles.length ? 'has-video' : ''} ${call.phase}`} aria-label={t('calls.call')}>
      <div className="call-top">
        <span className={`e2e-badge ${encrypted ? '' : 'pending'}`} title={t('calls.onlyTwoOfYou')}>
          <Lock size={13} /> {encrypted ? t('calls.e2e') : t('calls.encryptedCall')}
        </span>
        <button className="link call-verify" onClick={() => setVerify(true)}>{t('calls.safetyNumber')}</button>
        <span className="spacer" />
        <span className={`call-status ${call.phase}`} role="status">{status}</span>
      </div>

      <div className="call-stage">
        {tiles.map((tile) => (
          <VideoTile key={tile.id} tile={tile} name={nameOf(tile.accountKey)} speaking={!!speaking[tile.accountKey]} />
        ))}
        {people.map((key) => (
          <div
            key={key}
            {...userMenuProps(key)}
            className={`call-person ${speaking[key] ? 'speaking' : ''} ${key === peer && !inRoom.includes(peer) && call.phase !== 'ended' ? 'waiting' : ''}`}
          >
            <Avatar name={nameOf(key)} accountKey={key} size={64} />
            <span className="call-person-name">{key === me ? t('calls.you') : nameOf(key)}</span>
          </div>
        ))}
      </div>

      {error && inCall && <p className="call-error" role="alert">{error}</p>}
      {call.phase !== 'ended' && (inCall && session ? (
        <CallControls onLeave={() => void hangUp()} nameOf={nameOf} />
      ) : (
        <div className="call-controls">
          <button className="call-button hang-up" onClick={() => void hangUp()} aria-label={t('calls.hangUp')} title={t('calls.hangUp')}>
            <PhoneOff />
          </button>
        </div>
      ))}
      {verify && <SafetyNumberDialog me={me} peer={peer} onClose={() => setVerify(false)} />}
    </section>
  )
}

/** Full-screen on phones, a card elsewhere: someone is calling you. */
export function IncomingCall() {
  const { t } = useTranslation()
  const call = useCalls((s) => s.call)
  useApp((s) => s.servers)
  if (!call || call.phase !== 'incoming') return null
  const name = nameOf(call.peer)
  return (
    <div className="incoming-call" role="alertdialog" aria-label={t('calls.incomingFrom', { name })}>
      <div className="incoming-card">
        <div className="incoming-avatar">
          <Avatar name={name} accountKey={call.peer} size={96} />
        </div>
        <h2>{name}</h2>
        <p className="muted">{call.video ? t('calls.incomingVideo') : t('calls.incomingVoice')}</p>
        <span className="e2e-badge"><Lock size={13} /> {t('calls.e2e')}</span>
        <div className="incoming-actions">
          <label className="incoming-action">
            <button className="call-button hang-up" onClick={declineCall} aria-label={t('calls.decline')}>
              <PhoneOff />
            </button>
            <span>{t('calls.decline')}</span>
          </label>
          <label className="incoming-action">
            <button className="call-button accept" onClick={() => void acceptCall()} aria-label={t('calls.accept')} autoFocus>
              {call.video ? <Video /> : <Phone />}
            </button>
            <span>{t('calls.accept')}</span>
          </label>
        </div>
      </div>
    </div>
  )
}

/** A call log entry in a DM thread (written by the caller's app when the call ended). */
export function CallLogLine({ call, from, peer }: { call: unknown; from: string; peer: string }) {
  const { t } = useTranslation()
  const log = asLog(call)
  if (!log) return null
  const mine = from === myKey()
  const text =
    log.outcome === 'ended' ? callLogText(log.video, 'ended', log.duration)
    : log.outcome === 'declined' ? (mine
      ? (log.video ? t('calls.log.declinedYoursVideo', { name: nameOf(peer) }) : t('calls.log.declinedYoursVoice', { name: nameOf(peer) }))
      : (log.video ? t('calls.log.youDeclinedVideo') : t('calls.log.youDeclinedVoice')))
    : mine ? t('calls.log.noAnswer') : log.video ? t('calls.log.missedVideo') : t('calls.log.missedVoice')
  const missed = log.outcome !== 'ended' && !mine
  return (
    <div className={`call-log ${missed ? 'missed' : ''}`}>
      {missed ? <PhoneMissed size={15} /> : log.video ? <Video size={15} /> : <Phone size={15} />}
      <span>{text}</span>
    </div>
  )
}
