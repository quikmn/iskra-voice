// Direct messages and friends. A conversation is with a person (account key), not a server:
// any server you both belong to can carry it, and histories from all of them are merged.
// Decrypted messages are also kept on this device: with forward secrecy, old envelopes on the
// servers stop being readable once their prekey is deleted, so the local copy is the history.
import { create } from 'zustand'
import { b64u } from '../core/crypto'
import { revokedSet } from '../core/devices'
import { decryptDm, DmError, encryptDm, type DmContent, type DmEnvelope } from '../core/dm'
import type { DeviceCert } from '../core/identity'
import type { DeviceBundle, WireDm } from '../core/protocol'
import * as storage from '../core/storage'
import { mergeDm, orderTime } from './dmMerge'
import { ensurePrekeys, ownRevokedDevices } from './devices'
import { connectionFor, onServerEvent, onWelcomeHook, useApp } from './store'

export interface Dm {
  /** The id inside the encrypted header; the same on every server and device. */
  id: string
  from: string
  to: string
  text: string
  sentAt: number
  pending?: 'sending' | 'failed'
  /** Set when a message couldn't be decrypted (shown as a notice, never as text). */
  error?: string
  /** A call log entry (see calls.ts); shown instead of the text. */
  call?: Record<string, unknown>
}

export interface Conversation {
  messages: Dm[]
  loaded: boolean
  unread: number
}

export interface Friend {
  accountKey: string
  name: string
  addedAt: number
}

interface DmState {
  conversations: Record<string, Conversation>
  friends: Record<string, Friend>
  /** What the home screen shows: the friends list or a conversation. */
  open: { kind: 'friends' } | { kind: 'dm'; peer: string }
}

export const useDms = create<DmState>(() => ({
  conversations: {},
  friends: {},
  open: { kind: 'friends' },
}))

const me = () => {
  const identity = useApp.getState().identity
  return identity ? b64u(identity.account.publicKey) : ''
}

/** Servers where both of us are members and we're connected, most recently active first. */
export function sharedServers(peer: string): string[] {
  const { servers, order } = useApp.getState()
  return order.filter((key) => servers[key]?.status.state === 'online' && (peer === me() || servers[key].members[peer]))
}

/** The best display name we know for someone, from any server. */
export function nameOf(accountKey: string): string {
  const { servers } = useApp.getState()
  for (const server of Object.values(servers)) {
    const member = server.members[accountKey]
    if (member) return member.profileName ?? member.name // DMs aren't on a server: their own name, not a nickname
  }
  return useDms.getState().friends[accountKey]?.name ?? 'Someone'
}

export function isOnline(accountKey: string): boolean {
  return Object.values(useApp.getState().servers).some((s) => s.members[accountKey]?.online)
}

function patchConversation(peer: string, patch: (c: Conversation) => Partial<Conversation>): void {
  let changed = false
  useDms.setState((state) => {
    const current = state.conversations[peer] ?? { messages: [], loaded: false, unread: 0 }
    const next = { ...current, ...patch(current) }
    changed = next.messages !== current.messages
    return { conversations: { ...state.conversations, [peer]: next } }
  })
  if (changed) persist(peer)
}

const upsert = (list: Dm[], dm: Dm): Dm[] => mergeDm(list, dm)

function open(wire: WireDm): Dm {
  const identity = useApp.getState().identity!
  try {
    const { text, header, call } = decryptDm(identity, wire.envelope, wire.from, wire.to)
    return { id: header.id, from: wire.from, to: wire.to, text, sentAt: orderTime(header.sentAt, wire.createdAt), call }
  } catch (e) {
    // The header id (unauthenticated here) only lets a readable local copy of the same message win.
    const headerId = wire.envelope?.header?.id
    return {
      id: typeof headerId === 'string' && headerId.length <= 32 ? headerId : `server-${wire.id}-${wire.createdAt}`,
      from: wire.from, to: wire.to, text: '', sentAt: wire.createdAt,
      error: e instanceof DmError ? e.message : "This message couldn't be read.",
    }
  }
}

// ── The local copy of decrypted history ─────────────────────────────────────

const MAX_LOCAL_PER_CONVERSATION = 5000
const dirty = new Set<string>()
let saveTimer: ReturnType<typeof setTimeout> | null = null
let saving: Promise<void> = Promise.resolve()
let historyLoaded = false

const storable = (m: Dm): storage.StoredDm => ({ id: m.id, from: m.from, to: m.to, text: m.text, sentAt: m.sentAt, ...(m.call ? { call: m.call } : {}) })

function persist(peer: string): void {
  if (!historyLoaded) return
  dirty.add(peer)
  saveTimer ??= setTimeout(() => {
    saveTimer = null
    const peers = [...dirty]
    dirty.clear()
    saving = saving.then(async () => {
      for (const p of peers) {
        const messages = (useDms.getState().conversations[p]?.messages ?? []).filter((m) => !m.pending && !m.error)
        await storage.saveDmConversation(p, messages.slice(-MAX_LOCAL_PER_CONVERSATION).map(storable)).catch(() => undefined)
      }
    })
  }, 300)
}

/** Loads the decrypted history kept on this device. Runs once the app has an identity. */
let historyLoading: Promise<void> | null = null

export function loadLocalHistory(): Promise<void> {
  historyLoading ??= (async () => {
    const stored = await storage.loadDmHistory().catch(() => ({}) as Record<string, storage.StoredDm[]>)
    for (const [peer, messages] of Object.entries(stored)) {
      patchConversation(peer, (c) => ({ messages: messages.reduce<Dm[]>(upsert, c.messages) }))
    }
    historyLoaded = true
    // Save whatever arrived while we were loading.
    for (const [peer, c] of Object.entries(useDms.getState().conversations)) {
      if (c.messages.filter((m) => !m.pending && !m.error).length > (stored[peer]?.length ?? 0)) persist(peer)
    }
  })()
  return historyLoading
}

/** Adds history copied from another device (device linking). */
export async function importHistory(history: Record<string, storage.StoredDm[]>): Promise<void> {
  for (const [peer, messages] of Object.entries(history)) {
    if (!Array.isArray(messages)) continue
    const clean = messages.filter((m) => typeof m?.id === 'string' && typeof m.text === 'string' && typeof m.sentAt === 'number'
      && typeof m.from === 'string' && typeof m.to === 'string')
    await storage.saveDmConversation(peer, clean.map(storable))
  }
}

/** Recent history for a device link: newest messages, at most this many per conversation and bytes in total. */
export function exportHistory(perConversation = 200, maxBytes = 600_000): Record<string, storage.StoredDm[]> {
  const out: Record<string, storage.StoredDm[]> = {}
  let size = 0
  const conversations = Object.entries(useDms.getState().conversations)
    .sort(([, a], [, b]) => (b.messages.at(-1)?.sentAt ?? 0) - (a.messages.at(-1)?.sentAt ?? 0))
  for (const [peer, c] of conversations) {
    const kept: storage.StoredDm[] = []
    for (const m of c.messages.filter((m) => !m.pending && !m.error).slice(-perConversation).reverse()) {
      const item = storable(m)
      size += JSON.stringify(item).length
      if (size > maxBytes) break
      kept.unshift(item)
    }
    if (kept.length) out[peer] = kept
    if (size > maxBytes) break
  }
  return out
}

/** Every dm.message event from any server. */
async function onDmEvent(wire: WireDm): Promise<void> {
  await ensurePrekeys()
  const mine = me()
  const peer = wire.from === mine ? wire.to : wire.from
  const dm = open(wire)
  const state = useDms.getState()
  const viewing = useApp.getState().activeServer === null && state.open.kind === 'dm' && state.open.peer === peer && document.hasFocus()
  patchConversation(peer, (c) => ({
    messages: upsert(c.messages, dm),
    unread: dm.from === mine || viewing ? c.unread : c.unread + 1,
  }))
}

export async function loadConversations(): Promise<void> {
  const mine = me()
  await Promise.all(
    sharedServers(mine).map(async (serverKey) => {
      try {
        const { conversations } = await connectionFor(serverKey)!.request('dm.conversations', {})
        for (const c of conversations) patchConversation(c.accountKey, () => ({}))
        // Read (and keep) what arrived while we were away, before its prekey can expire.
        await loadLocalHistory()
        const stale = conversations.filter((c) => c.lastAt > (useDms.getState().conversations[c.accountKey]?.messages.at(-1)?.sentAt ?? 0))
        for (const c of stale.slice(0, 20)) await loadHistory(c.accountKey)
      } catch {
        /* that server is busy or gone; others still work */
      }
    }),
  )
}

export async function loadHistory(peer: string): Promise<void> {
  await ensurePrekeys()
  const results = await Promise.all(
    sharedServers(peer).map(async (serverKey) => {
      try {
        const { messages } = await connectionFor(serverKey)!.request('dm.history', { accountKey: peer, limit: 100 })
        return messages
      } catch {
        return []
      }
    }),
  )
  const opened = results.flat().map(open)
  patchConversation(peer, (c) => ({ messages: opened.reduce(upsert, c.messages), loaded: true }))
}

export function openConversation(peer: string): void {
  useApp.setState({ activeServer: null })
  useDms.setState({ open: { kind: 'dm', peer } })
  patchConversation(peer, () => ({ unread: 0 }))
  void loadHistory(peer)
}

export function markRead(peer: string): void {
  patchConversation(peer, () => ({ unread: 0 }))
}

export function openFriends(): void {
  useApp.setState({ activeServer: null })
  useDms.setState({ open: { kind: 'friends' } })
}

const deviceCache = new Map<string, { at: number; bundle: DeviceBundle }>()

/** Someone's device certificates, prekeys and revocations, as one server knows them (cached briefly). */
export async function bundleOf(serverKey: string, accountKey: string): Promise<DeviceBundle> {
  const cacheKey = `${serverKey}:${accountKey}`
  const cached = deviceCache.get(cacheKey)
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.bundle
  const bundle = await connectionFor(serverKey)!.request('dm.devices', { accountKey })
  deviceCache.set(cacheKey, { at: Date.now(), bundle })
  return bundle
}

/** Certificates of someone's devices (revoked ones left out), for callers that only need those. */
export async function devicesOf(serverKey: string, accountKey: string): Promise<DeviceCert[]> {
  const bundle = await bundleOf(serverKey, accountKey)
  const revoked = revokedSet(accountKey, bundle.revoked)
  return bundle.devices.filter((d) => !revoked.has(d.deviceKey))
}

/**
 * Encrypts for everyone who should read it (their devices and ours), forward secret where the devices
 * have prekeys, never for revoked devices. Used for DMs and call invites.
 */
export async function encryptFor(serverKey: string, peer: string, content: DmContent): Promise<DmEnvelope> {
  const identity = useApp.getState().identity
  if (!identity) throw new DmError('No account on this device.')
  const mine = me()
  const [theirs, ours, ownRevoked] = await Promise.all([bundleOf(serverKey, peer), bundleOf(serverKey, mine), ownRevokedDevices(), ensurePrekeys()])
  const revokedDevices = [...revokedSet(peer, theirs.revoked), ...revokedSet(mine, ours.revoked), ...ownRevoked]
  return encryptDm(identity, peer, theirs.devices, peer === mine ? [] : ours.devices, content, Date.now(), {
    prekeys: [...(theirs.prekeys ?? []), ...(ours.prekeys ?? [])],
    revokedDevices,
  })
}

export async function sendDm(peer: string, text: string, extra: Pick<DmContent, 'call'> = {}): Promise<void> {
  const identity = useApp.getState().identity
  const mine = me()
  const route = sharedServers(peer)[0]
  const tempId = `pending-${Date.now()}-${Math.random()}`
  const pending: Dm = { id: tempId, from: mine, to: peer, text, sentAt: Date.now(), pending: 'sending', ...extra }
  patchConversation(peer, (c) => ({ messages: upsert(c.messages, pending) }))

  try {
    if (!identity || !route) throw new DmError("You don't share an online server with this person right now.")
    const envelope = await encryptFor(route, peer, { text, ...extra })
    await connectionFor(route)!.request('dm.send', { accountKey: peer, envelope })
    // The dm.message event (also sent to us) adds the real message; drop the placeholder.
    patchConversation(peer, (c) => ({
      messages: upsert(c.messages.filter((m) => m.id !== tempId), { id: envelope.header.id, from: mine, to: peer, text, sentAt: envelope.header.sentAt, ...extra }),
    }))
  } catch (e) {
    patchConversation(peer, (c) => ({
      messages: c.messages.map((m) => (m.id === tempId ? { ...m, pending: 'failed' as const, error: (e as Error).message } : m)),
    }))
  }
}

export function discardDm(peer: string, id: string): void {
  patchConversation(peer, (c) => ({ messages: c.messages.filter((m) => !(m.id === id && m.pending)) }))
}

onServerEvent((_server, type, body) => {
  if (type === 'dm.message') void onDmEvent((body as { message: WireDm }).message)
  // Someone's device list changed: fetch fresh bundles next time.
  if (type === 'device.revoked') deviceCache.clear()
})
onWelcomeHook(() => void loadConversations())
// Local history loads once there's an identity (right after boot, or after onboarding/linking).
useApp.subscribe((state) => {
  if (state.phase === 'ready' && !historyLoaded) void loadLocalHistory()
})

// ── Friends (kept on this device) ──────────────────────────────────────────

export async function loadFriends(): Promise<void> {
  const list = await storage.loadFriends()
  useDms.setState({ friends: Object.fromEntries(list.map((f) => [f.accountKey, f])) })
}

async function saveFriends(): Promise<void> {
  await storage.saveFriends(Object.values(useDms.getState().friends))
}

export async function addFriend(accountKey: string): Promise<void> {
  if (accountKey === me()) return
  useDms.setState((s) => ({ friends: { ...s.friends, [accountKey]: { accountKey, name: nameOf(accountKey), addedAt: Date.now() } } }))
  await saveFriends()
}

export async function removeFriend(accountKey: string): Promise<void> {
  useDms.setState((s) => {
    const friends = { ...s.friends }
    delete friends[accountKey]
    return { friends }
  })
  await saveFriends()
}
