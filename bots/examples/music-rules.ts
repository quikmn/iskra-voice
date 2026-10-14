// What the Music bot plays, who may control it and how its card looks; kept apart from the bot so it can be tested
// without a server. Music plays files people upload to the server (and DM it), plus the operator's own folder and
// radio streams. Never an address someone types, unless it's a file on this same server.
import type { AudioInput, Card, ComponentRow, FileInfo, Member } from '../sdk/src/index'

export type Control =
  | { kind: 'everyone' }
  | { kind: 'level'; level: 'trusted' | 'admin' }
  | { kind: 'role'; id: number; name: string }

export interface MusicSettings {
  /** Who may pause, skip other people's songs, stop, change the volume and clear the queue. */
  control: Control
  /** 0 to 2 (1 = as recorded). */
  volume: number
}

export const DEFAULT_SETTINGS: MusicSettings = { control: { kind: 'everyone' }, volume: 1 }

export interface QueuedTrack {
  title: string
  source: AudioInput
  /** Who added it (account key) and their name. */
  by: string
  byName: string
  from: 'upload' | 'dm' | 'library' | 'station'
}

export const MAX_QUEUE = 100
export const MAX_PER_PERSON = 25
const RANKS = ['guest', 'member', 'trusted', 'admin', 'owner']

/** Reads settings from JSON (a file the bot keeps), falling back to the defaults for anything odd. */
export function readSettings(raw: unknown): MusicSettings {
  const value = (raw ?? {}) as Partial<MusicSettings>
  const c = value.control as Control | undefined
  const control: Control = c?.kind === 'level' && (c.level === 'trusted' || c.level === 'admin') ? { kind: 'level', level: c.level }
    : c?.kind === 'role' && Number.isSafeInteger(c.id) && typeof c.name === 'string' ? { kind: 'role', id: c.id, name: c.name.slice(0, 100) }
    : { kind: 'everyone' }
  const volume = typeof value.volume === 'number' && value.volume >= 0 && value.volume <= 2 ? value.volume : 1
  return { control, volume }
}

/**
 * Whether someone may control the music. Admins and the owner always may; anyone may skip or remove a song they added
 * themselves (`own`).
 */
export function canControl(settings: MusicSettings, member: Pick<Member, 'role' | 'roles'> | undefined, own = false): boolean {
  if (own) return true
  if (!member) return false
  if (RANKS.indexOf(member.role) >= RANKS.indexOf('admin')) return true
  const c = settings.control
  if (c.kind === 'everyone') return true
  if (c.kind === 'level') return RANKS.indexOf(member.role) >= RANKS.indexOf(c.level)
  return (member.roles ?? []).includes(c.id)
}

export function controlText(control: Control): string {
  if (control.kind === 'everyone') return 'everyone listening'
  if (control.kind === 'level') return control.level === 'admin' ? 'admins' : 'trusted members and up'
  return `people with the ${control.name} role (and admins)`
}

/** A link to a file on this server (`/files/<id>/<name>`, or the full address), as a path; null for anything else. */
export function serverFileLink(text: string, serverUrl: string): string | null {
  let value = text.trim().replace(/^<(.*)>$/u, '$1')
  const origin = serverUrl.replace(/\/+$/u, '')
  if (/^https?:\/\//iu.test(value)) {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      return null
    }
    if (url.origin.toLowerCase() !== new URL(origin).origin.toLowerCase()) return null
    value = url.pathname
  }
  return /^\/files\/[A-Za-z0-9_-]{1,64}\/[^/?#\s]{1,200}$/u.test(value) ? value : null
}

const AUDIO_NAME = /\.(mp3|ogg|oga|opus|flac|wav)$/iu

/** An attachment that looks like audio (the player checks the bytes anyway). */
export function isAudio(file: Pick<FileInfo, 'name' | 'type'>): boolean {
  return /^audio\//iu.test(file.type) || file.type === 'application/ogg' || AUDIO_NAME.test(file.name)
}

/** A song's title from its file name: no extension, no spoiler mark, underscores as spaces. */
export function titleOf(name: string): string {
  let base = name
  try {
    base = decodeURIComponent(name)
  } catch {
    /* not encoded */
  }
  return base.replace(/^SPOILER_/u, '').replace(AUDIO_NAME, '').replace(/_/gu, ' ').trim().slice(0, 100) || 'a song'
}

/** "/volume 150" or "150%": a percentage from 0 to 200, as 0 to 2. */
export function parseVolume(value: string | number): number | null {
  const n = typeof value === 'number' ? value : Number(String(value).trim().replace(/%$/u, ''))
  return Number.isFinite(n) && n >= 0 && n <= 200 ? Math.round(n) / 100 : null
}

/** The songs to play, in order, with the one playing now. */
export class MusicQueue {
  private tracks: QueuedTrack[] = []
  private at = -1

  get current(): QueuedTrack | undefined {
    return this.tracks[this.at]
  }

  get upcoming(): QueuedTrack[] {
    return this.tracks.slice(this.at + 1)
  }

  /** Adds songs at the end. Returns how many fit (the queue holds 100, and 25 per person). */
  add(...tracks: QueuedTrack[]): number {
    let added = 0
    for (const track of tracks) {
      const theirs = this.upcoming.filter((t) => t.by === track.by).length
      if (this.upcoming.length >= MAX_QUEUE || theirs >= MAX_PER_PERSON) break
      this.tracks.push(track)
      added++
    }
    // Forget what's long gone, so the list doesn't grow forever.
    if (this.at > 50) {
      this.tracks = this.tracks.slice(this.at)
      this.at = 0
    }
    return added
  }

  /** Moves on to the next song (undefined when there's none). */
  next(): QueuedTrack | undefined {
    if (this.at < this.tracks.length) this.at++
    return this.current
  }

  /** Takes song `position` (1 = the next one) out of what's coming. */
  remove(position: number): QueuedTrack | null {
    const index = this.at + position
    if (!Number.isSafeInteger(position) || position < 1 || index >= this.tracks.length) return null
    return this.tracks.splice(index, 1)[0]
  }

  /** Empties what's coming (the song playing now goes on). */
  clear(): number {
    const count = this.upcoming.length
    this.tracks = this.tracks.slice(0, this.at + 1)
    return count
  }

  /** Forgets everything. */
  reset(): void {
    this.tracks = []
    this.at = -1
  }

  listing(): string {
    const now = this.current
    const next = this.upcoming
    if (!now && next.length === 0) return 'The queue is empty. Attach a song and mention me, or `/play` a song.'
    const lines = now ? [`▶ **${now.title}** (${now.byName})`] : []
    lines.push(...next.slice(0, 20).map((t, i) => `${i + 1}. ${t.title} (${t.byName})`))
    if (next.length > 20) lines.push(`…and ${next.length - 20} more`)
    return lines.join('\n')
  }
}

/** The "Now playing" card and its buttons. */
export function nowPlaying(track: QueuedTrack, next: QueuedTrack | undefined, paused: boolean, volume: number): { text: string; cards: Card[]; components: ComponentRow[] } {
  return {
    text: '',
    cards: [{
      title: paused ? '⏸ Paused' : '🎵 Now playing',
      description: `**${track.title}**${track.from === 'station' ? ' (radio)' : ''}`,
      color: 0x7c5cff,
      fields: [
        { name: 'Added by', value: track.byName, inline: true },
        { name: 'Up next', value: next ? next.title : 'Nothing yet', inline: true },
        { name: 'Volume', value: `${Math.round(volume * 100)} %`, inline: true },
      ],
    }],
    components: [{
      type: 'row',
      items: [
        { type: 'button', customId: paused ? 'music:resume' : 'music:pause', label: paused ? 'Resume' : 'Pause', style: 'primary' },
        { type: 'button', customId: 'music:skip', label: 'Skip', style: 'secondary' },
        { type: 'button', customId: 'music:stop', label: 'Stop', style: 'danger' },
        { type: 'button', customId: 'music:quieter', label: '🔉', style: 'secondary', disabled: volume <= 0 },
        { type: 'button', customId: 'music:louder', label: '🔊', style: 'secondary', disabled: volume >= 2 },
      ],
    }],
  }
}

/** The card once the music stopped (no buttons). */
export function stopped(reason: string): { text: string; cards: Card[]; components: ComponentRow[] } {
  return { text: '', cards: [{ title: '⏹ Stopped', description: reason, color: 0x7c5cff }], components: [] }
}
