import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { t as translate } from '../i18n'
import type { ServerState } from '../state/store'
import { useVoice, videoTrackFor, type Tile } from '../state/voice'
import { Avatar } from './bits'
import { openProfileCard } from '../state/profile'
import { Expand, HeadphonesOff, Menu, MicOff, Users, Volume } from './icons'
import type { Panel } from './Shell'
import './audio.css'
import { partyFor, useWatch } from '../state/watch'
import { WatchButton, WatchPartyPanel } from './watch/WatchParty'
import { VoiceBoardPanel, WhiteboardButton } from './whiteboard/VoiceBoard'
import { useBoardShown } from './whiteboard/abilities'
import { useWhiteboard, voiceBoardFor } from '../state/whiteboard'
import { userMenuProps } from './people/userMenuProps'
import { VoiceChatButton } from './clips/VoiceRoom'
import { ClipsMark } from './clips/ClipControls'
import { RecordingMark } from './recording/Recording'
import { useChannelRecording } from '../state/recording'
import { setWatchedTile } from '../state/clips'
import { VideoPopoutButton } from './popout/PopoutButtons'
import { ChannelTopic } from './chat/ChannelTopic'
import { CallControls } from './calls/CallControls'
import { VoiceStatusBar } from './voiceStatus/VoiceStatus'
import './afk/afk.css'
import { EncryptedVoiceBadge, PeerEncryptionMark } from './e2ee/E2eeVoice'
import { ActivityButton, ActivityPanel } from './activities/Activities'
import { sessionFor, useActivities } from '../state/activities'

/** The call screen: video tiles (screen shares first) and everyone's avatar, with call controls. */
export function VoiceStage({ server, onToggle }: { server: ServerState; onToggle: (panel: Panel) => void }) {
  const { t } = useTranslation()
  const session = useVoice((s) => s.session)!
  const tiles = useVoice((s) => s.tiles)
  const speaking = useVoice((s) => s.speaking)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [statusEditing, setStatusEditing] = useState(false)
  const channel = server.channels.find((c) => c.id === session.channelId)
  const participants = server.voice[session.channelId] ?? []
  const withVideo = new Set(tiles.map((t) => t.accountKey))
  const audioOnly = participants.filter((p) => !withVideo.has(p.accountKey))
  const party = useWatch(partyFor(server.key, session.channelId))
  const board = useWhiteboard(voiceBoardFor(server.key, session.channelId))
  const boardShown = useBoardShown((s) => !!s[`${server.key}:${session.channelId}`]) && !!board
  const activity = useActivities(sessionFor(server.key, session.channelId))
  const recording = useChannelRecording(server.key, session.channelId)
  // A watch party takes the big spot; screen shares then sit with the other tiles.
  const focused = party ? null : (tiles.find((t) => t.id === focusId) ?? tiles.find((t) => t.source === 'screen') ?? null)
  const others = tiles.filter((t) => t !== focused)
  // A clip keeps the screen share shown big.
  useEffect(() => setWatchedTile(focused?.id ?? null), [focused?.id])
  const spotlight = !!(focused || party || boardShown || activity)
  const grid = useFitGrid(others.length + audioOnly.length, !spotlight)

  return (
    <div className="stage">
      <header className="chat-header">
        <button className="icon-button mobile-only" onClick={() => onToggle('nav')} aria-label={t('voice.stage.openChannels')}>
          <Menu />
        </button>
        <h1>
          <span className="hash"><Volume size={20} /></span>
          {channel?.name ?? t('voice.stage.voice')}
        </h1>
        <EncryptedVoiceBadge variant="stage" />
        {channel && <VoiceStatusBar server={server} channel={channel} place="header" editing={statusEditing} onEditing={setStatusEditing} />}
        <span className="spacer" />
        <VoiceChatButton server={server} channelId={session.channelId} />
        <button className="icon-button members-toggle" onClick={() => onToggle('members')} aria-label={t('voice.stage.members')} title={t('voice.stage.members')}>
          <Users />
        </button>
      </header>
      <ChannelTopic channel={channel} />
      {channel && <VoiceStatusBar server={server} channel={channel} editing={statusEditing} onEditing={setStatusEditing} />}

      <div className={`stage-body ${spotlight ? 'has-focus' : ''}`}>
        {channel && <WatchPartyPanel server={server} channel={channel} />}
        {channel && <VoiceBoardPanel server={server} channel={channel} />}
        {channel && <ActivityPanel server={server} channel={channel} />}
        {focused && <VideoTile tile={focused} name={nameIn(server, focused.accountKey)} big speaking={!!speaking[focused.accountKey]} />}
        <div ref={grid.ref} className={`stage-grid ${grid.width ? 'fit' : ''}`} style={grid.width ? { '--tile-w': `${grid.width}px` } as CSSProperties : undefined}>
          {others.map((tile) => (
            <VideoTile key={tile.id} tile={tile} name={nameIn(server, tile.accountKey)} speaking={!!speaking[tile.accountKey]} onClick={() => setFocusId(tile.id)} />
          ))}
          {audioOnly.map((p) => {
            const name = server.members[p.accountKey]?.name ?? t('common.someone')
            return (
              <div
                {...userMenuProps(p.accountKey, server.key)}
                key={p.accountKey}
                className={`person-tile ${speaking[p.accountKey] ? 'speaking' : ''}`}
                role="button"
                tabIndex={0}
                aria-label={[t('voice.stage.profileOf', { name }), speaking[p.accountKey] ? t('voice.isSpeaking', { name }) : null, p.deafened ? t('voice.stage.deafened') : p.muted ? t('voice.stage.muted') : null].filter(Boolean).join(', ')}
                onClick={(e) => openProfileCard(server.key, p.accountKey, e.currentTarget)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return
                  e.preventDefault()
                  openProfileCard(server.key, p.accountKey, e.currentTarget)
                }}
              >
                <Avatar name={name} accountKey={p.accountKey} size={72} />
                <span className="tile-label">
                  {name}
                  <PeerEncryptionMark accountKey={p.accountKey} name={name} />
                  <ClipsMark on={p.clips} />
                  <RecordingMark participant={p} mark={recording} />
                  {p.deafened ? <HeadphonesOff size={14} /> : p.muted ? <MicOff size={14} /> : null}
                </span>
              </div>
            )
          })}
        </div>
        {participants.length === 0 && session.state !== 'connected' && <p className="muted stage-hint">{t('voice.bar.connecting')}</p>}
      </div>

      <CallControls together={channel && <><WatchButton server={server} channel={channel} /><WhiteboardButton server={server} channel={channel} /><ActivityButton server={server} channel={channel} /></>} nameOf={(key) => nameIn(server, key)} />
    </div>
  )
}

/**
 * Without anything in the big spot, the tiles share the stage: as big as they fit, 16:9, centred (one column on a
 * phone held upright, side by side on a wide window). Too many to fit at a useful size: they wrap and scroll instead.
 */
function useFitGrid(count: number, on: boolean) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState<number | null>(null)
  useLayoutEffect(() => {
    const body = ref.current?.parentElement
    if (!on || count === 0 || !body || typeof ResizeObserver === 'undefined') return setWidth(null)
    const measure = () => {
      const style = getComputedStyle(body)
      const w = body.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      const h = body.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
      const gap = parseFloat(getComputedStyle(ref.current ?? body).columnGap) || 12
      let best = 0
      for (let cols = 1; cols <= count; cols++) {
        const rows = Math.ceil(count / cols)
        best = Math.max(best, Math.min((w - (cols - 1) * gap) / cols, ((h - (rows - 1) * gap) / rows) * (16 / 9)))
      }
      const fit = Math.floor(Math.min(best, 960))
      setWidth(fit >= 150 ? fit : null)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(body)
    return () => observer.disconnect()
  }, [count, on])
  return { ref, width }
}

const nameIn = (server: ServerState, accountKey: string) => server.members[accountKey]?.name ?? translate('common.someone')

export function VideoTile({ tile, name, big, speaking, onClick }: { tile: Tile; name: string; big?: boolean; speaking: boolean; onClick?: () => void }) {
  const { t } = useTranslation()
  const ref = useRef<HTMLVideoElement>(null)
  const wrapper = useRef<HTMLDivElement>(null)
  const facing = useVoice((s) => s.facing)
  // A phone held upright sends a tall picture: shown whole, not cut down to the middle of a wide tile.
  const [portrait, setPortrait] = useState(false)

  useEffect(() => {
    const element = ref.current
    const track = videoTrackFor(tile)
    if (!element || !track) return
    track.attach(element)
    return () => {
      track.detach(element)
    }
  }, [tile])

  return (
    <div
      ref={wrapper}
      className={`video-tile ${big ? 'big' : ''} ${speaking && tile.source === 'camera' ? 'speaking' : ''} ${tile.source} ${portrait ? 'portrait' : ''}`}
    >
      <video
        ref={ref} autoPlay playsInline muted className={tile.isLocal && tile.source === 'camera' && facing === 'user' ? 'mirror' : ''}
        onResize={(e) => setPortrait(e.currentTarget.videoHeight > e.currentTarget.videoWidth)}
        onLoadedMetadata={(e) => setPortrait(e.currentTarget.videoHeight > e.currentTarget.videoWidth)}
      />
      <span className="tile-label">
        {tile.source === 'screen' ? t('voice.stage.screenOf', { name }) : name}
        {!tile.isLocal && <PeerEncryptionMark accountKey={tile.accountKey} name={name} />}
      </span>
      {speaking && tile.source === 'camera' && <span className="sr-only">{t('voice.isSpeaking', { name })}</span>}
      {/* The whole tile is the button that puts it in the big spot (a real button, so keyboards and screen readers get it). */}
      {onClick && <button className="tile-focus" onClick={onClick} aria-label={t('voice.stage.showBig', { name: tile.source === 'screen' ? t('voice.stage.screenOf', { name }) : name })} />}
      <VideoPopoutButton tile={tile} video={ref} />
      <button
        className="icon-button tile-fullscreen"
        aria-label={t('voice.stage.fullScreen')}
        title={t('voice.stage.fullScreen')}
        onClick={(e) => {
          e.stopPropagation()
          void wrapper.current?.requestFullscreen?.()
        }}
      >
        <Expand size={16} />
      </button>
    </div>
  )
}
