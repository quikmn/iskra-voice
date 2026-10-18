// Direct messages and friends. A conversation is with a person (account key), not a server:
// any server you both belong to can carry it, and histories from all of them are merged.
// Decrypted messages are also kept on this device: with forward secrecy, old envelopes on the
// servers stop being readable once their prekey is deleted, so the local copy is the history.
import { create } from 'zustand'
import type { ParseKeys } from 'i18next'
import { t } from '../i18n'
import { errorMessage } from '../i18n/errors'
import { b64u } from '../core/crypto'
import { revokedSet } from '../core/devices'
import { decryptDm, DmError, encryptDm, type DmContent, type DmEnvelope, type DmForward } from '../core/dm'
import { checkFiles, type DmFile } from '../core/dmFiles'
import { checkFriend, type FriendAction } from '../core/friend'
import { isTimer, localExpiry } from '../core/disappear'
import type { DeviceCert } from '../core/identity'
import type { DeviceBundle, DmRequestFlag, WireDm } from '../core/protocol'
import * as storage from '../core/storage'
import { mergeDm, orderTime } from './dmMerge'
import { ensurePrekeys, ownRevokedDevices } from './devices'
import { keysReady, resolveKey, sameAccount } from './keyMap'
import type { Rotation } from '../core/rotation'
import { connectionFor, onServerEvent, onWelcomeHook, useApp } from './store'
import { dmConv, moveConversation, noteMessage, seeConversation } from './readState'

/** The English texts of core's DmErrors (core can't translate: the bot SDK shares it), by key. */
const CORE_ERRORS: Record<string, ParseKeys> = {
  "This person hasn't got any devices we can encrypt to yet.": 'dms.errors.noDevices',
  "This message was locked to an older key that this device has since deleted, so it can't be read here.": 'dms.errors.oldKey',
  "This message couldn't be decrypted.": 'dms.errors.notDecrypted',
  'Unsupported message format.': 'dms.errors.unsupportedFormat',
  "This message's sender or recipient doesn't match.": 'dms.errors.mismatch',
  "This message isn't for you.": 'dms.errors.notForYou',
  "The sender's device couldn't be verified.": 'dms.errors.unverified',
  "This message wasn't encrypted for this device.": 'dms.errors.notForDevice',
  'This message was tampered with.': 'dms.errors.tampered',
  'Unsupported message content.': 'dms.errors.unsupportedContent',
  "This file doesn't match what was sent.": 'dms.errors.fileMismatch',
  'This file is damaged.': 'dms.errors.fileDamaged',
}

/** What to show for a DM or group DM error: core's messages translated, server errors by code, else the text. */
export function dmErrorText(e: unknown): string {
  const message = (e as Error | null)?.message
  if (typeof message === 'string') {
    const key = CORE_ERRORS[message]
    if (key) return t(key) as string
    const length = /^Messages must be 1–(\d+) characters\.$/.exec(message)
    if (length) return t('dms.errors.length', { max: Number(length[1]) })
  }
  return errorMessage(e)
}

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
  /** A local notice, not a message: the person's account key (and so the safety number) changed. */
  notice?: 'key-changed' | 'key-disputed'
  /** A forwarded message (see state/forward.ts). */
  forward?: DmForward
  /** End-to-end encrypted attachments. */
  files?: DmFile[]
  /** A checked friend action (see state/friends.ts); shown as a small line, or not at all. */
  friend?: FriendAction
  /** When it disappears from this device (state/disappearing.ts deletes it then). */
  expiresAt?: number
  /** A disappearing messages timer change line (seconds, 0 = off), shown instead of the text. */
  disappear?: { seconds: number }
}

export interface Conversation {
  messages: Dm[]
  loaded: boolean
}

/** Someone you're friends with (both of you agreed; see state/friends.ts, which keeps this map). */
export interface Friend {
  accountKey: string
  name: string
  addedAt: number
}

interface DmState {
  conversations: Record<string, Conversation>
  friends: Record<string, Friend>
  /** What the home screen shows: the friends list, a conversation or a group DM (key: "<serverKey>/<groupId>", see groups.ts). */
  open: { kind: 'friends' } | { kind: 'dm'; peer: string } | { kind: 'group'; key: string }
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
  return useDms.getState().friends[accountKey]?.name ?? t('common.someone')
}

export function isOnline(accountKey: string): boolean {
  return Object.values(useApp.getState().servers).some((s) => s.members[accountKey]?.online)
}

function patchConversation(peer: string, patch: (c: Conversation) => Partial<Conversation>): void {
  let changed = false
  useDms.setState((state) => {
    const current = state.conversations[peer] ?? { messages: [], loaded: false }
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
    // Messages sent to or from an earlier key of the same person (a checked rotation) belong to their current key.
    const { text, header, call, forward, files, friend: rawFriend, kt, disappear } = decryptDm(identity, wire.envelope, wire.from, wire.to, sameAccount)
    const expiresAt = localExpiry(wire.expiresAt, header, wire.createdAt)
    if (kt) gossip?.receive(wire.from, wire.to, kt)
    // A friend action must carry a good signature from the sender; never shown as plain text if it doesn't.
    const friend = rawFriend === undefined ? undefined : checkFriend(rawFriend, wire.from, wire.to, Date.now(), sameAccount)
    if (friend === null) throw new DmError("The sender's device couldn't be verified.")
    return {
      id: header.id, from: resolveKey(wire.from), to: resolveKey(wire.to), text, sentAt: orderTime(header.sentAt, wire.createdAt), call,
      ...(forward ? { forward } : {}), ...(files ? { files } : {}), ...(friend ? { friend } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}), ...(disappear ? { disappear } : {}),
    }
  } catch (e) {
    // The header id (unauthenticated here) only lets a readable local copy of the same message win.
    const headerId = wire.envelope?.header?.id
    return {
      id: typeof headerId === 'string' && headerId.length <= 32 ? headerId : `server-${wire.id}-${wire.createdAt}`,
      from: resolveKey(wire.from), to: resolveKey(wire.to), text: '', sentAt: wire.createdAt,
      ...(typeof wire.expiresAt === 'number' ? { expiresAt: wire.expiresAt } : {}),
      error: e instanceof DmError ? dmErrorText(e) : t('dms.errors.unreadable'),
    }
  }
}

// ── The local copy of decrypted history ─────────────────────────────────────

const MAX_LOCAL_PER_CONVERSATION = 5000
const dirty = new Set<string>()
let saveTimer: ReturnType<typeof setTimeout> | null = null
let saving: Promise<void> = Promise.resolve()
let historyLoaded = false

const storable = (m: Dm): storage.StoredDm => ({
  id: m.id, from: m.from, to: m.to, text: m.text, sentAt: m.sentAt, ...(m.call ? { call: m.call } : {}), ...(m.notice ? { notice: m.notice } : {}),
  ...(m.forward ? { forward: m.forward } : {}), ...(m.files?.length ? { files: m.files } : {}), ...(m.friend ? { friend: m.friend } : {}),
  ...(typeof m.expiresAt === 'number' ? { expiresAt: m.expiresAt } : {}), ...(m.disappear && isTimer(m.disappear.seconds) ? { disappear: { seconds: m.disappear.seconds } } : {}),
})

/** Gone already (a disappearing message whose time is up). */
const expired = (m: { expiresAt?: number }, now = Date.now()) => typeof m.expiresAt === 'number' && m.expiresAt <= now

/** Attachments from storage or another device, checked like freshly decrypted ones (dropped if malformed). */
function storedFiles(raw: unknown): DmFile[] | undefined {
  try {
    const files = checkFiles(raw)
    return files.length ? files : undefined
  } catch {
    return undefined
  }
}

function persist(peer: string): void {
  if (!historyLoaded) return
  dirty.add(peer)
  saveTimer ??= setTimeout(() => {
    saveTimer = null
    const peers = [...dirty]
    dirty.clear()
    saving = saving.then(async () => {
      for (const p of peers) {
        const messages = (useDms.getState().conversations[p]?.messages ?? []).filter((m) => !m.pending && !m.error && !expired(m))
        await storage.saveDmConversation(p, messages.slice(-MAX_LOCAL_PER_CONVERSATION).map(storable)).catch(() => undefined)
      }
    })
  }, 300)
}

/** Loads the decrypted history kept on this device. Runs once the app has an identity. */
let historyLoading: Promise<void> | null = null

export function loadLocalHistory(): Promise<void> {
  historyLoading ??= (async () => {
    await keysReady()
    const stored = await storage.loadDmHistory().catch(() => ({}) as Record<string, storage.StoredDm[]>)
    for (const [peer, messages] of Object.entries(stored)) {
      // Disappearing messages whose time came while the app was closed go now (and from storage with the next save).
      if (messages.some((m) => expired(m))) dirty.add(peer)
      const checked = messages.filter((m) => !expired(m)).map((m): Dm => { const { files, ...rest } = m; const ok = storedFiles(files); return ok ? { ...rest, files: ok } : rest })
      patchConversation(peer, (c) => ({ messages: checked.reduce<Dm[]>(upsert, c.messages) }))
    }
    historyLoaded = true
    applyKeyChanges(resolveKey, [])
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
    // Friend actions come over separately (state/friends.ts), already checked.
    const clean = messages.filter((m) => typeof m?.id === 'string' && typeof m.text === 'string' && typeof m.sentAt === 'number'
      && typeof m.from === 'string' && typeof m.to === 'string' && !m.friend && !expired(m))
    await storage.saveDmConversation(peer, clean.map((m) => storable({ ...m, files: storedFiles(m.files) })))
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
    for (const m of c.messages.filter((m) => !m.pending && !m.error && !expired(m)).slice(-perConversation).reverse()) {
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

type DmListener = (peer: string, dms: Dm[], live: boolean) => void
const dmListeners: DmListener[] = []

/** Called with every decrypted DM that wasn't in the conversation yet (live: just sent, not loaded history). */
export function onDmOpened(listener: DmListener): void {
  dmListeners.push(listener)
}

/** Message requests (state/dmRequests.ts): true when someone's DM is a request or ignored, so it stays quiet. */
let isRequest: (peer: string, request: DmRequestFlag | undefined, serverKey: string) => boolean = () => false
export function setDmRequestCheck(check: typeof isRequest): void {
  isRequest = check
}

/** Every dm.message event from any server. */
async function onDmEvent(wire: WireDm, request: DmRequestFlag | undefined, serverKey: string): Promise<void> {
  await Promise.all([ensurePrekeys(), keysReady()])
  const mine = me()
  const dm = open(wire)
  const peer = dm.from === mine ? dm.to : dm.from
  const known = useDms.getState().conversations[peer]?.messages.some((m) => m.id === dm.id && m.from === dm.from)
  const quiet = dm.from !== mine && isRequest(peer, request, serverKey)
  patchConversation(peer, (c) => ({ messages: upsert(c.messages, dm) }))
  // Unread (state/readState.ts): someone else's message, the first time it arrives (it can come from several servers).
  // Friend actions show in the Friends page instead; message requests wait in their own list, without a sound.
  if (dm.from !== mine && !known && !dm.friend && !quiet) noteMessage(dmConv(peer), { id: dm.id, at: dm.sentAt }, false)
  if (!known) for (const listener of dmListeners) listener(peer, [dm], !quiet)
}

export async function loadConversations(): Promise<void> {
  const mine = me()
  await Promise.all(
    sharedServers(mine).map(async (serverKey) => {
      try {
        const { conversations } = await connectionFor(serverKey)!.request('dm.conversations', {})
        await keysReady()
        for (const c of conversations) c.accountKey = resolveKey(c.accountKey)
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
  await Promise.all([ensurePrekeys(), keysReady()])
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
  const before = useDms.getState().conversations[peer]?.messages ?? []
  const fresh = opened.filter((dm) => !dm.error && !before.some((m) => m.id === dm.id && m.from === dm.from))
  patchConversation(peer, (c) => ({ messages: opened.reduce(upsert, c.messages), loaded: true }))
  if (fresh.length) for (const listener of dmListeners) listener(peer, fresh, false)
}

export function openConversation(peer: string): void {
  useApp.setState({ activeServer: null })
  useDms.setState({ open: { kind: 'dm', peer } })
  seeConversation(dmConv(peer))
  void loadHistory(peer)
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
export async function encryptFor(serverKey: string, peer: string, content: DmContent, sentAt = Date.now(), expires?: number): Promise<DmEnvelope> {
  const identity = useApp.getState().identity
  if (!identity) throw new DmError(t('dms.errors.noAccount'))
  const mine = me()
  const [theirs, ours, ownRevoked] = await Promise.all([bundleOf(serverKey, peer), bundleOf(serverKey, mine), ownRevokedDevices(), ensurePrekeys()])
  const revokedDevices = [...revokedSet(peer, theirs.revoked), ...revokedSet(mine, ours.revoked), ...ownRevoked]
  return encryptDm(identity, peer, theirs.devices, peer === mine ? [] : ours.devices, content, sentAt, {
    prekeys: [...(theirs.prekeys ?? []), ...(ours.prekeys ?? [])],
    revokedDevices,
    ...(expires ? { expires } : {}),
  })
}

/** The disappearing messages timer a DM sends with (state/disappearing.ts sets it; 0 = off). */
let expiryFor: (peer: string) => number = () => 0
export function setDmExpiry(fn: (peer: string) => number): void {
  expiryFor = fn
}

/** Drops disappearing messages whose time has come, from the screen and from this device's storage. */
export function purgeExpiredDms(now = Date.now()): void {
  for (const [peer, c] of Object.entries(useDms.getState().conversations)) {
    if (c.messages.some((m) => expired(m, now))) patchConversation(peer, (conv) => ({ messages: conv.messages.filter((m) => !expired(m, now)) }))
  }
}

export async function sendDm(peer: string, text: string, extra: Pick<DmContent, 'call' | 'forward' | 'files' | 'disappear'> = {}): Promise<void> {
  const identity = useApp.getState().identity
  const mine = me()
  // Attachments live on one server: the message goes through that one, so the server can link them to it.
  const shared = sharedServers(peer)
  const route = extra.files?.length ? shared.find((s) => s === extra.files![0].server) : shared[0]
  const tempId = `pending-${Date.now()}-${Math.random()}`
  // A timer change line never disappears itself; everything else follows the conversation's timer.
  const expires = extra.disappear ? 0 : expiryFor(peer)
  const pending: Dm = { id: tempId, from: mine, to: peer, text, sentAt: Date.now(), pending: 'sending', ...extra }
  patchConversation(peer, (c) => ({ messages: upsert(c.messages, pending) }))

  let id = tempId
  const isOurs = (m: Dm) => m.id === id && m.from === mine
  try {
    if (!identity || !route) throw new DmError(t('dms.errors.noSharedServer'))
    const kt = await gossip?.attach(peer).catch(() => undefined)
    const envelope = await encryptFor(route, peer, { text, ...extra, ...(kt ? { kt } : {}) }, Date.now(), expires || undefined)
    // The placeholder takes the real id before sending, so our own dm.message echo (which can arrive before the
    // request's result) merges into it instead of showing the message twice.
    const sent: Dm = {
      id: envelope.header.id, from: mine, to: peer, text, sentAt: envelope.header.sentAt, ...extra,
      ...(expires ? { expiresAt: envelope.header.sentAt + expires * 1000 } : {}),
    }
    patchConversation(peer, (c) => ({ messages: upsert(c.messages.filter((m) => !isOurs(m)), { ...sent, pending: 'sending' }) }))
    id = sent.id
    await connectionFor(route)!.request('dm.send', { accountKey: peer, envelope, ...(extra.files?.length ? { files: extra.files.map((f) => f.id) } : {}) })
    patchConversation(peer, (c) => ({ messages: upsert(c.messages.filter((m) => !isOurs(m)), sent) }))
  } catch (e) {
    patchConversation(peer, (c) => ({
      messages: c.messages.map((m) => (isOurs(m) ? { ...m, pending: 'failed' as const, error: dmErrorText(e) } : m)),
    }))
  }
}

/** Key transparency gossip rides along in DMs (state/kt.ts): a signed digest out, a checked one in. */
let gossip: { attach(peer: string): Promise<Record<string, unknown> | undefined>; receive(from: string, to: string, raw: Record<string, unknown>): void } | null = null
export function setDmGossip(handler: NonNullable<typeof gossip>): void {
  gossip = handler
}

export function discardDm(peer: string, id: string): void {
  patchConversation(peer, (c) => ({ messages: c.messages.filter((m) => !(m.id === id && m.pending)) }))
}

onServerEvent((server, type, body) => {
  if (type === 'dm.message') {
    const { message, request } = body as { message: WireDm; request?: DmRequestFlag }
    void onDmEvent(message, request === 'request' || request === 'ignored' ? request : undefined, server)
  }
  // Someone's device list changed: fetch fresh bundles next time.
  if (type === 'device.revoked') deviceCache.clear()
})
onWelcomeHook(() => void loadConversations())
// Local history loads once there's an identity (right after boot, or after onboarding/linking).
useApp.subscribe((state) => {
  if (state.phase === 'ready' && !historyLoaded) void loadLocalHistory()
})

// ── Account key changes ─────────────────────────────────────────────────────

/**
 * Someone (or this account) moved to a new account key: conversations, messages and friends follow
 * <paramref name="resolve"/>, and each person in <paramref name="changes"/> gets a "safety number changed" notice.
 */
const keyListeners: ((resolve: (key: string) => string) => void)[] = []

/** Called when account keys move (friends.ts moves its entries along). */
export function onKeyChanges(listener: (resolve: (key: string) => string) => void): void {
  keyListeners.push(listener)
}

export function applyKeyChanges(resolve: (key: string) => string, changes: (Rotation & { disputed?: boolean })[]): void {
  for (const listener of keyListeners) listener(resolve)
  const mine = me()
  const before = useDms.getState()
  const moved: string[] = []
  const conversations: Record<string, Conversation> = {}
  for (const [peer, c] of Object.entries(before.conversations)) {
    const target = resolve(peer)
    if (target !== peer) {
      moved.push(peer)
      moveConversation(dmConv(peer), dmConv(target))
    }
    const messages = c.messages.map((m) => ({ ...m, from: resolve(m.from), to: resolve(m.to) }))
    const into = conversations[target]
    conversations[target] = into
      ? { messages: messages.reduce(upsert, into.messages), loaded: into.loaded || c.loaded }
      : { ...c, messages: messages.reduce<Dm[]>(upsert, []) }
  }
  for (const change of changes) {
    const peer = resolve(change.newKey)
    if (peer === mine || !conversations[peer]) continue
    const notice: Dm = {
      id: `key-${change.newKey.slice(0, 20)}`, from: peer, to: mine, text: '', sentAt: change.rotatedAt,
      notice: change.disputed ? 'key-disputed' : 'key-changed',
    }
    conversations[peer] = { ...conversations[peer], messages: upsert(conversations[peer].messages, notice) }
  }
  const open = before.open.kind === 'dm' ? { kind: 'dm' as const, peer: resolve(before.open.peer) } : before.open
  useDms.setState({ conversations, open })
  if (!historyLoaded) return
  for (const peer of Object.keys(conversations)) persist(peer)
  for (const peer of moved) void storage.deleteDmConversation(peer).catch(() => undefined)
}
