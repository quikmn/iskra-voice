// GIFs (KLIPY), per server: "through this server" (the default) asks the server, which proxies search and media, so
// this device never contacts KLIPY; in "direct" mode (an owner's choice) this device calls KLIPY with the server's key
// (KLIPY sees your address and searches). Favourites live on this device.
import { create } from 'zustand'
import { t } from '../i18n'
import { klipyUrl, parseKlipyCategories, parseKlipyPage, type KlipyGif } from '../core/klipy'
import type { Events, GifCategory, GifResult, GifStatus, Message } from '../core/protocol'
import { connectionFor, onServerEvent, onWelcomeHook, sendMessage, type SendOptions } from './store'

interface GifState {
  /** Per server; missing until known (older servers say nothing: off). */
  status: Record<string, GifStatus>
  /** Per server, newest first (tokens and addresses are per server). */
  favourites: Record<string, GifResult[]>
  /** Show direct-mode GIFs in messages without a click (each one then loads from KLIPY). */
  autoLoad: boolean
}

const FAVOURITES_KEY = 'iskra.gifFavourites'
const AUTO_KEY = 'iskra.gifAutoLoad'
export const MAX_FAVOURITES = 100

function loadJson<T>(key: string, fallback: T): T {
  try {
    return (JSON.parse(localStorage.getItem(key) ?? 'null') as T) ?? fallback
  } catch {
    return fallback
  }
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* private mode */
  }
}

export const useGifs = create<GifState>(() => ({ status: {}, favourites: loadJson(FAVOURITES_KEY, {}), autoLoad: loadJson<boolean>(AUTO_KEY, false) === true }))

export const useGifStatus = (serverKey: string) => useGifs((s) => s.status[serverKey])

export function setGifAutoLoad(on: boolean): void {
  useGifs.setState({ autoLoad: on })
  save(AUTO_KEY, on)
}

const setStatus = (serverKey: string, status: GifStatus) => useGifs.setState((s) => ({ status: { ...s.status, [serverKey]: status } }))

onWelcomeHook((serverKey) => {
  connectionFor(serverKey)?.request('gif.status', {})
    .then((status) => setStatus(serverKey, status))
    .catch(() => setStatus(serverKey, { enabled: false, provider: null })) // older servers
})

onServerEvent((serverKey, type, body) => {
  if (type === 'gif.status') setStatus(serverKey, body as Events['gif.status'])
})

const connection = (serverKey: string) => {
  const c = connectionFor(serverKey)
  if (!c?.isOnline) throw new Error(t('errors.codes.disconnected'))
  return c
}

const fromKlipy = (g: KlipyGif): GifResult => ({ ...g, token: '', direct: true })

/** Direct mode: straight to KLIPY (no cookies, no referrer). */
async function klipy(serverKey: string, kind: 'trending' | 'search' | 'categories', params: { q?: string; page?: number } = {}): Promise<unknown> {
  const status = useGifs.getState().status[serverKey]
  if (!status?.key) throw new Error(t('chat.gifs.off'))
  const response = await fetch(klipyUrl(kind, status.key, { ...params, customerId: status.customerId ?? undefined }), {
    credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store',
  }).catch(() => null)
  if (!response?.ok) throw new Error(t('chat.gifs.unreachable'))
  return response.json()
}

const direct = (serverKey: string) => useGifs.getState().status[serverKey]?.mode === 'direct'

export async function trendingGifs(serverKey: string, page = 1): Promise<{ gifs: GifResult[]; hasNext: boolean }> {
  if (!direct(serverKey)) return connection(serverKey).request('gif.trending', { page })
  const result = parseKlipyPage(await klipy(serverKey, 'trending', { page }))
  return { gifs: result.gifs.map(fromKlipy), hasNext: result.hasNext }
}

export async function searchGifs(serverKey: string, q: string, page = 1): Promise<{ gifs: GifResult[]; hasNext: boolean }> {
  if (!direct(serverKey)) return connection(serverKey).request('gif.search', { q, page })
  const result = parseKlipyPage(await klipy(serverKey, 'search', { q, page }))
  return { gifs: result.gifs.map(fromKlipy), hasNext: result.hasNext }
}

export async function gifCategories(serverKey: string): Promise<GifCategory[]> {
  if (!direct(serverKey)) return (await connection(serverKey).request('gif.categories', {})).categories
  return parseKlipyCategories(await klipy(serverKey, 'categories'))
}

export const configureGifs = (serverKey: string, change: { key?: string; mode?: 'direct' | 'proxy' }) =>
  connection(serverKey).request('gif.configure', change)

export function sendGif(serverKey: string, channelId: number, gif: GifResult, options: Pick<SendOptions, 'replyTo'> = {}): Promise<void> {
  const shown: NonNullable<Message['gif']> = {
    provider: 'klipy', id: gif.id, title: gif.title, width: gif.width, height: gif.height, url: gif.url, preview: gif.preview, direct: !!gif.direct,
  }
  const token = gif.direct
    ? { id: gif.id, title: gif.title, url: gif.url, preview: gif.preview, width: gif.width, height: gif.height }
    : gif.token
  return sendMessage(serverKey, channelId, '', { ...options, gif: { token, shown } })
}

// ── Favourites ──────────────────────────────────────────────────────────────

export const isFavourite = (favourites: GifResult[] | undefined, gif: GifResult) => !!favourites?.some((f) => f.id === gif.id)

export function toggleFavourite(serverKey: string, gif: GifResult): void {
  useGifs.setState((s) => {
    const list = s.favourites[serverKey] ?? []
    const next = isFavourite(list, gif) ? list.filter((f) => f.id !== gif.id) : [gif, ...list].slice(0, MAX_FAVOURITES)
    const favourites = { ...s.favourites, [serverKey]: next }
    save(FAVOURITES_KEY, favourites)
    return { favourites }
  })
}
