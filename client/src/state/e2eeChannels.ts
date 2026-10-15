// End-to-end encrypted channels (see core/channelChain.ts for the crypto, PROTOCOL.md "End-to-end encrypted channels").
//
// This device keeps, per encrypted channel: the membership chain it verified, the epoch keys it received (sealed at rest
// in the vault), and a local copy of decrypted messages for search and catch-up. Messages arrive through the normal chat
// paths (store.ts) with an `e2ee` envelope and empty text; a subscription here decrypts them in place. Sending, edits,
// uploads and voice keys go through hooks so the shared files only grow a line each.
//
// Membership follows the channel's read permission: when the server says who should be added or removed (`echan.get`
// → want), one member's app (the first online one, others wait a little and find nothing left to do) signs the change and
// hands out a fresh key to the new member list.
import { create } from 'zustand'
import { b64u, fromB64u } from '../core/crypto'
import { revokedSet } from '../core/devices'
import { DmError } from '../core/dm'
import type { DmFile } from '../core/dmFiles'
import { isExpiry, localExpiry } from '../core/disappear'
import {
  decryptChannelMessage, encryptChannelMessage, MAX_CHANNEL_MEMBERS, MissingKeyError, newChainId, newEpochKey, openEpochKey, sealEpochKey,
  signChannelChange, verifyChannelChain, voiceKey, voiceKeyIndex,
  type ChannelAction, type ChannelChange, type ChannelContent, type ChannelEnvelope, type ChannelKeyEnvelope, type ChannelView, type MemberDevices,
} from '../core/channelChain'
import { GroupBehindError, GroupError, sameKey, type GroupChange } from '../core/group'
import { RequestError, roleRank, type Channel, type Events, type FileInfo, type Message, type Requests, type Role, type SearchRequest, type SearchResult } from '../core/protocol'
import * as storage from '../core/storage'
import { ensurePrekeys, ownRevokedDevices } from './devices'
import { bundleOf } from './dms'
import { uploadDmFile } from './dmFiles'
import { notifyChannelMessage } from './notify'
import { knownThread } from './threads'
import { connectionFor, onChannelsGone, onServerEvent, onWelcomeHook, patchServer, setChannelSender, uploadFile, useApp, type PendingMessage } from './store'
import { acceptStartOver, CHAIN_REPLACED, chainFor, receiveChain, type ChainState, type PastChain } from './e2eeStartOver'
import { checkSeen, noteSeen, ROLLED_BACK, seenIndex, type Seen } from './e2eeIntegrity'
import { setChannelVoiceKeys, setCallKey, useVoice } from './voice'

/** What the UI shows about an encrypted channel. */
export interface ChannelCrypto {
  members: string[]
  version: number
  /** This device holds the key of the current version (it can read and write new messages). */
  hasKey: boolean
  /** The chain didn't verify or contradicts what this device saw; sending stays off. */
  problem?: string
  /** More people can read the channel than fit (the server keeps the rest waiting). */
  full?: boolean
  /** A different chain the server showed while you're in this one: you may start over by hand (see e2eeStartOver.ts). */
  offer?: { chain: string; members: string[]; changes: ChannelChange[] }
  /** When you started this channel's encryption over (newest last). */
  restarts: number[]
}

export const useE2ee = create<{ channels: Record<string, ChannelCrypto> }>(() => ({ channels: {} }))

/** A decrypted message as kept on this device, for search and catch-up, with what its envelopes said (e2eeIntegrity.ts). */
export interface LocalMessage extends Seen {
  id: number
  channelId: number
  author: string
  text: string
  at: number
  /** When it disappears from this device (the sooner of the server's time and the signed header's). */
  expiresAt?: number
}

/** Gone already (a disappearing message whose time is up). */
const expired = (m: { expiresAt?: number | null }, now = Date.now()) => typeof m.expiresAt === 'number' && m.expiresAt <= now

interface StoredPast {
  chain: string
  changes: GroupChange[]
  keys: Record<number, string>
  endedAt: number
  startedOver: boolean
}

interface Stored {
  chain: string
  changes: GroupChange[]
  keys: Record<number, string>
  messages: LocalMessage[]
  /** Chains used before a start-over (or before this account was out of the channel), for old messages. */
  past?: StoredPast[]
  restarts?: ChainState['restarts']
}

interface Rec extends ChainState {
  slot: string
  serverKey: string
  channelId: number
  messages: Map<number, LocalMessage>
  /** Which message each envelope id belongs to (built from `messages` when first needed). */
  envelopeIds?: Map<string, number>
}

const keysIn = (stored: Record<number, string> | undefined) => new Map(Object.entries(stored ?? {}).map(([v, k]) => [Number(v), fromB64u(k)] as const))
const keysOut = (keys: Map<number, Uint8Array>) => Object.fromEntries([...keys].map(([v, k]) => [v, b64u(k)]))

const MAX_LOCAL = 5000
const records = new Map<string, Rec>()
const loading = new Map<string, Promise<Rec>>()
/** How many times each slot was forgotten: a load that started before is thrown away (see forgetSlot). */
const forgets = new Map<string, number>()

export const slotOf = (serverKey: string, channelId: number) => `${serverKey}:${channelId}`

const me = () => {
  const identity = useApp.getState().identity
  return identity ? b64u(identity.account.publicKey) : ''
}

/** The encrypted channel a channel or thread belongs to (threads use their parent's chain), or null. */
export function encryptedChannel(serverKey: string, channelId: number): Channel | null {
  const server = useApp.getState().servers[serverKey]
  if (!server) return null
  const parent = knownThread(serverKey, channelId)?.channelId ?? channelId
  const channel = server.channels.find((c) => c.id === parent)
  return channel?.e2ee ? channel : null
}

export const isEncrypted = (serverKey: string, channelId: number) => !!encryptedChannel(serverKey, channelId)

// ── The local copy ─────────────────────────────────────────────────────────

function publish(rec: Rec, full?: boolean): void {
  const view = rec.view
  useE2ee.setState((s) => ({
    channels: {
      ...s.channels,
      [rec.slot]: {
        members: view?.members ?? [], version: view?.version ?? 0, hasKey: !!view && rec.keys.has(view.version), problem: rec.problem,
        full: full ?? s.channels[rec.slot]?.full,
        ...(rec.offer ? { offer: { chain: rec.offer.chain, members: rec.offer.view.members, changes: rec.offer.view.changes } } : {}),
        restarts: rec.restarts.map((r) => r.at),
      },
    },
  }))
}

async function load(serverKey: string, channelId: number): Promise<Rec> {
  const slot = slotOf(serverKey, channelId)
  const known = records.get(slot)
  if (known) return known
  let running = loading.get(slot)
  if (!running) {
    running = (async () => {
      const rec: Rec = { slot, serverKey, channelId, chain: null, changes: [], view: null, keys: new Map(), messages: new Map(), past: [], offer: null, restarts: [] }
      const generation = forgets.get(slot) ?? 0
      let stored = await storage.loadE2ee<Stored>(slot).catch(() => undefined)
      if ((forgets.get(slot) ?? 0) !== generation) stored = undefined // the channel went meanwhile
      if (stored?.chain) {
        try {
          rec.view = verifyChannelChain(stored.chain, stored.changes)
          rec.chain = stored.chain
          rec.changes = stored.changes
          rec.keys = keysIn(stored.keys)
          // Disappearing messages whose time came while the app was closed aren't loaded (and leave storage with the next save).
          for (const m of stored.messages ?? []) if (!expired(m)) rec.messages.set(m.id, m)
          if ((stored.messages ?? []).some((m) => expired(m))) persist(rec)
          rec.restarts = stored.restarts ?? []
          for (const p of stored.past ?? []) {
            try {
              rec.past.push({ ...p, view: verifyChannelChain(p.chain, p.changes), keys: keysIn(p.keys) } satisfies PastChain)
            } catch {
              /* a damaged old chain: its messages stay unreadable */
            }
          }
        } catch {
          /* a damaged copy: start again from the server */
        }
      }
      records.set(slot, rec)
      publish(rec)
      return rec
    })().finally(() => loading.delete(slot))
    loading.set(slot, running)
  }
  return running
}

const dirty = new Set<string>()
let saveTimer: ReturnType<typeof setTimeout> | null = null

/** A channel that's gone: its chain, keys and decrypted messages leave this device. */
function forgetSlot(serverKey: string, channelId: number): void {
  const slot = slotOf(serverKey, channelId)
  forgets.set(slot, (forgets.get(slot) ?? 0) + 1)
  records.delete(slot)
  loading.delete(slot)
  dirty.delete(slot)
  useE2ee.setState((s) => {
    if (!(slot in s.channels)) return s
    const channels = { ...s.channels }
    delete channels[slot]
    return { channels }
  })
  void storage.deleteE2ee(slot).catch(() => undefined)
}

onChannelsGone((serverKey, channelIds) => {
  for (const id of channelIds) forgetSlot(serverKey, id)
})

function persist(rec: Rec): void {
  dirty.add(rec.slot)
  saveTimer ??= setTimeout(() => {
    saveTimer = null
    for (const slot of [...dirty]) {
      dirty.delete(slot)
      const r = records.get(slot)
      if (!r?.chain) continue
      const messages = [...r.messages.values()].filter((m) => !expired(m)).sort((a, b) => a.id - b.id).slice(-MAX_LOCAL)
      const stored: Stored = {
        chain: r.chain, changes: r.changes, keys: keysOut(r.keys), messages, restarts: r.restarts,
        past: r.past.map((p) => ({ chain: p.chain, changes: p.changes, keys: keysOut(p.keys), endedAt: p.endedAt, startedOver: p.startedOver })),
      }
      void storage.saveE2ee(slot, stored).catch(() => undefined)
    }
  }, 500)
}

// ── Chain and keys ─────────────────────────────────────────────────────────

export { CHAIN_REPLACED, mayReplaceChain } from './e2eeStartOver'

/**
 * Adds verified changes. A different chain id means the channel was started over (everyone before lost access); while
 * this account is still in its verified chain that is only ever an offer (see e2eeStartOver.ts).
 */
function applyChanges(rec: Rec, chain: string, changes: GroupChange[]): void {
  receiveChain(rec, chain, changes, me())
}

function openKeys(rec: Rec, envelopes: ChannelKeyEnvelope[]): boolean {
  const identity = useApp.getState().identity
  if (!identity || !rec.view) return false
  let added = false
  for (const envelope of envelopes) {
    try {
      const { version, key } = openEpochKey(identity, envelope, rec.view)
      if (!rec.keys.has(version)) {
        rec.keys.set(version, key)
        added = true
      }
    } catch {
      /* not for this device, or not verifiable: skipped */
    }
  }
  if (added) void voiceKeyChanged(rec)
  return added
}

const syncing = new Map<string, Promise<void>>()

/** Fetches what's new in the chain and the keys for this device, then fixes membership if it's this app's turn. */
export function syncChannel(serverKey: string, channelId: number): Promise<void> {
  const slot = slotOf(serverKey, channelId)
  let running = syncing.get(slot)
  if (!running) {
    running = (async () => {
      const connection = connectionFor(serverKey)
      if (!connection?.isOnline) return
      await ensurePrekeys()
      const rec = await load(serverKey, channelId)
      let reply: Requests['echan.get'][1]
      try {
        reply = await connection.request('echan.get', { channelId, since: rec.view && rec.chain ? rec.view.version : 0 })
        if (rec.chain && reply.e2ee.chain !== rec.chain) reply = await connection.request('echan.get', { channelId, since: 0 })
      } catch {
        return // gone, or not readable any more
      }
      if (!rec.view || reply.e2ee.chain !== rec.chain || reply.e2ee.version > rec.view.version) applyChanges(rec, reply.e2ee.chain, reply.changes)
      const view = rec.view
      if (view && view.chain === reply.e2ee.chain && view.version === reply.e2ee.version && (view.head !== reply.e2ee.head || view.members.join() !== reply.e2ee.members.join()))
        rec.problem = "The server's member list doesn't match the channel's signed history."
      await fetchKeys(rec)
      publish(rec, reply.want.full)
      persist(rec)
      redecrypt(serverKey)
      maybeMaintain(rec, reply.want)
      maybeRestart(rec, reply.want)
    })().finally(() => syncing.delete(slot))
    syncing.set(slot, running)
  }
  return running
}

async function fetchKeys(rec: Rec): Promise<void> {
  const connection = connectionFor(rec.serverKey)
  if (!connection || !rec.view) return
  const have = [...rec.keys.keys()]
  let since = have.length ? Math.max(...have) + 1 : 1
  if (since > rec.view.version) return
  for (let page = 0; page < 5; page++) {
    const { keys, hasMore } = await connection.request('echan.keys', { channelId: rec.channelId, since }).catch(() => ({ keys: [], hasMore: false }))
    openKeys(rec, keys.map((k) => k.envelope))
    if (!hasMore || keys.length === 0) break
    since = keys[keys.length - 1].version
  }
}

/** Every device of every account in `members`, fetched a few at a time (the server limits requests). */
async function devicesOf(serverKey: string, members: string[]): Promise<{ bundles: MemberDevices[]; prekeys: import('../core/devices').SignedPrekey[]; revoked: string[] }> {
  const out: { accountKey: string; bundle: Awaited<ReturnType<typeof bundleOf>> }[] = []
  for (let i = 0; i < members.length; i += 4) {
    const part = await Promise.all(members.slice(i, i + 4).map((accountKey) => bundleOf(serverKey, accountKey).then((bundle) => ({ accountKey, bundle }))))
    out.push(...part)
  }
  const own = await ownRevokedDevices()
  return {
    bundles: out.map((b) => ({ accountKey: b.accountKey, devices: b.bundle.devices })),
    prekeys: out.flatMap((b) => b.bundle.prekeys ?? []),
    revoked: [...own, ...out.flatMap((b) => [...revokedSet(b.accountKey, b.bundle.revoked)])],
  }
}

/** Signs a change, makes a new epoch key for the new member list and sends both (more key envelopes after). */
async function change(rec: Rec, action: ChannelAction, targets: string[]): Promise<void> {
  const identity = useApp.getState().identity
  const connection = connectionFor(rec.serverKey)
  if (!identity || !connection || !rec.view || !rec.chain) throw new GroupError('This channel isn’t ready yet.')
  for (let attempt = 0; ; attempt++) {
    const view = rec.view!
    const signed = signChannelChange(identity, view, rec.chain!, action, targets)
    const next = verifyChannelChain(rec.chain!, [signed], view)
    const key = newEpochKey()
    const { bundles, prekeys, revoked } = await devicesOf(rec.serverKey, next.members)
    await ensurePrekeys()
    const envelopes = sealEpochKey(identity, next, key, bundles, Date.now(), { prekeys, revokedDevices: revoked })
    try {
      await connection.request('echan.change', { channelId: rec.channelId, change: signed, keys: envelopes.slice(0, 1) })
    } catch (e) {
      if (e instanceof RequestError && e.code === 'conflict' && attempt === 0) {
        await syncChannel(rec.serverKey, rec.channelId)
        continue
      }
      throw e
    }
    applyChanges(rec, rec.chain!, [signed])
    rec.keys.set(next.version, key)
    for (const extra of envelopes.slice(1)) await connection.request('echan.keys.add', { channelId: rec.channelId, version: next.version, keys: [extra] })
    publish(rec)
    persist(rec)
    void voiceKeyChanged(rec)
    return
  }
}

const maintaining = new Set<string>()
const lastHeal = new Map<string, number>()

/**
 * Brings the chain in line with who can read the channel. The first chain member who is online goes at once; the rest
 * wait a bit longer each and usually find nothing left to do. Removals go first. A member whose device has no key for
 * the current version (a new device) hands out a fresh one after a while.
 */
function maybeMaintain(rec: Rec, want: { add: string[]; remove: string[] }): void {
  const mine = me()
  const view = rec.view
  if (!view || rec.problem || !view.members.includes(mine) || maintaining.has(rec.slot)) return
  const remove = want.remove.filter((k) => view.members.includes(k))
  const add = want.add.filter((k) => !view.members.includes(k)).slice(0, MAX_CHANNEL_MEMBERS - (view.members.length - remove.length))
  const needKey = !rec.keys.has(view.version)
  if (remove.length === 0 && add.length === 0 && !needKey) return
  const server = useApp.getState().servers[rec.serverKey]
  const online = view.members.filter((k) => k === mine || server?.members[k]?.online)
  const rank = Math.max(0, online.indexOf(mine))
  const delay = needKey && remove.length === 0 && add.length === 0 ? 4000 : 300 + rank * 2500 + Math.random() * 500
  maintaining.add(rec.slot)
  setTimeout(() => {
    void (async () => {
      try {
        // Look again: someone else may have done it meanwhile.
        const fresh = await connectionFor(rec.serverKey)?.request('echan.get', { channelId: rec.channelId, since: rec.view?.version ?? 0 })
        if (!fresh) return
        if (fresh.e2ee.version > (rec.view?.version ?? 0)) {
          applyChanges(rec, fresh.e2ee.chain, fresh.changes)
          await fetchKeys(rec)
        }
        const v = rec.view
        if (!v || !v.members.includes(mine)) return
        const removeNow = fresh.want.remove.filter((k) => v.members.includes(k))
        if (removeNow.length) await change(rec, 'remove', removeNow)
        const v2 = rec.view!
        const addNow = fresh.want.add.filter((k) => !v2.members.includes(k)).slice(0, MAX_CHANNEL_MEMBERS - v2.members.length)
        if (addNow.length) await change(rec, 'add', addNow)
        if (!rec.keys.has(rec.view!.version) && Date.now() - (lastHeal.get(rec.slot) ?? 0) > 60_000) {
          lastHeal.set(rec.slot, Date.now())
          await change(rec, 'rekey', [])
        }
      } catch {
        /* the next sync tries again */
      } finally {
        maintaining.delete(rec.slot)
        publish(rec)
        redecrypt(rec.serverKey)
      }
    })()
  }, delay)
}

/** Hands out a new key to the current members (e.g. after removing one of your devices). */
export async function rekeyChannel(serverKey: string, channelId: number): Promise<void> {
  const rec = await load(serverKey, channelId)
  await syncChannel(serverKey, channelId)
  await change(rec, 'rekey', [])
}

// ── Starting over ──────────────────────────────────────────────────────────

const restarting = new Set<string>()

/**
 * Nobody in the chain can read the channel any more (they all lost access or left), so nobody can add the people who
 * can: one of them starts a new chain (a `create` with a new id). The first online reader goes; the others find it done.
 * Never from a device whose account is in the verified chain: the server refuses that anyway while any member can read.
 */
function maybeRestart(rec: Rec, want: { add: string[]; remove: string[]; full: boolean }): void {
  const mine = me()
  const view = rec.view
  if (!view || rec.problem || rec.offer || want.full || restarting.has(rec.slot)) return
  if (view.members.some((m) => sameKey(m, mine)) || !want.add.includes(mine) || !view.members.every((m) => want.remove.includes(m))) return
  const server = useApp.getState().servers[rec.serverKey]
  const online = want.add.filter((k) => k === mine || server?.members[k]?.online)
  const delay = 500 + Math.max(0, online.indexOf(mine)) * 2500 + Math.random() * 500
  restarting.add(rec.slot)
  setTimeout(() => {
    void (async () => {
      try {
        const connection = connectionFor(rec.serverKey)
        const identity = useApp.getState().identity
        if (!connection || !identity) return
        const fresh = await connection.request('echan.get', { channelId: rec.channelId, since: 0 })
        if (fresh.e2ee.chain !== rec.chain) return // someone else started it over meanwhile
        const { add, remove, full } = fresh.want
        if (full || !add.includes(mine) || !fresh.e2ee.members.every((m) => remove.includes(m))) return
        const chain = newChainId()
        const signed = signChannelChange(identity, null, chain, 'create', add.filter((k) => k !== mine))
        const next = verifyChannelChain(chain, [signed])
        const key = newEpochKey()
        const { bundles, prekeys, revoked } = await devicesOf(rec.serverKey, next.members)
        await ensurePrekeys()
        const envelopes = sealEpochKey(identity, next, key, bundles, Date.now(), { prekeys, revokedDevices: revoked })
        await connection.request('echan.change', { channelId: rec.channelId, change: signed, keys: envelopes.slice(0, 1) })
        applyChanges(rec, chain, [signed])
        rec.keys.set(1, key)
        for (const extra of envelopes.slice(1)) await connection.request('echan.keys.add', { channelId: rec.channelId, version: 1, keys: [extra] })
        publish(rec)
        persist(rec)
      } catch {
        /* someone else was quicker, or it's no longer needed: the next sync shows */
      } finally {
        restarting.delete(rec.slot)
        void syncChannel(rec.serverKey, rec.channelId)
      }
    })()
  }, delay)
}

/**
 * The person chose to start over with the chain the server offers (after the warning and the signer check in the
 * encryption panel). The old chain and its keys stay for old messages; the choice is recorded with the channel. Then
 * this device signs a new key in the new chain, so the others see that you joined it and later restarts list you as a
 * signer they know.
 */
export async function startOver(serverKey: string, channelId: number, offeredChain: string): Promise<void> {
  const rec = await load(serverKey, channelId)
  if (!rec.offer || rec.offer.chain !== offeredChain) throw new GroupError('This channel’s encryption changed again. Look at it once more.')
  if (!rec.offer.view.members.some((m) => sameKey(m, me()))) throw new GroupError("You're not in this channel's encryption.")
  acceptStartOver(rec)
  publish(rec)
  persist(rec)
  await syncChannel(serverKey, channelId)
  await fetchKeys(rec)
  try {
    await change(rec, 'rekey', [])
  } catch {
    /* the old key works too; a later sync hands out a new one if needed */
  }
  publish(rec)
  persist(rec)
  redecrypt(serverKey)
}

// ── Creating ───────────────────────────────────────────────────────────────

export interface NewChannel {
  name: string
  kind: 'text' | 'voice' | 'whiteboard'
  readRole: Role
  writeRole: Role
  categoryId?: number
}

/** People who will be able to read a new channel with these roles: members (not bots) at or above `readRole`, you first. */
export function readersFor(serverKey: string, readRole: Role): string[] {
  const server = useApp.getState().servers[serverKey]
  if (!server?.me) return []
  const mine = server.me.accountKey
  const others = Object.values(server.members)
    .filter((m) => m.accountKey !== mine && !m.bot && roleRank(m.role) >= roleRank(readRole))
    .map((m) => m.accountKey)
  return [mine, ...others]
}

/** Creates an encrypted channel: the first change of its chain and its first key travel with channel.create. */
export async function createEncryptedChannel(serverKey: string, spec: NewChannel): Promise<Channel> {
  const identity = useApp.getState().identity
  const connection = connectionFor(serverKey)
  if (!identity || !connection) throw new DmError("This server isn't connected right now.")
  const readers = readersFor(serverKey, spec.readRole)
  if (readers.length > MAX_CHANNEL_MEMBERS) throw new GroupError(`At most ${MAX_CHANNEL_MEMBERS} people can be in an encrypted channel.`)
  const chain = newChainId()
  const signed = signChannelChange(identity, null, chain, 'create', readers.slice(1))
  const view = verifyChannelChain(chain, [signed])
  const key = newEpochKey()
  const { bundles, prekeys, revoked } = await devicesOf(serverKey, readers)
  await ensurePrekeys()
  const envelopes = sealEpochKey(identity, view, key, bundles, Date.now(), { prekeys, revokedDevices: revoked })
  const { channel } = await connection.request('channel.create', { ...spec, e2ee: { change: signed, keys: envelopes.slice(0, 1) } } as never) as { channel: Channel }
  for (const extra of envelopes.slice(1)) await connection.request('echan.keys.add', { channelId: channel.id, version: 1, keys: [extra] })
  const rec = await load(serverKey, channel.id)
  applyChanges(rec, chain, [signed])
  rec.keys.set(1, key)
  publish(rec)
  persist(rec)
  return channel
}

// ── Reading messages ───────────────────────────────────────────────────────

/** Fields this app adds to a message of an encrypted channel once it tried to decrypt it. */
export interface Shown {
  state: 'ok' | 'pending' | 'error'
  files?: DmFile[]
  error?: string
  /** No key yet for an epoch this account was in: tried again when keys arrive. */
  retry?: boolean
  /** Sent in the older format, not bound to its channel or thread. */
  legacy?: boolean
  /** It claims a time after its sender lost access to the channel (then): not shown as really theirs. */
  afterRemoval?: number
  /** The channel's chain version it was checked against (a later removal means checking it again). */
  checked?: number
}

type Shownable = PendingMessage & { e2eeShown?: Shown }

export const shownOf = (m: Message): Shown | undefined => (m as Shownable).e2eeShown

const processed = new WeakSet<object>()
const waitingSync = new Set<string>()
/** Messages that arrived live (not from history), so they may notify once they're readable. */
const live = new Set<string>()

/** Where the server put a message: the encrypted channel, and the thread if it's in one. */
const placeOf = (channel: Channel, channelId: number) => ({ channel: channel.id, ...(channelId !== channel.id ? { thread: channelId } : {}) })

/** `lenient`: a copy kept elsewhere (pins, a thread's root) may be older than the newest edit this device saw. */
function decryptOne(serverKey: string, message: Shownable, lenient = false): Shownable {
  const env = message.e2ee
  if (!env) return message
  const channel = encryptedChannel(serverKey, message.channelId)
  const rec = channel ? records.get(slotOf(serverKey, channel.id)) : undefined
  if (!channel || !rec) {
    if (channel) void load(serverKey, channel.id).then(() => redecrypt(serverKey))
    return { ...message, e2eeShown: { state: 'pending' } }
  }
  if (!rec.view) {
    requestSync(serverKey, channel.id)
    return { ...message, e2eeShown: { state: 'pending' } }
  }
  // The chain it was sent under: the current one, or one kept from before a start-over.
  const header = (env.envelope as Partial<ChannelEnvelope> | undefined)?.header
  const sentIn = typeof header?.chain === 'string' ? header.chain : rec.view.chain
  const found = chainFor(rec, sentIn)
  if (!found) {
    // A chain you could start over to (tried again once you do), one this device hasn't caught up with, or an old one.
    if (rec.offer?.chain === sentIn) return { ...message, e2eeShown: { state: 'error', error: CHAIN_REPLACED, retry: true } }
    if (!waitingSync.has(rec.slot)) {
      requestSync(serverKey, channel.id)
      return { ...message, e2eeShown: { state: 'pending' } }
    }
    live.delete(`${serverKey}:${message.id}`)
    return { ...message, e2eeShown: { state: 'error', error: BEFORE_YOU_JOINED } }
  }
  try {
    const routed = { from: message.author, version: env.version, ...placeOf(channel, message.channelId), at: message.createdAt }
    const content = decryptChannelMessage(env.envelope, routed, found.view, (v) => found.keys.get(v), found.endedAt)
    // Replayed under another message, an edit moved to another message, or an edit rolled back (security review L13).
    const seen = rec.messages.get(message.id)
    rec.envelopeIds ??= seenIndex(rec.messages.values())
    const problem = checkSeen(seen, (hid) => rec.envelopeIds!.get(hid), message.id, content.header, content.legacy)
    if (problem && !(lenient && problem === ROLLED_BACK)) throw new DmError(problem)
    // An edit never moves the expiry: the sooner of every copy this device saw counts.
    const expiresAt = [localExpiry(message.expiresAt, content.header, message.createdAt), seen?.expiresAt]
      .filter((x): x is number => typeof x === 'number').reduce<number | undefined>((a, b) => (a === undefined ? b : Math.min(a, b)), undefined)
    if (!problem) {
      const noted = noteSeen(seen, content.header, content.legacy)
      for (const h of noted.hids ?? []) rec.envelopeIds.set(h, message.id)
      if (noted.origin) rec.envelopeIds.set(noted.origin, message.id)
      rec.messages.set(message.id, {
        ...noted, id: message.id, channelId: message.channelId, author: message.author, text: content.text, at: message.createdAt,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      })
      persist(rec)
    }
    const reply = message.replyTo && 'author' in message.replyTo && !message.replyTo.text ? rec.messages.get(message.replyTo.id) : undefined
    const flags = { ...(content.legacy ? { legacy: true } : {}), ...(content.afterRemoval !== undefined ? { afterRemoval: content.afterRemoval } : {}) }
    const out: Shownable = {
      ...message, ...(expiresAt !== undefined ? { expiresAt } : {}), text: content.text, e2eeShown: { state: 'ok', ...(content.files ? { files: content.files } : {}), ...flags, checked: rec.view.version },
      ...(reply && message.replyTo && 'author' in message.replyTo ? { replyTo: { ...message.replyTo, text: reply.text.slice(0, 140) } } : {}),
    }
    const tag = `${serverKey}:${message.id}`
    // Never a notification for a message that isn't shown as really from its sender.
    if (live.delete(tag) && content.afterRemoval === undefined) notifyChannelMessage(serverKey, out)
    return out
  } catch (e) {
    const failure = decryptFailure(e, found.view, env.version, me(), waitingSync.has(rec.slot))
    if (failure === 'sync') {
      requestSync(serverKey, channel.id)
      return { ...message, e2eeShown: { state: 'pending' } }
    }
    live.delete(`${serverKey}:${message.id}`)
    return { ...message, e2eeShown: failure }
  }
}

export const BEFORE_YOU_JOINED = 'This message was sent before you could read this channel.'

/**
 * What to show for a message that didn't decrypt, or 'sync' to fetch the chain and keys and try again. A key for an
 * epoch you weren't in never comes (you joined later); one you were in may still be on its way, so it's retried.
 */
export function decryptFailure(e: unknown, view: Pick<ChannelView, 'changes'>, version: number, myKey: string, syncing: boolean): Shown | 'sync' {
  if (e instanceof GroupBehindError) return 'sync'
  if (e instanceof MissingKeyError) {
    const wasIn = !!myKey && !!view.changes.find((c) => c.version === version)?.members.some((m) => sameKey(m, myKey))
    if (!wasIn) return { state: 'error', error: BEFORE_YOU_JOINED }
    return syncing ? { state: 'error', error: (e as Error).message, retry: true } : 'sync'
  }
  return { state: 'error', error: (e as Error).message }
}

/** Loads (and if needed fetches) an encrypted channel's chain and keys, so {@link readable} can decrypt right away. */
export async function prepareChannel(serverKey: string, channelId: number): Promise<void> {
  const channel = encryptedChannel(serverKey, channelId)
  if (!channel) return
  const rec = await load(serverKey, channel.id)
  if (!rec.view || !rec.keys.has(rec.view.version)) await syncChannel(serverKey, channel.id)
}

/** A message as this device can show it (decrypted if it can be), for lists outside the chat (pins, a thread's root). */
export const readable = (serverKey: string, message: Message): Message => (message.e2ee ? decryptOne(serverKey, message as Shownable, true) : message)

function requestSync(serverKey: string, channelId: number): void {
  const slot = slotOf(serverKey, channelId)
  if (waitingSync.has(slot)) return
  waitingSync.add(slot)
  void syncChannel(serverKey, channelId).finally(() => {
    // One round per burst: messages still missing a key after it are shown as such until the next sync.
    setTimeout(() => waitingSync.delete(slot), 3000)
    redecrypt(serverKey)
  })
}

/** Shown, but checked against an older version of the chain (one that may not have had the sender's removal yet). */
function stale(serverKey: string, m: Shownable): boolean {
  if (m.e2eeShown?.state !== 'ok' || m.e2eeShown.checked === undefined) return false
  const channel = encryptedChannel(serverKey, m.channelId)
  const version = channel ? records.get(slotOf(serverKey, channel.id))?.view?.version : undefined
  return version !== undefined && version !== m.e2eeShown.checked
}

const needsWork = (serverKey: string, m: Shownable) =>
  !!m.e2ee && (!m.e2eeShown || m.e2eeShown.state === 'pending' || !!m.e2eeShown.retry || stale(serverKey, m))

/** Decrypts what's waiting in a server's loaded channels (pending ones are tried again). */
function redecrypt(serverKey: string, onlyNew = false): void {
  const server = useApp.getState().servers[serverKey]
  if (!server) return
  const changed: Record<number, PendingMessage[]> = {}
  for (const [id, list] of Object.entries(server.messages)) {
    if (!list.some((m) => (onlyNew ? !!m.e2ee && !(m as Shownable).e2eeShown : needsWork(serverKey, m)))) continue
    changed[Number(id)] = list.map((m) => (needsWork(serverKey, m) && (!onlyNew || !(m as Shownable).e2eeShown) ? decryptOne(serverKey, m) : m))
  }
  if (Object.keys(changed).length === 0) return
  for (const list of Object.values(changed)) processed.add(list)
  patchServer(serverKey, (s) => ({ messages: { ...s.messages, ...changed } }))
}

let scheduled = false
useApp.subscribe((state) => {
  if (state.phase !== 'ready' || scheduled) return
  let work = false
  for (const server of Object.values(state.servers)) {
    for (const list of Object.values(server.messages)) {
      if (processed.has(list)) continue
      processed.add(list)
      if (list.some((m) => !!m.e2ee && !(m as Shownable).e2eeShown)) work = true
    }
  }
  if (!work) return
  scheduled = true
  queueMicrotask(() => {
    scheduled = false
    for (const key of Object.keys(useApp.getState().servers)) redecrypt(key, true)
  })
})

/** Decrypted messages of an encrypted channel kept on this device (for search and catch-up), oldest first. */
export async function localMessages(serverKey: string, channelId: number): Promise<LocalMessage[]> {
  const rec = await load(serverKey, channelId)
  return [...rec.messages.values()].filter((m) => !expired(m)).sort((a, b) => a.id - b.id)
}

/** Drops decrypted copies of disappearing messages whose time has come, from memory and from this device's storage. */
export function purgeExpiredE2ee(now = Date.now()): void {
  for (const rec of records.values()) {
    let changed = false
    for (const [id, m] of rec.messages) {
      if (!expired(m, now)) continue
      rec.messages.delete(id)
      changed = true
    }
    if (changed) persist(rec)
  }
}

/** The disappearing messages timer an encrypted channel sends with (state/disappearing.ts sets it; 0 = off). */
let expiryFor: (serverKey: string, channelId: number) => number = () => 0
export function setE2eeExpiry(fn: (serverKey: string, channelId: number) => number): void {
  expiryFor = fn
}

/**
 * Search in encrypted channels, on the decrypted copies kept on this device (the server only has ciphertext). Every
 * word must appear (case-insensitive); `has: file` can't be answered here, `has: link` looks for a web address.
 */
export async function localSearchResults(serverKey: string, request: SearchRequest): Promise<SearchResult[]> {
  const server = useApp.getState().servers[serverKey]
  if (!server || request.has?.includes('file')) return []
  const scope = request.channelId !== undefined ? encryptedChannel(serverKey, request.channelId) : null
  if (request.channelId !== undefined && !scope) return []
  const channels = scope ? [scope] : server.channels.filter((c) => c.e2ee)
  const words = (request.query ?? '').toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const out: SearchResult[] = []
  for (const channel of channels) {
    for (const m of await localMessages(serverKey, channel.id)) {
      const text = m.text.toLocaleLowerCase()
      if (request.author && m.author !== request.author) continue
      if (request.before !== undefined && m.at >= request.before) continue
      if (request.after !== undefined && m.at <= request.after) continue
      if (request.has?.includes('link') && !/https?:\/\//i.test(m.text)) continue
      if (!words.every((w) => text.includes(w))) continue
      const message: Message = {
        id: m.id, channelId: m.channelId, author: m.author, text: m.text, createdAt: m.at, editedAt: null, attachments: [], replyTo: null, reactions: [],
      }
      out.push({ message, matches: words.map((w) => [text.indexOf(w), w.length] as [number, number]) })
    }
  }
  return out.sort((a, b) => b.message.id - a.message.id).slice(0, 100)
}

// ── Sending ────────────────────────────────────────────────────────────────

/** Encrypted uploads by file id (their keys go inside the message). */
const uploads = new Map<string, DmFile>()

/** Uploads for a channel: encrypted (ciphertext only) in an encrypted channel, else the normal upload. */
export async function uploadFor(serverKey: string, channelId: number, file: File, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<FileInfo> {
  const channel = encryptedChannel(serverKey, channelId)
  if (!channel) return uploadFile(serverKey, file, onProgress, signal)
  const sealed = await uploadDmFile(serverKey, { channelId: channel.id }, file, onProgress, signal)
  uploads.set(sealed.id, sealed)
  // Shown as a plain file chip until the message is confirmed and decrypted.
  return { id: sealed.id, name: sealed.name, size: sealed.size, type: 'application/octet-stream', url: '' } as FileInfo
}

/** Why you can't write in this encrypted channel right now (null: you can), in English (the UI translates it). */
export function cannotWrite(serverKey: string, channelId: number): string | null {
  const channel = encryptedChannel(serverKey, channelId)
  if (!channel) return null
  const state = useE2ee.getState().channels[slotOf(serverKey, channel.id)]
  if (state?.problem) return state.problem
  if (!state?.members.includes(me())) return 'waiting'
  if (!state.hasKey) return 'waiting'
  return null
}

async function readyRec(serverKey: string, channelId: number): Promise<Rec> {
  const rec = await load(serverKey, channelId)
  if (!rec.view || !rec.keys.has(rec.view.version)) await syncChannel(serverKey, channelId)
  if (rec.problem) throw new GroupError(rec.problem)
  if (!rec.view || !rec.keys.has(rec.view.version)) throw new DmError("This device doesn't have this channel's key yet.")
  return rec
}

function contentOf(body: { text: string; attachments?: string[]; voice?: { duration: number; waveform: string } }, files?: DmFile[]): ChannelContent {
  const sealed = files ?? (body.attachments ?? []).map((id) => uploads.get(id)).filter((f): f is DmFile => !!f)
  if ((body.attachments?.length ?? 0) !== sealed.length && !files) throw new DmError('An attachment is missing. Attach it again.')
  const withVoice = body.voice && sealed[0] ? [{ ...sealed[0], voice: body.voice }, ...sealed.slice(1)] : sealed
  return { text: body.text, ...(withVoice.length ? { files: withVoice } : {}) }
}

/** chat.send for an encrypted channel (store.ts calls this first; null: not encrypted). Retries once if the channel changed. */
async function sendSealed(serverKey: string, channelId: number, body: { text: string; attachments?: string[]; replyTo?: number; nonce?: string; voice?: { duration: number; waveform: string }; sticker?: string; gif?: unknown }): Promise<{ message: Message }> {
  const channel = encryptedChannel(serverKey, channelId)!
  if (body.sticker || body.gif) throw new DmError("Stickers and GIFs can't be sent in encrypted channels yet.")
  const identity = useApp.getState().identity!
  const connection = connectionFor(serverKey)!
  for (let attempt = 0; ; attempt++) {
    const rec = await readyRec(serverKey, channel.id)
    const view = rec.view!
    const content = contentOf(body)
    const expires = expiryFor(serverKey, channel.id)
    const envelope = encryptChannelMessage(identity, view, rec.keys.get(view.version)!, content, placeOf(channel, channelId), Date.now(), undefined, expires || undefined)
    try {
      const reply = await connection.request('chat.send', {
        channelId, version: view.version, envelope, replyTo: body.replyTo, nonce: body.nonce,
        ...(content.files?.length ? { files: content.files.map((f) => f.id) } : {}),
      } as never) as { message: Message }
      return reply
    } catch (e) {
      if (e instanceof RequestError && e.code === 'conflict' && attempt === 0) {
        await syncChannel(serverKey, channel.id)
        continue
      }
      throw e
    }
  }
}

setChannelSender((serverKey, channelId, body) => (isEncrypted(serverKey, channelId) ? sendSealed(serverKey, channelId, body) : null))

/** Edits a message in an encrypted channel (keeps its attachments). */
export async function editEncrypted(serverKey: string, message: Message, text: string): Promise<void> {
  const channel = encryptedChannel(serverKey, message.channelId)
  if (!channel) throw new DmError('Not an encrypted channel.')
  const identity = useApp.getState().identity!
  // An edit names the message's first envelope (v2), so a server can't show it under another message.
  const header = (message.e2ee?.envelope as Partial<ChannelEnvelope> | undefined)?.header
  const first = header?.edit ?? header?.id
  // An edit keeps the message's expiry (and its format: apps from before disappearing messages can't read either).
  const expires = isExpiry(header?.expires) ? header.expires : undefined
  for (let attempt = 0; ; attempt++) {
    const rec = await readyRec(serverKey, channel.id)
    const view = rec.view!
    const envelope = encryptChannelMessage(identity, view, rec.keys.get(view.version)!, contentOf({ text }, shownOf(message)?.files), placeOf(channel, message.channelId), Date.now(), first, expires)
    try {
      await connectionFor(serverKey)!.request('chat.edit', { id: message.id, version: view.version, envelope } as never)
      return
    } catch (e) {
      if (e instanceof RequestError && e.code === 'conflict' && attempt === 0) {
        await syncChannel(serverKey, channel.id)
        continue
      }
      throw e
    }
  }
}

// ── Other features sealing under a channel's chain (whiteboards) ─────────────

/** The verified chain and current epoch key, for sealing (fetched first if needed). Throws if this device can't write. */
export async function channelSealKey(serverKey: string, channelId: number): Promise<{ view: ChannelView; key: Uint8Array }> {
  const rec = await readyRec(serverKey, channelId)
  return { view: rec.view!, key: rec.keys.get(rec.view!.version)! }
}

/** The chain an envelope names (the current one or one kept from before a start-over), for opening; syncs once if unknown. */
export async function channelOpenKeys(serverKey: string, channelId: number, chain: string, sync = false): Promise<{ view: ChannelView; keys: Map<number, Uint8Array> } | null> {
  const rec = await load(serverKey, channelId)
  if (sync || !rec.view) await syncChannel(serverKey, channelId)
  return chainFor(rec, chain)
}

// ── Voice ──────────────────────────────────────────────────────────────────

/** The LiveKit key for an encrypted voice channel (null: not encrypted). Throws if this device has no key yet. */
setChannelVoiceKeys(async (serverKey, channelId) => {
  const channel = encryptedChannel(serverKey, channelId)
  if (!channel) return null
  const rec = await readyRec(serverKey, channel.id)
  const v = rec.view!.version
  return { key: voiceKey(rec.keys.get(v)!), index: voiceKeyIndex(v) }
})

/** A new epoch while you're in the channel's voice room: switch the media key (older frames still decrypt). */
async function voiceKeyChanged(rec: Rec): Promise<void> {
  const session = useVoice.getState().session
  if (!session || session.serverKey !== rec.serverKey || session.channelId !== rec.channelId || !rec.view) return
  const key = rec.keys.get(rec.view.version)
  if (key) await setCallKey(voiceKey(key), voiceKeyIndex(rec.view.version))
}

// ── Events ─────────────────────────────────────────────────────────────────

let syncTimer: ReturnType<typeof setTimeout> | null = null
const pendingSyncs = new Set<string>()

/** Permissions may have changed: check each encrypted channel this app is in (debounced). */
function scheduleSyncAll(serverKey: string, delay = 1500): void {
  pendingSyncs.add(serverKey)
  syncTimer ??= setTimeout(() => {
    syncTimer = null
    for (const key of [...pendingSyncs]) {
      pendingSyncs.delete(key)
      for (const c of useApp.getState().servers[key]?.channels ?? []) if (c.e2ee) void syncChannel(key, c.id)
    }
  }, delay)
}

onServerEvent((serverKey, type, body) => {
  if (type === 'echan.changed' || type === 'echan.keys') {
    const { channelId } = body as Events['echan.keys']
    void syncChannel(serverKey, channelId)
  } else if (type === 'channels' || type === 'member.updated' || type === 'member.joined' || type === 'member.removed' || type === 'roles') {
    scheduleSyncAll(serverKey)
  } else if (type === 'chat.message') {
    const { message } = body as Events['chat.message']
    if (message.e2ee && message.author !== me()) live.add(`${serverKey}:${message.id}`)
  } else if (type === 'device.revoked') {
    // One of your devices was removed: it still holds the current keys, so one of your other devices hands out new ones
    // (each waits a moment and skips it if another already did).
    const at = Date.now()
    setTimeout(() => {
      for (const c of useApp.getState().servers[serverKey]?.channels ?? []) {
        if (!c.e2ee) continue
        void syncChannel(serverKey, c.id).then(async () => {
          const rec = records.get(slotOf(serverKey, c.id))
          if (rec?.view?.members.includes(me()) && (rec.view.changes.at(-1)?.at ?? 0) < at) await change(rec, 'rekey', [])
        }).catch(() => undefined)
      }
    }, 500 + Math.random() * 4000)
  }
})

onWelcomeHook((serverKey) => scheduleSyncAll(serverKey, 500))
