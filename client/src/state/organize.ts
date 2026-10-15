// Organizing a server: channel categories (and who's collapsed what, remembered on this device), notification
// levels and mutes (kept by the server for your account, so every device and push follow them), and nicknames.
import { create } from 'zustand'
import type { Category, Events, Member, NotifyDefault, NotifyLevel, NotifySetting } from '../core/protocol'
import { connectionFor, onChannelsGone, onServerEvent, onWelcomeHook, useApp } from './store'
import { knownThread } from './threads'
import { t } from '../i18n'
import { defaultLevel, effectiveNotify, nextMuteEnd, notifyKey, type EffectiveNotify, type NotifyMap } from './organizeLogic'

interface OrganizeState {
  categories: Record<string, Category[]>
  notify: Record<string, NotifyMap>
  /** serverKey → the server's default for people who chose nothing. */
  serverDefaults: Record<string, NotifyDefault>
  /** serverKey → collapsed category ids (this device only). */
  collapsed: Record<string, number[]>
  /** Bumped when a timed mute runs out, so badges and labels refresh. */
  clock: number
}

const COLLAPSED_KEY = 'iskra.collapsed'

function loadCollapsed(): Record<string, number[]> {
  try {
    const parsed = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '{}') as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, Array.isArray(v) ? v.filter(Number.isSafeInteger) : []]))
  } catch {
    return {}
  }
}

export const useOrganize = create<OrganizeState>(() => ({ categories: {}, notify: {}, serverDefaults: {}, collapsed: loadCollapsed(), clock: Date.now() }))

const toMap = (list: NotifySetting[]): NotifyMap => Object.fromEntries(list.map((s) => [notifyKey(s.channelId), s]))

let timer: ReturnType<typeof setTimeout> | null = null

/** Wakes up when the next timed mute ends. */
function scheduleMuteEnd(): void {
  if (timer) clearTimeout(timer)
  timer = null
  const now = Date.now()
  const next = nextMuteEnd(Object.values(useOrganize.getState().notify), now)
  if (next === null) return
  timer = setTimeout(() => {
    useOrganize.setState({ clock: Date.now() })
    scheduleMuteEnd()
  }, Math.min(next - now + 50, 2 ** 31 - 1))
}

function saveSetting(key: string, setting: NotifySetting): void {
  useOrganize.setState((s) => ({ notify: { ...s.notify, [key]: { ...s.notify[key], [notifyKey(setting.channelId)]: setting } }, clock: Date.now() }))
  scheduleMuteEnd()
}

onWelcomeHook((key, welcome) => {
  useOrganize.setState((s) => ({
    categories: { ...s.categories, [key]: welcome.categories ?? [] },
    collapsed: keepCollapsed(s.collapsed, key, welcome.categories ?? []),
    notify: { ...s.notify, [key]: toMap(welcome.notify ?? []) },
    serverDefaults: { ...s.serverDefaults, [key]: welcome.notifyDefault ?? 'auto' },
    clock: Date.now(),
  }))
  scheduleMuteEnd()
})

onServerEvent((key, type, body) => {
  if (type === 'channels') {
    const { categories } = body as Events['channels']
    if (categories) useOrganize.setState((s) => ({ categories: { ...s.categories, [key]: categories }, collapsed: keepCollapsed(s.collapsed, key, categories) }))
  }
  if (type === 'notify.updated') saveSetting(key, (body as Events['notify.updated']).setting)
  if (type === 'notify.default') {
    const { level } = body as Events['notify.default']
    useOrganize.setState((s) => ({ serverDefaults: { ...s.serverDefaults, [key]: level }, clock: Date.now() }))
  }
})

// ── Reading ─────────────────────────────────────────────────────────────────

/** Threads follow their channel's settings. */
export function settingsChannel(serverKey: string, channelId: number): number {
  return knownThread(serverKey, channelId)?.channelId ?? channelId
}

export function notifyFor(serverKey: string, channelId: number | null): EffectiveNotify {
  const map = useOrganize.getState().notify[serverKey]
  return effectiveNotify(map, channelId === null ? null : settingsChannel(serverKey, channelId), Date.now(), serverDefaultLevel(serverKey))
}

/** The level for this server when you chose nothing: the server's choice, or by how many people are on it. */
export function serverDefaultLevel(serverKey: string): NotifyLevel {
  const chosen = useOrganize.getState().serverDefaults[serverKey]
  if (chosen === 'all' || chosen === 'mentions') return chosen
  const members = useApp.getState().servers[serverKey]?.members ?? {}
  return defaultLevel(Object.values(members).filter((m) => !m.bot).length)
}

/** Re-renders when settings change, a mute runs out, or the server's size crosses the default's line. */
export function useNotifyFor(serverKey: string, channelId: number | null): EffectiveNotify {
  useApp((s) => s.servers[serverKey]?.members)
  useOrganize((s) => s.notify[serverKey])
  useOrganize((s) => s.clock)
  return notifyFor(serverKey, channelId)
}

export const useServerNotifyDefault = (serverKey: string): NotifyDefault => useOrganize((s) => s.serverDefaults[serverKey] ?? 'auto')

/** Admins: the default for everyone on the server who chose nothing. */
export async function setServerNotifyDefault(serverKey: string, level: NotifyDefault): Promise<void> {
  const c = connectionFor(serverKey)
  if (!c) throw new Error(t('errors.codes.disconnected'))
  const result = await c.request('notify.default.set', { level })
  useOrganize.setState((s) => ({ serverDefaults: { ...s.serverDefaults, [serverKey]: result.level }, clock: Date.now() }))
}

export function useCategories(serverKey: string): Category[] {
  return useOrganize((s) => s.categories[serverKey]) ?? NONE
}
const NONE: Category[] = []

// ── Collapsing (this device) ────────────────────────────────────────────────

/** Forgets collapsed categories that are gone (ids are never reused, but this keeps the device's list honest). */
function keepCollapsed(collapsed: Record<string, number[]>, serverKey: string, categories: Category[]): Record<string, number[]> {
  const mine = collapsed[serverKey]
  if (!mine) return collapsed
  const kept = mine.filter((id) => categories.some((c) => c.id === id))
  if (kept.length === mine.length) return collapsed
  const next = { ...collapsed, [serverKey]: kept }
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next))
  } catch {
    /* private mode */
  }
  return next
}

// A channel that's gone: forget its notification setting here too (the server already did).
onChannelsGone((serverKey, channelIds) => {
  useOrganize.setState((s) => {
    const mine = s.notify[serverKey]
    if (!mine || !channelIds.some((id) => notifyKey(id) in mine)) return s
    const next = { ...mine }
    for (const id of channelIds) delete next[notifyKey(id)]
    return { notify: { ...s.notify, [serverKey]: next } }
  })
})

export function toggleCollapsed(serverKey: string, categoryId: number): void {
  useOrganize.setState((s) => {
    const mine = s.collapsed[serverKey] ?? []
    const next = mine.includes(categoryId) ? mine.filter((id) => id !== categoryId) : [...mine, categoryId]
    return { collapsed: { ...s.collapsed, [serverKey]: next } }
  })
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(useOrganize.getState().collapsed))
  } catch {
    /* private mode */
  }
}

// ── Requests ────────────────────────────────────────────────────────────────

function connection(serverKey: string) {
  const c = connectionFor(serverKey)
  if (!c) throw new Error(t('errors.codes.disconnected'))
  return c
}

export async function setNotifyLevel(serverKey: string, channelId: number | null, level: NotifyLevel | 'default'): Promise<void> {
  const { setting } = await connection(serverKey).request('notify.set', { channelId, level })
  saveSetting(serverKey, setting)
}

/** minutes: 0 unmutes, -1 mutes until turned back on. */
export async function muteFor(serverKey: string, channelId: number | null, minutes: number): Promise<void> {
  const { setting } = await connection(serverKey).request('notify.set', { channelId, muteMinutes: minutes })
  saveSetting(serverKey, setting)
}

export async function createCategory(serverKey: string, name: string): Promise<Category> {
  return (await connection(serverKey).request('category.create', { name })).category
}

export async function renameCategory(serverKey: string, id: number, name: string): Promise<void> {
  await connection(serverKey).request('category.update', { id, name })
}

export async function deleteCategory(serverKey: string, id: number): Promise<void> {
  await connection(serverKey).request('category.delete', { id })
}

export async function moveCategory(serverKey: string, id: number, before: number | null): Promise<void> {
  await connection(serverKey).request('category.move', { id, before })
}

export async function moveChannel(serverKey: string, id: number, categoryId: number | null, before: number | null): Promise<void> {
  await connection(serverKey).request('channel.move', { id, categoryId, before })
}

/** Your own nickname (no accountKey) or someone else's (admins). "" resets it. */
export async function setNickname(serverKey: string, nick: string, accountKey?: string): Promise<Member> {
  return (await connection(serverKey).request('member.nick', { accountKey, nick })).member
}
