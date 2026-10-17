// Notification sounds: which sound plays for messages, mentions and DMs, per server and per channel, and your own
// uploaded sound. The choices follow your account (prefs.get/prefs.set under "sounds", sealed like the rail); your own
// sound stays on this device (decoded and checked here, kept as short mono PCM, never uploaded). Whether a sound plays
// at all (mutes, quiet hours, do not disturb, streamer mode) is decided by state/notify.ts before it asks for one.
import { create } from 'zustand'
import { openPrefs, prefsKey, sealPrefs } from '../../core/prefs'
import { connectionFor, onServerEvent, onWelcomeHook, useApp } from '../store'
import {
  checkDecoded, checkUploadFile, decodePcm, emptySoundPrefs, encodePcm, MAX_SOUND_SECONDS, parseCustomSound, parseSoundPrefs, peakOf,
  playable, resolveSound, STORED_RATE, tame, withDefault, withOverride,
  type CustomSound, type SoundId, type SoundKind, type SoundPlace, type SoundPrefs, type UploadProblem,
} from './soundLogic'
import { playBuiltin, playSamples } from './synth'

const STORAGE_KEY = 'iskra.sounds'
const CUSTOM_KEY = 'iskra.sounds.custom'
const PREF = 'sounds'

interface SoundState {
  prefs: SoundPrefs
  /** Your own sound on this device. */
  custom: CustomSound | null
}

function read<T>(key: string, parse: (raw: unknown) => T | null): T | null {
  try {
    return parse(JSON.parse(localStorage.getItem(key) ?? 'null'))
  } catch {
    return null
  }
}

export const useSounds = create<SoundState>(() => ({
  prefs: read(STORAGE_KEY, parseSoundPrefs) ?? emptySoundPrefs(),
  custom: read(CUSTOM_KEY, parseCustomSound),
}))

function write(key: string, value: unknown): boolean {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false // private mode or full
  }
}

function keep(prefs: SoundPrefs): void {
  useSounds.setState({ prefs })
  write(STORAGE_KEY, prefs)
}

// ── Playing ─────────────────────────────────────────────────────────────────

let customSamples: { pcm: string; samples: Float32Array } | null = null

/** Plays one sound now (previews too); `custom` falls back to Classic where this device has none. */
export function playSound(id: SoundId): void {
  const custom = useSounds.getState().custom
  const sound = playable(id, !!custom)
  if (sound === 'none') return
  if (sound !== 'custom') return playBuiltin(sound)
  if (customSamples?.pcm !== custom!.pcm) {
    const samples = decodePcm(custom!.pcm)
    if (!samples) return playBuiltin('classic')
    customSamples = { pcm: custom!.pcm, samples }
  }
  playSamples(customSamples.samples, STORED_RATE)
}

/** The sound for a notification here (the caller already checked that one should play). */
export function playNotifySound(kind: SoundKind, place: SoundPlace): void {
  playSound(resolveSound(useSounds.getState().prefs, kind, place))
}

export const soundFor = (kind: SoundKind, place: SoundPlace = {}) => resolveSound(useSounds.getState().prefs, kind, place)

// ── Choosing ────────────────────────────────────────────────────────────────

function change(next: SoundPrefs): void {
  keep(next)
  for (const serverKey of useApp.getState().order) void pushTo(serverKey, next)
}

export const setDefaultSound = (kind: SoundKind, id: SoundId) => change(withDefault(useSounds.getState().prefs, kind, id, Date.now()))

/** A server's (channelId null) or a channel's sound; null goes back to inheriting. */
export const setPlaceSound = (serverKey: string, channelId: number | null, id: SoundId | null) =>
  change(withOverride(useSounds.getState().prefs, { serverKey, channelId }, id, Date.now()))

// ── Your own sound ──────────────────────────────────────────────────────────

export class SoundUploadError extends Error {
  readonly problem: UploadProblem
  constructor(problem: UploadProblem) {
    super(problem)
    this.problem = problem
  }
}

/**
 * Checks and keeps a sound file on this device: decoded here, at most 4 s, made mono at 22 kHz and brought down to the
 * built-in sounds' loudness. Only the decoded samples are kept, never the file. Throws SoundUploadError.
 */
export async function uploadCustomSound(file: File): Promise<CustomSound> {
  const problem = checkUploadFile(file)
  if (problem) throw new SoundUploadError(problem)
  let decoded: AudioBuffer
  try {
    const bytes = await file.arrayBuffer()
    const ctx = new OfflineAudioContext(1, 1, STORED_RATE)
    decoded = await ctx.decodeAudioData(bytes)
  } catch {
    throw new SoundUploadError('unreadable')
  }
  // Too long is refused before any more work; silence once it's mono.
  if (decoded.duration > MAX_SOUND_SECONDS + 0.05) throw new SoundUploadError('tooLong')
  // Mono at the kept rate (the offline context mixes channels down and resamples).
  const frames = Math.max(1, Math.ceil(decoded.duration * STORED_RATE))
  const offline = new OfflineAudioContext(1, frames, STORED_RATE)
  const source = offline.createBufferSource()
  source.buffer = decoded
  source.connect(offline.destination)
  source.start()
  const mono = (await offline.startRendering()).getChannelData(0)
  const checked = checkDecoded({ duration: decoded.duration, length: mono.length, peak: peakOf(mono) })
  if (checked) throw new SoundUploadError(checked)
  const custom: CustomSound = { name: file.name.slice(0, 80), seconds: Math.round(decoded.duration * 10) / 10, pcm: encodePcm(tame(mono)) }
  if (!write(CUSTOM_KEY, custom)) throw new SoundUploadError('tooBig')
  customSamples = null
  useSounds.setState({ custom })
  return custom
}

export function removeCustomSound(): void {
  write(CUSTOM_KEY, null)
  customSamples = null
  useSounds.setState({ custom: null })
}

// ── Sync (like streamer mode and the rail) ──────────────────────────────────

function keyNow(): Uint8Array | null {
  const identity = useApp.getState().identity
  return identity ? prefsKey(identity.account.secretKey) : null
}

async function pushTo(serverKey: string, prefs: SoundPrefs): Promise<void> {
  const key = keyNow()
  const connection = connectionFor(serverKey)
  if (!key || !connection?.isOnline || prefs.updatedAt === 0) return
  await connection.request('prefs.set', { name: PREF, data: sealPrefs(key, PREF, JSON.stringify(prefs)), updatedAt: prefs.updatedAt }).catch(() => undefined)
}

/** Reads the server's copy; takes it if newer, or sends ours if that is. */
async function syncWith(serverKey: string): Promise<void> {
  const connection = connectionFor(serverKey)
  const key = keyNow()
  if (!connection || !key) return
  try {
    const { data, updatedAt } = await connection.request('prefs.get', { name: PREF })
    const local = useSounds.getState().prefs
    const opened = data ? openPrefs(key, PREF, data) : null
    if (data && opened === null && updatedAt !== null && local.updatedAt > 0) {
      // Sealed under an earlier account key: seal ours again under the current one.
      const resealed = { ...local, updatedAt: Math.max(local.updatedAt, updatedAt + 1) }
      keep(resealed)
      await pushTo(serverKey, resealed)
    } else if (opened !== null && updatedAt !== null && updatedAt > local.updatedAt) {
      const remote = parseSoundPrefs(JSON.parse(opened))
      if (remote) keep(remote)
    } else if ((updatedAt ?? 0) < local.updatedAt) {
      await pushTo(serverKey, local)
    }
  } catch {
    /* an older server, or offline: the local copy still works */
  }
}

onWelcomeHook((serverKey) => void syncWith(serverKey))
onServerEvent((serverKey, type, body) => {
  if (type === 'prefs.updated' && (body as { name: string }).name === PREF) void syncWith(serverKey)
})
