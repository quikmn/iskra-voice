// Voice and video: one LiveKit room at a time. The server hands out the token; LiveKit carries the media.
import {
  ConnectionState, createKeyMaterialFromBuffer, ExternalE2EEKeyProvider, LocalAudioTrack, Room, RoomEvent, ScreenSharePresets, Track, VideoPresets,
  type LocalTrackPublication, type Participant, type RemoteParticipant, type RemoteTrack, type RemoteTrackPublication, type RoomOptions,
} from 'livekit-client'
import { create } from 'zustand'
import { t } from '../i18n'
import { errorMessage } from '../i18n/errors'
import { desktop } from '../platform/desktop'
import { connectionFor } from './store'
import { canBoost, captureOptions, effectiveVolume, onAudioSettings, useAudio, type AudioSettings } from './audio'
import { MicProcessor, strongWorks } from './micPipeline'
import { playTone } from './notify'
import { screenShareOptions, useScreenShareSettings } from './screenShare'
import { iosApp } from '../platform/native'

export interface VoiceSession {
  serverKey: string
  channelId: number
  state: 'connecting' | 'connected' | 'reconnecting'
  canSpeak: boolean
  /** Set for a DM call (channelId is then 0). */
  call?: { id: string; peer: string }
  /** Set for a group DM call (channelId is then 0). `key` is the group's key in groups.ts. */
  group?: { key: string; callId: string }
  /** Our media is end-to-end encrypted (DM calls). */
  encrypted?: boolean
}

/** One video on the call screen: someone's camera or screen share. */
export interface Tile {
  id: string
  accountKey: string
  source: 'camera' | 'screen'
  isLocal: boolean
}

/** How your mic opens: always (voice activity) or only while a key is held. */
export interface VoiceSettings {
  mode: 'voice' | 'ptt'
  /** Web: a KeyboardEvent.code. */
  webKey: { code: string; label: string } | null
  /** Desktop: a global key or mouse button. */
  desktopKey: { code: number; label: string } | null
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
  settings: VoiceSettings
  /** The push-to-talk key is held right now. */
  pttDown: boolean
  /** Your own mic is above the voice activity threshold (measured here, so it shows instantly). */
  localSpeaking: boolean
  /** RNNoise is cleaning up your mic in this call (null: not in a call or not known yet). */
  strongActive: boolean | null
}

const VOLUME_KEY = 'iskra.volumes'
const SETTINGS_KEY = 'iskra.voice'

function loadSettings(): VoiceSettings {
  try {
    return { mode: 'voice', webKey: null, desktopKey: null, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') }
  } catch {
    return { mode: 'voice', webKey: null, desktopKey: null }
  }
}

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
  settings: loadSettings(),
  pttDown: false,
  localSpeaking: false,
  strongActive: null,
}))

// Never in the iPhone/iPad app: iOS web views can't capture the screen.
export const canShareScreen = () => !iosApp && typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia

let room: Room | null = null
let e2eeWorker: Worker | null = null

/** The LiveKit room of the call you're in (clips listen to it). */
export const activeRoom = (): Room | null => room

/** A shared-key provider that also takes keys at a given index, so a group call can switch keys without a gap. */
class CallKeyProvider extends ExternalE2EEKeyProvider {
  async setIndexedKey(key: Uint8Array, index: number): Promise<void> {
    this.onSetEncryptionKey(await createKeyMaterialFromBuffer(key.slice().buffer), undefined, index)
  }
}
let keyProvider: CallKeyProvider | null = null
let mutedBeforeDeafen = false
/** A stage speaker's mic is published the first time they open it (not the moment they're brought up). */
let micDeferred = false
/** We're muting our own mic right now (so the event isn't taken for a moderator's mute). */
let selfMuting = false
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
  const volume = effectiveVolume(volumes[participant.identity] ?? 1, useAudio.getState().outputVolume, deafened, boosting)
  participant.setVolume(volume)
  participant.setVolume(volume, Track.Source.ScreenShareAudio)
}

// ── Your own mic: processing, level and speaking ─────────────────────────

/** This call mixes audio with Web Audio, so people can be turned up past 100%. */
let boosting = false
let processor: MicProcessor | null = null
/** Whether the mic was captured with the browser's noise suppression on. */
let capturedWithBrowserNs: boolean | null = null
const levelListeners = new Set<(db: number) => void>()

/** The highest volume a person can be set to on this device. */
export const maxVolume = () => (canBoost() ? 2 : 1)

/** Your mic level in dBFS while in a call (the settings meter listens). */
export function onMicLevel(listener: (db: number) => void): () => void {
  levelListeners.add(listener)
  return () => levelListeners.delete(listener)
}

export const micPipelineActive = () => !!processor?.active

function onLevel(db: number, open: boolean): void {
  for (const l of levelListeners) l(db)
  const { muted, pttDown, settings, localSpeaking } = useVoice.getState()
  const talking = open && !muted && (settings.mode === 'voice' || pttDown)
  if (talking !== localSpeaking) setLocalSpeaking(talking)
}

function setLocalSpeaking(on: boolean): void {
  const me = room?.localParticipant.identity
  useVoice.setState((s) => {
    const speaking = { ...s.speaking }
    if (me && on) speaking[me] = true
    else if (me) delete speaking[me]
    return { localSpeaking: on, speaking }
  })
}

/** RNNoise turned out not to run here: capture again with the browser's noise suppression instead. */
function onStrong(strong: boolean | null): void {
  useVoice.setState({ strongActive: strong })
  const settings = useAudio.getState()
  // Only when that changes what we ask the browser for (strongWorks() is false from now on), so this can't loop.
  if (settings.noise === 'strong' && !strong && capturedWithBrowserNs === false && captureOptions(settings, strongWorks()).noiseSuppression) {
    setTimeout(() => void recapture(settings), 0)
  }
}

function micTrack(): LocalAudioTrack | null {
  const track = room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track
  return track instanceof LocalAudioTrack ? track : null
}

/** Gets the mic again with the current device and browser processing (the processor follows along). */
async function recapture(settings: AudioSettings): Promise<void> {
  const track = micTrack()
  if (!track) return
  const options = captureOptions(settings, strongWorks())
  capturedWithBrowserNs = options.noiseSuppression
  try {
    await track.restartTrack(options)
  } catch {
    // The chosen device is gone: fall back to the default one.
    if (settings.inputDevice) await track.restartTrack({ ...options, deviceId: undefined }).catch(() => undefined)
  }
  await applyMic()
}

onAudioSettings((next, prev) => {
  if (!room) return
  if (next.noise !== prev.noise || next.echoCancellation !== prev.echoCancellation || next.autoGainControl !== prev.autoGainControl ||
    next.inputDevice !== prev.inputDevice) {
    void recapture(next)
  } else if (next.inputVolume !== prev.inputVolume || next.threshold !== prev.threshold) {
    processor?.active?.update(next)
  }
  if (next.outputDevice !== prev.outputDevice) void room.switchActiveDevice('audiooutput', next.outputDevice || 'default').catch(() => undefined)
  if (next.outputVolume !== prev.outputVolume) room.remoteParticipants.forEach(applyVolume)
})

/** Mute and deafen sounds. */
function voiceTone(kind: 'mute' | 'unmute' | 'deafen' | 'undeafen'): void {
  if (useVoice.getState().session) playTone(kind)
}

function reportFlags(): void {
  const { session, muted, deafened } = useVoice.getState()
  if (!session || session.call || session.group) return
  connectionFor(session.serverKey)?.request('voice.state', { muted, deafened }).catch(() => undefined)
}

/** Rebuilds the list of video tiles from the room. Screen shares first: they're what people came to see. */
function refreshTiles(): void {
  if (!room) return
  const tiles: Tile[] = []
  const collect = (participant: Participant, isLocal: boolean) => {
    for (const pub of participant.trackPublications.values()) {
      if (pub.kind !== Track.Kind.Video || !pub.track || pub.isMuted) continue
      // A share that just stopped can linger for a moment (unsubscribed, or its track ended) before it's unpublished.
      if (!isLocal && !(pub as RemoteTrackPublication).isSubscribed) continue
      if (pub.track.mediaStreamTrack?.readyState === 'ended') continue
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
  if (current?.serverKey === serverKey && current.channelId === channelId && !current.call) {
    useVoice.setState({ stageOpen: true })
    return
  }
  await leaveVoice()

  const connection = connectionFor(serverKey)
  if (!connection) return
  await connect({ serverKey, channelId, state: 'connecting', canSpeak: false }, () => connection.request('voice.join', { channelId }))
}

/**
 * Joins a DM call's room (the token comes from call.start / call.accept). Media is end-to-end encrypted with
 * `key`: LiveKit's E2EE encrypts every frame in a worker, so the server only forwards ciphertext.
 */
export async function joinCall(
  serverKey: string, call: { id: string; peer: string }, target: { url: string; token: string }, key: Uint8Array, camera: boolean,
): Promise<boolean> {
  await leaveVoice() // one room at a time: a voice channel or a call
  return connect(
    { serverKey, channelId: 0, state: 'connecting', canSpeak: true, call, encrypted: false },
    async () => ({ ...target, canSpeak: true }),
    { e2eeKey: key, camera },
  )
}

/**
 * Joins a group call's room. `key` may still be missing (it was sent before you joined the group): the person who has
 * been in the call longest sends a new one, and {@link setCallKey} puts it in place.
 */
export async function joinGroupCall(
  serverKey: string, group: { key: string; callId: string }, target: { url: string; token: string }, key: { key: Uint8Array; index: number } | null,
  camera: boolean,
): Promise<boolean> {
  await leaveVoice()
  return connect(
    { serverKey, channelId: 0, state: 'connecting', canSpeak: true, group, encrypted: false },
    async () => ({ ...target, canSpeak: true }),
    { groupKey: key ?? 'later', camera },
  )
}

/** A new media key for the group call you're in. Senders switch to it; frames under older keys still decrypt. */
export async function setCallKey(key: Uint8Array, index: number): Promise<void> {
  await keyProvider?.setIndexedKey(key, index)
}

async function connect(
  session: VoiceSession,
  target: () => Promise<{ url: string; token: string; canSpeak: boolean }>,
  options: { e2eeKey?: Uint8Array; groupKey?: { key: Uint8Array; index: number } | 'later'; camera?: boolean } = {},
): Promise<boolean> {
  useVoice.setState({
    session, error: null, speaking: {}, tiles: [], stageOpen: !session.call && !session.group, camera: false, screen: false,
  })

  try {
    const { url, token, canSpeak } = await target()
    let encryption: RoomOptions['encryption']
    let worker: Worker | null = null
    let provider: CallKeyProvider | null = null
    if (options.e2eeKey || options.groupKey) {
      const { default: E2EEWorker } = await import('livekit-client/e2ee-worker?worker')
      provider = new CallKeyProvider()
      // A random 32-byte key: LiveKit derives the frame key from it with HKDF.
      if (options.e2eeKey) await provider.setKey(options.e2eeKey.slice().buffer)
      else if (options.groupKey !== 'later' && options.groupKey) await provider.setIndexedKey(options.groupKey.key, options.groupKey.index)
      worker = new E2EEWorker()
      encryption = { keyProvider: provider, worker }
    }
    if (useVoice.getState().session !== session) {
      worker?.terminate() // hung up meanwhile
      return false
    }
    e2eeWorker = worker
    const audio = useAudio.getState()
    boosting = canBoost()
    keyProvider = provider
    const next = new Room({
      adaptiveStream: true,
      dynacast: true,
      // Web Audio mixing lets people be turned up past 100% (only where it can also pick the output device).
      webAudioMix: boosting,
      audioOutput: audio.outputDevice ? { deviceId: audio.outputDevice } : undefined,
      audioCaptureDefaults: captureOptions(audio, strongWorks()),
      videoCaptureDefaults: { resolution: VideoPresets.h720.resolution },
      publishDefaults: { simulcast: true, screenShareEncoding: ScreenSharePresets.h1080fps30.encoding },
      encryption,
    })
    room = next

    // A few frames fail while a new key goes round (someone left, the key changed): only failures that keep
    // coming are worth showing, and the notice goes away once they stop.
    const DECRYPT_ERROR = t('voice.errors.decrypt')
    let failingSince = 0
    let lastFailure = 0
    const decryptFailed = () => {
      const now = Date.now()
      if (now - lastFailure > 2000) failingSince = now
      lastFailure = now
      if (now - failingSince >= 3000) useVoice.setState({ error: DECRYPT_ERROR })
      setTimeout(() => {
        if (room === next && Date.now() - lastFailure >= 3000 && useVoice.getState().error === DECRYPT_ERROR) useVoice.setState({ error: null })
      }, 3100)
    }

    next
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, participant: RemoteParticipant) => {
        if (track.kind === Track.Kind.Audio) {
          const element = track.attach()
          audioElements.set(participant.identity + track.sid, element)
          container().appendChild(element)
          applyVolume(participant)
        } else {
          // The sender's capture ended (they stopped sharing): drop the tile even if the room hasn't said so yet.
          track.mediaStreamTrack.addEventListener('ended', refreshTiles)
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
      .on(RoomEvent.TrackMuted, (pub, participant: Participant) => {
        // A stage moderator muted us: show it, and stay muted until we unmute.
        if (participant === next.localParticipant && pub.source === Track.Source.Microphone && !selfMuting && !useVoice.getState().muted) {
          useVoice.setState({ muted: true })
          reportFlags()
        }
        refreshTiles()
      })
      .on(RoomEvent.ParticipantPermissionsChanged, (_previous, participant: Participant) => {
        if (participant === next.localParticipant) void permissionsChanged(next)
      })
      .on(RoomEvent.TrackUnmuted, refreshTiles)
      // Over the internet "unpublished" can arrive after "unsubscribed": refresh on both, or a stopped share stays as a black tile.
      .on(RoomEvent.TrackPublished, refreshTiles)
      .on(RoomEvent.TrackUnpublished, refreshTiles)
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
        // Your own ring comes from your mic's level here when we measure it: quicker than the server's.
        const me = next.localParticipant.identity
        const measured = micPipelineActive()
        const speaking: Record<string, true> = {}
        for (const p of speakers) if (!measured || p.identity !== me) speaking[p.identity] = true
        if (measured && useVoice.getState().localSpeaking) speaking[me] = true
        useVoice.setState({ speaking })
      })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => {
        // The browser held back playback until the next tap or key press.
        if (next.canPlaybackAudio) return
        const start = () => void next.startAudio().catch(() => undefined)
        window.addEventListener('pointerdown', start, { once: true, capture: true })
        window.addEventListener('keydown', start, { once: true, capture: true })
      })
      .on(RoomEvent.ParticipantEncryptionStatusChanged, (enabled: boolean, participant?: Participant) => {
        if (room === next && participant === next.localParticipant)
          useVoice.setState((s) => ({ session: s.session && { ...s.session, encrypted: enabled } }))
      })
      .on(RoomEvent.EncryptionError, () => {
        if (room === next) decryptFailed()
      })
      .on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => {
        if (room !== next) return
        const mapped = state === ConnectionState.Connected ? 'connected' : state === ConnectionState.Reconnecting ? 'reconnecting' : null
        if (mapped) useVoice.setState((s) => ({ session: s.session && { ...s.session, state: mapped } }))
      })
      .on(RoomEvent.Disconnected, () => {
        if (room === next) void cleanup()
      })

    if (encryption) await next.setE2EEEnabled(true)
    await next.connect(url, token)
    if (room !== next) {
      await next.disconnect()
      return false
    }
    useVoice.setState((s) => ({ session: s.session && { ...s.session, state: 'connected', canSpeak } }))

    if (canSpeak) {
      try {
        // Publish the mic once; muting and push-to-talk just pause it (instant, no new permission prompts).
        const options = captureOptions(useAudio.getState(), strongWorks())
        capturedWithBrowserNs = options.noiseSuppression
        let tracks
        try {
          tracks = await next.localParticipant.createTracks({ audio: options })
        } catch (e) {
          // A remembered device that's gone: use the default one.
          if (!options.deviceId) throw e
          tracks = await next.localParticipant.createTracks({ audio: { ...options, deviceId: undefined } })
        }
        const track = tracks.find((t): t is LocalAudioTrack => t instanceof LocalAudioTrack)
        if (!track) throw new Error('no microphone')
        if (room !== next) {
          track.stop()
          return false
        }
        // The processed mic is what gets published: nothing leaves before noise suppression is on.
        if (typeof AudioWorkletNode === 'function') {
          const mic = new MicProcessor(() => useAudio.getState(), onLevel, onStrong)
          try {
            await track.setProcessor(mic)
            processor = mic
          } catch {
            // Send the mic as it is, with the browser's own noise suppression if you want any.
            const noiseSuppression = useAudio.getState().noise !== 'off'
            capturedWithBrowserNs = noiseSuppression
            if (noiseSuppression !== options.noiseSuppression) await track.restartTrack({ ...options, noiseSuppression }).catch(() => undefined)
          }
        }
        await next.localParticipant.publishTrack(track, { source: Track.Source.Microphone })
        await applyMic()
      } catch {
        useVoice.setState({ muted: true, error: t('voice.errors.mic') })
      }
      if (options.camera) await toggleCamera()
    }
    refreshTiles()
    reportFlags()
    return true
  } catch (e) {
    if (useVoice.getState().session === session) await cleanup()
    useVoice.setState({ error: (e as Error)?.message ? errorMessage(e) : t('voice.errors.join') })
    return false
  }
}

/** Stages: the server brought us up to speak or sent us back (through LiveKit, so this is what we may really do). */
async function permissionsChanged(current: Room): Promise<void> {
  const canSpeak = !!current.localParticipant.permissions?.canPublish
  const { session } = useVoice.getState()
  if (room !== current || !session || session.call || session.canSpeak === canSpeak) return
  micDeferred = canSpeak
  if (canSpeak) {
    useVoice.setState((s) => ({ muted: true, session: s.session && { ...s.session, canSpeak } }))
  } else {
    useVoice.setState((s) => ({ camera: false, screen: false, session: s.session && { ...s.session, canSpeak } }))
    for (const pub of [...current.localParticipant.trackPublications.values()]) {
      if (pub.track) await current.localParticipant.unpublishTrack(pub.track).catch(() => undefined)
    }
  }
  refreshTiles()
  reportFlags()
}

async function cleanup(): Promise<void> {
  const old = room
  const worker = e2eeWorker
  room = null
  e2eeWorker = null
  micDeferred = false
  processor = null // LiveKit destroys it with the track
  capturedWithBrowserNs = null
  keyProvider = null
  for (const element of audioElements.values()) element.remove()
  audioElements.clear()
  useVoice.setState({
    session: null, speaking: {}, tiles: [], stageOpen: false, camera: false, screen: false, localSpeaking: false, strongActive: null,
  })
  if (old && old.state !== ConnectionState.Disconnected) await old.disconnect()
  worker?.terminate()
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
  voiceTone(nextMuted ? 'mute' : 'unmute')
  if (room && session?.canSpeak) await applyMic()
  reportFlags()
}

export async function toggleDeafen(): Promise<void> {
  const { deafened, muted, session } = useVoice.getState()
  const next = !deafened
  if (next) mutedBeforeDeafen = muted
  // Deafening mutes you too; undeafening puts your mic back how it was.
  const nextMuted = next ? true : mutedBeforeDeafen
  useVoice.setState({ deafened: next, muted: nextMuted })
  voiceTone(next ? 'deafen' : 'undeafen')
  room?.remoteParticipants.forEach(applyVolume)
  if (room && session?.canSpeak) await applyMic()
  reportFlags()
}

export async function toggleCamera(): Promise<void> {
  if (!room || !useVoice.getState().session?.canSpeak) return
  const next = !useVoice.getState().camera
  try {
    await room.localParticipant.setCameraEnabled(next)
    useVoice.setState({ camera: next })
  } catch {
    useVoice.setState({ camera: false, error: t('voice.errors.camera') })
  }
  refreshTiles()
}

export async function toggleScreenShare(): Promise<void> {
  if (!room || !useVoice.getState().session?.canSpeak) return
  const next = !useVoice.getState().screen
  try {
    // Quality, sound and motion-vs-detail come from the share menu (state/screenShare.ts).
    const { capture, publish } = screenShareOptions(useScreenShareSettings.getState())
    await room.localParticipant.setScreenShareEnabled(next, capture, publish)
    useVoice.setState({ screen: next })
  } catch (e) {
    // Cancelling the browser's picker isn't an error worth showing.
    if ((e as Error).name !== 'NotAllowedError') useVoice.setState({ error: t('voice.errors.screen') })
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

/** Opens or pauses the published mic: not muted, and (in push-to-talk mode) the key is held. */
async function applyMic(): Promise<void> {
  const { muted, settings, pttDown, session } = useVoice.getState()
  const current = room
  if (!current || !session?.canSpeak) return
  const publication = current.localParticipant.getTrackPublication(Track.Source.Microphone)
  const open = !muted && (settings.mode === 'voice' || pttDown)
  if (!publication?.track) {
    if (!open || !micDeferred) return
    micDeferred = false
    try {
      await current.localParticipant.setMicrophoneEnabled(true)
    } catch {
      micDeferred = true // try again next time
      useVoice.setState({ muted: true, error: t('voice.errors.mic') })
    }
    return
  }
  if (!open && useVoice.getState().localSpeaking) setLocalSpeaking(false)
  selfMuting = true
  try {
    if (open && publication.isMuted) await publication.unmute()
    else if (!open && !publication.isMuted) await publication.mute()
  } finally {
    selfMuting = false
  }
}

export function setPushToTalkDown(down: boolean): void {
  if (useVoice.getState().pttDown === down) return
  useVoice.setState({ pttDown: down })
  if (useVoice.getState().settings.mode === 'ptt') void applyMic()
}

export function updateVoiceSettings(patch: Partial<VoiceSettings>): void {
  const settings = { ...useVoice.getState().settings, ...patch }
  useVoice.setState({ settings, pttDown: false })
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    /* private mode */
  }
  void desktop?.setPushToTalkKey(settings.mode === 'ptt' ? (settings.desktopKey?.code ?? null) : null)
  void applyMic()
}

/** Wires the push-to-talk key: global on desktop, in-page on the web. */
export function startPushToTalk(): () => void {
  if (desktop) {
    const { settings } = useVoice.getState()
    void desktop.setPushToTalkKey(settings.mode === 'ptt' ? (settings.desktopKey?.code ?? null) : null)
    return desktop.onPushToTalk(setPushToTalkDown)
  }
  const isTyping = (target: EventTarget | null) =>
    target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  const handler = (down: boolean) => (event: KeyboardEvent) => {
    const { settings } = useVoice.getState()
    if (settings.mode !== 'ptt' || event.code !== settings.webKey?.code || event.repeat) return
    if (down && isTyping(event.target)) return
    setPushToTalkDown(down)
  }
  const onDown = handler(true)
  const onUp = handler(false)
  const onBlur = () => setPushToTalkDown(false)
  window.addEventListener('keydown', onDown)
  window.addEventListener('keyup', onUp)
  window.addEventListener('blur', onBlur)
  return () => {
    window.removeEventListener('keydown', onDown)
    window.removeEventListener('keyup', onUp)
    window.removeEventListener('blur', onBlur)
  }
}

export function clearVoiceError(): void {
  useVoice.setState({ error: null })
}
