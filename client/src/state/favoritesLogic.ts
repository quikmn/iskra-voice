// Favorite channels: a short list of (server, channel) pairs you starred, in your order. Pure rules; state/favorites.ts
// keeps the list and syncs it (sealed, like the alerts) across your devices.

export const MAX_FAVORITES = 50
const KEY = /^[A-Za-z0-9_-]{1,64}$/

export interface Favorite {
  /** The server's key (state/store.ts). */
  server: string
  channel: number
}

export interface FavoriteSettings {
  v: 1
  updatedAt: number
  items: Favorite[]
}

export const emptyFavorites = (): FavoriteSettings => ({ v: 1, updatedAt: 0, items: [] })

export const sameFavorite = (a: Favorite, b: Favorite): boolean => a.server === b.server && a.channel === b.channel

export const isFavorite = (items: Favorite[], fav: Favorite): boolean => items.some((f) => sameFavorite(f, fav))

/** Checks a stored or synced copy; malformed entries are dropped (null if the whole thing isn't ours). */
export function parseFavorites(raw: unknown): FavoriteSettings | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (r.v !== 1 || !Number.isSafeInteger(r.updatedAt) || (r.updatedAt as number) < 0 || !Array.isArray(r.items)) return null
  const items: Favorite[] = []
  for (const item of r.items) {
    if (typeof item !== 'object' || item === null) continue
    const { server, channel } = item as Record<string, unknown>
    if (typeof server !== 'string' || !KEY.test(server) || !Number.isSafeInteger(channel) || (channel as number) < 1) continue
    const fav = { server, channel: channel as number }
    if (!isFavorite(items, fav) && items.length < MAX_FAVORITES) items.push(fav)
  }
  return { v: 1, updatedAt: r.updatedAt as number, items }
}

/** Adds to the end, or null if it's there already or the list is full. */
export function addFavorite(items: Favorite[], fav: Favorite): Favorite[] | null {
  if (isFavorite(items, fav) || items.length >= MAX_FAVORITES) return null
  return [...items, fav]
}

export const removeFavorite = (items: Favorite[], fav: Favorite): Favorite[] => items.filter((f) => !sameFavorite(f, fav))

/** One step up (-1) or down (1); the same list when it can't move. */
export function moveFavorite(items: Favorite[], fav: Favorite, direction: -1 | 1): Favorite[] {
  const at = items.findIndex((f) => sameFavorite(f, fav))
  const to = at + direction
  if (at < 0 || to < 0 || to >= items.length) return items
  const out = items.slice()
  const moved = out[at]
  out[at] = out[to]
  out[to] = moved
  return out
}

/** Moves `fav` to where `before` is (drag and drop); without `before`, to the end. */
export function dropFavorite(items: Favorite[], fav: Favorite, before: Favorite | null): Favorite[] {
  if (!isFavorite(items, fav) || (before && sameFavorite(fav, before))) return items
  const rest = removeFavorite(items, fav)
  const at = before ? rest.findIndex((f) => sameFavorite(f, before)) : rest.length
  rest.splice(at < 0 ? rest.length : at, 0, fav)
  return rest
}

/**
 * The favorites you can open now, in order. A channel that is gone, or that you can no longer see, drops out of the
 * list but stays stored (a server still connecting has no channels yet), so it returns if you get access again.
 */
export function visibleFavorites<S extends { channels: { id: number }[] }>(
  items: Favorite[], servers: Record<string, S | undefined>,
): { fav: Favorite; server: S; channel: S['channels'][number] }[] {
  const out: { fav: Favorite; server: S; channel: S['channels'][number] }[] = []
  for (const fav of items) {
    const server = servers[fav.server]
    const channel = server?.channels.find((c) => c.id === fav.channel)
    if (server && channel) out.push({ fav, server, channel })
  }
  return out
}
