// What Jukebox plays and how its "Now playing" card looks; kept apart from the bot so it can be tested without a server.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, parse } from 'node:path'
import type { Card, ComponentRow } from '../sdk/src/index'

export interface Song {
  title: string
  /** A file in the music folder, or a stream address the operator put in stations.json. */
  source: string
  station: boolean
}

const AUDIO = new Set(['.mp3', '.ogg', '.oga', '.opus', '.flac', '.wav'])

/**
 * The music folder: audio files (sorted by name), plus the streams in its stations.json, if any:
 * `[{ "name": "Lo-fi radio", "url": "https://..." }]`. Only the operator chooses addresses; people pick by name.
 */
export function library(folder: string): Song[] {
  let names: string[]
  try {
    names = readdirSync(folder)
  } catch {
    return []
  }
  const songs: Song[] = names
    .filter((n) => AUDIO.has(extname(n).toLowerCase()) && statSync(join(folder, n)).isFile())
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((n) => ({ title: parse(n).name, source: join(folder, n), station: false }))
  try {
    const stations = JSON.parse(readFileSync(join(folder, 'stations.json'), 'utf8')) as { name?: unknown; url?: unknown }[]
    for (const s of Array.isArray(stations) ? stations : []) {
      if (typeof s.name === 'string' && typeof s.url === 'string' && /^https?:\/\//i.test(s.url))
        songs.push({ title: s.name.slice(0, 100), source: s.url, station: true })
    }
  } catch {
    /* no stations */
  }
  return songs
}

/** Where to start for "/play <query>": an exact title, else the first that contains it (ignoring case). -1: nothing. */
export function find(songs: Song[], query: string): number {
  const q = query.trim().toLowerCase()
  if (!q) return songs.length ? 0 : -1
  const exact = songs.findIndex((s) => s.title.toLowerCase() === q)
  return exact >= 0 ? exact : songs.findIndex((s) => s.title.toLowerCase().includes(q))
}

/** The card and buttons for the song playing now, with what's next. */
export function nowPlaying(song: Song, next: Song | undefined, paused: boolean): { text: string; cards: Card[]; components: ComponentRow[] } {
  return {
    text: '',
    cards: [{
      title: `${paused ? '⏸' : '🎵'} ${paused ? 'Paused' : 'Now playing'}`,
      description: `**${song.title}**${song.station ? ' (radio)' : ''}`,
      color: 0x7c5cff,
      fields: [{ name: 'Up next', value: next ? next.title : 'Nothing: the queue ends here', inline: true }],
    }],
    components: [{
      type: 'row',
      items: [
        { type: 'button', customId: paused ? 'jukebox:resume' : 'jukebox:pause', label: paused ? 'Resume' : 'Pause', style: 'primary' },
        { type: 'button', customId: 'jukebox:skip', label: 'Skip', style: 'secondary', disabled: !next },
        { type: 'button', customId: 'jukebox:stop', label: 'Stop', style: 'danger' },
      ],
    }],
  }
}

/** The card once the music stopped (no buttons). */
export function stopped(reason: string): { text: string; cards: Card[]; components: ComponentRow[] } {
  return { text: '', cards: [{ title: '⏹ Stopped', description: reason, color: 0x7c5cff }], components: [] }
}

/** "/songs": what's in the folder, as one message. */
export function listing(songs: Song[]): string {
  if (songs.length === 0) return 'The music folder is empty. Put MP3, Ogg, FLAC or WAV files in it.'
  const lines = songs.slice(0, 40).map((s, i) => `${i + 1}. ${s.title}${s.station ? ' (radio)' : ''}`)
  if (songs.length > 40) lines.push(`…and ${songs.length - 40} more`)
  return lines.join('\n')
}
