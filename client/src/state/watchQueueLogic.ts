// Pure helpers for the listen-together queue: how items are named and shown, and where a moved item lands (unit-tested).
import type { WatchItem, WatchSource } from '../core/protocol'

const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|flac|wav|weba)(\?|#|$)/i

/** Sounds like music or a podcast rather than a video (by the link's or file's name); YouTube counts as video. */
export function isAudioish(source: Pick<WatchSource, 'kind' | 'url' | 'title'>): boolean {
  if (source.kind === 'youtube') return false
  return AUDIO_EXT.test(source.url ?? '') || AUDIO_EXT.test(source.title ?? '')
}

/** The item's title, else the file's name from its link, else a word for its kind. */
export function itemTitle(source: Pick<WatchSource, 'kind' | 'url' | 'title'>, fallback: { youtube: string; video: string }): string {
  if (source.title) return source.title
  if (source.kind === 'youtube') return fallback.youtube
  const name = (source.url ?? '').split('?')[0].split('#')[0].split('/').pop() ?? ''
  const decoded = (() => {
    try {
      return decodeURIComponent(name)
    } catch {
      return name
    }
  })()
  return decoded.trim() || fallback.video
}

/** One string per source, so a player remounts when the party moves on to something else. */
export const sourceKey = (source: Pick<WatchSource, 'kind' | 'url' | 'videoId'>) => `${source.kind}:${source.videoId ?? source.url ?? ''}`

/** YouTube's still for a video (loaded only once this viewer has agreed to load from YouTube anyway). */
export const youTubeThumb = (videoId: string) => `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/mqdefault.jpg`

/**
 * Where an item goes when stepped up or down: the `before` the server wants (null = last), or null when it's already
 * at that end (nothing to do).
 */
export function moveTarget(queue: readonly Pick<WatchItem, 'id'>[], itemId: string, direction: -1 | 1): { before: string | null } | null {
  const at = queue.findIndex((i) => i.id === itemId)
  if (at < 0) return null
  if (direction === -1) return at === 0 ? null : { before: queue[at - 1].id }
  if (at >= queue.length - 1) return null
  return { before: queue[at + 2]?.id ?? null }
}
