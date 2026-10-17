// "Let friends connect without port forwarding": the owner's switch (p2p.status/set/rotate), the secret each server
// hands its members, and, in the desktop app, reaching a server through the peer-to-peer tunnel when its address
// can't be reached. The tunnel itself lives in the desktop app's main process (desktop/src/p2p).
import { create } from 'zustand'
import type { P2pStatus } from '../core/protocol'
import { desktop, type P2pHostStatus, type TunnelEndpoint } from '../platform/desktop'
import { t } from '../i18n'
import { noteHosted, useHostedHere } from './hosting'
import { connectionFor, patchServer, setUrlResolver, useApp } from './store'
import { duration, log } from '../core/log'
import { serverLogFields } from './logIds'

interface P2pState {
  /** p2p.status per server key (the owner's view). */
  status: Record<string, P2pStatus>
  /** Servers reached through the tunnel right now: their local endpoint (null: the direct address). */
  via: Record<string, TunnelEndpoint | null>
}

export const useP2p = create<P2pState>(() => ({ status: {}, via: {} }))

/** The tunnel a server is reached through, if any (voice points LiveKit's TURN at it). */
export const tunnelFor = (serverKey: string): TunnelEndpoint | null => useP2p.getState().via[serverKey] ?? null

function setStatus(key: string, status: P2pStatus): void {
  useP2p.setState((s) => ({ status: { ...s.status, [key]: status } }))
}

export async function loadP2pStatus(key: string): Promise<P2pStatus> {
  const connection = connectionFor(key)
  if (!connection) throw new Error(t('errors.codes.disconnected'))
  const { status } = await connection.request('p2p.status', {})
  setStatus(key, status)
  return status
}

/** Turns the feature on or off (owner). The desktop app hosting the server starts or stops its tunnel to match. */
export async function setP2p(key: string, enabled: boolean): Promise<void> {
  const connection = connectionFor(key)
  if (!connection) throw new Error(t('errors.codes.disconnected'))
  const { status } = await connection.request('p2p.set', { enabled })
  setStatus(key, status)
  await syncHostedTunnel(key)
}

/** A new secret (owner): old invite links stop working this way; members learn the new one from the server. */
export async function rotateP2p(key: string): Promise<void> {
  const connection = connectionFor(key)
  if (!connection) throw new Error(t('errors.codes.disconnected'))
  const { status } = await connection.request('p2p.rotate', {})
  setStatus(key, status)
  await syncHostedTunnel(key)
}

/** The server runs in this desktop app: tell the app to re-read the world's files (secret, listener port). */
async function syncHostedTunnel(key: string): Promise<void> {
  const server = useApp.getState().servers[key]
  const here = server && useHostedHere.getState().byUrl[server.directUrl.replace(/\/$/, '')]
  if (!here || !desktop?.host.p2pSync) return
  // The server writes p2p.port and p2p.key before answering, but give the files a moment on a slow disk.
  for (let i = 0; i < 3; i++) {
    const updated = await desktop.host.p2pSync(here.id).catch(() => null)
    if (updated) noteHosted(updated)
    if (!updated || updated.p2p?.state !== 'off' || !server.p2p) return
    await new Promise((r) => setTimeout(r, 300))
  }
}

// ── Reaching a server through the tunnel (desktop app) ─────────────────────

/** How long we keep using the tunnel before trying the direct address again. */
const RETRY_DIRECT_MS = 10 * 60_000
const PROBE_MS = 2_500
const preferTunnel = new Map<string, number>()
/** Servers whose direct address was tried at least once (its first answer is logged, later ones only after a tunnel). */
const probed = new Set<string>()

export interface Probe {
  ok: boolean
  /** Why not, as a log word: timeout, unreachable (refused, no route, DNS), http-<status>, not-iskra. */
  why?: string
  took: number
}

/** Does the server answer at its direct address? (Any Iskra server answers GET / to any origin.) */
export async function probeDirect(url: string, fetcher: typeof fetch = fetch, now: () => number = () => performance.now()): Promise<Probe> {
  const started = now()
  const done = (why?: string): Probe => ({ ok: !why, ...(why ? { why } : {}), took: Math.max(0, now() - started) })
  try {
    const response = await fetcher(`${url}/`, { signal: AbortSignal.timeout(PROBE_MS), cache: 'no-store' })
    if (!response.ok) return done(`http-${response.status}`)
    const body = (await response.json().catch(() => null)) as { iskra?: number } | null
    return done(body?.iskra === 1 ? undefined : 'not-iskra')
  } catch (e) {
    return done((e as Error)?.name === 'TimeoutError' || (e as Error)?.name === 'AbortError' ? 'timeout' : 'unreachable')
  }
}

function useTunnel(key: string, endpoint: TunnelEndpoint | null): void {
  useP2p.setState((s) => (s.via[key] === endpoint || (!s.via[key] && !endpoint) ? s : { via: { ...s.via, [key]: endpoint } }))
  patchServer(key, (s) => ({ url: endpoint?.url ?? s.directUrl }))
}

/**
 * Where to connect to a server right now: its address when it answers, else (desktop app, a server whose invite
 * carried a p2p secret) the tunnel's local address. Keeps using the tunnel for a while once it was needed.
 */
export async function resolveServerUrl(key: string): Promise<string | null> {
  const server = useApp.getState().servers[key]
  if (!server) return null
  if (!server.p2p || !desktop?.p2p) {
    useTunnel(key, null)
    return server.directUrl
  }
  const since = preferTunnel.get(key)
  const tryDirect = !(since !== undefined && Date.now() - since < RETRY_DIRECT_MS)
  // Only ids, outcomes and durations in the log: never the address, the secret or the tunnel's error text.
  const srv = serverLogFields(key)
  const probe = tryDirect ? await probeDirect(server.directUrl) : null
  if (probe?.ok) {
    if (useP2p.getState().via[key] || !probed.has(key)) log('INFO', 'tunnel', 'direct', null, [...srv, ['path', 'direct'], ['took', duration(probe.took)]])
    probed.add(key)
    preferTunnel.delete(key)
    useTunnel(key, null)
    return server.directUrl
  }
  probed.add(key)
  if (probe) log('INFO', 'tunnel', 'fallback', 'TUN-120', [...srv, ['why', probe.why], ['took', duration(probe.took)]])
  const opening = Date.now()
  const endpoint = await desktop.p2p.open(key, server.p2p).catch(() => null)
  if (!endpoint || 'error' in endpoint) {
    log('WARN', 'tunnel', 'failed', 'TUN-110', [...srv, ['why', endpoint ? 'open-failed' : 'no-answer'], ['took', duration(Date.now() - opening)]])
    useTunnel(key, null)
    return server.directUrl
  }
  if (useP2p.getState().via[key]?.url !== endpoint.url) log('INFO', 'tunnel', 'opened', null, [...srv, ['took', duration(Date.now() - opening)]])
  preferTunnel.set(key, Date.now())
  useTunnel(key, endpoint)
  return endpoint.url
}

setUrlResolver(resolveServerUrl)

/** Servers that leave the list close their tunnels. */
useApp.subscribe((state, previous) => {
  for (const key of Object.keys(previous.servers)) {
    if (!state.servers[key] && useP2p.getState().via[key]) {
      useP2p.setState((s) => {
        const via = { ...s.via }
        delete via[key]
        return { via }
      })
      void desktop?.p2p?.close(key)
    }
  }
})

// The desktop app's tunnel status for servers hosted here (NAT type, started, failed) arrives as it changes.
desktop?.host.onP2p?.((update: { id: string; p2p: P2pHostStatus }) => {
  useHostedHere.setState((s) => {
    const entry = Object.entries(s.byUrl).find(([, h]) => h.id === update.id)
    return entry ? { byUrl: { ...s.byUrl, [entry[0]]: { ...entry[1], p2p: update.p2p } } } : s
  })
})
