import { useEffect, useRef, useState } from 'react'
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

/** The call screen: video tiles (screen shares first) and everyone's avatar, with call controls. */
export function VoiceStage({ server, onToggle }: { server: ServerState; onToggle: (panel: Panel) => void }) {
  const session = useVoice((s) => s.session)!
  const tiles = useVoice((s) => s.tiles)
  const speaking = useVoice((s) => s.speaking)
  const [focusId, setFocusId] = useState<string | null>(null)
  const channel = server.channels.find((c) => c.id === session.channelId)
  const participants = server.voice[session.channelId] ?? []
  const withVideo = new Set(tiles.map((t) => t.accountKey))
  const audioOnly = participants.filter((p) => !withVideo.has(p.accountKey))
  const focused = tiles.find((t) => t.id === focusId) ?? tiles.find((t) => t.source === 'screen') ?? null
  const others = tiles.filter((t) => t !== focused)

  return (
    <div className="stage">
      <header className="chat-header">
        <button className="icon-button mobile-only" onClick={() => onToggle('nav')} aria-label="Open channels">
          <Menu />
        </button>
        <h1>
          <span className="hash"><Volume size={20} /></span>
          {channel?.name ?? 'Voice'}
        </h1>
        <span className="spacer" />
        <button className="icon-button members-toggle" onClick={() => onToggle('members')} aria-label="Members" title="Members">
          <Users />
        </button>
      </header>

      <div className={`stage-body ${focused ? 'has-focus' : ''}`}>
        {focused && <VideoTile tile={focused} server={server} big speaking={!!speaking[focused.accountKey]} />}
        <div className="stage-grid">
          {others.map((tile) => (
            <VideoTile key={tile.id} tile={tile} server={server} speaking={!!speaking[tile.accountKey]} onClick={() => setFocusId(tile.id)} />
          ))}
          {audioOnly.map((p) => {
            const name = server.members[p.accountKey]?.name ?? 'Someone'
            return (
              <div
                key={p.accountKey}
                className={`person-tile ${speaking[p.accountKey] ? 'speaking' : ''}`}
                role="button"
                tabIndex={0}
                aria-label={`Profile of ${name}`}
                onClick={(e) => openProfileCard(server.key, p.accountKey, e.currentTarget)}
                onKeyDown={(e) => e.key === 'Enter' && openProfileCard(server.key, p.accountKey, e.currentTarget)}
              >
                <Avatar name={name} accountKey={p.accountKey} size={72} />
                <span className="tile-label">
                  {name}
                  {p.deafened ? <HeadphonesOff size={14} /> : p.muted ? <MicOff size={14} /> : null}
                </span>
              </div>
            )
          })}
        </div>
        {participants.length === 0 && session.state !== 'connected' && <p className="muted stage-hint">Connecting…</p>}
      </div>

      <CallControls />
    </div>
  )
}

function VideoTile({ tile, server, big, speaking, onClick }: { tile: Tile; server: ServerState; big?: boolean; speaking: boolean; onClick?: () => void }) {
  const ref = useRef<HTMLVideoElement>(null)
  const wrapper = useRef<HTMLDivElement>(null)
  const name = server.members[tile.accountKey]?.name ?? 'Someone'

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
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      <video ref={ref} autoPlay playsInline muted className={tile.isLocal && tile.source === 'camera' ? 'mirror' : ''} />
      <span className="tile-label">
        {tile.source === 'screen' ? `${name}'s screen` : name}
      </span>
      <button
        className="icon-button tile-fullscreen"
        aria-label="Full screen"
        title="Full screen"
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

function CallControls() {
  const session = useVoice((s) => s.session)!
  const { muted, deafened, camera, screen } = useVoice()
  const speak = session.canSpeak
  return (
    <div className="call-controls" role="toolbar" aria-label="Call controls">
      {speak && (
        <button className={`call-button ${muted ? 'off' : ''}`} onClick={() => void toggleMute()} aria-pressed={muted} aria-label={muted ? 'Unmute' : 'Mute'} title={muted ? 'Unmute' : 'Mute'}>
          {muted ? <MicOff /> : <Mic />}
        </button>
      )}
      <button className={`call-button ${deafened ? 'off' : ''}`} onClick={() => void toggleDeafen()} aria-pressed={deafened} aria-label={deafened ? 'Undeafen' : 'Deafen'} title={deafened ? 'Undeafen' : 'Deafen'}>
        {deafened ? <HeadphonesOff /> : <Headphones />}
      </button>
      {speak && (
        <button className={`call-button ${camera ? 'on' : ''}`} onClick={() => void toggleCamera()} aria-pressed={camera} aria-label={camera ? 'Turn camera off' : 'Turn camera on'} title={camera ? 'Turn camera off' : 'Turn camera on'}>
          {camera ? <Camera /> : <CameraOff />}
        </button>
      )}
      {speak && canShareScreen() && (
        <button className={`call-button ${screen ? 'on' : ''}`} onClick={() => void toggleScreenShare()} aria-pressed={screen} aria-label={screen ? 'Stop sharing' : 'Share your screen'} title={screen ? 'Stop sharing' : 'Share your screen'}>
          {screen ? <ScreenShareOff /> : <ScreenShare />}
        </button>
      )}
      <button className="call-button hang-up" onClick={() => void leaveVoice()} aria-label="Leave call" title="Leave call">
        <PhoneOff />
      </button>
    </div>
  )
}
