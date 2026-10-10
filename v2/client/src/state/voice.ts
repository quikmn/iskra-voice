// Voice: one LiveKit room at a time. The server hands out the token; LiveKit carries the audio.
import { ConnectionState, Room, RoomEvent, Track, type RemoteParticipant, type RemoteTrack } from 'livekit-client'
import { create } from 'zustand'
import { connectionFor } from './store'

export interface VoiceSession {
  serverKey: string
  channelId: number
  state: 'connecting' | 'connected' | 'reconnecting'
  canSpeak: boolean
}

interface VoiceState {
  session: VoiceSession | null
  muted: boolean
  deafened: boolean
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
  speaking: {},
  volumes: loadVolumes(),
  error: null,
}))

let room: Room | null = null
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
}

function reportFlags(): void {
  const { session, muted, deafened } = useVoice.getState()
  if (!session) return
  connectionFor(session.serverKey)?.request('voice.state', { muted, deafened }).catch(() => undefined)
}

export async function joinVoice(serverKey: string, channelId: number): Promise<void> {
  const current = useVoice.getState().session
  if (current?.serverKey === serverKey && current.channelId === channelId) return
  await leaveVoice()

  const connection = connectionFor(serverKey)
  if (!connection) return
  useVoice.setState({ session: { serverKey, channelId, state: 'connecting', canSpeak: false }, error: null, speaking: {} })

  try {
    const { url, token, canSpeak } = await connection.request('voice.join', { channelId })
    const next = new Room({
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    room = next

    next
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, participant: RemoteParticipant) => {
        if (track.kind !== Track.Kind.Audio) return
        const element = track.attach()
        audioElements.set(participant.identity + track.sid, element)
        container().appendChild(element)
        applyVolume(participant)
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, _pub, participant: RemoteParticipant) => {
        const key = participant.identity + track.sid
        audioElements.get(key)?.remove()
        audioElements.delete(key)
        track.detach()
      })
      .on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => applyVolume(participant))
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
  useVoice.setState({ session: null, speaking: {} })
  if (old && old.state !== ConnectionState.Disconnected) await old.disconnect()
}

export async function leaveVoice(): Promise<void> {
  await cleanup()
}

export async function toggleMute(): Promise<void> {
  const { muted, deafened, session } = useVoice.getState()
  const nextMuted = !muted
  // Unmuting while deafened also undeafens, like everyone expects.
  useVoice.setState({ muted: nextMuted, deafened: nextMuted ? deafened : false })
  if (room && session?.canSpeak) {
    try {
      await room.localParticipant.setMicrophoneEnabled(!nextMuted)
    } catch {
      useVoice.setState({ muted: true, error: "Couldn't use your microphone. Check your browser's permissions." })
    }
  }
  if (!nextMuted && deafened) room?.remoteParticipants.forEach(applyVolume)
  reportFlags()
}

export async function toggleDeafen(): Promise<void> {
  const { deafened } = useVoice.getState()
  const next = !deafened
  // Deafening mutes you too; undeafening leaves your mic as it was before.
  useVoice.setState((s) => ({ deafened: next, muted: next ? true : s.muted }))
  room?.remoteParticipants.forEach(applyVolume)
  if (next && room) await room.localParticipant.setMicrophoneEnabled(false).catch(() => undefined)
  reportFlags()
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
