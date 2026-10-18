// Favorite channels (state/favoritesLogic.ts). The list lives on this device and follows the account, sealed, through
// every server (prefs "favorites", same path as the alerts), so servers can't read which channels you starred.
import { create } from 'zustand'
import { openPrefs, prefsKey, sealPrefs } from '../core/prefs'
import { addFavorite, dropFavorite, emptyFavorites, isFavorite, moveFavorite, parseFavorites, removeFavorite, type Favorite, type FavoriteSettings } from './favoritesLogic'
import { connectionFor, onServerEvent, onWelcomeHook, useApp } from './store'

const STORAGE_KEY = 'iskra.favorites'
const PREF = 'favorites'

function load(): FavoriteSettings {
  try {
    return parseFavorites(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')) ?? emptyFavorites()
  } catch {
    return emptyFavorites()
  }
}

export const useFavorites = create<{ settings: FavoriteSettings }>(() => ({ settings: load() }))

function keep(settings: FavoriteSettings): void {
  useFavorites.setState({ settings })
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    /* private mode */
  }
}

function change(items: Favorite[]): void {
  const current = useFavorites.getState().settings
  const settings: FavoriteSettings = { v: 1, items, updatedAt: Math.max(Date.now(), current.updatedAt + 1) }
  keep(settings)
  for (const key of useApp.getState().order) void sealTo(key, settings)
}

export const useIsFavorite = (server: string, channel: number): boolean =>
  useFavorites((s) => isFavorite(s.settings.items, { server, channel }))

/** Stars or unstars. False if a new star couldn't be added (the list is full). */
export function setFavorite(fav: Favorite, on: boolean): boolean {
  const { items } = useFavorites.getState().settings
  if (!on && !isFavorite(items, fav)) return true
  const next = on ? addFavorite(items, fav) : removeFavorite(items, fav)
  if (!next) return isFavorite(items, fav)
  change(next)
  return true
}

export function stepFavorite(fav: Favorite, direction: -1 | 1): void {
  const { items } = useFavorites.getState().settings
  const next = moveFavorite(items, fav, direction)
  if (next !== items) change(next)
}

export function dropFavoriteBefore(fav: Favorite, before: Favorite | null): void {
  const { items } = useFavorites.getState().settings
  const next = dropFavorite(items, fav, before)
  if (next !== items) change(next)
}

// ── Sync across devices (sealed) ────────────────────────────────────────────

function keyNow(): Uint8Array | null {
  const identity = useApp.getState().identity
  return identity ? prefsKey(identity.account.secretKey) : null
}

async function sealTo(serverKey: string, settings: FavoriteSettings): Promise<void> {
  const key = keyNow()
  const connection = connectionFor(serverKey)
  if (!key || !connection?.isOnline || settings.updatedAt === 0) return
  await connection.request('prefs.set', { name: PREF, data: sealPrefs(key, PREF, JSON.stringify(settings)), updatedAt: settings.updatedAt }).catch(() => undefined)
}

async function syncWith(serverKey: string): Promise<void> {
  const connection = connectionFor(serverKey)
  const key = keyNow()
  if (!connection || !key) return
  try {
    const { data, updatedAt } = await connection.request('prefs.get', { name: PREF })
    const local = useFavorites.getState().settings
    const opened = data ? openPrefs(key, PREF, data) : null
    if (opened !== null && updatedAt !== null && updatedAt > local.updatedAt) {
      const remote = parseFavorites(JSON.parse(opened))
      if (remote) keep({ ...remote, updatedAt })
    } else if ((updatedAt ?? 0) < local.updatedAt || (data && opened === null)) {
      await sealTo(serverKey, local)
    }
  } catch {
    /* an older server without prefs, or offline: the local copy still works */
  }
}

onWelcomeHook((serverKey) => void syncWith(serverKey))

onServerEvent((serverKey, type, body) => {
  if (type === 'prefs.updated' && (body as { name: string }).name === PREF) void syncWith(serverKey)
})
