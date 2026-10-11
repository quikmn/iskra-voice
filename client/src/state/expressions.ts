// Polls, server emoji and the soundboard: per-server lists, live updates, and playing sounds.
import { create } from 'zustand'
import type { CustomEmoji, Events, FileInfo, Poll, Sound } from '../core/protocol'
import { connectionFor, onServerEvent, onWelcomeHook, uploadFile, useApp } from './store'
import { useVoice } from './voice'
import { useAudio } from './audio'

export interface SoundboardSettings {
  /** 0–1. */
  volume: number
  muted: boolean
}

export interface PlayedSound {
  key: number
  serverKey: string
  accountKey: string
  sound: Sound
}

interface ExpressionsState {
  emojis: Record<string, CustomEmoji[]>
  sounds: Record<string, Sound[]>
  settings: SoundboardSettings
  /** Recently played sounds, shown briefly as "Alice played …". */
  played: PlayedSound[]
}

const SETTINGS_KEY = 'iskra.soundboard'

function loadSettings(): SoundboardSettings {
  try {
    return { volume: 0.6, muted: false, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') }
  } catch {
    return { volume: 0.6, muted: false }
  }
}

export const useExpressions = create<ExpressionsState>(() => ({ emojis: {}, sounds: {}, settings: loadSettings(), played: [] }))

const EMPTY_EMOJI: CustomEmoji[] = []
const EMPTY_SOUNDS: Sound[] = []
export const useServerEmojis = (serverKey: string) => useExpressions((s) => s.emojis[serverKey] ?? EMPTY_EMOJI)
export const useServerSounds = (serverKey: string) => useExpressions((s) => s.sounds[serverKey] ?? EMPTY_SOUNDS)

export function updateSoundboardSettings(patch: Partial<SoundboardSettings>): void {
  const settings = { ...useExpressions.getState().settings, ...patch }
  useExpressions.setState({ settings })
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    /* private mode */
  }
}

/** Absolute URL of something the server serves (emoji images, sounds). */
export function serverFileUrl(serverKey: string, path: string | null): string | null {
  if (!path) return null
  const base = useApp.getState().servers[serverKey]?.url
  return base ? base + path : null
}

async function loadLists(serverKey: string): Promise<void> {
  const connection = connectionFor(serverKey)
  if (!connection) return
  const [emojis, sounds] = await Promise.all([
    connection.request('emoji.list', {}).then((r) => r.emojis).catch(() => null),
    connection.request('sound.list', {}).then((r) => r.sounds).catch(() => null),
  ])
  useExpressions.setState((s) => ({
    emojis: emojis ? { ...s.emojis, [serverKey]: emojis } : s.emojis,
    sounds: sounds ? { ...s.sounds, [serverKey]: sounds } : s.sounds,
  }))
}

function patchPoll(serverKey: string, channelId: number, id: number, poll: Poll): void {
  useApp.setState((state) => {
    const server = state.servers[serverKey]
    const list = server?.messages[channelId]
    if (!server || !list) return state
    const messages = list.map((m) => (m.id === id && !m.tempId ? { ...m, poll } : m))
    return { servers: { ...state.servers, [serverKey]: { ...server, messages: { ...server.messages, [channelId]: messages } } } }
  })
}

let playedCounter = 0

function onSoundPlayed(serverKey: string, { channelId, accountKey, sound }: Events['sound.played']): void {
  const voice = useVoice.getState()
  // Only for the call you're in on this device (another device of yours may be the one in voice).
  if (voice.session?.serverKey !== serverKey || voice.session.channelId !== channelId) return
  const key = ++playedCounter
  useExpressions.setState((s) => ({ played: [...s.played.slice(-2), { key, serverKey, accountKey, sound }] }))
  setTimeout(() => useExpressions.setState((s) => ({ played: s.played.filter((p) => p.key !== key) })), 3500)

  const { settings } = useExpressions.getState()
  const url = serverFileUrl(serverKey, sound.url)
  if (settings.muted || voice.deafened || !url || settings.volume <= 0) return
  playUrl(url, settings.volume)
}

/** Sounds playing right now (any length), so they can be stopped. */
const playing = new Set<HTMLAudioElement>()
/** How many sounds are playing; the soundboard shows "Stop sounds" while any are. */
export const useSoundsPlaying = create<{ count: number }>(() => ({ count: 0 }))
const playingChanged = () => useSoundsPlaying.setState({ count: playing.size })

function finish(audio: HTMLAudioElement) {
  if (!playing.delete(audio)) return
  audio.pause()
  audio.removeAttribute('src')
  playingChanged()
}

/** Stops every soundboard sound and preview playing for you. */
export function stopSounds(): void {
  for (const audio of [...playing]) finish(audio)
}

/** Plays a sound locally (a received soundboard sound, or a preview) to its end, or until stopped. */
export function playUrl(url: string, volume = useExpressions.getState().settings.volume): void {
  try {
    const audio = new Audio(url)
    audio.volume = Math.min(1, Math.max(0, volume))
    const sink = useAudio.getState().outputDevice
    if (sink && 'setSinkId' in audio) void audio.setSinkId(sink).catch(() => undefined)
    audio.onended = audio.onerror = () => finish(audio)
    playing.add(audio)
    playingChanged()
    void audio.play().catch(() => finish(audio))
  } catch {
    /* no audio support */
  }
}

onServerEvent((serverKey, type, body) => {
  switch (type) {
    case 'poll.updated': {
      const { id, channelId, poll } = body as Events['poll.updated']
      patchPoll(serverKey, channelId, id, poll)
      return
    }
    case 'emoji.updated': {
      const { emojis } = body as Events['emoji.updated']
      useExpressions.setState((s) => ({ emojis: { ...s.emojis, [serverKey]: emojis } }))
      return
    }
    case 'sounds.updated': {
      const { sounds } = body as Events['sounds.updated']
      useExpressions.setState((s) => ({ sounds: { ...s.sounds, [serverKey]: sounds } }))
      return
    }
    case 'sound.played':
      onSoundPlayed(serverKey, body as Events['sound.played'])
      return
  }
})

onWelcomeHook((serverKey) => void loadLists(serverKey))

// ── Actions ─────────────────────────────────────────────────────────────────

function connection(serverKey: string) {
  const c = connectionFor(serverKey)
  if (!c) throw new Error('Not connected.')
  return c
}

export async function createPoll(serverKey: string, channelId: number, poll: { question: string; options: string[]; multi: boolean; durationMs?: number }) {
  await connection(serverKey).request('poll.create', { channelId, ...poll })
}

export async function votePoll(serverKey: string, id: number, options: number[]) {
  await connection(serverKey).request('poll.vote', { id, options })
}

export async function endPoll(serverKey: string, id: number) {
  await connection(serverKey).request('poll.end', { id })
}

export async function playSound(serverKey: string, id: string) {
  await connection(serverKey).request('sound.play', { id })
}

export const EMOJI_MAX_BYTES = 256 * 1024
export const EMOJI_MAX_SIDE = 128

/** Fits a still image into 128×128 (PNG). GIFs keep their animation, so they must already be small enough. */
export async function prepareEmojiImage(file: File): Promise<File> {
  if (!/^image\/(png|gif|webp|jpeg)$/.test(file.type)) throw new Error('Emoji must be PNG, GIF or WebP images.')
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.src = url
    await image.decode().catch(() => {
      throw new Error("Couldn't read that image.")
    })
    const { naturalWidth: width, naturalHeight: height } = image
    if (file.type === 'image/gif') {
      if (width > EMOJI_MAX_SIDE || height > EMOJI_MAX_SIDE) throw new Error(`Animated emoji can be up to ${EMOJI_MAX_SIDE}×${EMOJI_MAX_SIDE} pixels.`)
      if (file.size > EMOJI_MAX_BYTES) throw new Error('Emoji can be up to 256 KB.')
      return file
    }
    if (file.type !== 'image/jpeg' && width <= EMOJI_MAX_SIDE && height <= EMOJI_MAX_SIDE && file.size <= EMOJI_MAX_BYTES) return file
    const scale = Math.min(1, EMOJI_MAX_SIDE / width, EMOJI_MAX_SIDE / height)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    const context = canvas.getContext('2d')!
    context.imageSmoothingQuality = 'high'
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error("Couldn't read that image.")
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.png', { type: 'image/png' })
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** An emoji name from a file name: "Party Parrot.gif" → "party_parrot". */
export function emojiNameFrom(fileName: string): string {
  const name = fileName.replace(/\.\w+$/, '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32)
  return name.length >= 2 ? name : 'emoji'
}

export async function addEmoji(serverKey: string, file: File, name: string): Promise<void> {
  const prepared = await prepareEmojiImage(file)
  const uploaded: FileInfo = await uploadFile(serverKey, prepared, () => undefined)
  await connection(serverKey).request('emoji.create', { name, fileId: uploaded.id })
}

export async function renameEmoji(serverKey: string, id: string, name: string) {
  await connection(serverKey).request('emoji.rename', { id, name })
}

export async function deleteEmoji(serverKey: string, id: string) {
  await connection(serverKey).request('emoji.delete', { id })
}

/** How long an audio file plays, from the browser's decoder (the server measures it again). */
export function audioDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const audio = new Audio()
    audio.preload = 'metadata'
    audio.onloadedmetadata = () => {
      URL.revokeObjectURL(url)
      resolve(audio.duration * 1000)
    }
    audio.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error("Couldn't read that sound. Try an MP3, Ogg or WAV file."))
    }
    audio.src = url
  })
}

export async function addSound(serverKey: string, file: File, name: string, emoji: string | null): Promise<void> {
  const uploaded = await uploadFile(serverKey, file, () => undefined)
  await connection(serverKey).request('sound.create', { name, emoji, fileId: uploaded.id })
}

export async function updateSound(serverKey: string, id: string, name: string, emoji: string | null) {
  await connection(serverKey).request('sound.update', { id, name, emoji })
}

export async function deleteSound(serverKey: string, id: string) {
  await connection(serverKey).request('sound.delete', { id })
}
