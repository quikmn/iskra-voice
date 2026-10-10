// Device linking, both sides. The protocol lives in core/link.ts and PROTOCOL.md ("Device linking").
import { create } from 'zustand'
import { b64u, fromB64u } from '../core/crypto'
import {
  checkMac, confirmationCode, encodeLinkCode, sameConfirmation, ephemeralKey, linkAppUrl, linkKeys, macKey, newLinkSecret, openPayload,
  parseLinkCode, relayDeliver, relayPoll, relayRequest, sealPayload, type EphemeralKey, type LinkCode, type LinkKeys,
} from '../core/link'
import type { LinkRequest } from '../core/protocol'
import { normalizeServerUrl } from '../core/invite'
import { profileForLink, profileFromLink, type LinkedProfile } from '../core/profile'
import { restoreIdentity, seedOf } from '../core/recovery'
import * as storage from '../core/storage'
import { appUrl } from '../ui/format'
import { platformName } from './devices'
import { exportHistory, importHistory, loadFriends } from './dms'
import { boot, connectionFor, onServerEvent, useApp } from './store'

/** What the new device receives, encrypted. */
export interface LinkPayload {
  v: 1
  seed: string
  name: string
  recoverySaved: boolean
  servers: { url: string; serverKey: string; name: string }[]
  friends: storage.StoredFriend[]
  history?: Record<string, storage.StoredDm[]>
  /** Bio, pronouns, accent, avatar and page, so the new device shows the same profile. */
  profile?: LinkedProfile
}

// ── The existing device: shows the code, checks the new device, sends the account ──

export type OfferState =
  | { phase: 'idle' }
  | { phase: 'creating' }
  | { phase: 'waiting'; text: string; url: string; serverName: string; expiresAt: number }
  | { phase: 'confirm'; confirm: string; info: string | null }
  | { phase: 'sending' }
  | { phase: 'done' }
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
    useLinkOffer.setState({ phase: 'error', message: "That server isn't connected right now." }, true)
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
    useLinkOffer.setState({ phase: 'error', message: (e as Error).message }, true)
  }
}

function onLinkRequest(serverKey: string, request: LinkRequest): void {
  const current = offer
  if (!current || current.serverKey !== serverKey || current.code.token !== request.token) return
  const theirs = checkMac(request.epk, request.mac, current.keys.macNew)
  if (!theirs) {
    // Someone has the token but not the secret: not the device the code was shown to.
    void cancelLinkOffer()
    useLinkOffer.setState({ phase: 'error', message: "A device tried to link with a code that doesn't match. Nothing was sent. Try again with a new code." }, true)
    return
  }
  const mine = ephemeralKey()
  current.mine = mine
  current.theirs = theirs
  connectionFor(serverKey)?.request('link.respond', { token: request.token, epk: b64u(mine.publicKey), mac: macKey(mine.publicKey, current.keys.macExisting) })
    .then(() => useLinkOffer.setState({ phase: 'confirm', confirm: confirmationCode(current.keys, mine.publicKey, theirs), info: request.info }, true))
    .catch((e: Error) => useLinkOffer.setState({ phase: 'error', message: e.message }, true))
}

async function buildPayload(includeHistory: boolean): Promise<LinkPayload> {
  const { identity, profile } = useApp.getState()
  const saved = await storage.loadServers()
  const payload: LinkPayload = {
    v: 1,
    seed: b64u(seedOf(identity!)),
    name: profile?.name ?? 'Someone',
    recoverySaved: !!profile?.recoverySaved,
    servers: saved.filter((s) => !s.invite).map((s) => ({ url: s.url, serverKey: s.serverKey, name: s.name })),
    friends: await storage.loadFriends(),
    history: includeHistory ? exportHistory() : undefined,
    profile: profileForLink(profile),
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
    useLinkOffer.setState({ phase: 'error', message: "That number doesn't match, so nothing was sent. If you didn't start this on your new device, someone else may have your code. Make a new one." }, true)
    return
  }
  useLinkOffer.setState({ phase: 'sending' }, true)
  try {
    const sealed = sealPayload(await buildPayload(current.includeHistory), current.mine, current.theirs)
    const server = useApp.getState().servers[current.serverKey]
    await relayDeliver(server.url, current.code.token, current.putKey, sealed)
    offer = null
    useLinkOffer.setState({ phase: 'done' }, true)
  } catch (e) {
    useLinkOffer.setState({ phase: 'error', message: (e as Error).message }, true)
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
    useLinkJoin.setState({ phase: 'error', message: "That code doesn't look right. Check it on your other device." }, true)
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
        if (!existing) throw new Error("The answer didn't match the code, so it may not be from your device. Nothing was linked.")
        useLinkJoin.setState({ phase: 'confirm', confirm: confirmationCode(keys, existing, mine.publicKey) }, true)
      } else if (state.state === 'done') {
        if (!existing) throw new Error('Something went wrong. Make a new code and try again.')
        useLinkJoin.setState({ phase: 'finishing' }, true)
        await adopt(openPayload<LinkPayload>(fromB64u(state.payload), existing, mine))
        useLinkJoin.setState({ phase: 'idle' }, true)
        return
      }
      await sleep(1000)
    }
  } catch (e) {
    if (alive()) useLinkJoin.setState({ phase: 'error', message: e instanceof TypeError ? "Couldn't reach the server in the code." : (e as Error).message }, true)
  }
}

/** Becomes the account: a fresh device key certified by the account seed, then the same servers and history. */
async function adopt(payload: LinkPayload): Promise<void> {
  if (payload?.v !== 1 || typeof payload.seed !== 'string') throw new Error('Unsupported link data. Update Iskra on both devices.')
  const seed = fromB64u(payload.seed)
  if (seed.length !== 32) throw new Error('Unsupported link data.')
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
  void storage.requestPersistence()
  await boot()
  await loadFriends()
}
