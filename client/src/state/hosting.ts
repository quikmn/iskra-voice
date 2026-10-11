// "Open to the internet": the owner's view of internet hosting, plus the public address invite links use.
import { create } from 'zustand'
import type { HostPort, HostStatus } from '../core/protocol'
import { connectionFor, onServerEvent, useApp, type ServerState } from './store'
import { t } from '../i18n'
import { formatDate } from '../i18n/format'

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
  if (!connection) throw new Error(t('errors.codes.disconnected'))
  const { status } = await connection.request('host.status', {})
  setStatus(key, status)
  return status
}

/** Turns internet hosting on or off. Turning it on while it's on checks everything again right away. */
export async function setInternet(key: string, enabled: boolean): Promise<void> {
  const connection = connectionFor(key)
  if (!connection) throw new Error(t('errors.codes.disconnected'))
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

const PORT_PURPOSE = {
  acme: 'settings.internet.purpose.acme',
  web: 'settings.internet.purpose.web',
  'voice-tcp': 'settings.internet.purpose.voice',
  'voice-udp': 'settings.internet.purpose.voice',
} as const satisfies Record<HostPort['name'], string>

/** Plain-language steps: router found → ports opened → address → HTTPS certificate → reachable. */
export function hostChecklist(s: HostStatus): Step[] {
  const failed = s.ports.filter((p) => p.state === 'failed')
  const manual = s.ports.some((p) => p.state === 'manual')
  const routerLabel = t('settings.internet.steps.router')
  const router: Step = (() => {
    switch (s.router.state) {
      case 'searching':
        return { id: 'router', label: routerLabel, state: 'working', detail: t('settings.internet.steps.routerSearching') }
      case 'found':
        return { id: 'router', label: routerLabel, state: 'done', detail: t('settings.internet.steps.routerFound', { kind: s.router.kind ?? 'UPnP' }) }
      case 'disabled':
        return { id: 'router', label: routerLabel, state: 'done', detail: t('settings.internet.steps.routerDisabled') }
      case 'not_found':
        return { id: 'router', label: routerLabel, state: 'problem', detail: t('settings.internet.steps.routerNotFound') }
      default:
        return { id: 'router', label: routerLabel, state: 'todo', detail: '' }
    }
  })()

  const portsLabel = t('settings.internet.steps.ports')
  const ports: Step = s.cgnat
    ? { id: 'ports', label: portsLabel, state: 'problem', detail: t('settings.internet.steps.portsSkipped') }
    : s.ports.length > 0 && s.ports.every((p) => p.state === 'open')
      ? { id: 'ports', label: portsLabel, state: 'done', detail: t('settings.internet.steps.portsOpened', { ports: s.ports.map((p) => `${p.external}/${p.protocol}`).join(', ') }) }
      : failed.length > 0
        ? {
            id: 'ports', label: portsLabel, state: 'problem',
            detail: failed.map((p) => `${p.external}/${p.protocol} (${t(PORT_PURPOSE[p.name])}): ${p.error ?? t('settings.internet.steps.refused')}`).join(' '),
          }
        : manual
          ? { id: 'ports', label: portsLabel, state: 'problem', detail: t('settings.internet.steps.portsManual') }
          : { id: 'ports', label: portsLabel, state: s.router.state === 'searching' ? 'todo' : 'working', detail: '' }

  const addressLabel = t('settings.internet.steps.address')
  const address: Step = s.address
    ? { id: 'address', label: addressLabel, state: 'done', detail: s.autoAddress ? t('settings.internet.steps.autoAddress', { address: s.address, ip: s.publicIp ?? '' }) : s.address }
    : s.cgnat
      ? { id: 'address', label: addressLabel, state: 'problem', detail: t('settings.internet.steps.addressShared', { ip: s.publicIp ?? '' }) }
      : { id: 'address', label: addressLabel, state: 'todo', detail: t('settings.internet.steps.addressNeeds') }

  const https: Step = (() => {
    const label = t('settings.internet.steps.https')
    switch (s.https.state) {
      case 'valid':
        return {
          id: 'https', label, state: 'done',
          detail: s.https.expiresAt
            ? t('settings.internet.steps.httpsValidRenews', { domain: s.https.domain ?? '', date: formatDate(s.https.expiresAt, { year: 'numeric', month: 'numeric', day: 'numeric' }) })
            : t('settings.internet.steps.httpsValid', { domain: s.https.domain ?? '' }),
        }
      case 'requesting':
        return { id: 'https', label, state: 'working', detail: t('settings.internet.steps.httpsRequesting') }
      case 'needs_port_80':
        return { id: 'https', label, state: 'problem', detail: t('settings.internet.steps.httpsPort80') }
      case 'failed':
        return { id: 'https', label, state: 'problem', detail: t('settings.internet.steps.httpsFailed', { error: s.https.error ?? t('settings.internet.steps.somethingWrong') }) }
      default:
        return { id: 'https', label, state: 'todo', detail: '' }
    }
  })()

  const reachableLabel = t('settings.internet.steps.reachable')
  const reachable: Step =
    s.reachable === 'verified'
      ? { id: 'reachable', label: reachableLabel, state: 'done', detail: t('settings.internet.steps.reachableVerified') }
      : s.reachable === 'router'
        ? { id: 'reachable', label: reachableLabel, state: 'done', detail: t('settings.internet.steps.reachableRouter') }
        : { id: 'reachable', label: reachableLabel, state: 'todo', detail: t('settings.internet.steps.reachableUnknown') }

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
      purpose: t(PORT_PURPOSE[p.name]),
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
  if (!s.enabled) return { tone: 'off', text: t('settings.internet.summary.off') }
  if (s.cgnat) return { tone: 'warn', text: t('settings.internet.summary.cgnat') }
  if (s.publicUrl?.startsWith('https://')) return { tone: 'ok', text: t('settings.internet.summary.open') }
  if (s.publicUrl) return { tone: 'warn', text: t('settings.internet.summary.plainHttp') }
  if (s.router.state === 'searching') return { tone: 'busy', text: t('settings.internet.summary.settingUp') }
  if (s.address && (s.https.state === 'requesting' || s.https.state === 'waiting')) return { tone: 'busy', text: t('settings.internet.summary.waitingHttps') }
  if (s.address && s.https.state !== 'valid') return { tone: 'warn', text: t('settings.internet.summary.waitingHttpsLocal') }
  return { tone: 'warn', text: t('settings.internet.summary.notReachable') }
}
