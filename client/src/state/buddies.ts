// Backup buddies (Settings → Backup & move, owner only): this server's backups at friends' servers, and the spots this
// server keeps for friends. See "Backup buddies" in PROTOCOL.md. State changes only from the server's answers and its
// buddy.changed event.
import { create } from 'zustand'
import type { Buddy, BuddySpot, BuddySpots, BuddyStatus } from '../core/protocol'
import { connectionFor, onServerEvent, onWelcomeHook } from './store'
import { t } from '../i18n'

interface BuddiesState {
  /** serverKey → our buddies (we're the source). */
  status: Record<string, BuddyStatus | undefined>
  /** serverKey → the spots we keep for friends (we're the holder). */
  spots: Record<string, BuddySpots | undefined>
}

export const useBuddies = create<BuddiesState>(() => ({ status: {}, spots: {} }))

function connection(serverKey: string) {
  const c = connectionFor(serverKey)
  if (!c) throw new Error(t('settings.backup.notConnected'))
  return c
}

function setStatus(serverKey: string, status: BuddyStatus) {
  useBuddies.setState((s) => ({ status: { ...s.status, [serverKey]: status } }))
}

function setSpots(serverKey: string, spots: BuddySpots) {
  useBuddies.setState((s) => ({ spots: { ...s.spots, [serverKey]: spots } }))
}

/** Something changed (an upload, a pairing, a removal): look again, if we were looking. */
onServerEvent((serverKey, type) => {
  if (type !== 'buddy.changed') return
  const { status, spots } = useBuddies.getState()
  if (status[serverKey]) void loadBuddies(serverKey).catch(() => undefined)
  if (spots[serverKey]) void loadSpots(serverKey).catch(() => undefined)
})

// A reconnect (or a restart) may have missed events.
onWelcomeHook((serverKey) => {
  const { status, spots } = useBuddies.getState()
  if (status[serverKey]) void loadBuddies(serverKey).catch(() => undefined)
  if (spots[serverKey]) void loadSpots(serverKey).catch(() => undefined)
})

export async function loadBuddies(serverKey: string): Promise<BuddyStatus> {
  const status = await connection(serverKey).request('buddy.status', {})
  setStatus(serverKey, status)
  return status
}

/** Pairs with a friend's spot. Returns the recovery code when this made it (the first buddy): show it once. */
export async function addBuddy(serverKey: string, code: string): Promise<string | null> {
  const { recoveryCode, ...status } = await connection(serverKey).request('buddy.add', { code: code.trim() }, 90_000)
  setStatus(serverKey, status)
  return recoveryCode
}

export async function removeBuddy(serverKey: string, id: string): Promise<void> {
  setStatus(serverKey, await connection(serverKey).request('buddy.remove', { id }, 90_000))
}

export async function backupNow(serverKey: string): Promise<void> {
  setStatus(serverKey, await connection(serverKey).request('buddy.backupNow', {}, 5 * 60_000))
}

export async function showRecoveryCode(serverKey: string): Promise<string> {
  return (await connection(serverKey).request('buddy.recoveryCode', {})).recoveryCode
}

export async function loadSpots(serverKey: string): Promise<BuddySpots> {
  const spots = await connection(serverKey).request('buddy.spots', {})
  setSpots(serverKey, spots)
  return spots
}

/** Makes a spot for a friend's server and returns its one-time pairing code. */
export async function createSpot(serverKey: string, spot: { label: string; quotaMb: number; keep: number; graceDays: number; url?: string }): Promise<string> {
  const { code } = await connection(serverKey).request('buddy.spot.create', spot)
  await loadSpots(serverKey)
  return code
}

export async function updateSpot(serverKey: string, id: string, patch: { label?: string; quotaMb?: number; keep?: number; graceDays?: number }): Promise<void> {
  await connection(serverKey).request('buddy.spot.update', { id, ...patch })
  await loadSpots(serverKey)
}

export async function removeSpot(serverKey: string, id: string, now = false): Promise<void> {
  setSpots(serverKey, await connection(serverKey).request('buddy.spot.remove', { id, now }))
}

// ── Pure helpers (tested) ────────────────────────────────────────────────

const PREFIX = 'iskra-buddy:'

/** The address a pairing code leads to (shown before adding), or null when it isn't one. */
export function pairingCodeAddress(code: string): string | null {
  const text = code.trim()
  if (!text.startsWith(PREFIX) || text.length > 1024) return null
  try {
    const base64 = text.slice(PREFIX.length).replace(/-/g, '+').replace(/_/g, '/')
    const json = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)))) as { v?: number; url?: unknown }
    return json.v === 1 && typeof json.url === 'string' && /^https?:\/\//.test(json.url) ? json.url : null
  } catch {
    return null
  }
}

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** A recovery code as typed: case, spaces and dashes don't matter, O/I/L read as 0/1/1. Null unless it's 25 letters. */
export function normalizeRecoveryCode(typed: string): string | null {
  const chars = [...typed.toUpperCase()].filter((c) => c !== ' ' && c !== '-').map((c) => (c === 'O' ? '0' : c === 'I' || c === 'L' ? '1' : c))
  return chars.length === 25 && chars.every((c) => ALPHABET.includes(c)) ? chars.join('') : null
}

export type BuddyState = 'sending' | 'ok' | 'waiting' | 'problem' | 'removed'

/** What a buddy row says at a glance. */
export function buddyState(buddy: Buddy): BuddyState {
  if (buddy.removed) return 'removed'
  if (buddy.uploading) return 'sending'
  if (buddy.error) return 'problem'
  return buddy.lastOk ? 'ok' : 'waiting'
}

/** 0–1 of a spot's quota in use. */
export function spotUsage(spot: Pick<BuddySpot, 'used' | 'quotaBytes'>): number {
  return spot.quotaBytes > 0 ? Math.min(1, spot.used / spot.quotaBytes) : 0
}

export const QUOTA_CHOICES_MB = [500, 1024, 2048, 5120, 10240, 51200] as const
