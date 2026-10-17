// The server's public page (Server settings → Overview → Public page, owner only): what a browser sees at the server's
// own address. See "Public page" in PROTOCOL.md. The settings change only from the server's answers and events.
import { create } from 'zustand'
import type { Events, Invite, LandingSettings, Requests } from '../core/protocol'
import { t } from '../i18n'
import { connectionFor, onServerEvent } from './store'

/** The description's limit (the server checks it too). */
export const LANDING_DESCRIPTION_MAX = 500

interface LandingState {
  /** serverKey → the page's settings, once the owner's screen loaded them. */
  settings: Record<string, LandingSettings | undefined>
}

export const useLanding = create<LandingState>(() => ({ settings: {} }))

const put = (serverKey: string, settings: LandingSettings) =>
  useLanding.setState((s) => ({ settings: { ...s.settings, [serverKey]: settings } }))

onServerEvent((serverKey, type, body) => {
  if (type === 'landing.settings') put(serverKey, (body as Events['landing.settings']).settings)
})

function connection(serverKey: string) {
  const c = connectionFor(serverKey)
  if (!c) throw new Error(t('errors.codes.disconnected'))
  return c
}

export const useLandingSettings = (serverKey: string) => useLanding((s) => s.settings[serverKey])

export async function loadLanding(serverKey: string): Promise<LandingSettings> {
  const { settings } = await connection(serverKey).request('landing.get', {})
  put(serverKey, settings)
  return settings
}

export async function updateLanding(serverKey: string, patch: Requests['landing.update'][0]): Promise<LandingSettings> {
  const { settings } = await connection(serverKey).request('landing.update', patch)
  put(serverKey, settings)
  return settings
}

/** Invites that can go on the page: still working, and for members or guests only (never a higher role). */
export function landingInviteChoices(invites: Invite[], now: number): Invite[] {
  return invites.filter((i) =>
    (i.role === 'member' || i.role === 'guest')
    && (i.expiresAt === null || i.expiresAt > now)
    && (i.maxUses === null || i.uses < i.maxUses))
}

/** The page's address: where people reach the server (its public address once it has one). */
export function landingUrl(server: { publicUrl?: string | null; directUrl: string }): string {
  return `${(server.publicUrl ?? server.directUrl).replace(/\/+$/, '')}/`
}
