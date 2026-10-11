// Your profile lives on this device and is sent to every server you're on: edit once, every server updates.
// Text fields go with each connect (auth); the avatar and page are uploaded wherever they're out of date.
import { t } from '../i18n'
import { create } from 'zustand'
import { sha256Hex } from '../core/profile'
import type { Member, ProfileUpdate } from '../core/protocol'
import * as storage from '../core/storage'
import { connectionFor, onServerEvent, onWelcomeHook, uploadFile, useApp } from './store'

interface ProfileUiState {
  /** Whether each server allows profile pages. */
  pagesEnabled: Record<string, boolean>
  /** The open profile card, anchored to what was clicked (null rect: show as a sheet). */
  card: { serverKey: string; accountKey: string; rect: DOMRect | null } | null
  /** The open profile page viewer. */
  viewer: { serverKey: string; accountKey: string } | null
  /** The full member dialog (moderation, volume), opened from a card. */
  details: { serverKey: string; accountKey: string } | null
}

export const useProfiles = create<ProfileUiState>(() => ({ pagesEnabled: {}, card: null, viewer: null, details: null }))

export function openProfileCard(serverKey: string, accountKey: string, anchor?: Element | null): void {
  useProfiles.setState({ card: { serverKey, accountKey, rect: anchor?.getBoundingClientRect() ?? null } })
}

export const closeProfileCard = () => useProfiles.setState({ card: null })
export const openProfilePage = (serverKey: string, accountKey: string) => useProfiles.setState({ viewer: { serverKey, accountKey }, card: null })
export const closeProfilePage = () => useProfiles.setState({ viewer: null })
export const openMemberDetails = (serverKey: string, accountKey: string) => useProfiles.setState({ details: { serverKey, accountKey }, card: null })
export const closeMemberDetails = () => useProfiles.setState({ details: null })

// ── Keeping servers in step ─────────────────────────────────────────────────

const syncing = new Map<string, Promise<void>>()

/** Brings one server's copy of your avatar and page up to date (queued, so uploads never overlap). */
export function syncProfile(serverKey: string): Promise<void> {
  const run = (syncing.get(serverKey) ?? Promise.resolve()).then(() => syncNow(serverKey))
  syncing.set(serverKey, run.catch(() => undefined))
  return run
}

async function syncNow(serverKey: string): Promise<void> {
  const { profile, servers } = useApp.getState()
  const me = servers[serverKey]?.me
  const connection = connectionFor(serverKey)
  if (!profile || !me || !connection?.isOnline || !('avatarHash' in me)) return // older servers have no profiles

  const avatar = profile.avatar
  if (avatar === null && me.avatar) await connection.request('profile.update', { avatar: '' })
  if (avatar && me.avatarHash !== avatar.hash) {
    const file = await uploadFile(serverKey, new File([avatar.bytes], avatar.type === 'image/webp' ? 'avatar.webp' : 'avatar.png', { type: avatar.type }), () => {})
    await connection.request('profile.update', { avatar: file.id })
  }

  if (!useProfiles.getState().pagesEnabled[serverKey]) return
  const page = profile.page
  if (page === null && me.page) await connection.request('profile.page.remove', {})
  if (page && me.pageHash !== page.hash) {
    const file = await uploadFile(serverKey, new File([page.html], 'page.html', { type: 'text/html' }), () => {})
    await connection.request('profile.page.set', { file: file.id })
  }
}

onWelcomeHook((serverKey, welcome) => {
  useProfiles.setState((s) => ({ pagesEnabled: { ...s.pagesEnabled, [serverKey]: welcome.server.profilePages ?? false } }))
  syncProfile(serverKey).catch(() => undefined)
})

onServerEvent((serverKey, type, body) => {
  if (type !== 'profile.pages') return
  const { enabled } = body as { enabled: boolean }
  useProfiles.setState((s) => ({ pagesEnabled: { ...s.pagesEnabled, [serverKey]: enabled } }))
  if (enabled) syncProfile(serverKey).catch(() => undefined)
})

const onlineServers = () => useApp.getState().order.filter((key) => connectionFor(key)?.isOnline)

async function saveLocal(patch: Partial<storage.Profile>): Promise<storage.Profile> {
  const current = useApp.getState().profile
  if (!current) throw new Error(t('profile.noProfile'))
  const next = { ...current, ...patch }
  await storage.saveProfile(next)
  useApp.setState({ profile: next })
  return next
}

/** Runs on every connected server; resolves with the names of servers that refused. */
async function everywhere(action: (serverKey: string) => Promise<unknown>): Promise<string[]> {
  const failed: string[] = []
  await Promise.all(
    onlineServers().map(async (key) => {
      try {
        await action(key)
      } catch {
        failed.push(useApp.getState().servers[key]?.name ?? key)
      }
    }),
  )
  return failed
}

/** Name, bio, pronouns and accent ("" clears). */
export async function updateProfile(fields: ProfileUpdate): Promise<string[]> {
  const { avatar: _ignored, ...text } = fields
  await saveLocal(text)
  return everywhere(async (key) => {
    const me = useApp.getState().servers[key]?.me
    // Servers without profiles only understand a rename.
    const body = me && 'avatarHash' in me ? text : text.name ? { name: text.name } : null
    if (body) await connectionFor(key)!.request('profile.update', body)
  })
}

/** A new avatar (already cropped and encoded), or null to remove it. */
export async function setAvatar(image: Blob | null): Promise<string[]> {
  if (image) {
    const bytes = await image.arrayBuffer()
    await saveLocal({ avatar: { bytes, type: image.type || 'image/png', hash: sha256Hex(new Uint8Array(bytes)) } })
  } else {
    await saveLocal({ avatar: null })
  }
  return everywhere(syncProfile)
}

/** Publishes your page to every server that allows pages, or removes it (null). */
export async function publishPage(html: string | null): Promise<string[]> {
  await saveLocal({ page: html === null ? null : { html, hash: sha256Hex(new TextEncoder().encode(html)) } })
  return everywhere(syncProfile)
}

// ── Admin ───────────────────────────────────────────────────────────────────

export async function removeMemberPage(serverKey: string, member: Member): Promise<void> {
  await connectionFor(serverKey)?.request('profile.page.remove', { accountKey: member.accountKey })
}

export async function setPagesEnabled(serverKey: string, enabled: boolean): Promise<void> {
  await connectionFor(serverKey)?.request('profile.pages.configure', { enabled })
}
