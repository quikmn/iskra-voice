// Your profile lives on this device and is sent to every server you're on: edit once, every server updates.
// Text fields go with each connect (auth); the avatar and page are uploaded wherever they're out of date.
// It also follows your account to your other devices (Profile sync): every edit is stamped, the newest one wins.
import { t } from '../i18n'
import { create } from 'zustand'
import { openPrefs, prefsKey, sealPrefs } from '../core/prefs'
import { originOf, sha256Hex } from '../core/profile'
import { adopt, compareStamps, missing, nextStamp, parseSynced, PROFILE_PREF, stampOf, toSynced, wireStamp, type SyncedProfile } from '../core/profileSync'
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

  const stamp = wireStamp(profile)
  const avatar = profile.avatar
  if (avatar === null && me.avatar) await connection.request('profile.update', { avatar: '', ...stamp })
  if (avatar && me.avatarHash !== avatar.hash) {
    const file = await uploadFile(serverKey, new File([avatar.bytes], avatar.type === 'image/webp' ? 'avatar.webp' : 'avatar.png', { type: avatar.type }), () => {})
    noteStale(serverKey, await connection.request('profile.update', { avatar: file.id, ...stamp }))
  }

  if (!useProfiles.getState().pagesEnabled[serverKey]) return
  const page = profile.page
  if (page === null && me.page) await connection.request('profile.page.remove', { ...stamp })
  if (page && me.pageHash !== page.hash) {
    const file = await uploadFile(serverKey, new File([page.html], 'page.html', { type: 'text/html' }), () => {})
    noteStale(serverKey, await connection.request('profile.page.set', { file: file.id, ...stamp }))
  }
}

onWelcomeHook((serverKey, welcome) => {
  useProfiles.setState((s) => ({ pagesEnabled: { ...s.pagesEnabled, [serverKey]: welcome.server.profilePages ?? false } }))
  // Take a newer profile from your other devices first, so an old avatar or page isn't uploaded for nothing.
  void catchUp(serverKey).finally(() => syncProfile(serverKey).catch(() => undefined))
})

onServerEvent((serverKey, type, body) => {
  if (type === 'prefs.updated' && (body as { name: string }).name === PROFILE_PREF) void catchUp(serverKey)
  // A newer avatar or page we were waiting for has arrived on a server.
  if (type === 'member.updated' && waiting.size && (body as { member: Member }).member.accountKey === myAccount()) {
    for (const key of [...waiting]) void catchUp(key)
  }
  if (type !== 'profile.pages') return
  const { enabled } = body as { enabled: boolean }
  useProfiles.setState((s) => ({ pagesEnabled: { ...s.pagesEnabled, [serverKey]: enabled } }))
  if (enabled) syncProfile(serverKey).catch(() => undefined)
})

const onlineServers = () => useApp.getState().order.filter((key) => connectionFor(key)?.isOnline)

/** Saves an edit here, stamped as the newest version of your profile. */
async function saveLocal(patch: Partial<storage.Profile>): Promise<storage.Profile> {
  const current = useApp.getState().profile
  if (!current) throw new Error(t('profile.noProfile'))
  const next = { ...current, ...patch, ...nextStamp(current, myDevice()) }
  await keep(next)
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
  const saved = await saveLocal(text)
  const failed = await everywhere(async (key) => {
    const me = useApp.getState().servers[key]?.me
    // Servers without profiles only understand a rename.
    const body = me && 'avatarHash' in me ? text : text.name ? { name: text.name } : null
    if (body) noteStale(key, await connectionFor(key)!.request('profile.update', { ...body, ...wireStamp(saved) }))
  })
  await pushCopyEverywhere()
  return failed
}

/** A new avatar (already cropped and encoded), or null to remove it. */
export async function setAvatar(image: Blob | null): Promise<string[]> {
  if (image) {
    const bytes = await image.arrayBuffer()
    await saveLocal({ avatar: { bytes, type: image.type || 'image/png', hash: sha256Hex(new Uint8Array(bytes)) } })
  } else {
    await saveLocal({ avatar: null })
  }
  // Uploaded before the account's copy changes, so your other devices find the new picture.
  const failed = await everywhere(syncProfile)
  await pushCopyEverywhere()
  return failed
}

/** Publishes your page to every server that allows pages, or removes it (null). */
export async function publishPage(html: string | null): Promise<string[]> {
  await saveLocal({ page: html === null ? null : { html, hash: sha256Hex(new TextEncoder().encode(html)) } })
  const failed = await everywhere(syncProfile)
  await pushCopyEverywhere()
  return failed
}

// ── Profile sync: your other devices ────────────────────────────────────────

const myAccount = () => useApp.getState().identity?.cert.accountKey
const myDevice = () => useApp.getState().identity?.cert.deviceKey ?? ''

/** Servers whose newer copy waits for an avatar or page to show up. */
const waiting = new Set<string>()
let catching: Promise<void> = Promise.resolve()

function prefsKeyNow(): Uint8Array | null {
  const identity = useApp.getState().identity
  return identity ? prefsKey(identity.account.secretKey) : null
}

async function keep(profile: storage.Profile): Promise<void> {
  await storage.saveProfile(profile)
  useApp.setState({ profile })
}

/** A server answered that it has a newer profile than ours: another device edited it. */
function noteStale(serverKey: string, result: { stale?: boolean } | undefined): void {
  if (result?.stale) void catchUp(serverKey)
}

/** Writes this device's profile as the account's copy on one server (the server keeps the newest). */
async function pushCopy(serverKey: string, profile = useApp.getState().profile): Promise<void> {
  const key = prefsKeyNow()
  const copy = profile && toSynced(profile)
  const connection = connectionFor(serverKey)
  if (!key || !copy || !connection?.isOnline) return
  await connection
    .request('prefs.set', { name: PROFILE_PREF, data: sealPrefs(key, PROFILE_PREF, JSON.stringify(copy)), updatedAt: copy.updatedAt })
    .catch(() => undefined)
}

const pushCopyEverywhere = () => Promise.all(onlineServers().map((key) => pushCopy(key)))

/** Compares with the account's copy on one server: takes it if it's newer, or writes ours if that is. Queued. */
export function catchUp(serverKey: string): Promise<void> {
  catching = catching.then(() => catchUpNow(serverKey)).catch(() => undefined)
  return catching
}

async function catchUpNow(serverKey: string): Promise<void> {
  const connection = connectionFor(serverKey)
  const key = prefsKeyNow()
  const local = useApp.getState().profile
  if (!connection?.isOnline || !key || !local) return
  let got: { data: string | null; updatedAt: number | null }
  try {
    got = await connection.request('prefs.get', { name: PROFILE_PREF })
  } catch {
    return // an older server without prefs, or offline
  }
  const opened = got.data ? openPrefs(key, PROFILE_PREF, got.data) : null
  if (got.data && opened === null && got.updatedAt !== null && local.updatedAt) {
    // Sealed under an earlier account key (it was replaced): stamp ours past it and write it again.
    await keep({ ...local, ...nextStamp({ updatedAt: Math.max(local.updatedAt, got.updatedAt) }, myDevice()) })
    await pushCopyEverywhere()
    return
  }
  const remote = opened === null ? null : parseSynced(opened)
  const order = remote ? compareStamps(remote, stampOf(local)) : -1
  if (remote && order > 0) await take(serverKey, local, remote)
  else if (local.updatedAt && order < 0) await pushCopy(serverKey, local)
}

/** Takes the newer copy (fetching its avatar and page), then brings every server we're on up to date with it. */
async function take(from: string, local: storage.Profile, remote: SyncedProfile): Promise<void> {
  const need = missing(local, remote)
  const fetched: { avatar?: ArrayBuffer; page?: string } = {}
  if (need.avatar) fetched.avatar = (await fetchAvatar(need.avatar.hash, from)) ?? undefined
  if (need.page) fetched.page = (await fetchPage(need.page.hash, from)) ?? undefined
  const next = adopt(local, remote, fetched)
  if (!next) {
    waiting.add(from) // not on a server we can reach yet; servers ignore our older profile meanwhile
    return
  }
  waiting.clear()
  await keep(next)
  await Promise.all(onlineServers().map(async (key) => {
    try {
      const me = useApp.getState().servers[key]?.me
      if (me && 'avatarHash' in me && differs(me, next)) {
        await connectionFor(key)!.request('profile.update', { name: next.name, ...textOf(next), ...wireStamp(next) })
      }
      await syncProfile(key)
    } catch {
      /* this server catches up on its next connect */
    }
  }))
  await pushCopyEverywhere()
}

const textOf = (p: storage.Profile) => ({
  ...(p.bio !== undefined ? { bio: p.bio } : {}),
  ...(p.pronouns !== undefined ? { pronouns: p.pronouns } : {}),
  ...(p.accent !== undefined ? { accent: p.accent } : {}),
})

/** Whether a server shows another name or text than this profile. */
function differs(me: Member, p: storage.Profile): boolean {
  const same = (shown: string | null | undefined, mine: string | undefined) => mine === undefined || (shown ?? '') === mine
  return (me.profileName ?? me.name) !== p.name || !same(me.bio, p.bio) || !same(me.pronouns, p.pronouns) || !same(me.accent, p.accent)
}

/** Servers to fetch a file from: the one the copy came from first, then the others we're on. */
const candidates = (first: string) => [first, ...onlineServers().filter((key) => key !== first)]

async function fetchAvatar(hash: string, from: string): Promise<ArrayBuffer | null> {
  for (const key of candidates(from)) {
    const server = useApp.getState().servers[key]
    const origin = server && originOf(server.url)
    const path = server?.me?.avatarHash === hash ? server.me.avatar : null
    if (!origin || !path?.startsWith('/files/')) continue
    try {
      const response = await fetch(origin + path)
      if (!response.ok) continue
      const bytes = await response.arrayBuffer()
      if (sha256Hex(new Uint8Array(bytes)) === hash) return bytes
    } catch {
      /* try the next server */
    }
  }
  return null
}

async function fetchPage(hash: string, from: string): Promise<string | null> {
  for (const key of candidates(from)) {
    if (useApp.getState().servers[key]?.me?.pageHash !== hash) continue
    try {
      const { html } = await connectionFor(key)!.request('profile.page.get', {})
      if (sha256Hex(new TextEncoder().encode(html)) === hash) return html
    } catch {
      /* try the next server */
    }
  }
  return null
}

// ── Admin ───────────────────────────────────────────────────────────────────

export async function removeMemberPage(serverKey: string, member: Member): Promise<void> {
  await connectionFor(serverKey)?.request('profile.page.remove', { accountKey: member.accountKey })
}

export async function setPagesEnabled(serverKey: string, enabled: boolean): Promise<void> {
  await connectionFor(serverKey)?.request('profile.pages.configure', { enabled })
}
