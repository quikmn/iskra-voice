// Friends, Discord style: you send a request, they accept (or ignore it), and then you're friends on both sides.
// There's no account server, so requests and answers are signed actions (core/friend.ts) inside ordinary end-to-end
// encrypted DMs: any server you share carries them, servers learn nothing new, and your other devices get a copy
// (your own devices always get one), so the list follows you. The relation is folded from both sides' actions
// (friendMachine.ts) and kept on this device.
import { create } from 'zustand'
import { b64u } from '../core/crypto'
import { DmError } from '../core/dm'
import { friendFallback, signFriend, type FriendAction, type FriendKind } from '../core/friend'
import * as storage from '../core/storage'
import { t } from '../i18n'
import { encryptFor, nameOf, onDmOpened, onKeyChanges, openFriends, sharedServers, useDms, type Dm, type Friend } from './dms'
import { actionFor, addEvent, quietKind, relationOf, sinceOf, type FriendEvent, type Relation } from './friendMachine'
import { keysReady, resolveKey } from './keyMap'
import { isBlocked, setBlocked, useBlocks } from './moderation'
import { show } from './notify'
import { connectionFor, onWelcomeHook, useApp } from './store'

export interface FriendPeer {
  name: string
  events: FriendEvent[]
  relation: Relation
  /** When the current relation began. */
  since: number
}

interface FriendsState {
  peers: Record<string, FriendPeer>
  /** Friends from before requests existed: a request goes out once we share a server. */
  unsent: string[]
  loaded: boolean
}

export const useFriends = create<FriendsState>(() => ({ peers: {}, unsent: [], loaded: false }))

export const relationWith = (peers: Record<string, FriendPeer>, accountKey: string): Relation => peers[accountKey]?.relation ?? 'none'
export const useRelation = (accountKey: string) => useFriends((s) => relationWith(s.peers, accountKey))
export const incomingCount = (peers: Record<string, FriendPeer>) => Object.values(peers).filter((p) => p.relation === 'incoming').length
export const useIncomingCount = () => useFriends((s) => incomingCount(s.peers))

const me = () => {
  const identity = useApp.getState().identity
  return identity ? b64u(identity.account.publicKey) : ''
}

const knownName = (accountKey: string, fallback?: string) => {
  const name = nameOf(accountKey)
  return name === t('common.someone') && fallback ? fallback : name
}

function peerFrom(name: string, events: FriendEvent[]): FriendPeer {
  return { name, events, relation: relationOf(events), since: sinceOf(events) }
}

/** The friends map other parts of the app read (useDms.friends): only people who are friends both ways. */
function publish(): void {
  const friends: Record<string, Friend> = {}
  for (const [accountKey, p] of Object.entries(useFriends.getState().peers)) {
    if (p.relation === 'friends') friends[accountKey] = { accountKey, name: p.name, addedAt: p.since }
  }
  useDms.setState({ friends })
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
function save(): void {
  publish()
  if (!useFriends.getState().loaded) return
  saveTimer ??= setTimeout(() => {
    saveTimer = null
    const { peers, unsent } = useFriends.getState()
    const stored: storage.StoredFriendState = { v: 1, unsent, peers: {} }
    for (const [key, p] of Object.entries(peers)) stored.peers[key] = { name: p.name, events: p.events }
    void storage.saveFriendState(stored).catch(() => undefined)
  }, 200)
}

/** Adds one action to someone's log; returns the relation before and after. */
function record(peer: string, event: FriendEvent): { before: Relation; after: Relation } {
  const current = useFriends.getState().peers[peer]
  const before = current?.relation ?? 'none'
  const events = addEvent(current?.events ?? [], event)
  if (current && events === current.events) return { before, after: before }
  const next = peerFrom(knownName(peer, current?.name), events)
  useFriends.setState((s) => ({ peers: { ...s.peers, [peer]: next } }))
  save()
  return { before, after: next.relation }
}

function unrecord(peer: string, id: string): void {
  const current = useFriends.getState().peers[peer]
  if (!current) return
  useFriends.setState((s) => ({ peers: { ...s.peers, [peer]: peerFrom(current.name, current.events.filter((e) => !(e.id === id && e.mine))) } }))
  save()
}

// ── Loading, and friends from before requests ───────────────────────────────

let loading: Promise<void> | null = null

export function loadFriends(): Promise<void> {
  loading ??= (async () => {
    await keysReady()
    let stored = await storage.loadFriendState().catch(() => undefined)
    if (!stored || stored.v !== 1 || typeof stored.peers !== 'object') stored = await migrate()
    const peers: Record<string, FriendPeer> = {}
    for (const [key, p] of Object.entries(stored.peers)) {
      if (!p || !Array.isArray(p.events)) continue
      const target = resolveKey(key)
      const events = p.events.reduce(addEvent, peers[target]?.events ?? [])
      peers[target] = peerFrom(String(p.name ?? '').slice(0, 64) || t('common.someone'), events)
    }
    const unsent = Array.isArray(stored.unsent) ? stored.unsent.filter((k) => typeof k === 'string').map(resolveKey) : []
    // Anything that arrived while we were loading is merged in.
    useFriends.setState((s) => {
      for (const [key, p] of Object.entries(s.peers)) peers[key] = peerFrom(p.name, p.events.reduce(addEvent, peers[key]?.events ?? []))
      return { peers, unsent: [...new Set([...unsent, ...s.unsent])], loaded: true }
    })
    save()
    void flushUnsent()
  })()
  return loading
}

/** Called again after linking or replacing keys on this device. */
export function reloadFriends(): Promise<void> {
  loading = null
  useFriends.setState({ peers: {}, unsent: [], loaded: false })
  return loadFriends()
}

/**
 * Friends used to be a one-sided list on each device. Each becomes a friend request we send once we share a
 * server with them (until then it shows as a request not sent yet). If they had added us too, the two requests
 * meet and you're friends right away.
 */
async function migrate(): Promise<storage.StoredFriendState> {
  const old = await storage.loadFriends().catch(() => [])
  const state: storage.StoredFriendState = { v: 1, peers: {}, unsent: [] }
  for (const f of old) {
    if (typeof f?.accountKey !== 'string') continue
    state.peers[f.accountKey] = {
      name: String(f.name ?? ''),
      events: [{ id: `local-${f.accountKey.slice(0, 16)}`, kind: 'request', mine: true, at: Number(f.addedAt) || Date.now() }],
    }
    state.unsent.push(f.accountKey)
  }
  return state
}

let flushing = false
async function flushUnsent(): Promise<void> {
  if (flushing) return
  flushing = true
  try {
    for (const peer of useFriends.getState().unsent) {
      const relation = relationWith(useFriends.getState().peers, peer)
      // Our old one-sided entry met their request (they're "friends" here, still waiting there): answer it.
      const kind: FriendKind | null = relation === 'outgoing' ? 'request' : relation === 'friends' ? 'accept' : null
      if (kind && sharedServers(peer).length === 0) continue
      if (kind && !isBlocked(useBlocks.getState().entries, peer)) {
        try {
          await send(peer, kind)
        } catch {
          continue // no devices yet, or offline: next time
        }
      }
      useFriends.setState((s) => ({ unsent: s.unsent.filter((k) => k !== peer) }))
      save()
    }
  } finally {
    flushing = false
  }
}

// ── Sending ─────────────────────────────────────────────────────────────────

async function send(peer: string, kind: FriendKind): Promise<void> {
  const identity = useApp.getState().identity
  if (!identity) throw new DmError(t('dms.errors.noAccount'))
  const route = sharedServers(peer)[0]
  if (!route || peer === me()) throw new DmError(t('dms.errors.noSharedServer'))
  const action = signFriend(identity, kind, peer)
  record(peer, { id: action.id, kind, mine: true, at: action.at })
  try {
    const envelope = await encryptFor(route, peer, { text: friendFallback(kind), friend: { ...action } })
    // Quiet kinds don't push a "new message" notification to their phone.
    await connectionFor(route)!.request('dm.send', { accountKey: peer, envelope, ...(quietKind(kind) ? { silent: true } : {}) })
  } catch (e) {
    unrecord(peer, action.id)
    throw e
  }
}

type Intent = Parameters<typeof actionFor>[1]

async function act(peer: string, intent: Intent): Promise<void> {
  await loadFriends()
  const kind = actionFor(relationWith(useFriends.getState().peers, peer), intent)
  if (!kind) return
  if (kind === 'request' && isBlocked(useBlocks.getState().entries, peer)) return
  await send(peer, kind)
  if (intent !== 'add' || kind !== 'request') useFriends.setState((s) => ({ unsent: s.unsent.filter((k) => k !== peer) }))
}

/** Sends a friend request, or accepts theirs if they already sent one. */
export const addFriend = (peer: string) => act(peer, 'add')
export const acceptFriend = (peer: string) => act(peer, 'accept')
export const ignoreFriend = (peer: string) => act(peer, 'ignore')
export const cancelFriendRequest = (peer: string) => act(peer, 'cancel')
/** Removes them as a friend on both sides, quietly (no notification). */
export const removeFriend = (peer: string) => act(peer, 'remove')

/** Blocking ends the friendship (or request) first, while the servers still let us tell them. */
export async function blockPerson(peer: string): Promise<void> {
  await loadFriends()
  const relation = relationWith(useFriends.getState().peers, peer)
  const kind = relation === 'friends' ? 'remove' : relation === 'outgoing' ? 'cancel' : relation === 'incoming' ? 'decline' : null
  if (kind) await send(peer, kind).catch(() => undefined)
  await setBlocked(peer, true)
}

// ── Receiving ───────────────────────────────────────────────────────────────

function onFriendDms(peer: string, dms: Dm[], live: boolean): void {
  const mine = me()
  for (const dm of dms) {
    const action: FriendAction | undefined = dm.friend
    if (!action) continue
    const fromMe = resolveKey(action.from) === mine
    // Nothing from people you've blocked.
    if (!fromMe && isBlocked(useBlocks.getState().entries, peer)) continue
    const { before, after } = record(peer, { id: action.id, kind: action.kind, mine: fromMe, at: action.at })
    if (fromMe) continue
    // They lost track of us (a new device, a reset): we're still friends here, so say so again.
    if (action.kind === 'request' && before === 'friends') void send(peer, 'accept').catch(() => undefined)
    if (!live) continue
    const name = knownName(peer)
    const serverKey = sharedServers(peer)[0] ?? ''
    if (after === 'incoming' && before !== 'incoming') show(serverKey, t('friends.notify.requestTitle'), t('friends.notify.request', { name }), openFriends)
    else if (after === 'friends' && before === 'outgoing') show(serverKey, t('friends.notify.acceptedTitle'), t('friends.notify.accepted', { name }), openFriends)
  }
}

onDmOpened((peer, dms, live) => {
  if (!dms.some((d) => d.friend)) return
  void loadFriends().then(() => onFriendDms(peer, dms, live))
})

onKeyChanges((resolve) => {
  const before = useFriends.getState()
  const peers: Record<string, FriendPeer> = {}
  for (const [key, p] of Object.entries(before.peers)) {
    const target = resolve(key)
    peers[target] = peerFrom(p.name, p.events.reduce(addEvent, peers[target]?.events ?? []))
  }
  useFriends.setState({ peers, unsent: [...new Set(before.unsent.map(resolve))] })
  save()
})

onWelcomeHook(() => {
  // Members arrive with the welcome; give the store a moment to take them in.
  setTimeout(() => void loadFriends().then(flushUnsent), 500)
})

// Blocked on another device (the list syncs): end it here too.
useBlocks.subscribe((state, prev) => {
  for (const entry of state.entries) {
    if (!entry.blocked || isBlocked(prev.entries, entry.accountKey)) continue
    const relation = relationWith(useFriends.getState().peers, entry.accountKey)
    if (relation !== 'none') record(entry.accountKey, { id: `local-block-${entry.at}`, kind: 'remove', mine: true, at: Math.max(entry.at, Date.now()) })
  }
})
