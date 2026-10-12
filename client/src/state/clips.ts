// Clips: "save the last 30 seconds" of a call. Opt in (Settings → Voice & audio); while it's on, what you hear is kept
// in a rolling buffer on this device and everyone in the call sees a "clips on" mark next to your name. Saving one
// posts a notice in the call first (the voice channel's chat, or the call's data channel), then opens the clip dialog.
// Nothing is ever uploaded unless you share the file.
import { create } from 'zustand'
import { RoomEvent, Track, type RemoteParticipant, type RemoteTrack, type RemoteTrackPublication, type Room } from 'livekit-client'
import { t } from '../i18n'
import { errorMessage } from '../i18n/errors'
import { native } from '../platform/native'
import { ClipRecorder, clipsSupported } from './clips/recorder'
import type { ClipDraft } from './clips/ring'
import { muxWebm } from './clips/webm'
import {
  callPlace, CLIP_TOPIC, clipFileName, encodeClipData, flagToSend, parseClipData, parseClipSettings, type CallPlace, type ClipData,
  type ClipSettings,
} from './clipsLogic'
import { connectionFor, onServerEvent, sendMessage, uploadFile, useApp } from './store'
import { activeRoom, cleanedAudio, onIncomingAudio, useVoice, videoTrackFor } from './voice'
import { sendDm } from './dms'
import { uploadDmFile } from './dmFiles'
import { sendGroupMessage, useGroups } from './groups'
import { onClipHotkey } from './hotkeys'

const KEY = 'iskra.clips'

export interface ClipNotice {
  id: number
  accountKey: string
}

interface ClipState {
  settings: ClipSettings
  /** The buffer is running (clips on, in a call, supported here). */
  recording: boolean
  busy: boolean
  /** The clip being looked at in the dialog. */
  draft: { clip: ClipDraft; place: CallPlace; at: number } | null
  /** DM and group calls: who said they have clips on (from the room's data channel). */
  roomClips: Record<string, true>
  /** "Alex saved a clip" lines shown in the call for a few seconds. */
  notices: ClipNotice[]
  /** The screen share the call screen shows big (its tile id): the video a clip keeps. */
  watched: string | null
  error: string | null
}

function loadSettings(): ClipSettings {
  try {
    return parseClipSettings(localStorage.getItem(KEY))
  } catch {
    return parseClipSettings(null)
  }
}

export const useClips = create<ClipState>(() => ({
  settings: loadSettings(),
  recording: false,
  busy: false,
  draft: null,
  roomClips: {},
  notices: [],
  watched: null,
  error: null,
}))

export const canClip = clipsSupported

export function setClipSettings(patch: Partial<ClipSettings>): void {
  const settings = { ...useClips.getState().settings, ...patch }
  useClips.setState({ settings, error: null })
  try {
    localStorage.setItem(KEY, JSON.stringify(settings))
  } catch {
    /* private mode: this session only */
  }
  sync()
}

export const setWatchedTile = (id: string | null): void => {
  if (useClips.getState().watched !== id) useClips.setState({ watched: id })
}

export const clearClipError = (): void => useClips.setState({ error: null })

// ── Notices in the call ─────────────────────────────────────────────────────

let noticeId = 0

function addNotice(accountKey: string): void {
  const notice = { id: ++noticeId, accountKey }
  useClips.setState((s) => ({ notices: [...s.notices.slice(-2), notice] }))
  setTimeout(() => useClips.setState((s) => ({ notices: s.notices.filter((n) => n !== notice) })), 8000)
}

// Someone else in your voice channel saved a clip.
onServerEvent((serverKey, type, body) => {
  if (type !== 'chat.message') return
  const { message } = body as { message: { channelId: number; author: string; clip?: unknown } }
  const session = useVoice.getState().session
  if (!message.clip || !session || session.call || session.group) return
  if (session.serverKey !== serverKey || session.channelId !== message.channelId) return
  if (message.author !== useApp.getState().servers[serverKey]?.me?.accountKey) addNotice(message.author)
})

// ── The room: incoming audio, the watched share, the data channel ───────────

let recorder: ClipRecorder | null = null
let bound: Room | null = null
let unbind: (() => void) | null = null
/** DM and group calls: what we last told the room (null: nothing yet). */
let announced: boolean | null = null

const wanted = (): boolean => useClips.getState().settings.enabled && clipsSupported()

function remoteAudio(room: Room): [string, MediaStreamTrack][] {
  const out: [string, MediaStreamTrack][] = []
  for (const p of room.remoteParticipants.values()) {
    for (const pub of p.audioTrackPublications.values()) {
      // With "Clean up others' audio" on, what you hear is the cleaned voice: record that.
      if (pub.isSubscribed && pub.track) out.push([pub.trackSid, cleanedAudio(pub.trackSid) ?? pub.track.mediaStreamTrack])
    }
  }
  return out
}

/** The screen share you're watching (the one shown big, else any), never your own. */
function updateVideo(): void {
  if (!recorder) return
  const { tiles } = useVoice.getState()
  const watched = useClips.getState().watched
  const screens = tiles.filter((tile) => tile.source === 'screen' && !tile.isLocal)
  const tile = screens.find((s) => s.id === watched) ?? screens[0]
  recorder.setVideo(tile ? (videoTrackFor(tile)?.mediaStreamTrack ?? null) : null)
}

async function publish(room: Room, data: ClipData, to?: string[]): Promise<void> {
  await room.localParticipant.publishData(encodeClipData(data), { reliable: true, topic: CLIP_TOPIC, destinationIdentities: to })
}

function bindRoom(room: Room): () => void {
  const onSubscribed = (track: RemoteTrack, pub: RemoteTrackPublication) => {
    if (track.kind === Track.Kind.Audio) recorder?.addAudio(pub.trackSid, cleanedAudio(pub.trackSid) ?? track.mediaStreamTrack)
    updateVideo()
  }
  const onUnsubscribed = (track: RemoteTrack, pub: RemoteTrackPublication) => {
    if (track.kind === Track.Kind.Audio) recorder?.removeAudio(pub.trackSid)
    updateVideo()
  }
  const onData = (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
    if (topic !== CLIP_TOPIC || !participant) return
    const data = parseClipData(payload)
    if (!data) return
    if ('saved' in data) {
      addNotice(participant.identity)
      return
    }
    useClips.setState((s) => {
      const roomClips = { ...s.roomClips }
      if (data.clips) roomClips[participant.identity] = true
      else delete roomClips[participant.identity]
      return { roomClips }
    })
  }
  const onJoined = (participant: RemoteParticipant) => {
    if (announced) void publish(room, { clips: true }, [participant.identity]).catch(() => undefined)
  }
  const onLeft = (participant: RemoteParticipant) => {
    useClips.setState((s) => {
      if (!s.roomClips[participant.identity]) return s
      const roomClips = { ...s.roomClips }
      delete roomClips[participant.identity]
      return { roomClips }
    })
  }
  room
    .on(RoomEvent.TrackSubscribed, onSubscribed)
    .on(RoomEvent.TrackUnsubscribed, onUnsubscribed)
    .on(RoomEvent.DataReceived, onData)
    .on(RoomEvent.ParticipantConnected, onJoined)
    .on(RoomEvent.ParticipantDisconnected, onLeft)
  return () => {
    room
      .off(RoomEvent.TrackSubscribed, onSubscribed)
      .off(RoomEvent.TrackUnsubscribed, onUnsubscribed)
      .off(RoomEvent.DataReceived, onData)
      .off(RoomEvent.ParticipantConnected, onJoined)
      .off(RoomEvent.ParticipantDisconnected, onLeft)
  }
}

function startRecorder(room: Room): void {
  try {
    recorder = new ClipRecorder()
  } catch {
    recorder = null
    return
  }
  for (const [id, track] of remoteAudio(room)) recorder.addAudio(id, track)
  updateVideo()
  useClips.setState({ recording: true })
}

function stopRecorder(): void {
  recorder?.stop()
  recorder = null
  if (useClips.getState().recording) useClips.setState({ recording: false })
}

/** Tells the others whether we have clips on: the server in a channel, the room's data channel in DM and group calls. */
function syncFlag(): void {
  const { session, muted, deafened } = useVoice.getState()
  if (!session || session.state !== 'connected') return
  const on = wanted()
  const place = callPlace(session)
  if (place.kind === 'channel') {
    const server = useApp.getState().servers[place.serverKey]
    const me = server?.me?.accountKey ?? null
    if (!flagToSend(server?.voice[place.channelId] ?? [], me, on)) return
    const tag = `${place.serverKey}:${place.channelId}:${on}`
    if (lastSent === tag && Date.now() - lastSentAt < 5000) return // waiting for the server's voice.state
    lastSent = tag
    lastSentAt = Date.now()
    void connectionFor(place.serverKey)?.request('voice.state', { muted, deafened, clips: on }).catch(() => undefined)
  } else if (bound && announced !== on) {
    const room = bound
    announced = on
    void publish(room, { clips: on }).catch(() => (announced = null))
    // Right after joining, the others may not know us yet (our message would arrive from nobody): say it again.
    if (on) setTimeout(() => {
      if (bound === room && announced) void publish(room, { clips: true }).catch(() => undefined)
    }, 2000)
  }
}
let lastSent = ''
let lastSentAt = 0

function sync(): void {
  const { session } = useVoice.getState()
  const room = session ? activeRoom() : null
  if (room !== bound) {
    unbind?.()
    unbind = null
    stopRecorder()
    bound = room
    announced = null
    useClips.setState({ roomClips: {}, watched: null })
    if (room) unbind = bindRoom(room)
  }
  if (room && wanted() && !recorder) startRecorder(room)
  else if ((!room || !wanted()) && recorder) stopRecorder()
  syncFlag()
}

// Incoming clean-up turned on or off, or a voice's cleaned track is ready: record the voices as you hear them now.
onIncomingAudio(() => {
  if (!recorder || !bound) return
  for (const [id, track] of remoteAudio(bound)) {
    recorder.removeAudio(id)
    recorder.addAudio(id, track)
  }
})
useVoice.subscribe((state, prev) => {
  if (state.session !== prev.session) sync()
  if (state.tiles !== prev.tiles) updateVideo()
})
useClips.subscribe((state, prev) => {
  if (state.watched !== prev.watched) updateVideo()
})
// The server's voice state changes (we appear in the channel, or it lost our flag after a rejoin).
useApp.subscribe((state, prev) => {
  const session = useVoice.getState().session
  if (!session || session.call || session.group) return
  if (state.servers[session.serverKey]?.voice !== prev.servers[session.serverKey]?.voice) syncFlag()
})

// ── Saving ──────────────────────────────────────────────────────────────────

/** Makes sure the server knows our clips are on before asking it to post the notice. */
async function flagged(place: Extract<CallPlace, { kind: 'channel' }>): Promise<void> {
  const server = useApp.getState().servers[place.serverKey]
  const me = server?.me?.accountKey ?? null
  if (!flagToSend(server?.voice[place.channelId] ?? [], me, true)) return
  const { muted, deafened } = useVoice.getState()
  await connectionFor(place.serverKey)?.request('voice.state', { muted, deafened, clips: true })
}

/**
 * Saves the last N seconds: the notice goes out first (no notice, no clip), then the clip dialog opens.
 * The hotkey and the call button both land here.
 */
export async function saveClip(): Promise<void> {
  const { session } = useVoice.getState()
  const state = useClips.getState()
  if (!session || state.busy || state.draft) return
  if (!clipsSupported()) return useClips.setState({ error: t('clips.unsupported') })
  if (!state.settings.enabled) return useClips.setState({ error: t('clips.turnOnFirst') })
  if (!recorder) return useClips.setState({ error: t('clips.notReady') })
  useClips.setState({ busy: true, error: null })
  try {
    const clip = await recorder.snapshot(state.settings.seconds)
    if (!clip || clip.duration < 500) throw new Error(t('clips.nothingYet'))
    const place = callPlace(session)
    if (place.kind === 'channel') {
      const connection = connectionFor(place.serverKey)
      if (!connection) throw new Error(t('errors.codes.disconnected'))
      await flagged(place)
      await connection.request('voice.clip', { channelId: place.channelId })
    } else {
      if (!bound) throw new Error(t('clips.notReady'))
      await publish(bound, { saved: true })
    }
    useClips.setState({ draft: { clip, place, at: Date.now() } })
  } catch (e) {
    useClips.setState({ error: errorMessage(e) })
  } finally {
    useClips.setState({ busy: false })
  }
}

onClipHotkey(() => void saveClip())

export const closeClip = (): void => useClips.setState({ draft: null })

/** The clip (or a part of it) as a WebM file. */
export function clipFile(clip: ClipDraft, at: number): File {
  const { bytes } = muxWebm([clip.video, clip.audio].filter((x) => !!x))
  const type = clip.video ? 'video/webm' : 'audio/webm'
  return new File([bytes as Uint8Array<ArrayBuffer>], clipFileName(new Date(at)), { type })
}

/** Desktop: the save dialog; browsers: a download; the phone app: the share sheet. */
export async function downloadClip(file: File): Promise<void> {
  if (native) {
    await native.saveFile(file, file.name)
    return
  }
  const url = URL.createObjectURL(file)
  const link = document.createElement('a')
  link.href = url
  link.download = file.name
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

/** Posts the clip where the call happens: the voice channel's chat, the DM, or the group. */
export async function shareClip(file: File, place: CallPlace, onProgress: (fraction: number) => void): Promise<void> {
  if (place.kind === 'channel') {
    const info = await uploadFile(place.serverKey, file, onProgress)
    await sendMessage(place.serverKey, place.channelId, '', { attachments: [info] })
  } else if (place.kind === 'dm') {
    const sent = await uploadDmFile(place.serverKey, place.peer, file, onProgress)
    await sendDm(place.peer, '', { files: [sent] })
  } else {
    const group = useGroups.getState().groups[place.groupKey]
    if (!group) throw new Error(t('errors.codes.not_found'))
    const sent = await uploadDmFile(group.serverKey, { groupId: group.id }, file, onProgress)
    await sendGroupMessage(place.groupKey, '', { files: [sent] })
  }
}
