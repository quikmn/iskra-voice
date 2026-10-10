// "Open to the internet": the owner's view of internet hosting, plus the public address invite links use.
import { create } from 'zustand'
import type { HostPort, HostStatus } from '../core/protocol'
import { connectionFor, onServerEvent, useApp, type ServerState } from './store'

interface HostingState {
  /** host.status per server key (admins only). */
  status: Record<string, HostStatus>
}

export const useHosting = create<HostingState>(() => ({ status: {} }))

function setStatus(key: string, status: HostStatus): void {
  useHosting.setState((s) => ({ status: { ...s.status, [key]: status } }))
}

onServerEvent((key, type, body) => {
  if (type === 'host.status') setStatus(key, (body as { status: HostStatus }).status)
  if (type === 'server.address') {
    const { publicUrl } = body as { publicUrl: string | null }
    useApp.setState((state) => {
      const server = state.servers[key]
      return server ? { servers: { ...state.servers, [key]: { ...server, publicUrl } } } : state
    })
  }
})

export async function loadHostStatus(key: string): Promise<HostStatus> {
  const connection = connectionFor(key)
  if (!connection) throw new Error('Not connected.')
  const { status } = await connection.request('host.status', {})
  setStatus(key, status)
  return status
}

/** Turns internet hosting on or off. Turning it on while it's on checks everything again right away. */
export async function setInternet(key: string, enabled: boolean): Promise<void> {
  const connection = connectionFor(key)
  if (!connection) throw new Error('Not connected.')
  const { status } = await connection.request('host.internet.set', { enabled })
  setStatus(key, status)
}

/** The server address to put in invite links: the public one when the server is open to the internet. */
export function inviteServerUrl(server: Pick<ServerState, 'url' | 'publicUrl'>): string {
  return server.publicUrl ?? server.url
}

// ── The checklist ────────────────────────────────────────────────────────────

export type StepState = 'done' | 'working' | 'problem' | 'todo'

export interface Step {
  id: 'router' | 'ports' | 'address' | 'https' | 'reachable'
  label: string
  state: StepState
  detail: string
}

const PORT_PURPOSE: Record<HostPort['name'], string> = {
  acme: 'certificate check',
  web: 'the server',
  'voice-tcp': 'voice',
  'voice-udp': 'voice',
}

/** Plain-language steps: router found → ports opened → address → HTTPS certificate → reachable. */
export function hostChecklist(s: HostStatus): Step[] {
  const failed = s.ports.filter((p) => p.state === 'failed')
  const manual = s.ports.some((p) => p.state === 'manual')
  const router: Step = (() => {
    switch (s.router.state) {
      case 'searching':
        return { id: 'router', label: 'Find your router', state: 'working', detail: 'Looking for your router…' }
      case 'found':
        return { id: 'router', label: 'Find your router', state: 'done', detail: `Found your router (${s.router.kind ?? 'UPnP'}).` }
      case 'disabled':
        return { id: 'router', label: 'Find your router', state: 'done', detail: 'Automatic port opening is off: you forward the ports yourself.' }
      case 'not_found':
        return {
          id: 'router', label: 'Find your router', state: 'problem',
          detail: "Your router didn't answer. Automatic port opening (UPnP or NAT-PMP) is probably turned off in its settings.",
        }
      default:
        return { id: 'router', label: 'Find your router', state: 'todo', detail: '' }
    }
  })()

  const ports: Step = s.cgnat
    ? { id: 'ports', label: 'Open the ports', state: 'problem', detail: "Skipped: opening ports at home won't help behind your provider's shared address." }
    : s.ports.length > 0 && s.ports.every((p) => p.state === 'open')
      ? { id: 'ports', label: 'Open the ports', state: 'done', detail: `Opened ${s.ports.map((p) => `${p.external}/${p.protocol}`).join(', ')}.` }
      : failed.length > 0
        ? {
            id: 'ports', label: 'Open the ports', state: 'problem',
            detail: failed.map((p) => `${p.external}/${p.protocol} (${PORT_PURPOSE[p.name]}): ${p.error ?? 'refused'}`).join(' '),
          }
        : manual
          ? { id: 'ports', label: 'Open the ports', state: 'problem', detail: 'Forward the ports below on your router.' }
          : { id: 'ports', label: 'Open the ports', state: s.router.state === 'searching' ? 'todo' : 'working', detail: '' }

  const address: Step = s.address
    ? { id: 'address', label: 'Public address', state: 'done', detail: s.autoAddress ? `${s.address} (free automatic address for ${s.publicIp})` : s.address }
    : s.cgnat
      ? { id: 'address', label: 'Public address', state: 'problem', detail: `Your router's internet address (${s.publicIp}) is shared by your provider (carrier-grade NAT).` }
      : { id: 'address', label: 'Public address', state: 'todo', detail: 'Needs your router (or your own domain in server.json).' }

  const https: Step = (() => {
    const label = 'HTTPS certificate'
    switch (s.https.state) {
      case 'valid':
        return { id: 'https', label, state: 'done', detail: `Browsers trust ${s.https.domain}${s.https.expiresAt ? `, renews automatically before ${new Date(s.https.expiresAt).toLocaleDateString()}` : ''}.` }
      case 'requesting':
        return { id: 'https', label, state: 'working', detail: "Asking Let's Encrypt for a free certificate…" }
      case 'needs_port_80':
        return {
          id: 'https', label, state: 'problem',
          detail: "Let's Encrypt checks port 80, and your router won't open it. Friends with the Iskra desktop app can still join; browsers need HTTPS.",
        }
      case 'failed':
        return { id: 'https', label, state: 'problem', detail: `Let's Encrypt said: ${s.https.error ?? 'something went wrong'}. Retrying automatically.` }
      default:
        return { id: 'https', label, state: 'todo', detail: '' }
    }
  })()

  const reachable: Step =
    s.reachable === 'verified'
      ? { id: 'reachable', label: 'Reachable from the internet', state: 'done', detail: "Let's Encrypt reached your server from the internet." }
      : s.reachable === 'router'
        ? {
            id: 'reachable', label: 'Reachable from the internet', state: 'done',
            detail: 'Your router forwards the ports to this computer (checked from inside your network).',
          }
        : {
            id: 'reachable', label: 'Reachable from the internet', state: 'todo',
            detail: "Not confirmed from outside yet: Iskra doesn't use outside services to test. Send a friend an invite to try it.",
          }

  return [router, ports, address, https, reachable]
}

export interface Forward {
  external: number
  internal: number
  protocol: 'TCP' | 'UDP'
  purpose: string
}

/** Port forwards for the owner to set up by hand: everything the router didn't open for us. */
export function manualForwards(s: HostStatus): Forward[] {
  const autoHttps = s.ports.some((p) => p.name === 'acme')
  return s.ports
    .filter((p) => p.state === 'failed' || p.state === 'manual')
    .map((p) => ({
      // By hand, 443 works on any router (automatic opening may only have tried the server's own port).
      external: p.name === 'web' && autoHttps ? 443 : p.external,
      internal: p.internal,
      protocol: p.protocol === 'tcp' ? ('TCP' as const) : ('UDP' as const),
      purpose: PORT_PURPOSE[p.name],
    }))
}

/** This computer's LAN address (where forwards point), from the LAN URL. */
export function lanHost(s: HostStatus): string | null {
  if (!s.lanUrl) return null
  try {
    return new URL(s.lanUrl).hostname
  } catch {
    return null
  }
}

/** One line for the overall state, shown next to the toggle. */
export function hostSummary(s: HostStatus): { tone: 'ok' | 'warn' | 'busy' | 'off'; text: string } {
  if (!s.enabled) return { tone: 'off', text: 'Only people on your network can join.' }
  if (s.cgnat) return { tone: 'warn', text: "Your internet connection can't host a server directly." }
  if (s.publicUrl?.startsWith('https://')) return { tone: 'ok', text: 'Open to the internet. Invite links work in any browser.' }
  if (s.publicUrl) return { tone: 'warn', text: 'Open to the desktop app only: browsers need HTTPS.' }
  if (s.router.state === 'searching' || s.https.state === 'requesting') return { tone: 'busy', text: 'Setting things up…' }
  return { tone: 'warn', text: "Not reachable from the internet yet. See what's missing below." }
}
