// Device linking, both sides. The protocol lives in core/link.ts and PROTOCOL.md ("Device linking").
import { create } from 'zustand'
import { b64u, fromB64u } from '../core/crypto'
import {
  checkMac, confirmationCode, encodeLinkCode, sameConfirmation, ephemeralKey, linkAppUrl, linkKeys, macKey, newLinkSecret, openPart, openPayload,
  parseLinkCode, relayDeliver, relayPoll, relayPutPart, relayRequest, relayTakePart, sealPart, sealPayload, splitParts, PART_BYTES,
  type EphemeralKey, type LinkCode, type LinkKeys, LinkRelayError,
} from '../core/link'
import { t } from '../i18n'
import { errorMessage } from '../i18n/errors'
import type { LinkRequest } from '../core/protocol'
import { normalizeServerUrl } from '../core/invite'
import { profileForLink, profileFromLink, type LinkedProfile } from '../core/profile'
import { restoreIdentity, seedOf } from '../core/recovery'
import * as storage from '../core/storage'
import { appUrl } from '../ui/format'
import { platformName } from './devices'
import { exportHistory, importHistory, loadFriends } from './dms'
import { exportGroups, importGroups } from './groups'
import { boot, connectionFor, onServerEvent, useApp } from './store'
import { knownRotations, remember } from './keyMap'
import { chainTo, type Rotation } from '../core/rotation'

/** What the new device receives, encrypted. */
export interface LinkPayload {
  v: 1
  seed: string
  name: string
  recoverySaved: boolean
  servers: { url: string; serverKey: string; name: string }[]
  friends: storage.StoredFriend[]
  /** Older apps: recent DMs inside the payload. Now history follows in parts (see historyParts). */
  history?: Record<string, storage.StoredDm[]>
  /** Bio, pronouns, accent, avatar and page, so the new device shows the same profile. */
  profile?: LinkedProfile
  /** The account key rotations that led to this key, for servers that missed them. */
  rotations?: Rotation[]
  /** How many sealed history parts follow the payload on the relay (0 or missing: none). */
  historyParts?: number
}

/** What the history parts carry, joined back together: 1:1 DMs and group DMs (with their signed chains and names). */
export interface LinkHistory {
  v: 1
  dms: Record<string, storage.StoredDm[]>
  groups: storage.StoredGroup[]
}

/** At most this many parts (~48 MB); bigger histories keep the newest messages of each conversation. */
export const MAX_HISTORY_PARTS = 64

/** Everything this device has, trimmed per conversation until it fits. */
export function buildHistory(maxBytes = MAX_HISTORY_PARTS * PART_BYTES): Uint8Array {
  for (let per = 5000; ; per = Math.floor(per / 2)) {
    const history: LinkHistory = { v: 1, dms: exportHistory(per, Infinity), groups: exportGroups(per) }
    const bytes = new TextEncoder().encode(JSON.stringify(history))
    if (bytes.length <= maxBytes || per <= 10) return bytes
  }
}

// ── The existing device: shows the code, checks the new device, sends the account ──

export type OfferState =
  | { phase: 'idle' }
  | { phase: 'creating' }
  | { phase: 'waiting'; text: string; url: string; serverName: string; expiresAt: number }
  | { phase: 'confirm'; confirm: string; info: string | null }
  | { phase: 'sending'; sent?: number; total?: number }
  | { phase: 'done'; warning?: string }
  | { phase: 'error'; message: string }

interface Offer {
  serverKey: string
  code: LinkCode
  keys: LinkKeys
  putKey: string
  includeHistory: boolean
  mine?: EphemeralKey
  theirs?: Uint8Array
}

export const useLinkOffer = create<OfferState>(() => ({ phase: 'idle' }))

/** Relay and link errors in the app's language (core/link.ts speaks English). */
function linkError(e: unknown): string {
  if (e instanceof LinkRelayError) {
    if (e.message.startsWith('The new device stopped')) return t('app.link.errors.receiverStopped')
    if (e.status === 408) return t('app.link.errors.senderStopped')
    if (e.status === 404) return t('app.link.errors.expired')
    if (e.status === 409) return t('app.link.errors.used')
    if (e.status === 429) return t('app.link.errors.tooSlow')
    return t('app.link.errors.refused', { status: e.status })
  }
  if (e instanceof Error && e.message === 'Part of the history arrived out of order.') return t('app.link.errors.outOfOrder')
  return errorMessage(e)
}
let offer: Offer | null = null

/** Servers we could relay a link through: online ones. */
export function linkableServers(): { key: string; name: string }[] {
  const { servers, order } = useApp.getState()
  return order.filter((k) => servers[k]?.status.state === 'online' && servers[k].me).map((k) => ({ key: k, name: servers[k].name }))
}

export async function startLinkOffer(serverKey: string, includeHistory: boolean): Promise<void> {
  await cancelLinkOffer()
  const server = useApp.getState().servers[serverKey]
  const connection = connectionFor(serverKey)
  if (!server || !connection) {
    useLinkOffer.setState({ phase: 'error', message: t('app.link.errors.serverOffline') }, true)
    return
  }
  useLinkOffer.setState({ phase: 'creating' }, true)
  try {
    const { token, putKey, expiresAt } = await connection.request('link.create', {})
    const code: LinkCode = { serverUrl: server.url, token, secret: newLinkSecret() }
    offer = { serverKey, code, keys: linkKeys(code), putKey, includeHistory }
    useLinkOffer.setState({
      phase: 'waiting', text: encodeLinkCode(code), url: linkAppUrl(appUrl(server.appUrl), code), serverName: server.name, expiresAt,
    }, true)
  } catch (e) {
    useLinkOffer.setState({ phase: 'error', message: linkError(e) }, true)
  }
}

function onLinkRequest(serverKey: string, request: LinkRequest): void {
  const current = offer
  if (!current || current.serverKey !== serverKey || current.code.token !== request.token) return
  const theirs = checkMac(request.epk, request.mac, current.keys.macNew)
  if (!theirs) {
    // Someone has the token but not the secret: not the device the code was shown to.
    void cancelLinkOffer()
    useLinkOffer.setState({ phase: 'error', message: t('app.link.errors.wrongDevice') }, true)
    return
  }
  const mine = ephemeralKey()
  current.mine = mine
  current.theirs = theirs
  connectionFor(serverKey)?.request('link.respond', { token: request.token, epk: b64u(mine.publicKey), mac: macKey(mine.publicKey, current.keys.macExisting) })
    .then(() => useLinkOffer.setState({ phase: 'confirm', confirm: confirmationCode(current.keys, mine.publicKey, theirs), info: request.info }, true))
    .catch((e: Error) => useLinkOffer.setState({ phase: 'error', message: linkError(e) }, true))
}

async function buildPayload(): Promise<LinkPayload> {
  const { identity, profile } = useApp.getState()
  const saved = await storage.loadServers()
  const payload: LinkPayload = {
    v: 1,
    seed: b64u(seedOf(identity!)),
    name: profile?.name ?? 'Someone',
    recoverySaved: !!profile?.recoverySaved,
    servers: saved.filter((s) => !s.invite).map((s) => ({ url: s.url, serverKey: s.serverKey, name: s.name })),
    friends: await storage.loadFriends(),
    profile: profileForLink(profile),
    rotations: chainTo(b64u(identity!.account.publicKey), knownRotations(), 16),
  }
  // The relay takes ≤ 1 MB. A big page is the first thing to leave out: servers keep it anyway,
  // and the new device leaves it alone until it's edited there.
  if (payload.profile?.page && JSON.stringify(payload).length > 900_000) delete payload.profile.page
  return payload
}

/**
 * The person typed the number the new device shows. Only if it matches does the account go over;
 * a wrong number cancels the link (it may be someone else's device).
 */
export async function confirmLinkOffer(typed: string): Promise<void> {
  const current = offer
  const state = useLinkOffer.getState()
  if (!current?.mine || !current.theirs || state.phase !== 'confirm') return
  if (!sameConfirmation(typed, state.confirm)) {
    await cancelLinkOffer()
    useLinkOffer.setState({ phase: 'error', message: t('app.link.errors.wrongNumber') }, true)
    return
  }
  useLinkOffer.setState({ phase: 'sending' }, true)
  try {
    const payload = await buildPayload()
    const parts = current.includeHistory ? splitParts(buildHistory()) : []
    payload.historyParts = parts.length
    const server = useApp.getState().servers[current.serverKey]
    await relayDeliver(server.url, current.code.token, current.putKey, sealPayload(payload, current.mine, current.theirs), parts.length)
    // The history follows in sealed parts; the relay holds only a few at a time, so this goes at the new device's pace.
    try {
      for (let i = 0; i < parts.length; i++) {
        if (offer !== current) return // cancelled
        useLinkOffer.setState({ phase: 'sending', sent: i, total: parts.length }, true)
        await relayPutPart(server.url, current.code.token, current.putKey, i, sealPart(i, parts.length, parts[i], current.mine, current.theirs))
      }
    } catch (e) {
      // The account is already there; only (part of) the history didn't make it.
      offer = null
      useLinkOffer.setState({ phase: 'done', warning: t('app.link.historyIncomplete', { reason: linkError(e) }) }, true)
      return
    }
    offer = null
    useLinkOffer.setState({ phase: 'done' }, true)
  } catch (e) {
    useLinkOffer.setState({ phase: 'error', message: linkError(e) }, true)
  }
}

export async function cancelLinkOffer(): Promise<void> {
  const current = offer
  offer = null
  useLinkOffer.setState({ phase: 'idle' }, true)
  if (current) await connectionFor(current.serverKey)?.request('link.cancel', { token: current.code.token }).catch(() => undefined)
}

onServerEvent((serverKey, type, body) => {
  if (type === 'link.request') onLinkRequest(serverKey, body as LinkRequest)
})

// ── The new device: enters the code, shows the confirmation, receives the account ──

export type JoinState =
  | { phase: 'idle' }
  | { phase: 'connecting' }
  | { phase: 'confirm'; confirm: string }
  | { phase: 'finishing' }
  | { phase: 'history'; received: number; total: number }
  | { phase: 'error'; message: string }

export const useLinkJoin = create<JoinState>(() => ({ phase: 'idle' }))

/** A link code from the QR code's "#/link/…" address, waiting for the onboarding screen. */
export const usePendingLink = create<{ code: string | null }>(() => ({ code: null }))
let joinRun = 0

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function cancelLinkJoin(): void {
  joinRun++
  useLinkJoin.setState({ phase: 'idle' }, true)
}

/** Runs the new-device side to the end: on success the app boots into the linked account. */
export async function joinWithCode(input: string): Promise<void> {
  const code = parseLinkCode(input)
  if (!code) {
    useLinkJoin.setState({ phase: 'error', message: t('app.link.errors.badCode') }, true)
    return
  }
  const run = ++joinRun
  const alive = () => run === joinRun
  useLinkJoin.setState({ phase: 'connecting' }, true)
  const keys = linkKeys(code)
  const mine = ephemeralKey()
  try {
    const readKey = await relayRequest(code, { epk: b64u(mine.publicKey), mac: macKey(mine.publicKey, keys.macNew), info: platformName() })
    let existing: Uint8Array | null = null
    while (alive()) {
      const state = await relayPoll(code, readKey)
      if (!alive()) return
      if (state.state === 'answered' && !existing) {
        existing = checkMac(state.epk, state.mac, keys.macExisting)
        if (!existing) throw new Error(t('app.link.errors.badAnswer'))
        useLinkJoin.setState({ phase: 'confirm', confirm: confirmationCode(keys, existing, mine.publicKey) }, true)
      } else if (state.state === 'done') {
        if (!existing) throw new Error(t('app.link.errors.generic'))
        useLinkJoin.setState({ phase: 'finishing' }, true)
        const payload = openPayload<LinkPayload>(fromB64u(state.payload), existing, mine)
        await adopt(payload)
        // The count that matters is the one sealed in the payload, not what the relay says.
        const total = Number.isSafeInteger(payload.historyParts) ? Math.min(payload.historyParts!, MAX_HISTORY_PARTS) : 0
        if (total > 0) {
          try {
            await receiveHistory(code, readKey, total, existing, mine, alive)
          } catch {
            /* the account is here either way; history the other device couldn't send stays there */
          }
        }
        if (!alive()) return
        await finish()
        useLinkJoin.setState({ phase: 'idle' }, true)
        return
      }
      await sleep(1000)
    }
  } catch (e) {
    if (alive()) useLinkJoin.setState({ phase: 'error', message: e instanceof TypeError ? t('app.link.errors.unreachable') : linkError(e) }, true)
  }
}

/** Receives the history parts in order and stores them, showing progress. */
async function receiveHistory(code: LinkCode, readKey: string, total: number, existing: Uint8Array, mine: EphemeralKey, alive: () => boolean): Promise<void> {
  const chunks: Uint8Array[] = []
  for (let i = 0; i < total && alive(); i++) {
    useLinkJoin.setState({ phase: 'history', received: i, total }, true)
    chunks.push(openPart(await relayTakePart(code, readKey, i), i, total, existing, mine))
  }
  if (!alive()) return
  useLinkJoin.setState({ phase: 'history', received: total, total }, true)
  const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let offset = 0
  for (const c of chunks) {
    bytes.set(c, offset)
    offset += c.length
  }
  const history = JSON.parse(new TextDecoder().decode(bytes)) as Partial<LinkHistory>
  if (history?.v !== 1) return
  if (history.dms && typeof history.dms === 'object') await importHistory(history.dms)
  await importGroups(history.groups)
}

/** Becomes the account: a fresh device key certified by the account seed, then the same servers and history. */
async function adopt(payload: LinkPayload): Promise<void> {
  if (payload?.v !== 1 || typeof payload.seed !== 'string') throw new Error(t('app.link.errors.unsupported'))
  const seed = fromB64u(payload.seed)
  if (seed.length !== 32) throw new Error(t('app.link.errors.unsupportedShort'))
  const identity = restoreIdentity(seed)
  await storage.saveIdentity(identity)
  await storage.saveProfile({
    ...profileFromLink(payload.profile),
    name: String(payload.name ?? 'Someone').slice(0, 32),
    recoverySaved: !!payload.recoverySaved,
  })
  const servers = Array.isArray(payload.servers) ? payload.servers : []
  await storage.saveServers(servers
    .filter((s) => typeof s?.url === 'string' && normalizeServerUrl(s.url) && typeof s.serverKey === 'string')
    .slice(0, 100)
    .map((s) => ({ url: normalizeServerUrl(s.url)!, serverKey: s.serverKey, name: String(s.name ?? '').slice(0, 100) })))
  if (Array.isArray(payload.friends)) await storage.saveFriends(payload.friends.slice(0, 1000))
  if (payload.history && typeof payload.history === 'object') await importHistory(payload.history)
  // Only rotations that check out and lead to this very key are kept.
  if (Array.isArray(payload.rotations))
    await remember(chainTo(b64u(identity.account.publicKey), payload.rotations.slice(0, 16), 16))
}

async function finish(): Promise<void> {
  void storage.requestPersistence()
  await boot()
  await loadFriends()
}
