import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { t as translate } from '../i18n'
import type { ServerState } from '../state/store'
import {
  canShareScreen, leaveVoice, toggleCamera, toggleDeafen, toggleMute, toggleScreenShare, useVoice, videoTrackFor, type Tile,
} from '../state/voice'
import { Avatar } from './bits'
import { openProfileCard } from '../state/profile'
import {
  Camera, CameraOff, Expand, Headphones, HeadphonesOff, Menu, Mic, MicOff, PhoneOff, ScreenShare, ScreenShareOff, Users, Volume,
} from './icons'
import type { Panel } from './Shell'
import { SoundboardButton } from './expressions/Soundboard'
import { ScreenShareMenu } from './ScreenShareMenu'
import './audio.css'
import { partyFor, useWatch } from '../state/watch'
import { WatchButton, WatchPartyPanel } from './watch/WatchParty'
import { VoiceBoardPanel, WhiteboardButton } from './whiteboard/VoiceBoard'
import { useBoardShown } from './whiteboard/abilities'
import { useWhiteboard, voiceBoardFor } from '../state/whiteboard'
import { userMenuProps } from './people/userMenuProps'
import { VoiceChatButton } from './clips/VoiceRoom'
import { ClipButton, ClipsMark, ClipsStrip } from './clips/ClipControls'
import { setWatchedTile } from '../state/clips'
import { BackgroundNotice, CaptionsButton, CaptionsOverlay } from './media/CallMedia'
import { ResumeOffer } from './ResumeOffer'
import { VideoPopoutButton } from './popout/PopoutButtons'
import { ChannelTopic } from './chat/ChannelTopic'
import './afk/afk.css'
import { EncryptedVoiceBadge, PeerEncryptionMark } from './e2ee/E2eeVoice'

/** The call screen: video tiles (screen shares first) and everyone's avatar, with call controls. */
export function VoiceStage({ server, onToggle }: { server: ServerState; onToggle: (panel: Panel) => void }) {
  const { t } = useTranslation()
  const session = useVoice((s) => s.session)!
  const tiles = useVoice((s) => s.tiles)
  const speaking = useVoice((s) => s.speaking)
  const [focusId, setFocusId] = useState<string | null>(null)
  const channel = server.channels.find((c) => c.id === session.channelId)
  const participants = server.voice[session.channelId] ?? []
  const withVideo = new Set(tiles.map((t) => t.accountKey))
  const audioOnly = participants.filter((p) => !withVideo.has(p.accountKey))
  const party = useWatch(partyFor(server.key, session.channelId))
  const board = useWhiteboard(voiceBoardFor(server.key, session.channelId))
  const boardShown = useBoardShown((s) => !!s[`${server.key}:${session.channelId}`]) && !!board
  // A watch party takes the big spot; screen shares then sit with the other tiles.
  const focused = party ? null : (tiles.find((t) => t.id === focusId) ?? tiles.find((t) => t.source === 'screen') ?? null)
  const others = tiles.filter((t) => t !== focused)
  // A clip keeps the screen share shown big.
  useEffect(() => setWatchedTile(focused?.id ?? null), [focused?.id])

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
        <span className="spacer" />
        <VoiceChatButton server={server} channelId={session.channelId} />
        <button className="icon-button members-toggle" onClick={() => onToggle('members')} aria-label={t('voice.stage.members')} title={t('voice.stage.members')}>
          <Users />
        </button>
      </header>
      <ChannelTopic channel={channel} />

      <div className={`stage-body ${focused || party || boardShown ? 'has-focus' : ''}`}>
        {channel && <WatchPartyPanel server={server} channel={channel} />}
        {channel && <VoiceBoardPanel server={server} channel={channel} />}
        {focused && <VideoTile tile={focused} name={nameIn(server, focused.accountKey)} big speaking={!!speaking[focused.accountKey]} />}
        <div className="stage-grid">
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
                  {p.deafened ? <HeadphonesOff size={14} /> : p.muted ? <MicOff size={14} /> : null}
                </span>
              </div>
            )
          })}
        </div>
        {participants.length === 0 && session.state !== 'connected' && <p className="muted stage-hint">{t('voice.bar.connecting')}</p>}
      </div>

      <CallControls extra={channel && <><WatchButton server={server} channel={channel} /><WhiteboardButton server={server} channel={channel} /></>} nameOf={(key) => nameIn(server, key)} />
    </div>
  )
}

const nameIn = (server: ServerState, accountKey: string) => server.members[accountKey]?.name ?? translate('common.someone')

export function VideoTile({ tile, name, big, speaking, onClick }: { tile: Tile; name: string; big?: boolean; speaking: boolean; onClick?: () => void }) {
  const { t } = useTranslation()
  const ref = useRef<HTMLVideoElement>(null)
  const wrapper = useRef<HTMLDivElement>(null)

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
      className={`video-tile ${big ? 'big' : ''} ${speaking && tile.source === 'camera' ? 'speaking' : ''} ${tile.source}`}
    >
      <video ref={ref} autoPlay playsInline muted className={tile.isLocal && tile.source === 'camera' ? 'mirror' : ''} />
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

/**
 * Mute, deafen, camera, screen share, captions and hang up. DM calls pass their own hang-up; stages add their own
 * buttons. `nameOf` names the people in the captions.
 */
export function CallControls({ onLeave, extra, nameOf }: { onLeave?: () => void; extra?: ReactNode; nameOf?: (accountKey: string) => string }) {
  const { t } = useTranslation()
  const session = useVoice((s) => s.session)!
  const { muted, deafened, camera, screen, localSpeaking } = useVoice()
  const [shareMenu, setShareMenu] = useState<HTMLElement | null>(null)
  const speak = session.canSpeak
  return (
    <>
    <BackgroundNotice />
    <CaptionsOverlay nameOf={nameOf ?? (() => translate('common.someone'))} />
    <ClipsStrip />
    <ResumeOffer />
    {session.afk && (
      <p className="afk-forced-banner" role="status" data-testid="afk-forced-banner"><HeadphonesOff size={16} /><strong>{t('afk.forced')}</strong> <span>{t('afk.forcedHint')}</span></p>
    )}
    <div className="call-controls" role="toolbar" aria-label={t('voice.stage.controls')}>
      {speak && (
        <button className={`call-button ${muted ? 'off' : ''} ${localSpeaking && !muted ? 'talking' : ''}`} onClick={() => void toggleMute()} aria-pressed={muted} aria-label={muted ? t('voice.unmute') : t('voice.mute')} title={muted ? t('voice.unmute') : t('voice.mute')}>
          {muted ? <MicOff /> : <Mic />}
        </button>
      )}
      {session.afk ? (
        <button className="call-button off" disabled aria-label={t('afk.forced')} title={t('afk.forcedHint')}><HeadphonesOff /></button>
      ) : (
        <button className={`call-button ${deafened ? 'off' : ''}`} onClick={() => void toggleDeafen()} aria-pressed={deafened} aria-label={deafened ? t('voice.undeafen') : t('voice.deafen')} title={deafened ? t('voice.undeafen') : t('voice.deafen')}>
          {deafened ? <HeadphonesOff /> : <Headphones />}
        </button>
      )}
      {speak && (
        <button className={`call-button ${camera ? 'on' : ''}`} onClick={() => void toggleCamera()} aria-pressed={camera} aria-label={camera ? t('voice.cameraOff') : t('voice.cameraOn')} title={camera ? t('voice.cameraOff') : t('voice.cameraOn')}>
          {camera ? <Camera /> : <CameraOff />}
        </button>
      )}
      {speak && canShareScreen() && (
        <button
          className={`call-button ${screen ? 'on' : ''}`}
          onClick={(e) => (screen ? void toggleScreenShare() : setShareMenu(shareMenu ? null : e.currentTarget))}
          aria-pressed={screen} aria-expanded={screen ? undefined : !!shareMenu} aria-label={screen ? t('voice.stopSharing') : t('voice.share.title')} title={screen ? t('voice.stopSharing') : t('voice.share.title')}>
          {screen ? <ScreenShareOff /> : <ScreenShare />}
        </button>
      )}
      {extra}
      {shareMenu && <ScreenShareMenu anchor={shareMenu} onClose={() => setShareMenu(null)} />}
      <SoundboardButton variant="call" />
      <ClipButton />
      <CaptionsButton />
      <button className="call-button hang-up" onClick={() => (onLeave ? onLeave() : void leaveVoice())} aria-label={onLeave ? t('voice.hangUp') : t('voice.leaveCall')} title={onLeave ? t('voice.hangUp') : t('voice.leaveCall')}>
        <PhoneOff />
      </button>
    </div>
    </>
  )
}
