// Who can message me, and message requests. The setting is kept on the device and handed to every server you're on
// (the newest choice wins, like "DMs from bots"); each server enforces it. A first DM someone may only send as a
// request arrives marked as one: it stays out of the DM list, doesn't notify, and shows links, pictures and files
// only once you accept. Accept, ignore and block go to every server you share with the person; the sender is never told.
import { create } from 'zustand'
import { b64u } from '../core/crypto'
import type { DmPrivacySetting, DmRequestFlag, DmWho, Events, RequestError } from '../core/protocol'
import * as storage from '../core/storage'
import { setDmRequestCheck, sharedServers, useDms, type Dm } from './dms'
import { applyServerList, applyServerState, checkDecisions, decide, saneStamp, serverClock, serversToSync, stampAfter, statusOf, storedDecisions, type DmStatus, type PeerRequests } from './dmRequestsLogic'
import { errorMessage } from '../i18n/errors'
import { setBlocked } from './moderation'
import { connectionFor, onServerEvent, onWelcomeHook, useApp } from './store'

interface DmRequestsState {
  who: DmWho
  at: number
  peers: Record<string, PeerRequests>
  /** Servers that refused the setting (the reason, shown in My settings), by server key. */
  refused: Record<string, string>
}

export const useDmRequests = create<DmRequestsState>(() => ({ who: 'anyone', at: 0, peers: {}, refused: {} }))

/** Each server's clock against ours (theirs − ours), from the `now` it sends with the setting. */
const offsets = new Map<string, number>()
const noteClock = (serverKey: string, now: unknown) => {
  if (typeof now === 'number' && Number.isFinite(now)) offsets.set(serverKey, now - Date.now())
}
const clock = () => serverClock(Date.now(), [...offsets.values()])

const me = () => {
  const identity = useApp.getState().identity
  return identity ? b64u(identity.account.publicKey) : ''
}

/** You wrote to them yourself (a real message, not a friend action): that accepts their DMs. */
const talkedIn = (messages: Dm[] | undefined, mine: string) =>
  !!messages?.some((m) => m.from === mine && !m.friend && !m.pending && !m.notice && !m.error)

export function dmStatus(peer: string): DmStatus {
  const mine = me()
  if (peer === mine) return 'accepted'
  return statusOf(useDmRequests.getState().peers[peer], talkedIn(useDms.getState().conversations[peer]?.messages, mine))
}

/** The person's status, kept fresh in React. */
export function useDmStatus(peer: string): DmStatus {
  useDmRequests((s) => s.peers[peer])
  useDms((s) => s.conversations[peer]?.messages)
  return dmStatus(peer)
}

/** Everyone whose DMs wait as a request, or were ignored (for the sidebar). */
export function useRequestPeers(): { requests: string[]; ignored: string[] } {
  const peers = useDmRequests((s) => s.peers)
  useDms((s) => s.conversations)
  const requests: string[] = []
  const ignored: string[] = []
  const lastAt = (peer: string) => useDms.getState().conversations[peer]?.messages.findLast((m) => !m.friend)?.sentAt ?? 0
  for (const peer of new Set([...Object.keys(peers), ...Object.keys(useDms.getState().conversations)])) {
    const status = dmStatus(peer)
    if (status === 'request') requests.push(peer)
    else if (status === 'ignored' && (Object.keys(peers[peer]?.servers ?? {}).length > 0 || lastAt(peer) > 0)) ignored.push(peer)
  }
  const newest = (a: string, b: string) => lastAt(b) - lastAt(a)
  return { requests: requests.sort(newest), ignored: ignored.sort(newest) }
}

// ── Decisions kept on the device ────────────────────────────────────────────

let loaded: Promise<void> | null = null
function ensureLoaded(): Promise<void> {
  loaded ??= Promise.all([
    storage.loadPrivate<unknown>('dmRequests').catch(() => undefined),
    storage.loadPrivate<DmPrivacySetting>('dmPrivacy').catch(() => undefined),
  ]).then(([decisions, setting]) => {
    let peers = useDmRequests.getState().peers
    for (const [peer, d] of Object.entries(checkDecisions(decisions))) peers = decide(peers, peer, d.state, d.at)
    const patch: Partial<DmRequestsState> = { peers }
    if (setting && isWho(setting.who) && typeof setting.at === 'number' && setting.at > useDmRequests.getState().at) {
      patch.who = setting.who
      patch.at = setting.at
    }
    useDmRequests.setState(patch)
  })
  return loaded
}

const isWho = (v: unknown): v is DmWho => v === 'anyone' || v === 'requests' || v === 'known' || v === 'nobody'

let saveTimer: ReturnType<typeof setTimeout> | null = null
function saveDecisions(): void {
  saveTimer ??= setTimeout(() => {
    saveTimer = null
    void storage.savePrivate('dmRequests', storedDecisions(useDmRequests.getState().peers)).catch(() => undefined)
  }, 300)
}

function setPeers(update: (peers: Record<string, PeerRequests>) => Record<string, PeerRequests>, persist = false): void {
  const before = useDmRequests.getState().peers
  const after = update(before)
  if (after === before) return
  useDmRequests.setState({ peers: after })
  if (persist) saveDecisions()
}

// ── Keeping servers in step ─────────────────────────────────────────────────

const inFlight = new Set<string>()

/** Tells servers that disagree with the person's status (accepted on another server or device, for example). */
function reconcile(peer: string): void {
  const info = useDmRequests.getState().peers[peer]
  if (!info || Object.keys(info.servers).length === 0) return
  const { accept, ignore } = serversToSync(info, dmStatus(peer))
  for (const serverKey of accept) void tell(serverKey, peer, 'accept')
  for (const serverKey of ignore) void tell(serverKey, peer, 'ignore')
}

async function tell(serverKey: string, peer: string, what: 'accept' | 'ignore'): Promise<void> {
  const flight = `${serverKey}|${peer}|${what}`
  const connection = connectionFor(serverKey)
  if (inFlight.has(flight) || !connection?.isOnline) return
  inFlight.add(flight)
  try {
    const { state } = await connection.request(what === 'accept' ? 'dm.requests.accept' : 'dm.requests.ignore', { accountKey: peer })
    setPeers((peers) => applyServerState(peers, serverKey, peer, state === 'accepted' ? null : state))
  } catch {
    /* offline, an older server, or they left it: retried on the next connect */
  } finally {
    inFlight.delete(flight)
  }
}

async function syncServer(serverKey: string): Promise<void> {
  await ensureLoaded()
  const connection = connectionFor(serverKey)
  if (!connection?.isOnline) return
  try {
    const { requests } = await connection.request('dm.requests.list', {})
    setPeers((peers) => applyServerList(peers, serverKey, requests))
    for (const { accountKey } of requests) reconcile(accountKey)
  } catch {
    /* an older server */
  }
  try {
    const remote = await connection.request('dm.privacy.get', {})
    noteClock(serverKey, remote.now)
    const local = useDmRequests.getState()
    // A choice stamped by a clock that ran ahead can't be ordered: a server's choice wins over it, or it's re-stamped.
    if (local.at > 0 && saneStamp(local.at, clock()) === 0) {
      if (remote.at > 0) return void (await adoptSetting(remote, serverKey, true))
      await setDmWho(local.who)
      return
    }
    if (remote.at > local.at) await adoptSetting(remote, serverKey)
    else if (remote.at < local.at) await pushSetting(serverKey)
  } catch {
    /* an older server */
  }
}

// ── The setting ─────────────────────────────────────────────────────────────

const online = () => Object.keys(useApp.getState().servers).filter((key) => connectionFor(key)?.isOnline)

async function adoptSetting(next: DmPrivacySetting, from?: string, replace = false): Promise<void> {
  if (!isWho(next.who) || (!replace && next.at <= useDmRequests.getState().at)) return
  useDmRequests.setState({ who: next.who, at: next.at })
  await storage.savePrivate('dmPrivacy', { who: next.who, at: next.at }).catch(() => undefined)
  for (const key of online()) if (key !== from) void pushSetting(key)
}

async function pushSetting(serverKey: string): Promise<void> {
  const { who, at } = useDmRequests.getState()
  const connection = connectionFor(serverKey)
  if (at === 0 || !connection?.isOnline) return
  try {
    const stored = await connection.request('dm.privacy.set', { who, at })
    noteClock(serverKey, stored.now)
    setRefused(serverKey, null)
    await adoptSetting(stored, serverKey)
  } catch (e) {
    // Never silently: a server that refuses the choice (a clock that's off, say) keeps the old one, so say so.
    const code = (e as RequestError | null)?.code
    if (code !== 'unknown_type' && code !== 'disconnected' && code !== 'timeout') setRefused(serverKey, errorMessage(e))
  }
}

function setRefused(serverKey: string, reason: string | null): void {
  const { refused } = useDmRequests.getState()
  if ((refused[serverKey] ?? null) === reason) return
  const { [serverKey]: _gone, ...rest } = refused
  useDmRequests.setState({ refused: reason === null ? rest : { ...rest, [serverKey]: reason } })
}

/** Changes who can start a DM with you, on every server (stamped by the servers' clock, not only this device's). */
export async function setDmWho(who: DmWho): Promise<void> {
  await ensureLoaded()
  await adoptSetting({ who, at: stampAfter(useDmRequests.getState().at, clock()) }, undefined, true)
}

// ── Accept, ignore, block ───────────────────────────────────────────────────

/** Every server we share with them, plus any that holds their DMs as a request (they may have left the others). */
const serversFor = (peer: string) => [...new Set([...sharedServers(peer), ...Object.keys(useDmRequests.getState().peers[peer]?.servers ?? {})])]

export async function acceptRequest(peer: string): Promise<void> {
  await ensureLoaded()
  setPeers((peers) => decide(peers, peer, 'accepted', Date.now()), true)
  await Promise.all(serversFor(peer).map((key) => tell(key, peer, 'accept')))
}

export async function ignoreRequest(peer: string): Promise<void> {
  await ensureLoaded()
  setPeers((peers) => decide(peers, peer, 'ignored', Date.now()), true)
  await Promise.all(serversFor(peer).map((key) => tell(key, peer, 'ignore')))
}

/** Blocks them (the block list syncs everywhere) and ignores the request. */
export async function blockRequest(peer: string): Promise<void> {
  await setBlocked(peer, true)
  await ignoreRequest(peer)
}

// ── Wiring ──────────────────────────────────────────────────────────────────

// dms.ts asks for every DM someone else sent: true means it's a request (or ignored), so it doesn't notify.
setDmRequestCheck((peer: string, request: DmRequestFlag | undefined, serverKey: string) => {
  setPeers((peers) => applyServerState(peers, serverKey, peer, request ?? null))
  reconcile(peer)
  return dmStatus(peer) !== 'accepted'
})

onWelcomeHook((serverKey) => void syncServer(serverKey))
onServerEvent((serverKey, type, body) => {
  if (type === 'dm.privacy') {
    noteClock(serverKey, (body as Events['dm.privacy']).now)
    void adoptSetting(body as Events['dm.privacy'], serverKey)
  }
  if (type === 'dm.requests.changed') {
    const { accountKey, state } = body as Events['dm.requests.changed']
    if (typeof accountKey !== 'string') return
    // Your own answer, on another device (or by writing to them): the newest decision.
    setPeers((peers) => applyServerState(peers, serverKey, accountKey, state === 'request' || state === 'ignored' ? state : null))
    if (state === 'accepted' || state === 'ignored') setPeers((peers) => decide(peers, accountKey, state, Date.now()), true)
    reconcile(accountKey)
  }
})
