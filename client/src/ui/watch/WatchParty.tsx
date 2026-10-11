import { useCallback, useEffect, useRef, useState } from 'react'
import type { Channel, StageState, WatchParty } from '../../core/protocol'
import { uploadFile, type ServerState } from '../../state/store'
import {
  canControlWatch, controlWatch, isWatchModerator, mayHostWatch, partyFor, sendWatchChat, serverNow, setAnyoneControls, startWatch, stopWatch,
  useWatch, watchKey, type WatchChatLine,
} from '../../state/watch'
import { correction, formatTime, parseWatchInput, positionAt, WATCH_RATES } from '../../state/watchSync'
import { Avatar, Modal } from '../bits'
import { Expand, Send } from '../icons'
import { videoAdapter, YouTubeBridge, youTubeEmbedUrl, YOUTUBE_FRAME, type PlayerAdapter } from './players'
import { ChatIcon, PauseIcon, PlayIcon, TvIcon, VolumeOffIcon, VolumeOnIcon } from './watchIcons'
import './watch.css'

const nameIn = (server: ServerState, accountKey: string) => server.members[accountKey]?.name ?? 'Someone'
const VOLUME_KEY = 'iskra.watchVolume'

function loadVolume(): number {
  try {
    const v = Number(localStorage.getItem(VOLUME_KEY))
    return Number.isFinite(v) && v > 0 && v <= 1 ? v : 1
  } catch {
    return 1
  }
}

/** "Watch together" in the call controls: for whoever may start a party, while none is on. */
export function WatchButton({ server, channel, stage }: { server: ServerState; channel: Channel; stage?: StageState }) {
  const party = useWatch(partyFor(server.key, channel.id))
  const [open, setOpen] = useState(false)
  if (party || !mayHostWatch(server, channel, stage)) return null
  return (
    <>
      <button className="call-button" onClick={() => setOpen(true)} aria-label="Watch together" title="Watch together">
        <TvIcon />
      </button>
      {open && <StartWatchDialog server={server} channelId={channel.id} onClose={() => setOpen(false)} />}
    </>
  )
}

function StartWatchDialog({ server, channelId, onClose }: { server: ServerState; channelId: number; onClose: () => void }) {
  const [link, setLink] = useState('')
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const parsed = parseWatchInput(link)

  async function start(source = parsed) {
    if (!source || busy) return
    setBusy(true)
    setError(null)
    try {
      await startWatch(server.key, channelId, source, title.trim() || undefined)
      onClose()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  async function upload(file: File) {
    setBusy(true)
    setError(null)
    try {
      const info = await uploadFile(server.key, file, setProgress)
      setBusy(false)
      await start({ kind: 'file', fileId: info.id })
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    } finally {
      setProgress(null)
    }
  }

  return (
    <Modal
      title="Watch together"
      onClose={onClose}
      footer={
        <>
          <button className="button" onClick={onClose}>Cancel</button>
          <button className="button primary" disabled={!parsed || busy} onClick={() => void start()}>Start</button>
        </>
      }
    >
      <p className="muted">Everyone in the channel watches in step. Paste a YouTube link or an https link to a video file, or upload one.</p>
      <label className="field">
        <span>Link</span>
        <input value={link} onChange={(e) => setLink(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void start()} placeholder="https://youtu.be/… or https://…/video.mp4" autoFocus />
      </label>
      {link.trim() && !parsed && <p className="error-text">That needs to be a YouTube link or an https:// link.</p>}
      <label className="field">
        <span>Title (optional)</span>
        <input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="Movie night" />
      </label>
      <label className={`button watch-upload ${busy ? 'disabled' : ''}`}>
        {progress !== null ? `Uploading… ${Math.round(progress * 100)}%` : 'Upload a video'}
        <input type="file" accept="video/mp4,video/webm,audio/*" hidden disabled={busy} onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
      </label>
      <p className="muted small-print">Anything else? Share your screen with audio instead.</p>
      {error && <p className="error-text" role="alert">{error}</p>}
    </Modal>
  )
}

/** The party: a big player with shared controls, and the party chat beside it (below it on phones). */
export function WatchPartyPanel({ server, channel, stage }: { server: ServerState; channel: Channel; stage?: StageState }) {
  const party = useWatch(partyFor(server.key, channel.id))
  const [chatOpen, setChatOpen] = useState(true)
  if (!party) return null
  return (
    <section className={`watch-party ${chatOpen ? '' : 'chat-closed'}`} aria-label="Watch party">
      <WatchPlayer key={party.id} server={server} channel={channel} stage={stage} party={party} chatOpen={chatOpen} onToggleChat={() => setChatOpen(!chatOpen)} />
      {chatOpen && <WatchChat server={server} channelId={channel.id} />}
    </section>
  )
}

function WatchPlayer({ server, channel, stage, party, chatOpen, onToggleChat }: {
  server: ServerState; channel: Channel; stage?: StageState; party: WatchParty; chatOpen: boolean; onToggleChat: () => void
}) {
  const adapter = useRef<PlayerAdapter | null>(null)
  const frame = useRef<HTMLDivElement>(null)
  const partyRef = useRef(party)
  useEffect(() => {
    partyRef.current = party // before the sync effect below, which reads it
  }, [party])
  const [ready, setReady] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const [now, setNow] = useState({ time: 0, duration: 0 })
  const [drag, setDrag] = useState<number | null>(null)
  const [volume, setVolume] = useState(loadVolume)
  const [muted, setMuted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const control = canControlWatch(server, channel, stage, party)
  const host = party.host === server.me?.accountKey
  const moderator = isWatchModerator(server, channel, stage)

  /** Follows the shared clock: play/pause, speed, and drift (nudge or jump). */
  const sync = useCallback(() => {
    const player = adapter.current
    if (!player) return
    const p = partyRef.current
    let expected = positionAt(p, serverNow(server.key))
    const duration = player.duration()
    if (duration > 0) expected = Math.min(expected, duration)
    // At the end the party is effectively paused there.
    const running = p.playing && (duration === 0 || expected < duration - 0.5)
    const fix = correction(player.time(), expected, p.rate, running, player.canNudge)
    if (fix.kind === 'seek') player.seek(fix.to)
    player.setRate(fix.kind === 'nudge' ? fix.rate : p.rate)
    if (running && player.paused()) {
      player.play().then(() => setBlocked(false), () => setBlocked(true))
    } else if (!p.playing && !player.paused()) player.pause()
    setNow({ time: player.time(), duration })
  }, [server.key])

  useEffect(() => {
    sync()
  }, [party, ready, sync])

  useEffect(() => {
    const timer = setInterval(sync, 1000)
    return () => clearInterval(timer)
  }, [sync])

  useEffect(() => {
    adapter.current?.setVolume(volume, muted)
    try {
      localStorage.setItem(VOLUME_KEY, String(volume))
    } catch {
      /* private mode */
    }
  }, [volume, muted, ready])

  const act = (change: Parameters<typeof controlWatch>[2]) => {
    setError(null)
    controlWatch(server.key, party, change).catch((e: Error) => setError(e.message))
  }
  const position = () => adapter.current?.time() ?? positionAt(party, serverNow(server.key))
  const commitSeek = () => {
    if (drag === null) return
    act({ position: drag })
    setDrag(null)
  }

  const title = party.source.title || (party.source.kind === 'youtube' ? 'YouTube video' : 'Video')
  return (
    <div className="watch-main">
      <div className="watch-frame" ref={frame}>
        {party.source.kind === 'youtube' ? (
          <YouTubeFrame videoId={party.source.videoId!} onReady={(a) => { adapter.current = a; setReady(true) }} onError={setFailed} />
        ) : (
          <video
            ref={(v) => {
              if (v && !adapter.current) adapter.current = videoAdapter(v)
            }}
            className="watch-video"
            src={party.source.kind === 'file' ? server.url + party.source.url : party.source.url!}
            playsInline
            preload="auto"
            onLoadedMetadata={() => setReady(true)}
            onError={() => setFailed("This video can't be played here. Check the link, or share your screen instead.")}
          />
        )}
        {failed && <div className="watch-overlay"><p>{failed}</p></div>}
        {!failed && blocked && (
          <button className="watch-overlay" onClick={() => adapter.current?.play().then(() => setBlocked(false), () => undefined)}>
            <span className="watch-overlay-play"><PlayIcon size={28} /></span>
            <span>Tap to watch along</span>
          </button>
        )}
      </div>

      <div className="watch-bar">
        <div className="watch-title">
          <strong title={title}>{title}</strong>
          <span className="muted">Hosted by {nameIn(server, party.host)}{party.anyoneControls ? ' · anyone can control' : ''}</span>
        </div>
        <div className="watch-controls" role="toolbar" aria-label="Watch party controls">
          {control && (
            <button className="icon-button" onClick={() => act({ playing: !party.playing, position: position() })} aria-label={party.playing ? 'Pause' : 'Play'} title={party.playing ? 'Pause' : 'Play'}>
              {party.playing ? <PauseIcon /> : <PlayIcon />}
            </button>
          )}
          <span className="watch-time">{formatTime(drag ?? now.time)} / {formatTime(now.duration)}</span>
          <input
            type="range"
            className="watch-seek"
            aria-label="Position"
            min={0}
            max={Math.max(now.duration, 0.1)}
            step={1}
            value={drag ?? now.time}
            disabled={!control || now.duration === 0}
            onChange={(e) => setDrag(Number(e.target.value))}
            onPointerUp={commitSeek}
            onKeyUp={commitSeek}
            onBlur={commitSeek}
          />
          <span className="spacer" />
          {control && (
            <select className="watch-rate" aria-label="Speed" value={party.rate} onChange={(e) => act({ rate: Number(e.target.value), position: position() })}>
              {WATCH_RATES.map((r) => <option key={r} value={r}>{r}×</option>)}
            </select>
          )}
          <button className="icon-button" onClick={() => setMuted(!muted)} aria-label={muted ? 'Unmute video' : 'Mute video'} title={muted ? 'Unmute video' : 'Mute video'}>
            {muted || volume === 0 ? <VolumeOffIcon /> : <VolumeOnIcon />}
          </button>
          <input type="range" className="watch-volume" aria-label="Video volume" min={0} max={1} step={0.05} value={muted ? 0 : volume}
            onChange={(e) => { setVolume(Number(e.target.value)); setMuted(false) }} />
          <button className="icon-button" onClick={() => void frame.current?.requestFullscreen?.()} aria-label="Full screen" title="Full screen"><Expand size={16} /></button>
          <button className={`icon-button ${chatOpen ? 'on' : ''}`} onClick={onToggleChat} aria-pressed={chatOpen} aria-label="Party chat" title="Party chat"><ChatIcon /></button>
        </div>
        {(host || moderator) && (
          <div className="watch-host">
            <label className="watch-toggle">
              <input type="checkbox" checked={party.anyoneControls} onChange={(e) => setAnyoneControls(server.key, party, e.target.checked).catch((err: Error) => setError(err.message))} />
              Anyone can control
            </label>
            <button className="button small danger-outline" onClick={() => stopWatch(server.key, party).catch((e: Error) => setError(e.message))}>End watch party</button>
          </div>
        )}
        {error && <p className="error-text" role="alert">{error}</p>}
      </div>
    </div>
  )
}

/**
 * YouTube's privacy-enhanced embed in a sandboxed frame, driven over the IFrame Player API's postMessage protocol:
 * no YouTube script runs in the app's page. Reports an adapter once the player answers.
 */
function YouTubeFrame({ videoId, onReady, onError }: { videoId: string; onReady: (adapter: PlayerAdapter) => void; onError: (message: string) => void }) {
  const ref = useRef<HTMLIFrameElement>(null)
  const callbacks = useRef({ onReady, onError })
  const src = youTubeEmbedUrl(videoId, window.location.origin)
  useEffect(() => {
    callbacks.current = { onReady, onError }
  }, [onReady, onError])
  useEffect(() => {
    const frame = ref.current
    if (!frame) return
    const bridge = new YouTubeBridge(frame)
    let announced = false
    let failed = false
    const onMessage = (e: MessageEvent) => {
      if (!bridge.receive(e)) return
      if (bridge.info.error !== null && !failed) {
        failed = true
        callbacks.current.onError("YouTube won't play this video here (it may not allow embedding).")
      }
      if (bridge.info.ready && !announced) {
        announced = true
        callbacks.current.onReady(bridge.adapter())
      }
    }
    const onLoad = () => bridge.listen()
    window.addEventListener('message', onMessage)
    frame.addEventListener('load', onLoad)
    // Ask the player to report to us until it does (it ignores us before it has loaded).
    const listen = setInterval(() => {
      if (!bridge.info.ready) bridge.listen()
    }, 400)
    return () => {
      window.removeEventListener('message', onMessage)
      frame.removeEventListener('load', onLoad)
      clearInterval(listen)
    }
  }, [videoId])
  return (
    <iframe
      ref={ref}
      className="watch-video"
      title="YouTube video"
      src={src}
      allow={YOUTUBE_FRAME.allow}
      referrerPolicy={YOUTUBE_FRAME.referrerPolicy}
      sandbox={YOUTUBE_FRAME.sandbox}
      allowFullScreen
    />
  )
}

function WatchChat({ server, channelId }: { server: ServerState; channelId: number }) {
  const lines = useWatch((s) => s.chat[watchKey(server.key, channelId)]) ?? EMPTY
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const list = useRef<HTMLOListElement>(null)
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight })
  }, [lines.length])

  async function send() {
    const message = text.trim()
    if (!message) return
    setText('')
    setError(null)
    try {
      await sendWatchChat(server.key, channelId, message)
    } catch (e) {
      setError((e as Error).message)
      setText(message)
    }
  }

  return (
    <aside className="watch-chat" aria-label="Party chat">
      <header>Party chat</header>
      <ol ref={list}>
        {lines.length === 0 && <li className="muted watch-chat-empty">Say hi. Messages here aren't saved.</li>}
        {lines.map((line, i) => (
          <li key={`${line.at}-${i}`}>
            <Avatar name={nameIn(server, line.accountKey)} accountKey={line.accountKey} size={22} />
            <span><strong>{nameIn(server, line.accountKey)}</strong> {line.text}</span>
          </li>
        ))}
      </ol>
      <form onSubmit={(e) => { e.preventDefault(); void send() }}>
        <input value={text} maxLength={500} onChange={(e) => setText(e.target.value)} placeholder="Message the party" aria-label="Message the party" />
        <button className="icon-button" type="submit" disabled={!text.trim()} aria-label="Send"><Send size={16} /></button>
      </form>
      {error && <p className="error-text">{error}</p>}
    </aside>
  )
}

const EMPTY: WatchChatLine[] = []
