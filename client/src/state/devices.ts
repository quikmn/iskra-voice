// Your devices: prekeys (forward secrecy), the device list, renaming and revoking.
// Servers only store what devices sign; every server you're on gets the same signed statements.
import { create } from 'zustand'
import { b64u } from '../core/crypto'
import {
  currentPrekey, rotatePrekeys, signPrekey, signRevocation, verifyRevocation, type Revocation,
} from '../core/devices'
import type { DeviceInfo } from '../core/protocol'
import * as storage from '../core/storage'
import { desktop } from '../platform/desktop'
import { connectionFor, onServerEvent, onWelcomeHook, useApp } from './store'

export interface DeviceView {
  deviceKey: string
  name: string
  platform: string | null
  created: number
  lastSeen: number
  current: boolean
}

interface DevicesState {
  devices: DeviceView[]
  loaded: boolean
  /** This device was removed from the account (by another of its devices). */
  thisDeviceRevoked: boolean
}

export const useDevices = create<DevicesState>(() => ({ devices: [], loaded: false, thisDeviceRevoked: false }))

const accountKey = () => {
  const identity = useApp.getState().identity
  return identity ? b64u(identity.account.publicKey) : ''
}
const thisDevice = () => useApp.getState().identity?.cert.deviceKey ?? ''

const onlineServers = () => {
  const { servers, order } = useApp.getState()
  return order.filter((key) => servers[key]?.status.state === 'online' && connectionFor(key))
}

/** "Firefox on Windows", "Safari on iPhone", "Iskra app on Windows". */
export function platformName(ua = globalThis.navigator?.userAgent ?? ''): string {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /CrOS/.test(ua) ? 'ChromeOS'
    : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : null
  const app = desktop ? 'Iskra app' : /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\/|FxiOS/.test(ua) ? 'Firefox'
    : /Chrome\/|CriOS/.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser'
  return os ? `${app} on ${os}` : app
}

// ── Prekeys ─────────────────────────────────────────────────────────────────

let prekeyQueue: Promise<boolean> = Promise.resolve(false)

/**
 * Loads this device's prekeys, rotates them if due (weekly; old secrets are deleted after the grace
 * period) and saves. Resolves true if there's a new current prekey to publish. Serialized.
 */
export function ensurePrekeys(): Promise<boolean> {
  prekeyQueue = prekeyQueue.then(async () => {
    const identity = useApp.getState().identity
    if (!identity) return false
    identity.prekeys ??= await storage.loadPrekeys()
    const { prekeys, changed } = rotatePrekeys(identity.prekeys)
    if (!changed) return false
    await storage.savePrekeys(prekeys)
    // The same identity object is shared with every connection and the DM code, so update it in place.
    identity.prekeys = prekeys
    return true
  }, () => false)
  return prekeyQueue
}

async function publishPrekey(serverKey: string): Promise<void> {
  const identity = useApp.getState().identity
  const current = currentPrekey(identity?.prekeys)
  if (!identity || !current) return
  await connectionFor(serverKey)?.request('prekey.publish', signPrekey(identity, current)).catch(() => undefined)
}

const SIX_HOURS = 6 * 60 * 60 * 1000
let rotationTimer: ReturnType<typeof setInterval> | null = null

function startRotationTimer(): void {
  if (rotationTimer) return
  rotationTimer = setInterval(() => {
    void ensurePrekeys().then(async (rotated) => {
      if (rotated) await Promise.all(onlineServers().map(publishPrekey))
    })
  }, SIX_HOURS)
}

// ── Revocations ─────────────────────────────────────────────────────────────

let revocationQueue: Promise<void> = Promise.resolve()

/** Adds verified revocations to the ones this device remembers. Returns the full list. */
function rememberRevocations(incoming: Revocation[]): Promise<Revocation[]> {
  let result: Revocation[] = []
  revocationQueue = revocationQueue.then(async () => {
    const account = accountKey()
    const known = await storage.loadRevocations()
    const byDevice = new Map(known.map((r) => [r.deviceKey, r]))
    let changed = false
    for (const r of incoming) {
      if (!byDevice.has(r.deviceKey) && verifyRevocation(account, r)) {
        byDevice.set(r.deviceKey, r)
        changed = true
      }
    }
    result = [...byDevice.values()]
    if (changed) await storage.saveRevocations(result)
    if (byDevice.has(thisDevice())) useDevices.setState({ thisDeviceRevoked: true })
  }).catch(() => undefined)
  return revocationQueue.then(() => result)
}

/** Device keys this account has revoked (as far as this device knows). */
export async function ownRevokedDevices(): Promise<Set<string>> {
  return new Set((await rememberRevocations([])).map((r) => r.deviceKey))
}

/** On every connect: publish our prekey, describe ourselves, and swap revocations with the server. */
async function onWelcome(serverKey: string): Promise<void> {
  startRotationTimer()
  const connection = connectionFor(serverKey)
  if (!connection) return
  const rotated = await ensurePrekeys()
  await publishPrekey(serverKey)
  if (rotated) for (const other of onlineServers()) if (other !== serverKey) void publishPrekey(other)
  void connection.request('device.describe', { name: platformName(), platform: platformName() }).catch(() => undefined)

  try {
    const { revoked } = await connection.request('device.list', {})
    const all = await rememberRevocations(revoked)
    const theirs = new Set(revoked.map((r) => r.deviceKey))
    // A revocation made on another server reaches this one through us.
    for (const r of all) if (!theirs.has(r.deviceKey)) await connection.request('device.revoke', r).catch(() => undefined)
  } catch {
    /* older server or busy; next connect tries again */
  }
  if (useDevices.getState().loaded) void refreshDevices()
}

// ── The device list ─────────────────────────────────────────────────────────

/** Merges every server's view of our devices (a device only shows up on servers it connected to). */
export async function refreshDevices(): Promise<void> {
  const lists = await Promise.all(
    onlineServers().map(async (key) => {
      try {
        const result = await connectionFor(key)!.request('device.list', {})
        void rememberRevocations(result.revoked)
        return result.devices
      } catch {
        return [] as DeviceInfo[]
      }
    }),
  )
  const revoked = await ownRevokedDevices()
  const merged = new Map<string, DeviceView>()
  for (const d of lists.flat().sort((a, b) => b.lastSeen - a.lastSeen)) {
    if (revoked.has(d.deviceKey)) continue
    const seen = merged.get(d.deviceKey)
    if (seen) {
      seen.platform ??= d.platform
      continue
    }
    merged.set(d.deviceKey, {
      deviceKey: d.deviceKey, name: d.name ?? d.platform ?? 'Unnamed device', platform: d.platform,
      created: d.created, lastSeen: d.lastSeen, current: d.deviceKey === thisDevice(),
    })
  }
  const devices = [...merged.values()].sort((a, b) => Number(b.current) - Number(a.current) || b.lastSeen - a.lastSeen)
  useDevices.setState({ devices, loaded: true })
}

export async function renameDevice(deviceKey: string, name: string): Promise<void> {
  await Promise.all(onlineServers().map((key) => connectionFor(key)!.request('device.rename', { deviceKey, name }).catch(() => undefined)))
  await refreshDevices()
}

/** Signs the revocation and hands it to every server we're on (the rest get it on our next connect). */
export async function revokeDevice(deviceKey: string): Promise<void> {
  const identity = useApp.getState().identity
  if (!identity || deviceKey === thisDevice()) return
  const revocation = signRevocation(identity, deviceKey)
  await rememberRevocations([revocation])
  useDevices.setState((s) => ({ devices: s.devices.filter((d) => d.deviceKey !== deviceKey) }))
  await Promise.all(onlineServers().map((key) => connectionFor(key)!.request('device.revoke', revocation).catch(() => undefined)))
  await refreshDevices()
}

/** After this device was removed: forget everything stored here and start over. */
export async function resetThisDevice(): Promise<void> {
  await storage.wipeAll()
  window.location.reload()
}

onWelcomeHook((serverKey) => void onWelcome(serverKey))
onServerEvent((_server, type, body) => {
  if (type !== 'device.revoked') return
  const { deviceKey } = body as { deviceKey: string }
  if (deviceKey === thisDevice()) useDevices.setState({ thisDeviceRevoked: true })
  else if (useDevices.getState().loaded) void refreshDevices()
})
// The server refuses a revoked device at the handshake.
useApp.subscribe((state) => {
  if (useDevices.getState().thisDeviceRevoked) return
  if (Object.values(state.servers).some((s) => s.status.state === 'rejected' && s.status.code === 'device_revoked'))
    useDevices.setState({ thisDeviceRevoked: true })
})
// Load prekeys as soon as there's an identity, so DMs that arrive first can be read.
useApp.subscribe((state, previous) => {
  if (state.identity && state.identity !== previous.identity) void ensurePrekeys()
})
