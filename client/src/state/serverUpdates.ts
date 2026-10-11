// Server updates (Settings → Updates, owner only) and the "restarting for an update" notice everyone sees.
import { create } from 'zustand'
import type { AutoUpdateBlock, Events, ServerUpdateStatus, UpdateChannel, UpdateMode } from '../core/protocol'
import { connectionFor, onServerEvent, onWelcomeHook } from './store'

interface ServerUpdatesState {
  /** serverKey → the update status (owners only). */
  status: Record<string, ServerUpdateStatus | undefined>
  /** serverKey → the version it's restarting into, until it's back. */
  restarting: Record<string, string | undefined>
}

export const useServerUpdates = create<ServerUpdatesState>(() => ({ status: {}, restarting: {} }))

function put(serverKey: string, status: ServerUpdateStatus) {
  useServerUpdates.setState((s) => ({ status: { ...s.status, [serverKey]: status } }))
}

onWelcomeHook((serverKey, welcome) => {
  // Back after a restart: the notice has done its job.
  useServerUpdates.setState((s) => ({ restarting: { ...s.restarting, [serverKey]: undefined } }))
  if (welcome.you.role !== 'owner') return
  connectionFor(serverKey)
    ?.request('update.status', {})
    .then(({ status }) => put(serverKey, status))
    .catch(() => undefined) // an older server without updates
})

onServerEvent((serverKey, type, body) => {
  if (type === 'update.status') put(serverKey, (body as Events['update.status']).status)
  else if (type === 'server.restarting') {
    const { version } = body as Events['server.restarting']
    useServerUpdates.setState((s) => ({ restarting: { ...s.restarting, [serverKey]: version } }))
  }
})

function connection(serverKey: string) {
  const c = connectionFor(serverKey)
  if (!c) throw new Error('Not connected to this server.')
  return c
}

export async function checkForUpdates(serverKey: string): Promise<ServerUpdateStatus> {
  const { status } = await connection(serverKey).request('update.check', {}, 60_000)
  put(serverKey, status)
  return status
}

export async function changeUpdateSettings(
  serverKey: string,
  change: { mode?: UpdateMode; channel?: UpdateChannel; window?: string; requireAttestation?: boolean },
): Promise<void> {
  put(serverKey, (await connection(serverKey).request('update.settings', change)).status)
}

export async function installUpdate(serverKey: string): Promise<void> {
  put(serverKey, (await connection(serverKey).request('update.install', {})).status)
}

// ── pure helpers (tested) ──

/** The owner's "Update available" notice, unless there's nothing new, updates are off, or they dismissed this version. */
export function updateNotice(status: ServerUpdateStatus | undefined, dismissed: string | null): { version: string; url: string; installing: boolean } | null {
  if (!status?.latest || status.mode === 'off' || status.managed) return null
  const installing = !['idle', 'failed', 'checking'].includes(status.state)
  if (!installing && status.latest.version === dismissed) return null
  return { version: status.latest.version, url: status.latest.url, installing }
}

/** Why "Install automatically" isn't available here, in plain words. */
export function autoBlockText(reason: AutoUpdateBlock | null): string {
  switch (reason) {
    case 'desktop': return 'This server runs in the Iskra desktop app and updates together with it.'
    case 'development': return 'This is a development build; it doesn’t update.'
    case 'platform': return 'Installing by itself works on Linux servers run by systemd. Here you’ll get a notice, then download the new version yourself.'
    case 'guard': return 'Add iskra-update-guard to the systemd service (see the hosting guide) so a failed update can be undone; then it can install by itself.'
    case 'readonly': return 'The server can’t write to the folder it runs from, so it can’t replace itself.'
    default: return ''
  }
}

/** What's happening right now, for the status line. */
export function stateText(status: ServerUpdateStatus): string | null {
  switch (status.state) {
    case 'checking': return 'Checking for updates…'
    case 'downloading': {
      const p = progressPercent(status)
      return p === null ? 'Downloading…' : `Downloading… ${p}%`
    }
    case 'verifying': return 'Checking the download…'
    case 'installing': return 'Installing…'
    case 'restarting': return 'Restarting into the new version…'
    default: return null
  }
}

export function progressPercent(status: ServerUpdateStatus): number | null {
  const p = status.progress
  if (!p || p.total <= 0) return null
  return Math.max(0, Math.min(100, Math.floor((p.done / p.total) * 100)))
}

/** "04:00" style, as the server wants it; null if it isn't one. */
export function normalizeWindow(text: string): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return `${String(h).padStart(2, '0')}:${m[2]}`
}
