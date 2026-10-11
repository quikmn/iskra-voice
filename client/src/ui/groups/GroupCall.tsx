// Group call UI: the call buttons, the "call in progress" banner, the call itself (2–10 tiles) and the ring card.
import { useEffect, useState } from 'react'
import { b64u } from '../../core/crypto'
import { formatDuration, isBusy } from '../../state/callMachine'
import { useCalls } from '../../state/calls'
import { callColumns } from '../../state/groupLogic'
import { declineGroupCall, joinOngoingCall, leaveGroupCall, startGroupCall, useGroupCalls } from '../../state/groupCalls'
import { cannotSend, knownName, openGroup, titleOf, useGroups } from '../../state/groups'
import { useApp } from '../../state/store'
import { useVoice, type Tile } from '../../state/voice'
import { Avatar } from '../bits'
import { Lock, Phone, PhoneOff, Video } from '../icons'
import { CallControls, VideoTile } from '../VoiceStage'
import '../calls/calls.css'

const myKey = () => {
  const identity = useApp.getState().identity
  return identity ? b64u(identity.account.publicKey) : ''
}

function useNarrow(): boolean {
  const query = '(max-width: 760px)'
  const [narrow, setNarrow] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(query).matches)
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return
    const list = matchMedia(query)
    const update = () => setNarrow(list.matches)
    list.addEventListener('change', update)
    return () => list.removeEventListener('change', update)
  }, [])
  return narrow
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

/** Start a voice or video call, or join the one going on. */
export function GroupCallButtons({ groupKey }: { groupKey: string }) {
  const g = useGroups((s) => s.groups[groupKey])
  const call = useGroupCalls((s) => s.calls[groupKey])
  const joined = useGroupCalls((s) => s.joined)
  const dmCall = useCalls((s) => s.call)
  const voiceAvailable = useApp((s) => (g ? s.servers[g.serverKey]?.voiceAvailable : false))
  if (joined?.key === groupKey) return null
  const busy = isBusy(dmCall) || !!joined
  if (call) {
    return (
      <button className="button small join-call" disabled={busy} onClick={() => void joinOngoingCall(groupKey)} title={busy ? "You're already in a call" : 'Join the call'}>
        <Phone size={15} /> Join call
      </button>
    )
  }
  const reason = cannotSend(g) ?? (!voiceAvailable ? "Calls aren't available on this group's server right now" : busy ? "You're already in a call" : null)
  return (
    <>
      <button className="icon-button" disabled={!!reason} title={reason ?? 'Start a voice call'} aria-label="Start voice call" onClick={() => void startGroupCall(groupKey, false)}>
        <Phone />
      </button>
      <button className="icon-button" disabled={!!reason} title={reason ?? 'Start a video call'} aria-label="Start video call" onClick={() => void startGroupCall(groupKey, true)}>
        <Video />
      </button>
    </>
  )
}

/** A call is going on in this group and you're not in it. */
export function OngoingCallBanner({ groupKey }: { groupKey: string }) {
  const call = useGroupCalls((s) => s.calls[groupKey])
  const joined = useGroupCalls((s) => s.joined)
  const dmCall = useCalls((s) => s.call)
  if (!call) return null
  const people = call.participants
  const busy = isBusy(dmCall) || !!joined
  return (
    <div className="ongoing-call" role="status">
      <span className="ongoing-icon">{call.video ? <Video size={16} /> : <Phone size={16} />}</span>
      <span className="ongoing-text">
        <strong>{call.video ? 'Video call' : 'Voice call'} in progress</strong>
        <span className="muted">{people.length === 0 ? 'Starting…' : people.map(knownName).join(', ')}</span>
      </span>
      <span className="ongoing-faces" aria-hidden>
        {people.slice(0, 4).map((k) => <Avatar key={k} name={knownName(k)} accountKey={k} size={24} />)}
      </span>
      <button className="button small join-call" disabled={busy} onClick={() => void joinOngoingCall(groupKey)}>Join</button>
    </div>
  )
}

/** The call you're in: one tile per person (their camera, or their avatar), screen shares big on top. */
export function GroupCallPanel({ groupKey }: { groupKey: string }) {
  const call = useGroupCalls((s) => s.calls[groupKey])
  const joined = useGroupCalls((s) => s.joined)
  const callError = useGroupCalls((s) => s.error)
  const session = useVoice((s) => s.session)
  const tiles = useVoice((s) => s.tiles)
  const speaking = useVoice((s) => s.speaking)
  const voiceError = useVoice((s) => s.error)
  const narrow = useNarrow()
  const [focusId, setFocusId] = useState<string | null>(null)
  const me = myKey()
  const inCall = !!joined && session?.group?.callId === joined.callId
  const connected = inCall && session.state === 'connected'
  const now = useTicker(connected)
  if (!joined || joined.key !== groupKey) return null

  const people = [me, ...(call?.participants ?? []).filter((k) => k !== me)]
  const screens = tiles.filter((t) => t.source === 'screen')
  const cameras = new Map<string, Tile>(tiles.filter((t) => t.source === 'camera').map((t) => [t.accountKey, t]))
  const focused = screens.find((t) => t.id === focusId) ?? screens[0] ?? null
  const strip = screens.filter((t) => t !== focused)
  const count = people.length + strip.length
  const columns = callColumns(count, narrow)
  const status = !joined.hasKey ? 'Waiting for the call key…'
    : connected ? formatDuration(now - joined.joinedAt)
    : session?.state === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'

  return (
    <section className={`call-panel group-call ${tiles.length ? 'has-video' : ''} ${focused ? 'has-focus' : ''}`} aria-label="Group call" data-key-version={call?.keyVersion}>
      <div className="call-top">
        <span className={`e2e-badge ${inCall && session.encrypted ? '' : 'pending'}`} title="Only the people in this group can hear and see this call">
          <Lock size={13} /> {inCall && session.encrypted ? 'End-to-end encrypted' : 'Encrypted call'}
        </span>
        <span className="spacer" />
        <span className="muted call-count">{people.length} in call</span>
        <span className={`call-status ${connected && joined.hasKey ? 'active' : ''}`} role="status">{status}</span>
      </div>
      {focused && (
        <div className="group-focus">
          <VideoTile tile={focused} name={knownName(focused.accountKey)} big speaking={false} />
        </div>
      )}
      <div className={`group-grid count-${Math.min(count, 10)}`} style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
        {strip.map((tile) => (
          <VideoTile key={tile.id} tile={tile} name={knownName(tile.accountKey)} speaking={false} onClick={() => setFocusId(tile.id)} />
        ))}
        {people.map((k) => {
          const camera = cameras.get(k)
          if (camera) return <VideoTile key={camera.id} tile={camera} name={k === me ? 'You' : knownName(k)} speaking={!!speaking[k]} />
          return (
            <div key={k} className={`person-tile ${speaking[k] ? 'speaking' : ''}`}>
              <Avatar name={knownName(k)} accountKey={k} size={narrow ? 48 : 64} />
              <span className="tile-label">{k === me ? 'You' : knownName(k)}</span>
            </div>
          )
        })}
      </div>
      {(voiceError || callError) && <p className="call-error" role="alert">{voiceError ?? callError}</p>}
      {inCall && session ? (
        <CallControls onLeave={() => void leaveGroupCall()} />
      ) : (
        <div className="call-controls">
          <button className="call-button hang-up" onClick={() => void leaveGroupCall()} aria-label="Hang up" title="Hang up"><PhoneOff /></button>
        </div>
      )}
    </section>
  )
}

/** Someone started a call in one of your groups. */
export function IncomingGroupCall() {
  const ringing = useGroupCalls((s) => s.ringing)
  const g = useGroups((s) => (ringing ? s.groups[ringing.key] : undefined))
  useApp((s) => s.servers)
  if (!ringing) return null
  const caller = knownName(ringing.from)
  const title = g ? titleOf(g) : 'a group'
  return (
    <div className="incoming-call" role="alertdialog" aria-label={`${caller} started a group call`}>
      <div className="incoming-card">
        <div className="incoming-avatar"><Avatar name={caller} accountKey={ringing.from} size={96} /></div>
        <h2>{title}</h2>
        <p className="muted">{caller} started a {ringing.video ? 'video' : 'voice'} call</p>
        <span className="e2e-badge"><Lock size={13} /> End-to-end encrypted</span>
        <div className="incoming-actions">
          <label className="incoming-action">
            <button className="call-button hang-up" onClick={declineGroupCall} aria-label="Decline"><PhoneOff /></button>
            <span>Decline</span>
          </label>
          <label className="incoming-action">
            <button className="call-button accept" onClick={() => { openGroup(ringing.key); void joinOngoingCall(ringing.key, ringing.video) }} aria-label="Join" autoFocus>
              {ringing.video ? <Video /> : <Phone />}
            </button>
            <span>Join</span>
          </label>
        </div>
      </div>
    </div>
  )
}
