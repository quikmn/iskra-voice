// What pop-out windows show (state/popouts.ts): rendered from the main page into each pop-out's document, so they
// share its state, its server connection and its call. The voice/call panel, one stream, or a text channel. (The bug
// report's window uses the same frame, rendered by ui/bugReport/BugReportDialog.tsx, which is there before sign-in too.)
import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { b64u } from '../../core/crypto'
import { loadHistory, useApp, type ServerState } from '../../state/store'
import type { Channel } from '../../core/protocol'
import { EncryptedWriteBlock, useEncryptedWriteBlock } from '../e2ee/E2ee'
import { hangUp } from '../../state/calls'
import { nameOf } from '../../state/dms'
import { leaveGroupCall, useGroupCalls } from '../../state/groupCalls'
import { knownName, titleOf, useGroups } from '../../state/groups'
import { leaveVoice, toggleDeafen, toggleMute, useVoice, videoTrackFor, type Tile } from '../../state/voice'
import { popIn, popoutHandle, popoutRoot, popoutWindow, setPopoutFlags, startPopouts, usePopouts, type Popout } from '../../state/popouts'
import { canSendIn } from '../../state/permissions'
import { useServerRoles } from '../../state/roles'
import { Avatar } from '../bits'
import { Close, Headphones, HeadphonesOff, Mic, MicOff, PhoneOff } from '../icons'
import { Composer, MessageList, TypingLine } from '../ChatView'
import { ClickThroughIcon, PinIcon, PopInIcon } from './popoutIcons'
import { StreamerPill } from '../streamer/StreamerBits'
import './popout.css'

/** Mounted once in the shell: one portal per open pop-out. */
export function PopoutLayer() {
  const open = usePopouts((s) => s.open)
  useEffect(() => startPopouts(), [])
  return (
    <>
      {open.map((p) => {
        const root = p.target.kind === 'report' ? null : popoutRoot(p.id)
        return root ? createPortal(<PopoutFrame popout={p} />, root, p.id) : null
      })}
    </>
  )
}

/** A pop-out's bar (title, always on top, pop back in) and what it shows; `children` replaces the usual content. */
export function PopoutFrame({ popout, children }: { popout: Popout; children?: ReactNode }) {
  const { t } = useTranslation()
  const title = usePopoutTitle(popout)
  const { target, mode, id } = popout
  const desktopWindow = mode === 'window'
  useEffect(() => {
    const win = popoutWindow(id)
    if (win) win.document.title = `${title} — Iskra`
  }, [id, title])

  return (
    <div className={`popout-frame popout-${target.kind} ${desktopWindow ? 'desktop' : 'pip'} ${popout.clickThrough ? 'click-through' : ''}`} data-testid={`popout-${target.kind}`}>
      {popout.clickThrough ? (
        // Clicks fall through the window; this handle takes them while the pointer is on it (desktop/src/popoutWindows.ts).
        <button
          className="popout-handle"
          onMouseEnter={() => popoutHandle(id, true)}
          onMouseLeave={() => popoutHandle(id, false)}
          onClick={() => void setPopoutFlags(id, { clickThrough: false })}
          aria-label={t('popout.clickThroughOn')}
          title={t('popout.clickThroughOn')}
        >
          <ClickThroughIcon size={14} />
        </button>
      ) : (
        <header className="popout-bar" role="toolbar" aria-label={t('popout.windowBar')}>
          <strong className="popout-title">{title}</strong>
          <StreamerPill />
          {desktopWindow && (
            <button
              className={`icon-button small ${popout.alwaysOnTop ? 'on' : ''}`}
              onClick={() => void setPopoutFlags(id, { alwaysOnTop: !popout.alwaysOnTop })}
              aria-pressed={popout.alwaysOnTop}
              aria-label={t('popout.alwaysOnTop')}
              title={t('popout.alwaysOnTop')}
            >
              <PinIcon size={15} />
            </button>
          )}
          {desktopWindow && target.kind === 'voice' && (
            <button
              className="icon-button small"
              onClick={() => void setPopoutFlags(id, { clickThrough: true })}
              aria-pressed={false}
              aria-label={t('popout.clickThrough')}
              title={t('popout.clickThrough')}
            >
              <ClickThroughIcon size={15} />
            </button>
          )}
          {target.kind === 'report' ? (
            // Nothing to pop back into: it closes (the draft stays).
            <button className="icon-button small" onClick={() => popIn(id)} aria-label={t('common.close')} title={t('common.close')}>
              <Close size={15} />
            </button>
          ) : (
            <button className="icon-button small" onClick={() => popIn(id)} aria-label={t('popout.popIn')} title={t('popout.popIn')}>
              <PopInIcon size={15} />
            </button>
          )}
        </header>
      )}
      <div className="popout-content">
        {children ?? (target.kind === 'voice' ? <PopoutVoice /> : target.kind === 'stream' ? <PopoutStream tileId={target.tileId} />
          : target.kind === 'chat' ? <PopoutChat serverKey={target.serverKey} channelId={target.channelId} /> : null)}
      </div>
    </div>
  )
}

/** The pop-out's name: its channel, the person streaming, the call, or "Report a bug". */
export function usePopoutTitle(popout: Popout): string {
  const { t } = useTranslation()
  const session = useVoice((s) => s.session)
  const tile = useVoice((s) => (popout.target.kind === 'stream' ? s.tiles.find((x) => x.id === (popout.target as { tileId: string }).tileId) : undefined))
  const voiceServer = useApp((s) => (session ? s.servers[session.serverKey] : undefined))
  const group = useGroups((s) => (session?.group ? s.groups[session.group.key] : undefined))
  const chat = useApp((s) => (popout.target.kind === 'chat' ? s.servers[popout.target.serverKey] : undefined))
  const { target } = popout
  if (target.kind === 'report') return t('bugReport.title')
  if (target.kind === 'chat') {
    const channel = chat?.channels.find((c) => c.id === target.channelId)
    return t('popout.channelTitle', { channel: channel?.name ?? '', server: chat?.name ?? '' })
  }
  if (target.kind === 'stream') {
    const name = tile ? nameOf(tile.accountKey) : ''
    return tile?.source === 'screen' ? t('voice.stage.screenOf', { name }) : name
  }
  if (session?.group) return group ? titleOf(group) : t('voice.bar.group')
  if (session?.call) return nameOf(session.call.peer)
  return voiceServer?.channels.find((c) => c.id === session?.channelId)?.name ?? t('popout.voiceTitle')
}

interface Person {
  key: string
  name: string
  muted?: boolean
  deafened?: boolean
}

/** Who's in the call, who's talking, and your mute, deafen and leave. */
function PopoutVoice() {
  const { t } = useTranslation()
  const session = useVoice((s) => s.session)
  const speaking = useVoice((s) => s.speaking)
  const muted = useVoice((s) => s.muted)
  const deafened = useVoice((s) => s.deafened)
  const talking = useVoice((s) => s.localSpeaking)
  const me = useApp((s) => (s.identity ? b64u(s.identity.account.publicKey) : ''))
  const server = useApp((s) => (session ? s.servers[session.serverKey] : undefined))
  const groupPeople = useGroupCalls((s) => (session?.group ? s.calls[session.group.key]?.participants : undefined))
  if (!session) return null
  const people: Person[] = session.group
    ? (groupPeople ?? [me]).map((key) => ({ key, name: key === me ? t('popout.you') : knownName(key) }))
    : session.call
    ? [me, session.call.peer].map((key) => ({ key, name: key === me ? t('popout.you') : nameOf(key) }))
    : (server?.voice[session.channelId] ?? []).map((p) => ({ key: p.accountKey, name: server?.members[p.accountKey]?.name ?? t('common.someone'), muted: p.muted, deafened: p.deafened }))
  const leave = () => void (session.group ? leaveGroupCall() : session.call ? hangUp() : leaveVoice())
  const leaveLabel = session.group || session.call ? t('voice.hangUp') : t('voice.leave')

  return (
    <>
      <ul className="popout-people" aria-label={t('popout.people')}>
        {people.map((p) => (
          <li key={p.key} className={`popout-person ${speaking[p.key] ? 'speaking' : ''}`}>
            <Avatar name={p.name} accountKey={p.key} size={28} />
            <span className="popout-person-name">{p.name}</span>
            {p.deafened ? <HeadphonesOff size={14} /> : p.muted ? <MicOff size={14} /> : null}
          </li>
        ))}
      </ul>
      <div className="popout-controls" role="toolbar" aria-label={t('voice.stage.controls')}>
        {session.canSpeak && (
          <button className={`icon-button ${muted ? 'off' : ''} ${talking && !muted ? 'talking' : ''}`} onClick={() => void toggleMute()} aria-pressed={muted} aria-label={muted ? t('voice.unmute') : t('voice.mute')} title={muted ? t('voice.unmute') : t('voice.mute')}>
            {muted ? <MicOff /> : <Mic />}
          </button>
        )}
        {!session.afk && (
          <button className={`icon-button ${deafened ? 'off' : ''}`} onClick={() => void toggleDeafen()} aria-pressed={deafened} aria-label={deafened ? t('voice.undeafen') : t('voice.deafen')} title={deafened ? t('voice.undeafen') : t('voice.deafen')}>
            {deafened ? <HeadphonesOff /> : <Headphones />}
          </button>
        )}
        <button className="icon-button hang-up" onClick={leave} aria-label={leaveLabel} title={leaveLabel}>
          <PhoneOff />
        </button>
      </div>
    </>
  )
}

function PopoutStream({ tileId }: { tileId: string }) {
  const tile = useVoice((s) => s.tiles.find((x) => x.id === tileId))
  return tile ? <PopoutVideo tile={tile} /> : null
}

type ElementInfo = {
  element: object; width(): number; height(): number; visible: boolean; pictureInPicture: boolean; visibilityChangedAt: number | undefined
  handleResize?: () => void; handleVisibilityChanged?: () => void; observe(): void; stopObserving(): void
}
type Observable = { observeElementInfo(info: ElementInfo): void; stopObservingElementInfo(info: ElementInfo): void }

/**
 * The same track the call screen shows, in the pop-out's own <video>. LiveKit's adaptive stream is told it's always
 * on show (like picture-in-picture), so it keeps coming at the window's size even while the main window is hidden.
 */
export function PopoutVideo({ tile }: { tile: Tile }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const element = ref.current
    const track = videoTrackFor(tile)
    if (!element || !track) return
    track.attach(element)
    const view = element.ownerDocument.defaultView as (Window & typeof globalThis) | null
    let info: ElementInfo | null = null
    let resize: ResizeObserver | null = null
    if (view && 'observeElementInfo' in track) {
      resize = new view.ResizeObserver(() => info?.handleResize?.())
      info = {
        element, visible: true, pictureInPicture: true, visibilityChangedAt: 0,
        width: () => element.clientWidth, height: () => element.clientHeight,
        observe: () => resize?.observe(element), stopObserving: () => resize?.disconnect(),
      }
      ;(track as unknown as Observable).observeElementInfo(info)
    }
    return () => {
      if (info) (track as unknown as Observable).stopObservingElementInfo(info)
      resize?.disconnect()
      track.detach(element)
    }
  }, [tile])
  return <video ref={ref} autoPlay playsInline muted className={`popout-video ${tile.isLocal && tile.source === 'camera' ? 'mirror' : ''}`} />
}

/** A text channel: its messages, who's typing, and the composer. */
function PopoutChat({ serverKey, channelId }: { serverKey: string; channelId: number }) {
  const server = useApp((s) => s.servers[serverKey])
  const online = server?.status.state === 'online'
  useEffect(() => {
    if (online) void loadHistory(serverKey, channelId)
  }, [serverKey, channelId, online])
  const channel = server?.channels.find((c) => c.id === channelId)
  return server && channel ? <PopoutChatBody server={server} channel={channel} /> : null
}

function PopoutChatBody({ server, channel }: { server: ServerState; channel: Channel }) {
  const { t } = useTranslation()
  const roles = useServerRoles(server.key)
  const writeBlock = useEncryptedWriteBlock(server, channel.id)
  const canWrite = canSendIn(server.me, channel, roles)
  return (
    <div className="chat popout-chat">
      <MessageList key={channel.id} server={server} channelId={channel.id} />
      <TypingLine server={server} channelId={channel.id} />
      {canWrite && writeBlock ? <EncryptedWriteBlock server={server} channel={channel} text={writeBlock} />
        : canWrite ? <Composer server={server} channelId={channel.id} channelName={channel.name} />
        : <div className="composer read-only">{t('chat.view.readOnly')}</div>}
    </div>
  )
}
