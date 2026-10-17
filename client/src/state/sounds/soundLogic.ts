// Pure rules for notification sounds (unit-tested; no audio, React or sockets here): the built-in set, the synced
// choices (yours, per server, per channel) and which one plays, and the checks an uploaded sound must pass.

export const BUILTIN_SOUNDS = ['classic', 'chime', 'pop', 'bell', 'droplet', 'marimba'] as const
export type BuiltinSound = (typeof BUILTIN_SOUNDS)[number]
/** `custom`: your own uploaded sound (this device only); `none`: silent. */
export type SoundId = BuiltinSound | 'custom' | 'none'
export const SOUND_IDS: readonly SoundId[] = [...BUILTIN_SOUNDS, 'custom', 'none']

/** What a sound is for: channel messages, mentions (and replies, alert words), direct messages. */
export type SoundKind = 'message' | 'mention' | 'dm'
export const SOUND_KINDS: readonly SoundKind[] = ['message', 'mention', 'dm']

/** The synced choices (newest copy wins across devices). Overrides cover every sound in that place. */
export interface SoundPrefs {
  message: SoundId
  mention: SoundId
  dm: SoundId
  /** By server key. */
  servers: Record<string, SoundId>
  /** By `serverKey:channelId`. */
  channels: Record<string, SoundId>
  updatedAt: number
}

/** Room left in the 16 KB synced setting: the oldest overrides go first past these. */
export const MAX_SERVER_OVERRIDES = 50
export const MAX_CHANNEL_OVERRIDES = 120

export const emptySoundPrefs = (): SoundPrefs => ({ message: 'classic', mention: 'classic', dm: 'classic', servers: {}, channels: {}, updatedAt: 0 })

export const isSoundId = (v: unknown): v is SoundId => typeof v === 'string' && (SOUND_IDS as readonly string[]).includes(v)

export const channelPlace = (serverKey: string, channelId: number) => `${serverKey}:${channelId}`

const KEY = /^[A-Za-z0-9_-]{1,64}$/
const CHANNEL_KEY = /^[A-Za-z0-9_-]{1,64}:\d{1,16}$/

function overrides(raw: unknown, pattern: RegExp, max: number): Record<string, SoundId> {
  const out: Record<string, SoundId> = {}
  if (!raw || typeof raw !== 'object') return out
  const entries = Object.entries(raw as Record<string, unknown>).filter(([k, v]) => pattern.test(k) && isSoundId(v)) as [string, SoundId][]
  for (const [k, v] of entries.slice(-max)) out[k] = v
  return out
}

/** A saved or synced copy, or null when it isn't one. Unknown sounds fall back to Classic; bad overrides are dropped. */
export function parseSoundPrefs(raw: unknown): SoundPrefs | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.updatedAt !== 'number' || !Number.isFinite(r.updatedAt) || r.updatedAt < 0) return null
  const pick = (v: unknown): SoundId => (isSoundId(v) ? v : 'classic')
  return {
    message: pick(r.message), mention: pick(r.mention), dm: pick(r.dm),
    servers: overrides(r.servers, KEY, MAX_SERVER_OVERRIDES),
    channels: overrides(r.channels, CHANNEL_KEY, MAX_CHANNEL_OVERRIDES),
    updatedAt: r.updatedAt,
  }
}

/** Where a sound plays: a channel (or a server-wide notice with no channel), or a DM (no server). */
export interface SoundPlace {
  serverKey?: string | null
  channelId?: number | null
}

/** Which sound plays: the channel's choice, then the server's, then yours for this kind. DMs only follow yours. */
export function resolveSound(prefs: SoundPrefs, kind: SoundKind, place: SoundPlace = {}): SoundId {
  const { serverKey, channelId } = place
  if (kind !== 'dm' && serverKey) {
    if (channelId != null) {
      const channel = prefs.channels[channelPlace(serverKey, channelId)]
      if (channel) return channel
    }
    const server = prefs.servers[serverKey]
    if (server) return server
  }
  return prefs[kind]
}

/** What actually plays here: your own sound only where this device has one (others play Classic). */
export const playable = (id: SoundId, hasCustom: boolean): Exclude<SoundId, 'custom'> | 'custom' =>
  id === 'custom' && !hasCustom ? 'classic' : id

/** Sets (or with `null`, removes) an override; the newest stays when there are too many. */
export function withOverride(prefs: SoundPrefs, place: { serverKey: string; channelId?: number | null }, id: SoundId | null, now: number): SoundPrefs {
  const channel = place.channelId != null
  const key = channel ? channelPlace(place.serverKey, place.channelId!) : place.serverKey
  const current = { ...(channel ? prefs.channels : prefs.servers) }
  delete current[key]
  if (id) current[key] = id
  const max = channel ? MAX_CHANNEL_OVERRIDES : MAX_SERVER_OVERRIDES
  const trimmed = Object.fromEntries(Object.entries(current).slice(-max))
  const updatedAt = Math.max(now, prefs.updatedAt + 1)
  return channel ? { ...prefs, channels: trimmed, updatedAt } : { ...prefs, servers: trimmed, updatedAt }
}

export function withDefault(prefs: SoundPrefs, kind: SoundKind, id: SoundId, now: number): SoundPrefs {
  return { ...prefs, [kind]: id, updatedAt: Math.max(now, prefs.updatedAt + 1) }
}

/** The override set for exactly this place (not inherited), or null. */
export function overrideAt(prefs: SoundPrefs, serverKey: string, channelId: number | null): SoundId | null {
  return (channelId == null ? prefs.servers[serverKey] : prefs.channels[channelPlace(serverKey, channelId)]) ?? null
}

// ── Your own sound ──────────────────────────────────────────────────────────

/** The file you pick: up to 1 MB. */
export const MAX_UPLOAD_BYTES = 1024 * 1024
/** Notification sounds are short: up to 4 seconds. */
export const MAX_SOUND_SECONDS = 4
/** What's kept on the device: mono, 16-bit, at this rate (4 s is about 170 KB). */
export const STORED_RATE = 22_050

const AUDIO_EXT = /\.(mp3|ogg|oga|opus|wav|m4a|aac|webm|flac)$/i

export type UploadProblem = 'notAudio' | 'tooBig' | 'tooLong' | 'empty' | 'unreadable'

/** Before decoding: an audio file of a sensible size. */
export function checkUploadFile(file: { name: string; size: number; type: string }): UploadProblem | null {
  const vague = file.type === '' || file.type === 'application/octet-stream' || file.type === 'video/webm'
  if (!(file.type.startsWith('audio/') || (vague && AUDIO_EXT.test(file.name)))) return 'notAudio'
  if (file.size <= 0) return 'empty'
  if (file.size > MAX_UPLOAD_BYTES) return 'tooBig'
  return null
}

/** After decoding: short, and not silence. */
export function checkDecoded(audio: { duration: number; length: number; peak: number }): UploadProblem | null {
  if (!Number.isFinite(audio.duration) || audio.length === 0) return 'unreadable'
  if (audio.duration > MAX_SOUND_SECONDS + 0.05) return 'tooLong'
  if (audio.duration < 0.02 || audio.peak < 0.001) return 'empty'
  return null
}

/** The loudest sample (absolute). */
export function peakOf(samples: Float32Array): number {
  let peak = 0
  for (const s of samples) {
    const a = Math.abs(s)
    if (a > peak) peak = a
  }
  return peak
}

/** Loud uploads come down to the built-in sounds' level; quiet ones stay as they are. */
export function tame(samples: Float32Array, maxPeak = 0.5): Float32Array {
  const peak = peakOf(samples)
  if (peak <= maxPeak) return samples
  const scale = maxPeak / peak
  return samples.map((s) => s * scale)
}

/** Float samples to 16-bit PCM in base64 (how your sound is kept). */
export function encodePcm(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2)
  const view = new DataView(bytes.buffer)
  samples.forEach((s, i) => view.setInt16(i * 2, Math.round(Math.max(-1, Math.min(1, s)) * 32767), true))
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/** Back to float samples; null for anything that isn't a kept sound. */
export function decodePcm(data: string): Float32Array | null {
  try {
    const binary = atob(data)
    if (binary.length % 2 !== 0 || binary.length > MAX_SOUND_SECONDS * STORED_RATE * 2 + 4096) return null
    const view = new DataView(Uint8Array.from(binary, (c) => c.charCodeAt(0)).buffer)
    const out = new Float32Array(binary.length / 2)
    for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 32767
    return out
  } catch {
    return null
  }
}

/** The kept sound with its name (shown in settings). */
export interface CustomSound {
  name: string
  seconds: number
  pcm: string
}

export function parseCustomSound(raw: unknown): CustomSound | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.name !== 'string' || typeof r.seconds !== 'number' || typeof r.pcm !== 'string') return null
  if (r.seconds <= 0 || r.seconds > MAX_SOUND_SECONDS + 0.05 || decodePcm(r.pcm) === null) return null
  return { name: r.name.slice(0, 80), seconds: r.seconds, pcm: r.pcm }
}
