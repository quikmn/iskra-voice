import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MAX_STAGE_TOPIC, roleRank, type Channel, type StageState, type VoiceParticipant } from '../../core/protocol'
import type { ServerState } from '../../state/store'
import {
  declineHand, endStage, inviteToSpeak, isStageModerator, listenerLabel, maySpeak, moveToAudience, muteSpeaker, removeFromStage,
  setHand, setStageModerator, setStageTopic, stageFor, stageView, startStage, useStages,
} from '../../state/stages'
import { useVoice } from '../../state/voice'
import { openProfileCard } from '../../state/profile'
import { Avatar, Modal } from '../bits'
import { HeadphonesOff, Menu, Mic, MicOff, Pencil, Users } from '../icons'
import { useEscapeLayer, useFocusTrap } from '../layers'
import type { Panel } from '../Shell'
import { CallControls, VideoTile } from '../VoiceStage'
import { CheckIcon, HandIcon, ShieldIcon, StageIcon, StepDownIcon, UserMinusIcon } from './stageIcons'
import './stage.css'

const nameIn = (server: ServerState, accountKey: string) => server.members[accountKey]?.name ?? 'Someone'

/** A stage: speakers up top (with video and screen shares), the audience below, and moderator tools. */
export function StageView({ server, onToggle }: { server: ServerState; onToggle: (panel: Panel) => void }) {
  const session = useVoice((s) => s.session)!
  const channelId = session.channelId
  const channel = server.channels.find((c) => c.id === channelId)
  const state = useStages(stageFor(server.key, channelId))
  const tiles = useVoice((s) => s.tiles)
  const speaking = useVoice((s) => s.speaking)
  const muted = useVoice((s) => s.muted)
  const [person, setPerson] = useState<string | null>(null)
  const [dialog, setDialog] = useState<'topic' | 'moderators' | 'end' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [focusId, setFocusId] = useState<string | null>(null)

  const me = server.me?.accountKey ?? ''
  const participants = server.voice[channelId] ?? []
  const { speakers, audience, hands } = stageView(state, participants)
  const live = !!state?.live
  const moderator = isStageModerator(server, state, me)
  const isAdmin = server.me ? roleRank(server.me.role) >= roleRank('admin') : false
  const amSpeaker = !!state?.speakers.includes(me)
  const handUp = hands.includes(me)
  const canAsk = !!channel && maySpeak(server, channel, state, me)

  const run = (action: () => Promise<unknown>) => () => {
    setError(null)
    action().catch((e: Error) => setError(e.message))
  }

  const speakerTiles = tiles.filter((t) => state?.speakers.includes(t.accountKey))
  const focused = speakerTiles.find((t) => t.id === focusId) ?? speakerTiles.find((t) => t.source === 'screen') ?? null
  const withVideo = new Set(speakerTiles.map((t) => t.accountKey))

  const openPerson = (accountKey: string, anchor: Element) => {
    if (moderator) setPerson(accountKey)
    else openProfileCard(server.key, accountKey, anchor)
  }

  const stageButton = !live ? null : amSpeaker ? (
    <button className="call-button" onClick={run(() => moveToAudience(server.key, channelId))} aria-label="Move to audience" title="Move to audience">
      <StepDownIcon />
    </button>
  ) : moderator ? (
    <button className="call-button" onClick={run(() => inviteToSpeak(server.key, channelId, me))} aria-label="Speak" title="Speak">
      <Mic />
    </button>
  ) : canAsk ? (
    <button
      className={`call-button ${handUp ? 'on' : ''}`}
      onClick={run(() => setHand(server.key, channelId, !handUp))}
      aria-pressed={handUp}
      aria-label={handUp ? 'Lower hand' : 'Raise hand'}
      title={handUp ? 'Lower hand' : 'Ask to speak'}
    >
      <HandIcon />
    </button>
  ) : null

  return (
    <div className="stage stage-channel">
      <header className="chat-header">
        <button className="icon-button mobile-only" onClick={() => onToggle('nav')} aria-label="Open channels">
          <Menu />
        </button>
        <h1>
          <span className="hash"><StageIcon size={20} /></span>
          {channel?.name ?? 'Stage'}
        </h1>
        {live && <span className="live-pill">Live</span>}
        <span className="spacer" />
        {moderator && live && (
          <button className="icon-button" onClick={() => setDialog('topic')} aria-label="Edit topic" title="Edit topic">
            <Pencil />
          </button>
        )}
        {isAdmin && (
          <button className="icon-button" onClick={() => setDialog('moderators')} aria-label="Stage moderators" title="Stage moderators">
            <ShieldIcon />
          </button>
        )}
        {moderator && live && (
          <button className="button small danger-outline stage-end" onClick={() => setDialog('end')}>End stage</button>
        )}
        <button className="icon-button members-toggle" onClick={() => onToggle('members')} aria-label="Members" title="Members">
          <Users />
        </button>
      </header>

      <div className="stage-body stage-scroll">
        {!live ? (
          <StageLobby server={server} channelId={channelId} moderator={moderator} connected={session.state === 'connected'} count={participants.length} />
        ) : (
          <>
            <section className="stage-topic" aria-label="Topic">
              <h2>{state?.topic}</h2>
              <p className="muted">
                {listenerLabel(audience.length)}
                {state?.startedBy && <> · started by {nameIn(server, state.startedBy)}</>}
              </p>
              {amSpeaker && session.canSpeak && muted && <p className="stage-hint-pill">You're on stage. Unmute when you're ready to talk.</p>}
            </section>

            <section className="stage-speakers" aria-label="Speakers">
              {focused && <VideoTile tile={focused} name={nameIn(server, focused.accountKey)} big speaking={!!speaking[focused.accountKey]} />}
              <div className="stage-grid">
                {speakerTiles.filter((t) => t !== focused).map((tile) => (
                  <VideoTile key={tile.id} tile={tile} name={nameIn(server, tile.accountKey)} speaking={!!speaking[tile.accountKey]} onClick={() => setFocusId(tile.id)} />
                ))}
                {speakers.filter((p) => !withVideo.has(p.accountKey)).map((p) => (
                  <SpeakerTile key={p.accountKey} server={server} participant={p} speaking={!!speaking[p.accountKey]} onOpen={openPerson} />
                ))}
              </div>
              {speakers.length === 0 && <p className="muted stage-hint">Nobody is speaking right now.</p>}
            </section>

            {moderator && hands.length > 0 && (
              <section className="stage-requests" aria-label="Requests to speak">
                <h3>Requests to speak <span className="count">{hands.length}</span></h3>
                <ul>
                  {hands.map((key) => (
                    <li key={key}>
                      <Avatar name={nameIn(server, key)} accountKey={key} size={28} />
                      <span className="member-name">{nameIn(server, key)}</span>
                      <button className="button small primary" onClick={run(() => inviteToSpeak(server.key, channelId, key))} aria-label={`Let ${nameIn(server, key)} speak`}>
                        <CheckIcon size={14} /> Accept
                      </button>
                      <button className="button small ghost" onClick={run(() => declineHand(server.key, channelId, key))} aria-label={`Decline ${nameIn(server, key)}`}>
                        Decline
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="stage-audience" aria-label="Audience">
              <h3>Audience <span className="count">{audience.length}</span></h3>
              {audience.length === 0 ? (
                <p className="muted">No listeners yet.</p>
              ) : (
                <ul>
                  {audience.map((p) => (
                    <li key={p.accountKey}>
                      <button className="stage-listener" onClick={(e) => openPerson(p.accountKey, e.currentTarget)} aria-label={nameIn(server, p.accountKey)}>
                        <Avatar name={nameIn(server, p.accountKey)} accountKey={p.accountKey} size={48} />
                        {hands.includes(p.accountKey) && <span className="hand-badge" title="Wants to speak"><HandIcon size={12} /></span>}
                        <span className="listener-name">{nameIn(server, p.accountKey)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
        {error && <p className="error-text stage-error" role="alert">{error}</p>}
      </div>

      <CallControls extra={stageButton} />

      {person && channel && (
        <PersonSheet server={server} channel={channel} state={state} accountKey={person} onError={setError} onClose={() => setPerson(null)} />
      )}
      {dialog === 'topic' && (
        <TopicDialog initial={state?.topic ?? ''} onClose={() => setDialog(null)} onSave={(topic) => setStageTopic(server.key, channelId, topic)} />
      )}
      {dialog === 'moderators' && channel && <ModeratorsDialog server={server} channel={channel} state={state} onClose={() => setDialog(null)} />}
      {dialog === 'end' && (
        <Modal
          title="End the stage?"
          onClose={() => setDialog(null)}
          footer={
            <>
              <button className="button" onClick={() => setDialog(null)}>Cancel</button>
              <button className="button danger" onClick={() => { setDialog(null); run(() => endStage(server.key, channelId))() }}>End stage</button>
            </>
          }
        >
          <p>Everyone on the stage will be disconnected.</p>
        </Modal>
      )}
    </div>
  )
}

function SpeakerTile({ server, participant, speaking, onOpen }: {
  server: ServerState; participant: VoiceParticipant; speaking: boolean; onOpen: (accountKey: string, anchor: Element) => void
}) {
  const name = nameIn(server, participant.accountKey)
  return (
    <div
      className={`person-tile ${speaking ? 'speaking' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={name}
      onClick={(e) => onOpen(participant.accountKey, e.currentTarget)}
      onKeyDown={(e) => e.key === 'Enter' && onOpen(participant.accountKey, e.currentTarget)}
    >
      <Avatar name={name} accountKey={participant.accountKey} size={72} />
      <span className="tile-label">
        {name}
        {participant.deafened ? <HeadphonesOff size={14} /> : participant.muted ? <MicOff size={14} /> : null}
      </span>
    </div>
  )
}

/** Before the stage goes live: moderators set a topic and start it; everyone else waits. */
function StageLobby({ server, channelId, moderator, connected, count }: {
  server: ServerState; channelId: number; moderator: boolean; connected: boolean; count: number
}) {
  const [topic, setTopic] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inRoom = !!server.me && (server.voice[channelId] ?? []).some((p) => p.accountKey === server.me!.accountKey)

  async function start() {
    if (!topic.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await startStage(server.key, channelId, topic.trim())
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="stage-lobby">
      <span className="stage-lobby-icon" aria-hidden><StageIcon size={30} /></span>
      {moderator ? (
        <>
          <h2>Start the stage</h2>
          <p className="muted">Pick a topic. You'll speak first; others join as listeners and can ask to speak.</p>
          <form className="stage-start" onSubmit={(e) => { e.preventDefault(); void start() }}>
            <label className="field">
              <span>Topic</span>
              <input value={topic} maxLength={MAX_STAGE_TOPIC} onChange={(e) => setTopic(e.target.value)} placeholder="Friday game night" />
            </label>
            <button className="button primary" type="submit" disabled={!topic.trim() || busy || !connected || !inRoom}>Go live</button>
          </form>
          {error && <p className="error-text" role="alert">{error}</p>}
        </>
      ) : (
        <>
          <h2>This stage isn't live yet</h2>
          <p className="muted">You'll hear the speakers as soon as a moderator starts it.</p>
        </>
      )}
      {count > 0 && <p className="muted">{count === 1 ? '1 person here' : `${count} people here`}</p>}
    </div>
  )
}

/** A moderator's actions for one person on the stage, as a sheet (works the same on phones). */
function PersonSheet({ server, channel, state, accountKey, onError, onClose }: {
  server: ServerState; channel: Channel; state: StageState | undefined; accountKey: string; onError: (message: string) => void; onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEscapeLayer(onClose)
  useFocusTrap(ref)
  const me = server.me
  const participant = (server.voice[channel.id] ?? []).find((p) => p.accountKey === accountKey)
  const target = server.members[accountKey]
  const self = me?.accountKey === accountKey
  const speaker = !!state?.speakers.includes(accountKey)
  const hand = !!state?.hands.some((h) => h.accountKey === accountKey)
  // Moderators can't act on other moderators, except admins on those ranked below them (as the server checks).
  const canAct = self || !isStageModerator(server, state, accountKey)
    || (!!me && !!target && roleRank(me.role) >= roleRank('admin') && roleRank(me.role) > roleRank(target.role))
  const live = !!state?.live
  const act = (action: () => Promise<unknown>) => () => {
    onClose()
    action().catch((e: Error) => onError(e.message))
  }
  const name = nameIn(server, accountKey)

  return createPortal(
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="action-sheet" role="dialog" aria-label={`${name} on the stage`} ref={ref} tabIndex={-1}>
        <span className="sheet-grabber" aria-hidden />
        <div className="stage-sheet-head">
          <Avatar name={name} accountKey={accountKey} size={40} />
          <div>
            <strong>{name}</strong>
            <span className="muted">{speaker ? 'Speaker' : hand ? 'Wants to speak' : 'Listener'}</span>
          </div>
        </div>
        <div className="sheet-list" role="menu">
          <button role="menuitem" onClick={() => { onClose(); openProfileCard(server.key, accountKey, null) }}><Users /> View profile</button>
          {live && canAct && !speaker && maySpeak(server, channel, state, accountKey) && (
            <button role="menuitem" onClick={act(() => inviteToSpeak(server.key, channel.id, accountKey))}><HandIcon /> {self ? 'Speak' : 'Invite to speak'}</button>
          )}
          {live && hand && !self && (
            <button role="menuitem" onClick={act(() => declineHand(server.key, channel.id, accountKey))}><StepDownIcon /> Decline request</button>
          )}
          {live && canAct && speaker && !self && !participant?.muted && (
            <button role="menuitem" onClick={act(() => muteSpeaker(server.key, channel.id, accountKey))}><MicOff /> Mute</button>
          )}
          {live && canAct && speaker && (
            <button role="menuitem" onClick={act(() => moveToAudience(server.key, channel.id, self ? undefined : accountKey))}><StepDownIcon /> Move to audience</button>
          )}
          {canAct && !self && (
            <button role="menuitem" className="danger" onClick={act(() => removeFromStage(server.key, channel.id, accountKey))}><UserMinusIcon /> Remove from stage</button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

function TopicDialog({ initial, onSave, onClose }: { initial: string; onSave: (topic: string) => Promise<void>; onClose: () => void }) {
  const [topic, setTopic] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const save = () => {
    if (!topic.trim()) return
    onSave(topic.trim()).then(onClose, (e: Error) => setError(e.message))
  }
  return (
    <Modal
      title="Stage topic"
      onClose={onClose}
      footer={
        <>
          <button className="button" onClick={onClose}>Cancel</button>
          <button className="button primary" disabled={!topic.trim()} onClick={save}>Save</button>
        </>
      }
    >
      <label className="field">
        <span>Topic</span>
        <input value={topic} maxLength={MAX_STAGE_TOPIC} onChange={(e) => setTopic(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} autoFocus />
      </label>
      {error && <p className="error-text">{error}</p>}
    </Modal>
  )
}

/** Admins pick who else moderates this stage. */
function ModeratorsDialog({ server, channel, state, onClose }: { server: ServerState; channel: Channel; state: StageState | undefined; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const people = Object.values(server.members)
    .filter((m) => !m.bot && roleRank(m.role) < roleRank('admin') && roleRank(m.role) >= roleRank(channel.readRole))
    .filter((m) => m.name.toLowerCase().includes(filter.trim().toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name))
  return (
    <Modal title="Stage moderators" onClose={onClose} footer={<button className="button primary" onClick={onClose}>Done</button>}>
      <p className="muted">Moderators start and end the stage, bring people up to speak and send them back. Admins always can.</p>
      <label className="field">
        <span>Find someone</span>
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Name" />
      </label>
      <ul className="stage-moderators">
        {people.map((m) => {
          const on = !!state?.moderators.includes(m.accountKey)
          return (
            <li key={m.accountKey}>
              <label>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => setStageModerator(server.key, channel.id, m.accountKey, !on).catch((e: Error) => setError(e.message))}
                />
                <Avatar name={m.name} accountKey={m.accountKey} size={28} />
                <span className="member-name">{m.name}</span>
                <span className="muted role">{m.role}</span>
              </label>
            </li>
          )
        })}
        {people.length === 0 && <li className="muted">Nobody else to pick.</li>}
      </ul>
      {error && <p className="error-text">{error}</p>}
    </Modal>
  )
}
