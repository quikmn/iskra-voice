// GIFs through each server's proxy: whether a server has them on, searching, sending, and favourites (on this device).
import { create } from 'zustand'
import type { Events, GifCategory, GifResult, Message } from '../core/protocol'
import { connectionFor, onServerEvent, onWelcomeHook, sendMessage, type SendOptions } from './store'

interface GifState {
  /** Per server: GIFs on (true), off (false), or unknown/older server (missing). */
  enabled: Record<string, boolean>
  /** Per server, newest first. Tokens are signed by that server, so favourites are kept per server. */
  favourites: Record<string, GifResult[]>
}

const FAVOURITES_KEY = 'iskra.gifFavourites'
export const MAX_FAVOURITES = 100

function loadFavourites(): Record<string, GifResult[]> {
  try {
    const raw = JSON.parse(localStorage.getItem(FAVOURITES_KEY) ?? '{}') as Record<string, GifResult[]>
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

export const useGifs = create<GifState>(() => ({ enabled: {}, favourites: loadFavourites() }))

onWelcomeHook((serverKey) => {
  connectionFor(serverKey)?.request('gif.status', {})
    .then(({ enabled }) => useGifs.setState((s) => ({ enabled: { ...s.enabled, [serverKey]: enabled } })))
    .catch(() => useGifs.setState((s) => ({ enabled: { ...s.enabled, [serverKey]: false } }))) // older servers
})

onServerEvent((serverKey, type, body) => {
  if (type !== 'gif.status') return
  const { enabled } = body as Events['gif.status']
  useGifs.setState((s) => ({ enabled: { ...s.enabled, [serverKey]: enabled } }))
})

const request = (serverKey: string) => {
  const connection = connectionFor(serverKey)
  if (!connection?.isOnline) throw new Error('Not connected.')
  return connection
}

export const trendingGifs = (serverKey: string, page = 1) => request(serverKey).request('gif.trending', { page })
export const searchGifs = (serverKey: string, q: string, page = 1) => request(serverKey).request('gif.search', { q, page })
export const gifCategories = (serverKey: string): Promise<GifCategory[]> =>
  request(serverKey).request('gif.categories', {}).then((r) => r.categories)
export const configureGifs = (serverKey: string, key: string) => request(serverKey).request('gif.configure', { key })

export function sendGif(serverKey: string, channelId: number, gif: GifResult, options: Pick<SendOptions, 'replyTo'> = {}): Promise<void> {
  const shown: NonNullable<Message['gif']> = { provider: 'klipy', id: gif.id, title: gif.title, width: gif.width, height: gif.height, url: gif.url, preview: gif.preview }
  return sendMessage(serverKey, channelId, '', { ...options, gif: { token: gif.token, shown } })
}

// ── Favourites ──────────────────────────────────────────────────────────────

export const isFavourite = (favourites: GifResult[] | undefined, gif: GifResult) => !!favourites?.some((f) => f.id === gif.id)

export function toggleFavourite(serverKey: string, gif: GifResult): void {
  useGifs.setState((s) => {
    const list = s.favourites[serverKey] ?? []
    const next = isFavourite(list, gif) ? list.filter((f) => f.id !== gif.id) : [gif, ...list].slice(0, MAX_FAVOURITES)
    const favourites = { ...s.favourites, [serverKey]: next }
    try {
      localStorage.setItem(FAVOURITES_KEY, JSON.stringify(favourites))
    } catch {
      /* private mode */
    }
    return { favourites }
  })
}
