// Whisper (talk only to chosen people or another voice channel) and priority speakers. Each whisper is its own LiveKit
// room that the server hands tokens for: we publish our processed mic there while a whisper key is held, and listen in
// the rooms of whispers that reach us. Priority is a flag in voice.state; we turn others down while a priority speaker talks.
import type { LocalAudioTrack, RemoteParticipant, RemoteTrack, Room } from 'livekit-client'
import { create } from 'zustand'
import { t } from '../i18n'
import { errorMessage } from '../i18n/errors'
import { captureOptions, effectiveVolume, useAudio } from './audio'
import { plannedEngine } from './audio/engines'
import { onHoldKey, type HoldAction } from './hotkeys'
import { lk, loadLiveKit } from './livekit'
import { MicProcessor } from './micPipeline'
import { playTone } from './notify'
import { connectionFor, onServerEvent, useApp } from './store'
import {
  connectSideRoom, rawMicTrack, reapplyVolumes, setVolumeFactor, setWhisperHold, useVoice,
} from './voice'
import {
  DEFAULT_DUCK_DB, duckFactor, emptyLists, parseLists, startBody, type WhisperList, type WhisperSlot,
} from './whisperLogic'

export * from './whisperLogic'

const LISTS_KEY = 'iskra.whisper'
const PRIORITY_KEY = 'iskra.priority'
/** Keep a whisper's room up this long after the key comes up, so the next press is instant. */
const LINGER_MS = 30_000
/** Freshen a whisper that stays open this long (the server closes one nobody started again for 10 minutes). */
const REFRESH_MS = 120_000

export interface Incoming {
  id: string
  serverKey: string
  from: string
  /** The channel it goes to (null: you're on their list). */
  channelId: number | null
  /** Their whisper track is live (they're holding the key). */
  live: boolean
}

export interface PrioritySettings {
  /** Priority whenever you talk, not only while the priority key is held. */
  always: boolean
  /** How far others go down while a priority speaker talks (dB, 0 = not at all). */
  duckDb: number
}

interface WhisperState {
  /** Lists per server (three each). */
  lists: Record<string, WhisperList[]>
  /** The list being whispered to right now (key or button held). */
  active: { slot: WhisperSlot; reached: string[] | null; connecting: boolean } | null
  incoming: Record<string, Incoming>
  priority: PrioritySettings
  /** Priority is on for us right now (key held, or always). */
  priorityOn: boolean
  error: string | null
}

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function loadLists(): Record<string, WhisperList[]> {
  const raw = load<Record<string, unknown>>(LISTS_KEY, {})
  return Object.fromEntries(Object.entries(raw && typeof raw === 'object' ? raw : {}).map(([k, v]) => [k, parseLists(v)]))
}

function loadPriority(): PrioritySettings {
  const raw = load<Partial<PrioritySettings>>(PRIORITY_KEY, {})
  const duckDb = typeof raw.duckDb === 'number' && raw.duckDb >= 0 && raw.duckDb <= 40 ? raw.duckDb : DEFAULT_DUCK_DB
  return { always: raw.always === true, duckDb }
}

export const useWhisper = create<WhisperState>(() => ({
  lists: loadLists(),
  active: null,
  incoming: {},
  priority: loadPriority(),
  priorityOn: false,
  error: null,
}))

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* private mode: this session only */
  }
}

export const listsFor = (serverKey: string): WhisperList[] => useWhisper.getState().lists[serverKey] ?? emptyLists()

export function saveList(serverKey: string, list: WhisperList): void {
  const lists = listsFor(serverKey).map((l) => (l.slot === list.slot ? list : l))
  const all = { ...useWhisper.getState().lists, [serverKey]: lists }
  useWhisper.setState({ lists: all })
  save(LISTS_KEY, all)
  // A list that changed starts a new whisper next time.
  const open = outgoing.get(list.slot)
  if (open && open.serverKey === serverKey) void closeOutgoing(list.slot, true)
}

export function setPrioritySettings(patch: Partial<PrioritySettings>): void {
  const priority = { ...useWhisper.getState().priority, ...patch }
  useWhisper.setState({ priority })
  save(PRIORITY_KEY, priority)
  syncPriority()
  reapplyVolumes()
}

export const clearWhisperError = () => useWhisper.setState({ error: null })

// ── Whispering ─────────────────────────────────────────────────────────────

interface Outgoing {
  serverKey: string
  id: string
  room: Room
  track: LocalAudioTrack
  idle: ReturnType<typeof setTimeout> | null
  refreshed: number
}
const outgoing = new Map<WhisperSlot, Outgoing>()
/** The slot whose key is held, and a press counter so a release during setup wins. */
let held: WhisperSlot | null = null
let press = 0

/** In a voice channel (not a call or stage) where the server said we may whisper. */
function whisperSession() {
  const { session } = useVoice.getState()
  return session && !session.call && !session.group && session.state === 'connected' && session.whisper ? session : null
}

/** Our mic for a whisper: a copy of the call's mic (or a capture of its own), with the same noise suppression. */
async function whisperTrack(): Promise<LocalAudioTrack> {
  const { LocalAudioTrack, createLocalAudioTrack } = lk()
  const settings = useAudio.getState()
  const raw = rawMicTrack()
  const track = raw && raw.readyState === 'live'
    ? new LocalAudioTrack(raw.clone(), undefined, true)
    : await createLocalAudioTrack(captureOptions(settings, plannedEngine(settings.noise)))
  if (typeof AudioWorkletNode === 'function') {
    // Always open while the key is held: no voice activity gate, like push-to-talk.
    const quiet = () => undefined
    await track.setProcessor(new MicProcessor(() => useAudio.getState(), () => true, { onLevel: quiet, onLoad: quiet, onSlow: quiet }, quiet)).catch(() => undefined)
  }
  return track
}

export async function startWhisper(slot: WhisperSlot): Promise<void> {
  const session = whisperSession()
  if (!session) return
  const list = listsFor(session.serverKey)[slot - 1]
  const body = startBody(list)
  if (!body) {
    useWhisper.setState({ error: t('whisper.errors.emptyList', { n: slot }) })
    return
  }
  const { muted } = useVoice.getState()
  if (muted) {
    useWhisper.setState({ error: t('whisper.errors.muted') })
    return
  }
  if (held && held !== slot) await stopWhisper(held)
  held = slot
  const mine = ++press
  setWhisperHold(true)
  const open = outgoing.get(slot)
  const ready = open && open.serverKey === session.serverKey && open.room.state === lk().ConnectionState.Connected
  useWhisper.setState({ active: { slot, reached: null, connecting: !ready }, error: null })
  if (open?.idle) clearTimeout(open.idle)
  if (open) open.idle = null
  const connection = connectionFor(session.serverKey)
  if (!connection) return
  try {
    if (ready) {
      await open.track.unmute()
      // Freshen it now and then (targets are worked out again on the server).
      if (Date.now() - open.refreshed > REFRESH_MS / 4) {
        open.refreshed = Date.now()
        const result = await connection.request('whisper.start', body)
        if (result.id !== open.id) {
          // The server closed the old one meanwhile: set up again.
          await closeOutgoing(slot, false)
          if (held === slot && mine === press) await startWhisper(slot)
          return
        }
        if (held === slot) useWhisper.setState({ active: { slot, reached: result.reached, connecting: false } })
      }
      return
    }
    if (open) await closeOutgoing(slot, false)
    const [result] = await Promise.all([connection.request('whisper.start', body), loadLiveKit()])
    if (held === slot && mine === press) useWhisper.setState({ active: { slot, reached: result.reached, connecting: true } })
    const { Room, Track } = lk()
    const room = new Room({ publishDefaults: { dtx: true, red: true } })
    const entry: Outgoing = { serverKey: session.serverKey, id: result.id, room, track: null as unknown as LocalAudioTrack, idle: null, refreshed: Date.now() }
    outgoing.set(slot, entry)
    room.on(lk().RoomEvent.Disconnected, () => {
      if (outgoing.get(slot) === entry) outgoing.delete(slot)
      entry.track?.stop()
    })
    await connectSideRoom(room, session.serverKey, result.url, result.token)
    entry.track = await whisperTrack()
    await room.localParticipant.publishTrack(entry.track, { source: Track.Source.Microphone, dtx: true, red: true })
    if (held !== slot || mine !== press) {
      await entry.track.mute()
      scheduleClose(slot)
    } else {
      useWhisper.setState((s) => ({ active: s.active?.slot === slot ? { ...s.active, connecting: false } : s.active }))
    }
  } catch (e) {
    await closeOutgoing(slot, false)
    if (held === slot) {
      held = null
      setWhisperHold(false)
      useWhisper.setState({ active: null })
    }
    useWhisper.setState({ error: errorMessage(e) || t('whisper.errors.start') })
  }
}

export async function stopWhisper(slot: WhisperSlot): Promise<void> {
  if (held !== slot) return
  held = null
  press++
  setWhisperHold(false)
  useWhisper.setState({ active: null })
  const open = outgoing.get(slot)
  if (open?.track) await open.track.mute().catch(() => undefined)
  scheduleClose(slot)
}

function scheduleClose(slot: WhisperSlot): void {
  const open = outgoing.get(slot)
  if (!open) return
  if (open.idle) clearTimeout(open.idle)
  open.idle = setTimeout(() => void closeOutgoing(slot, true), LINGER_MS)
}

/** Leaves a whisper's room; `stop`: also tells the server it's over. */
async function closeOutgoing(slot: WhisperSlot, stop: boolean): Promise<void> {
  const open = outgoing.get(slot)
  if (!open) return
  outgoing.delete(slot)
  if (open.idle) clearTimeout(open.idle)
  if (stop) connectionFor(open.serverKey)?.request('whisper.stop', { id: open.id }).catch(() => undefined)
  open.track?.stop()
  await open.room.disconnect().catch(() => undefined)
}

// ── Hearing whispers ───────────────────────────────────────────────────────

const listening = new Map<string, { room: Room; elements: HTMLMediaElement[] }>()

function incomingVolume(from: string): number {
  const { volumes, deafened } = useVoice.getState()
  return effectiveVolume(volumes[from] ?? 1, useAudio.getState().outputVolume, deafened, false)
}

/** When each whisper last went quiet: a soft tone only when one starts after a pause, not on every press. */
const quietSince = new Map<string, number>()

function setLive(id: string, live: boolean): void {
  const current = useWhisper.getState().incoming[id]
  if (!current || current.live === live) return
  useWhisper.setState((s) => ({ incoming: { ...s.incoming, [id]: { ...current, live } } }))
  if (!live) quietSince.set(id, Date.now())
  else if (Date.now() - (quietSince.get(id) ?? 0) > 10_000) playTone('whisper')
}

async function listen(serverKey: string, body: { id: string; from: string; channelId: number | null }): Promise<void> {
  const { session } = useVoice.getState()
  if (!session || session.serverKey !== serverKey || session.call || session.group || listening.has(body.id)) return
  const connection = connectionFor(serverKey)
  if (!connection) return
  useWhisper.setState((s) => ({ incoming: { ...s.incoming, [body.id]: { ...body, serverKey, live: false } } }))
  try {
    const [target] = await Promise.all([connection.request('whisper.join', { id: body.id }), loadLiveKit()])
    if (!useWhisper.getState().incoming[body.id]) return // ended meanwhile
    const { Room, RoomEvent, Track } = lk()
    const room = new Room()
    const entry = { room, elements: [] as HTMLMediaElement[] }
    listening.set(body.id, entry)
    const output = useAudio.getState().outputDevice
    room
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub, participant: RemoteParticipant) => {
        if (track.kind !== Track.Kind.Audio || participant.identity !== body.from) return
        const element = track.attach()
        element.dataset.whisper = body.id
        entry.elements.push(element)
        document.body.appendChild(element)
        element.hidden = true
        participant.setVolume(incomingVolume(body.from))
        setLive(body.id, !pub.isMuted)
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        for (const element of track.detach()) element.remove()
        setLive(body.id, false)
      })
      .on(RoomEvent.TrackMuted, (_pub, participant) => {
        if (participant.identity === body.from) setLive(body.id, false)
      })
      .on(RoomEvent.TrackUnmuted, (_pub, participant) => {
        if (participant.identity === body.from) setLive(body.id, true)
      })
      .on(RoomEvent.Disconnected, () => dropIncoming(body.id))
    await connectSideRoom(room, serverKey, target.url, target.token)
    if (output) await room.switchActiveDevice('audiooutput', output).catch(() => undefined)
    if (listening.get(body.id) !== entry) await room.disconnect()
  } catch {
    dropIncoming(body.id)
  }
}

function dropIncoming(id: string): void {
  quietSince.delete(id)
  const entry = listening.get(id)
  listening.delete(id)
  if (entry) {
    for (const element of entry.elements) element.remove()
    void entry.room.disconnect().catch(() => undefined)
  }
  useWhisper.setState((s) => {
    if (!s.incoming[id]) return s
    const incoming = { ...s.incoming }
    delete incoming[id]
    return { incoming }
  })
}

function applyIncomingVolumes(): void {
  for (const [id, { room }] of listening) {
    const from = useWhisper.getState().incoming[id]?.from
    if (from) room.remoteParticipants.get(from)?.setVolume(incomingVolume(from))
  }
}

/** Out of voice (or into another server's): every whisper goes. */
async function closeAll(): Promise<void> {
  if (held) {
    held = null
    press++
    setWhisperHold(false)
  }
  for (const slot of [...outgoing.keys()]) await closeOutgoing(slot, true)
  for (const id of [...listening.keys()]) dropIncoming(id)
  useWhisper.setState({ active: null, incoming: {}, priorityOn: false })
}

onServerEvent((serverKey, type, body) => {
  if (type === 'whisper.incoming') void listen(serverKey, body as { id: string; from: string; channelId: number | null })
  else if (type === 'whisper.ended') {
    const { id } = body as { id: string }
    dropIncoming(id)
    for (const [slot, open] of outgoing) if (open.id === id && open.serverKey === serverKey) void closeOutgoing(slot, false)
  } else if (type === 'whisper.reach') {
    const { id, reached } = body as { id: string; reached: string[] }
    const active = useWhisper.getState().active
    if (active && outgoing.get(active.slot)?.id === id) useWhisper.setState({ active: { ...active, reached } })
  }
})

// ── Priority speaker ───────────────────────────────────────────────────────

let priorityKeyDown = false
let prioritySent: { serverKey: string; on: boolean } | null = null

/** Tells the server whether priority is on (key held, or always), only when that changes. */
function syncPriority(): void {
  const { session, muted } = useVoice.getState()
  const can = !!session && !session.call && !session.group && session.state === 'connected' && !!session.priority && session.canSpeak
  const on = can && !muted && (useWhisper.getState().priority.always || priorityKeyDown)
  useWhisper.setState({ priorityOn: on })
  const serverKey = session?.serverKey ?? null
  if (prioritySent && (prioritySent.serverKey !== serverKey || !can)) {
    if (prioritySent.on && prioritySent.serverKey !== serverKey) connectionFor(prioritySent.serverKey)?.request('voice.priority', { on: false }).catch(() => undefined)
    prioritySent = null
  }
  if (!serverKey || !can || prioritySent?.on === on) return
  prioritySent = { serverKey, on }
  connectionFor(serverKey)?.request('voice.priority', { on }).catch((e) => {
    prioritySent = null
    useWhisper.setState({ priorityOn: false, error: errorMessage(e) })
  })
}

export function setPriorityKey(down: boolean): void {
  if (priorityKeyDown === down) return
  priorityKeyDown = down
  syncPriority()
}

/** Everyone else goes down while someone with priority talks (on this device; the server says who has priority). */
function participantsHere() {
  const { session } = useVoice.getState()
  if (!session || session.call || session.group) return []
  return useApp.getState().servers[session.serverKey]?.voice[session.channelId] ?? []
}
setVolumeFactor((accountKey) => {
  const { session, speaking } = useVoice.getState()
  if (!session) return 1
  const me = useApp.getState().servers[session.serverKey]?.me?.accountKey
  return duckFactor(accountKey, participantsHere(), speaking, me, useWhisper.getState().priority.duckDb)
})

let lastDuckKey = ''
function maybeReapply(): void {
  const { session, speaking } = useVoice.getState()
  const me = session && useApp.getState().servers[session.serverKey]?.me?.accountKey
  const key = participantsHere().filter((p) => p.priority && p.accountKey !== me && speaking[p.accountKey]).map((p) => p.accountKey).join(',')
  if (key !== lastDuckKey) {
    lastDuckKey = key
    reapplyVolumes()
  }
}

useVoice.subscribe((state, prev) => {
  const was = prev.session
  const now = state.session
  if (was && (!now || now.serverKey !== was.serverKey || now.channelId !== was.channelId || now.call || now.group)) void closeAll()
  if (state.speaking !== prev.speaking) maybeReapply()
  if (state.volumes !== prev.volumes || state.deafened !== prev.deafened) applyIncomingVolumes()
  if (state.session !== prev.session || state.muted !== prev.muted) syncPriority()
  if (state.muted && !prev.muted && held) void stopWhisper(held)
})
useApp.subscribe((state, prev) => {
  if (state.servers !== prev.servers) maybeReapply()
})

// ── Keys and buttons ───────────────────────────────────────────────────────

const SLOT_OF: Partial<Record<HoldAction, WhisperSlot>> = { whisper1: 1, whisper2: 2, whisper3: 3 }

/** A whisper or priority key went down or up (desktop global keys, in-app keys, or the hold buttons). */
export function holdKey(action: HoldAction, down: boolean): void {
  if (action === 'priority') return setPriorityKey(down)
  const slot = SLOT_OF[action]!
  if (down) void startWhisper(slot)
  else void stopWhisper(slot)
}
onHoldKey(holdKey)

/** For the call UI: lists you can whisper to on this server right now. */
export function usableLists(serverKey: string): WhisperList[] {
  return listsFor(serverKey).filter((l) => !!l.target)
}
