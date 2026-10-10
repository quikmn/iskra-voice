// Voice and video: one LiveKit room at a time. The server hands out the token; LiveKit carries the media.
import {
  ConnectionState, Room, RoomEvent, ScreenSharePresets, Track, VideoPresets,
  type LocalTrackPublication, type Participant, type RemoteParticipant, type RemoteTrack,
} from 'livekit-client'
import { create } from 'zustand'
import { connectionFor } from './store'

export interface VoiceSession {
  serverKey: string
  channelId: number
  state: 'connecting' | 'connected' | 'reconnecting'
  canSpeak: boolean
}

/** One video on the call screen: someone's camera or screen share. */
export interface Tile {
  id: string
  accountKey: string
  source: 'camera' | 'screen'
  isLocal: boolean
}

interface VoiceState {
  session: VoiceSession | null
  muted: boolean
  deafened: boolean
  camera: boolean
  screen: boolean
  /** The call screen is showing instead of the text channel. */
  stageOpen: boolean
  tiles: Tile[]
  /** accountKeys currently speaking (including yourself). */
  speaking: Record<string, true>
  /** Per-person volume, 0–2 (1 = normal). Remembered on this device. */
  volumes: Record<string, number>
  error: string | null
}

const VOLUME_KEY = 'iskra.volumes'

function loadVolumes(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(VOLUME_KEY) ?? '{}')
  } catch {
    return {}
  }
}

export const useVoice = create<VoiceState>(() => ({
  session: null,
  muted: false,
  deafened: false,
  camera: false,
  screen: false,
  stageOpen: false,
  tiles: [],
  speaking: {},
  volumes: loadVolumes(),
  error: null,
}))

export const canShareScreen = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia

let room: Room | null = null
let mutedBeforeDeafen = false
const audioElements = new Map<string, HTMLMediaElement>()
let audioContainer: HTMLDivElement | null = null

function container(): HTMLDivElement {
  if (!audioContainer) {
    audioContainer = document.createElement('div')
    audioContainer.hidden = true
    document.body.appendChild(audioContainer)
  }
  return audioContainer
}

function applyVolume(participant: RemoteParticipant): void {
  const { volumes, deafened } = useVoice.getState()
  participant.setVolume(deafened ? 0 : (volumes[participant.identity] ?? 1))
  participant.setVolume(deafened ? 0 : (volumes[participant.identity] ?? 1), Track.Source.ScreenShareAudio)
}

function reportFlags(): void {
  const { session, muted, deafened } = useVoice.getState()
  if (!session) return
  connectionFor(session.serverKey)?.request('voice.state', { muted, deafened }).catch(() => undefined)
}

/** Rebuilds the list of video tiles from the room. Screen shares first: they're what people came to see. */
function refreshTiles(): void {
  if (!room) return
  const tiles: Tile[] = []
  const collect = (participant: Participant, isLocal: boolean) => {
    for (const pub of participant.trackPublications.values()) {
      if (pub.kind !== Track.Kind.Video || !pub.track || pub.isMuted) continue
      const source = pub.source === Track.Source.ScreenShare ? 'screen' : 'camera'
      tiles.push({ id: `${participant.identity}:${pub.trackSid}`, accountKey: participant.identity, source, isLocal })
    }
  }
  collect(room.localParticipant, true)
  room.remoteParticipants.forEach((p) => collect(p, false))
  tiles.sort((a, b) => (a.source === b.source ? 0 : a.source === 'screen' ? -1 : 1))
  useVoice.setState({ tiles })
}

/** The live video track for a tile (components attach it to a <video>). */
export function videoTrackFor(tile: Tile): Track | undefined {
  if (!room) return undefined
  const participant = tile.isLocal ? room.localParticipant : room.remoteParticipants.get(tile.accountKey)
  const sid = tile.id.slice(tile.id.indexOf(':') + 1)
  return participant?.trackPublications.get(sid)?.track
}

export async function joinVoice(serverKey: string, channelId: number): Promise<void> {
  const current = useVoice.getState().session
  if (current?.serverKey === serverKey && current.channelId === channelId) {
    useVoice.setState({ stageOpen: true })
    return
  }
  await leaveVoice()

  const connection = connectionFor(serverKey)
  if (!connection) return
  useVoice.setState({
    session: { serverKey, channelId, state: 'connecting', canSpeak: false },
    error: null, speaking: {}, tiles: [], stageOpen: true, camera: false, screen: false,
  })

  try {
    const { url, token, canSpeak } = await connection.request('voice.join', { channelId })
    const next = new Room({
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      videoCaptureDefaults: { resolution: VideoPresets.h720.resolution },
      publishDefaults: { simulcast: true, screenShareEncoding: ScreenSharePresets.h1080fps30.encoding },
    })
    room = next

    next
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, participant: RemoteParticipant) => {
        if (track.kind === Track.Kind.Audio) {
          const element = track.attach()
          audioElements.set(participant.identity + track.sid, element)
          container().appendChild(element)
          applyVolume(participant)
        }
        refreshTiles()
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, _pub, participant: RemoteParticipant) => {
        const key = participant.identity + track.sid
        audioElements.get(key)?.remove()
        audioElements.delete(key)
        track.detach()
        refreshTiles()
      })
      .on(RoomEvent.TrackMuted, refreshTiles)
      .on(RoomEvent.TrackUnmuted, refreshTiles)
      .on(RoomEvent.LocalTrackPublished, refreshTiles)
      .on(RoomEvent.LocalTrackUnpublished, (pub: LocalTrackPublication) => {
        // The browser's own "Stop sharing" button ends the share without going through us.
        if (pub.source === Track.Source.ScreenShare) useVoice.setState({ screen: false })
        if (pub.source === Track.Source.Camera) useVoice.setState({ camera: false })
        refreshTiles()
      })
      .on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => applyVolume(participant))
      .on(RoomEvent.ParticipantDisconnected, refreshTiles)
      .on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        useVoice.setState({ speaking: Object.fromEntries(speakers.map((p) => [p.identity, true as const])) })
      })
      .on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => {
        if (room !== next) return
        const mapped = state === ConnectionState.Connected ? 'connected' : state === ConnectionState.Reconnecting ? 'reconnecting' : null
        if (mapped) useVoice.setState((s) => ({ session: s.session && { ...s.session, state: mapped } }))
      })
      .on(RoomEvent.Disconnected, () => {
        if (room === next) void cleanup()
      })

    await next.connect(url, token)
    if (room !== next) {
      await next.disconnect()
      return
    }
    useVoice.setState((s) => ({ session: s.session && { ...s.session, state: 'connected', canSpeak } }))

    if (canSpeak) {
      try {
        await next.localParticipant.setMicrophoneEnabled(!useVoice.getState().muted)
      } catch {
        useVoice.setState({ muted: true, error: "Couldn't use your microphone. Check your browser's permissions." })
      }
    }
    refreshTiles()
    reportFlags()
  } catch (e) {
    await cleanup()
    useVoice.setState({ error: (e as Error).message || 'Could not join voice.' })
  }
}

async function cleanup(): Promise<void> {
  const old = room
  room = null
  for (const element of audioElements.values()) element.remove()
  audioElements.clear()
  useVoice.setState({ session: null, speaking: {}, tiles: [], stageOpen: false, camera: false, screen: false })
  if (old && old.state !== ConnectionState.Disconnected) await old.disconnect()
}

export async function leaveVoice(): Promise<void> {
  await cleanup()
}

export function setStageOpen(open: boolean): void {
  if (useVoice.getState().stageOpen !== open) useVoice.setState({ stageOpen: open })
}

export async function toggleMute(): Promise<void> {
  const { muted, deafened, session } = useVoice.getState()
  const nextMuted = !muted
  if (!nextMuted && deafened) {
    // Unmuting while deafened also undeafens, like everyone expects.
    useVoice.setState({ deafened: false })
    room?.remoteParticipants.forEach(applyVolume)
  }
  useVoice.setState({ muted: nextMuted })
  if (room && session?.canSpeak) {
    try {
      await room.localParticipant.setMicrophoneEnabled(!nextMuted)
    } catch {
      useVoice.setState({ muted: true, error: "Couldn't use your microphone. Check your browser's permissions." })
    }
  }
  reportFlags()
}

export async function toggleDeafen(): Promise<void> {
  const { deafened, muted, session } = useVoice.getState()
  const next = !deafened
  if (next) mutedBeforeDeafen = muted
  // Deafening mutes you too; undeafening puts your mic back how it was.
  const nextMuted = next ? true : mutedBeforeDeafen
  useVoice.setState({ deafened: next, muted: nextMuted })
  room?.remoteParticipants.forEach(applyVolume)
  if (room && session?.canSpeak) await room.localParticipant.setMicrophoneEnabled(!nextMuted).catch(() => undefined)
  reportFlags()
}

export async function toggleCamera(): Promise<void> {
  if (!room || !useVoice.getState().session?.canSpeak) return
  const next = !useVoice.getState().camera
  try {
    await room.localParticipant.setCameraEnabled(next)
    useVoice.setState({ camera: next })
  } catch {
    useVoice.setState({ camera: false, error: "Couldn't use your camera. Check your browser's permissions." })
  }
  refreshTiles()
}

export async function toggleScreenShare(): Promise<void> {
  if (!room || !useVoice.getState().session?.canSpeak) return
  const next = !useVoice.getState().screen
  try {
    // contentHint "motion" keeps games smooth; "detail" would favour sharp text.
    await room.localParticipant.setScreenShareEnabled(next, { audio: true, contentHint: 'motion', selfBrowserSurface: 'exclude' })
    useVoice.setState({ screen: next })
  } catch (e) {
    // Cancelling the browser's picker isn't an error worth showing.
    if ((e as Error).name !== 'NotAllowedError') useVoice.setState({ error: "Couldn't start screen sharing." })
    useVoice.setState({ screen: false })
  }
  refreshTiles()
}

export function setVolume(accountKey: string, volume: number): void {
  const volumes = { ...useVoice.getState().volumes, [accountKey]: volume }
  useVoice.setState({ volumes })
  try {
    localStorage.setItem(VOLUME_KEY, JSON.stringify(volumes))
  } catch {
    /* private mode: works for this session only */
  }
  const participant = room?.remoteParticipants.get(accountKey)
  if (participant) applyVolume(participant)
}

export function clearVoiceError(): void {
  useVoice.setState({ error: null })
}
