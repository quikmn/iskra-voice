import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import type { Channel, StageState, WatchParty } from '../../core/protocol'
import { uploadFile, type ServerState } from '../../state/store'
import {
  canControlWatch, controlWatch, isWatchModerator, mayHostWatch, nextWatch, partyFor, sendWatchChat, serverNow, setAnyoneControls, setAudioOnly,
  startWatch, stopWatch, useWatch, watchKey, type WatchChatLine,
} from '../../state/watch'
import { correction, formatTime, parseWatchInput, positionAt, WATCH_RATES } from '../../state/watchSync'
import { sourceKey } from '../../state/watchQueueLogic'
import { needsGate, startedSites, withAgreedSite } from '../../state/watchConsentLogic'
import { Avatar, Modal } from '../bits'
import { Expand, Send } from '../icons'
import { videoAdapter, YouTubeBridge, youTubeEmbedUrl, YOUTUBE_FRAME, type PlayerAdapter } from './players'
import { ChatIcon, NextIcon, PauseIcon, PlayIcon, QueueIcon, TvIcon, VolumeOffIcon, VolumeOnIcon } from './watchIcons'
import { NowPlaying, usePhoneLike, WatchQueue } from './WatchQueue'
import './watch.css'
import { useTranslation } from 'react-i18next'
import { t as i18t } from '../../i18n'
import { errorMessage } from '../../i18n/errors'
import { formatNumber } from '../../i18n/format'
import { setAlwaysLoad, siteName, useAlwaysLoads, watchSourceSite, watchVideoSrc } from '../../state/siteConsent'

const nameIn = (server: ServerState, accountKey: string) => server.members[accountKey]?.name ?? i18t('common.someone')
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
  const { t } = useTranslation()
  const party = useWatch(partyFor(server.key, channel.id))
  const [open, setOpen] = useState(false)
  if (party || !mayHostWatch(server, channel, stage)) return null
  return (
    <>
      <button className="call-button" onClick={() => setOpen(true)} aria-label={t('watch.watchTogether')} title={t('watch.watchTogether')}>
        <TvIcon />
      </button>
      {open && <StartWatchDialog server={server} channelId={channel.id} onClose={() => setOpen(false)} />}
    </>
  )
}

function StartWatchDialog({ server, channelId, onClose }: { server: ServerState; channelId: number; onClose: () => void }) {
  const { t } = useTranslation()
  const [link, setLink] = useState('')
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const parsed = parseWatchInput(link)
  const startSite = (source: NonNullable<typeof parsed>) => watchSourceSite(source, server.url)

  async function start(source = parsed) {
    if (!source || busy) return
    setBusy(true)
    setError(null)
    try {
      await startWatch(server.key, channelId, source, title.trim() || undefined)
      onClose()
    } catch (e) {
      setError(errorMessage(e))
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
      setError(errorMessage(e))
      setBusy(false)
    } finally {
      setProgress(null)
    }
  }

  return (
    <Modal
      title={t('watch.watchTogether')}
      onClose={onClose}
      footer={
        <>
          <button className="button" onClick={onClose}>{t('common.cancel')}</button>
          <button className="button primary" disabled={!parsed || busy} onClick={() => void start()}>{t('watch.start')}</button>
        </>
      }
    >
      <p className="muted">{t('watch.intro')}</p>
      <label className="field">
        <span>{t('watch.link')}</span>
        <input value={link} onChange={(e) => setLink(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void start()} placeholder={t('watch.linkPlaceholder')} autoFocus />
      </label>
      {link.trim() && !parsed && <p className="error-text">{t('watch.badLink')}</p>}
      {parsed && startSite(parsed) && <p className="muted small-print" data-testid="watch-start-note">{t('watch.startNote', { site: siteName(startSite(parsed)!) })}</p>}
      <label className="field">
        <span>{t('watch.titleOptional')}</span>
        <input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder={t('watch.titlePlaceholder')} />
      </label>
      <label className={`button watch-upload ${busy ? 'disabled' : ''}`}>
        {progress !== null ? t('watch.uploading', { percent: Math.round(progress * 100) }) : t('watch.uploadVideo')}
        <input type="file" accept="video/mp4,video/webm,audio/*" hidden disabled={busy} onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
      </label>
      <p className="muted small-print">{t('watch.screenInstead')}</p>
      {error && <p className="error-text" role="alert">{error}</p>}
    </Modal>
  )
}

/** The party: a big player with shared controls, and the party chat beside it (below it on phones). */
export function WatchPartyPanel({ server, channel, stage }: { server: ServerState; channel: Channel; stage?: StageState }) {
  const { t } = useTranslation()
  const party = useWatch(partyFor(server.key, channel.id))
  const [chatOpen, setChatOpen] = useState(true)
  if (!party) return null
  return (
    <section className={`watch-party ${chatOpen ? '' : 'chat-closed'}`} aria-label={t('watch.watchParty')}>
      <WatchPlayer key={party.id} server={server} channel={channel} stage={stage} party={party} chatOpen={chatOpen} onToggleChat={() => setChatOpen(!chatOpen)} />
      {chatOpen && <WatchChat server={server} channelId={channel.id} />}
    </section>
  )
}

function WatchPlayer({ server, channel, stage, party, chatOpen, onToggleChat }: {
  server: ServerState; channel: Channel; stage?: StageState; party: WatchParty; chatOpen: boolean; onToggleChat: () => void
}) {
  const { t } = useTranslation()
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
  const [queueOpen, setQueueOpen] = useState(false)
  const phone = usePhoneLike()
  const control = canControlWatch(server, channel, stage, party)
  const controlRef = useRef(control)
  controlRef.current = control
  /** The playId we already asked to move on from, so an ended item asks once (the server ignores late asks anyway). */
  const advancedFrom = useRef<string | null>(null)
  const queue = party.queue ?? []
  const audioOnly = !!party.audioOnly
  const host = party.host === server.me?.accountKey
  // Plays from another site: say so first, once per site for this party (a queued item from elsewhere asks again),
  // unless this device always allows it. The host already agreed to the site of what they started themselves.
  const site = watchSourceSite(party.source, server.url)
  const always = useAlwaysLoads(site)
  const [agreed, setAgreed] = useState(() => startedSites(party, server.me?.accountKey, site))
  const gated = needsGate(site, agreed, always)
  // A link that isn't a plain web address (or a file elsewhere than this server) never plays: it would skip the gate.
  const src = party.source.kind === 'youtube' ? null : watchVideoSrc(party.source, server.url)
  const badLink = party.source.kind !== 'youtube' && !src
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
    // Listen together: this item ended and more is queued. Whoever may control asks the server to move on, once per
    // playId; when several apps ask at the same moment, the server moves on for the first and ignores the rest.
    if (controlRef.current && p.playing && player.ended() && (p.queue?.length ?? 0) > 0 && advancedFrom.current !== (p.playId ?? null)) {
      advancedFrom.current = p.playId ?? null
      void nextWatch(server.key, p, p.playId).catch(() => undefined)
    }
    setNow({ time: player.time(), duration })
  }, [server.key])

  useEffect(() => {
    sync()
  }, [party, ready, sync])

  // The party moved on to another source: the player below is a fresh one (keyed), so forget the old one's state.
  const key = sourceKey(party.source)
  const lastKey = useRef(key)
  useEffect(() => {
    if (lastKey.current === key) return
    lastKey.current = key
    if (party.source.kind === 'youtube') adapter.current = null // the new frame reports an adapter once it answers
    setReady(false)
    setFailed(null)
    setBlocked(false)
    setNow({ time: 0, duration: 0 })
  }, [key, party.source.kind])

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
    controlWatch(server.key, party, change).catch((e: Error) => setError(errorMessage(e)))
  }
  const position = () => adapter.current?.time() ?? positionAt(party, serverNow(server.key))
  const commitSeek = () => {
    if (drag === null) return
    act({ position: drag })
    setDrag(null)
  }

  const title = party.source.title || (party.source.kind === 'youtube' ? t('watch.youtubeVideo') : t('watch.video'))
  // Audio only (a jukebox): the player keeps playing out of sight and a now-playing bar takes its place; the consent
  // gate still shows first, since the player can't load before it.
  const hidden = audioOnly && !gated && !badLink
  return (
    <div className={`watch-main ${hidden ? 'audio-only' : ''}`}>
      <div className="watch-frame" ref={frame}>
        <Fragment key={key}>
          {badLink ? (
            <div className="watch-overlay" data-testid="watch-bad-link"><p>{t('watch.unplayableLink')}</p></div>
          ) : gated ? (
            <WatchGate site={site!} onWatch={() => setAgreed((sites) => withAgreedSite(sites, site!))} />
          ) : party.source.kind === 'youtube' ? (
            <YouTubeFrame videoId={party.source.videoId!} onReady={(a) => { adapter.current = a; setReady(true) }} onError={setFailed} />
          ) : (
            <video
              ref={(v) => {
                if (v) adapter.current = videoAdapter(v)
              }}
              className="watch-video"
              src={src!}
              playsInline
              preload="auto"
              onLoadedMetadata={() => setReady(true)}
              onError={() => setFailed(t('watch.cantPlay'))}
            />
          )}
        </Fragment>
        {failed && !badLink && <div className="watch-overlay"><p>{failed}</p></div>}
        {!failed && !gated && !badLink && blocked && (
          <button className="watch-overlay" onClick={() => adapter.current?.play().then(() => setBlocked(false), () => undefined)}>
            <span className="watch-overlay-play"><PlayIcon size={28} /></span>
            <span>{t('watch.tapToWatch')}</span>
          </button>
        )}
      </div>

      {hidden && <NowPlaying server={server} party={party} title={title} showArt={!gated} />}
      <div className="watch-bar">
        {!hidden && (
          <div className="watch-title">
            <strong title={title}>{title}</strong>
            <span className="muted">{t('watch.hostedBy', { name: nameIn(server, party.host) })}{party.anyoneControls ? t('watch.anyoneControlsSuffix') : ''}</span>
          </div>
        )}
        <div className="watch-controls" role="toolbar" aria-label={t('watch.controls')}>
          {control && (
            <button className="icon-button" onClick={() => act({ playing: !party.playing, position: position() })} aria-label={party.playing ? t('watch.pause') : t('watch.play')} title={party.playing ? t('watch.pause') : t('watch.play')}>
              {party.playing ? <PauseIcon /> : <PlayIcon />}
            </button>
          )}
          {control && queue.length > 0 && (
            <button
              className="icon-button" data-testid="watch-next" aria-label={t('watch.next')} title={t('watch.next')}
              onClick={() => {
                advancedFrom.current = party.playId ?? null
                setError(null)
                nextWatch(server.key, party, party.playId).catch((e: Error) => setError(errorMessage(e)))
              }}
            >
              <NextIcon />
            </button>
          )}
          <span className="watch-time">{formatTime(drag ?? now.time)} / {formatTime(now.duration)}</span>
          <input
            type="range"
            className="watch-seek"
            aria-label={t('watch.position')}
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
            <select className="watch-rate" aria-label={t('watch.speed')} value={party.rate} onChange={(e) => act({ rate: Number(e.target.value), position: position() })}>
              {WATCH_RATES.map((r) => <option key={r} value={r}>{t('watch.rate', { rate: formatNumber(r) })}</option>)}
            </select>
          )}
          <WatchVolume volume={volume} muted={muted} onVolume={(v) => { setVolume(v); setMuted(false) }} onMuted={setMuted} />
          {!hidden && <button className="icon-button" onClick={() => void frame.current?.requestFullscreen?.()} aria-label={t('watch.fullScreen')} title={t('watch.fullScreen')}><Expand size={16} /></button>}
          <button className={`icon-button ${queueOpen ? 'on' : ''}`} data-testid="watch-queue-button" onClick={() => setQueueOpen(!queueOpen)} aria-pressed={queueOpen} aria-label={t('watch.queueOpen')} title={t('watch.queueOpen')}>
            <QueueIcon />{queue.length > 0 && <span className="watch-queue-badge">{queue.length}</span>}
          </button>
          <button className={`icon-button ${chatOpen ? 'on' : ''}`} onClick={onToggleChat} aria-pressed={chatOpen} aria-label={t('watch.partyChat')} title={t('watch.partyChat')}><ChatIcon /></button>
        </div>
        {(host || moderator) && (
          <div className="watch-host">
            <label className="watch-toggle">
              <input type="checkbox" checked={party.anyoneControls} onChange={(e) => setAnyoneControls(server.key, party, e.target.checked).catch((err: Error) => setError(errorMessage(err)))} />
              {t('watch.anyoneControls')}
            </label>
            <label className="watch-toggle" title={t('watch.audioOnlyHint')}>
              <input type="checkbox" checked={audioOnly} onChange={(e) => setAudioOnly(server.key, party, e.target.checked).catch((err: Error) => setError(errorMessage(err)))} />
              {t('watch.audioOnly')}
            </label>
            <button className="button small danger-outline" onClick={() => stopWatch(server.key, party).catch((e: Error) => setError(errorMessage(e)))}>{t('watch.end')}</button>
          </div>
        )}
        {error && <p className="error-text" role="alert">{error}</p>}
      </div>
      {queueOpen && <WatchQueue server={server} party={party} control={control} sheet={phone} onClose={() => setQueueOpen(false)} />}
    </div>
  )
}

/**
 * YouTube's privacy-enhanced embed in a sandboxed frame, driven over the IFrame Player API's postMessage protocol:
 * no YouTube script runs in the app's page. Reports an adapter once the player answers.
 */
function YouTubeFrame({ videoId, onReady, onError }: { videoId: string; onReady: (adapter: PlayerAdapter) => void; onError: (message: string) => void }) {
  const { t } = useTranslation()
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
        callbacks.current.onError(i18t('watch.youtubeRefused'))
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
      title={t('watch.youtubeVideo')}
      src={src}
      allow={YOUTUBE_FRAME.allow}
      referrerPolicy={YOUTUBE_FRAME.referrerPolicy}
      sandbox={YOUTUBE_FRAME.sandbox}
      allowFullScreen
    />
  )
}

/** Before anything loads from another site: where it plays from, a button, and "Always load from <site>". */
function WatchGate({ site, onWatch }: { site: string; onWatch: () => void }) {
  const { t } = useTranslation()
  const [remember, setRemember] = useState(false)
  const name = siteName(site)
  return (
    <div className="watch-overlay watch-gate" data-testid="watch-gate">
      <p>{t('watch.playsFrom', { site: name })}</p>
      <button className="button primary" onClick={() => {
        if (remember) setAlwaysLoad(site, true)
        onWatch()
      }}>
        {t('watch.watchFrom', { site: name })}
      </button>
      <label className="checkbox">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        {t('chat.embed.always', { site: name })}
      </label>
    </div>
  )
}

function WatchChat({ server, channelId }: { server: ServerState; channelId: number }) {
  const { t } = useTranslation()
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
      setError(errorMessage(e))
      setText(message)
    }
  }

  return (
    <aside className="watch-chat" aria-label={t('watch.partyChat')}>
      <header>{t('watch.partyChat')}</header>
      <ol ref={list}>
        {lines.length === 0 && <li className="muted watch-chat-empty">{t('watch.chatEmpty')}</li>}
        {lines.map((line, i) => (
          <li key={`${line.at}-${i}`}>
            <Avatar name={nameIn(server, line.accountKey)} accountKey={line.accountKey} size={22} />
            <span><strong>{nameIn(server, line.accountKey)}</strong> {line.text}</span>
          </li>
        ))}
      </ol>
      <form onSubmit={(e) => { e.preventDefault(); void send() }}>
        <input value={text} maxLength={500} onChange={(e) => setText(e.target.value)} placeholder={t('watch.messageParty')} aria-label={t('watch.messageParty')} />
        <button className="icon-button" type="submit" disabled={!text.trim()} aria-label={t('common.send')}><Send size={16} /></button>
      </form>
      {error && <p className="error-text">{error}</p>}
    </aside>
  )
}

const EMPTY: WatchChatLine[] = []

/**
 * This viewer's own volume (never anyone else's). Wide players show a mute button and a slider; narrow ones a
 * speaker button that opens a small panel with a vertical slider and mute.
 */
export function WatchVolume({ volume, muted, onVolume, onMuted }: {
  volume: number; muted: boolean; onVolume: (v: number) => void; onMuted: (m: boolean) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const silent = muted || volume === 0
  const muteLabel = muted ? t('watch.unmuteVideo') : t('watch.muteVideo')

  useEffect(() => {
    if (!open) return
    const outside = (e: PointerEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])

  const slider = (vertical: boolean) => (
    <input
      type="range"
      className={vertical ? 'watch-volume-vertical' : 'watch-volume'}
      aria-label={t('watch.videoVolume')}
      aria-orientation={vertical ? 'vertical' : undefined}
      aria-valuetext={`${Math.round((muted ? 0 : volume) * 100)}%`}
      min={0}
      max={1}
      step={0.05}
      value={muted ? 0 : volume}
      onChange={(e) => onVolume(Number(e.target.value))}
    />
  )

  return (
    <div
      className="watch-volume-group"
      ref={wrap}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation()
          setOpen(false)
          wrap.current?.querySelector<HTMLElement>('.watch-volume-toggle')?.focus()
        }
      }}
    >
      <button className="icon-button watch-mute" onClick={() => onMuted(!muted)} aria-label={muteLabel} title={muteLabel}>
        {silent ? <VolumeOffIcon /> : <VolumeOnIcon />}
      </button>
      {slider(false)}
      <button
        className={`icon-button watch-volume-toggle ${open ? 'on' : ''}`}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={t('watch.volume')}
        title={t('watch.volume')}
      >
        {silent ? <VolumeOffIcon /> : <VolumeOnIcon />}
      </button>
      {open && (
        <div className="watch-volume-pop" role="group" aria-label={t('watch.volume')}>
          <span className="watch-volume-value" aria-hidden>{Math.round((muted ? 0 : volume) * 100)}</span>
          {slider(true)}
          <button className="icon-button small" onClick={() => onMuted(!muted)} aria-label={muteLabel} title={muteLabel}>
            {silent ? <VolumeOffIcon size={16} /> : <VolumeOnIcon size={16} />}
          </button>
        </div>
      )}
    </div>
  )
}
