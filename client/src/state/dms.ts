// Direct messages and friends. A conversation is with a person (account key), not a server:
// any server you both belong to can carry it, and histories from all of them are merged.
import { create } from 'zustand'
import { b64u } from '../core/crypto'
import { decryptDm, DmError, encryptDm, type DmContent } from '../core/dm'
import type { DeviceCert } from '../core/identity'
import type { WireDm } from '../core/protocol'
import * as storage from '../core/storage'
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
    if (member) return member.name
  }
  return useDms.getState().friends[accountKey]?.name ?? 'Someone'
}

export function isOnline(accountKey: string): boolean {
  return Object.values(useApp.getState().servers).some((s) => s.members[accountKey]?.online)
}

function patchConversation(peer: string, patch: (c: Conversation) => Partial<Conversation>): void {
  useDms.setState((state) => {
    const current = state.conversations[peer] ?? { messages: [], loaded: false, unread: 0 }
    return { conversations: { ...state.conversations, [peer]: { ...current, ...patch(current) } } }
  })
}

function upsert(list: Dm[], dm: Dm): Dm[] {
  const without = list.filter((m) => m.id !== dm.id)
  return [...without, dm].sort((a, b) => a.sentAt - b.sentAt || a.id.localeCompare(b.id))
}

function open(wire: WireDm): Dm {
  const identity = useApp.getState().identity!
  try {
    const { text, header, call } = decryptDm(identity, wire.envelope, wire.from, wire.to)
    return { id: header.id, from: wire.from, to: wire.to, text, sentAt: header.sentAt, call }
  } catch (e) {
    return {
      id: `server-${wire.id}-${wire.createdAt}`, from: wire.from, to: wire.to, text: '', sentAt: wire.createdAt,
      error: e instanceof DmError ? e.message : "This message couldn't be read.",
    }
  }
}

/** Every dm.message event from any server. */
function onDmEvent(wire: WireDm): void {
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
      } catch {
        /* that server is busy or gone; others still work */
      }
    }),
  )
}

export async function loadHistory(peer: string): Promise<void> {
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

const deviceCache = new Map<string, { at: number; devices: DeviceCert[] }>()

export async function devicesOf(serverKey: string, accountKey: string): Promise<DeviceCert[]> {
  const cacheKey = `${serverKey}:${accountKey}`
  const cached = deviceCache.get(cacheKey)
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.devices
  const { devices } = await connectionFor(serverKey)!.request('dm.devices', { accountKey })
  deviceCache.set(cacheKey, { at: Date.now(), devices })
  return devices
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
    const [theirs, ours] = await Promise.all([devicesOf(route, peer), devicesOf(route, mine)])
    const envelope = encryptDm(identity, peer, theirs, ours, { text, ...extra })
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
  patchConversation(peer, (c) => ({ messages: c.messages.filter((m) => m.id !== id) }))
}

onServerEvent((_server, type, body) => {
  if (type === 'dm.message') onDmEvent((body as { message: WireDm }).message)
})
onWelcomeHook(() => void loadConversations())

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
