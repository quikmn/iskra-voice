// Profile sync: your profile follows your account across devices. Each edit is stamped (time, device); the newest
// stamp wins on every device and on every server. The account's copy is a synced preference named "profile" (sealed
// like the rest, see core/prefs.ts); avatar and page travel as hashes, their bytes come from a server that has them.
// Rules: protocol/PROTOCOL.md, "Profile sync".
import { ACCENT_PATTERN, MAX_BIO, MAX_PAGE_BYTES, MAX_PRONOUNS, sha256Hex, utf8Length } from './profile'
import type { ProfileStamp } from './protocol'
import type { Profile } from './storage'

export const PROFILE_PREF = 'profile'
/** Stamps further ahead than this are refused (servers apply the same rule against their own clock). */
export const MAX_AHEAD = 24 * 60 * 60 * 1000
const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const HASH = /^[0-9a-f]{64}$/

export interface Stamp {
  updatedAt: number
  by: string
}

/** The account's copy (inside the sealed preference). Undefined fields: never set, so the other side keeps its own. */
export interface SyncedProfile extends Stamp {
  v: 1
  name: string
  bio?: string
  pronouns?: string
  accent?: string
  avatar?: { hash: string; type: string } | null
  page?: { hash: string } | null
}

/** An unstamped profile (from before sync, or a restored device) counts as the oldest. */
export const stampOf = (p: Partial<Stamp> | null | undefined): Stamp => ({ updatedAt: p?.updatedAt ?? 0, by: p?.by ?? '' })

/** Newer time wins; at the same millisecond the larger device key does, so every device and server agrees. */
export function compareStamps(a: Stamp, b: Stamp): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? -1 : 1
  return a.by === b.by ? 0 : a.by < b.by ? -1 : 1
}

/**
 * The stamp for a new edit on this device: never older than what this device already knows, so an edit made after
 * catching up always wins even if this clock is behind. A known stamp from a clock far ahead isn't followed.
 */
export function nextStamp(current: Partial<Stamp> | null | undefined, by: string, now = Date.now()): Stamp {
  const known = current?.updatedAt ?? 0
  return { updatedAt: known < now + MAX_AHEAD ? Math.max(now, known + 1) : now, by }
}

/** The stamp as sent to servers (nothing for an unstamped profile). */
export const wireStamp = (p: Partial<Stamp> | null | undefined): ProfileStamp =>
  p?.updatedAt ? { updatedAt: p.updatedAt, by: p.by ?? '' } : {}

export function toSynced(p: Profile): SyncedProfile | null {
  if (!p.updatedAt) return null
  const out: SyncedProfile = { v: 1, updatedAt: p.updatedAt, by: p.by ?? '', name: p.name }
  if (p.bio !== undefined) out.bio = p.bio
  if (p.pronouns !== undefined) out.pronouns = p.pronouns
  if (p.accent !== undefined) out.accent = p.accent
  if (p.avatar !== undefined) out.avatar = p.avatar && { hash: p.avatar.hash, type: p.avatar.type }
  if (p.page !== undefined) out.page = p.page && { hash: p.page.hash }
  return out
}

/** Checks a decrypted copy; anything malformed (or stamped too far ahead) makes it unusable. */
export function parseSynced(text: string, now = Date.now()): SyncedProfile | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (r.v !== 1 || !Number.isSafeInteger(r.updatedAt) || (r.updatedAt as number) < 1 || (r.updatedAt as number) > now + MAX_AHEAD) return null
  if (typeof r.by !== 'string' || r.by.length > 64) return null
  if (typeof r.name !== 'string' || r.name.trim().length === 0 || r.name.length > 64) return null
  const out: SyncedProfile = { v: 1, updatedAt: r.updatedAt as number, by: r.by, name: r.name }
  if (r.bio !== undefined) {
    if (typeof r.bio !== 'string' || r.bio.length > MAX_BIO) return null
    out.bio = r.bio
  }
  if (r.pronouns !== undefined) {
    if (typeof r.pronouns !== 'string' || r.pronouns.length > MAX_PRONOUNS) return null
    out.pronouns = r.pronouns
  }
  if (r.accent !== undefined) {
    if (typeof r.accent !== 'string' || (r.accent !== '' && !ACCENT_PATTERN.test(r.accent))) return null
    out.accent = r.accent
  }
  if (r.avatar === null) out.avatar = null
  else if (r.avatar !== undefined) {
    const a = r.avatar as Record<string, unknown>
    if (typeof a !== 'object' || typeof a.hash !== 'string' || !HASH.test(a.hash) || typeof a.type !== 'string' || !AVATAR_TYPES.includes(a.type)) return null
    out.avatar = { hash: a.hash, type: a.type }
  }
  if (r.page === null) out.page = null
  else if (r.page !== undefined) {
    const pg = r.page as Record<string, unknown>
    if (typeof pg !== 'object' || typeof pg.hash !== 'string' || !HASH.test(pg.hash)) return null
    out.page = { hash: pg.hash }
  }
  return out
}

/** The avatar and page bytes this device needs from a server before it can take the copy. */
export function missing(local: Profile, remote: SyncedProfile): { avatar?: { hash: string; type: string }; page?: { hash: string } } {
  const out: { avatar?: { hash: string; type: string }; page?: { hash: string } } = {}
  if (remote.avatar && local.avatar?.hash !== remote.avatar.hash) out.avatar = remote.avatar
  if (remote.page && local.page?.hash !== remote.page.hash) out.page = remote.page
  return out
}

/**
 * This device's profile after taking the newer copy, or null while a needed avatar or page isn't here yet (fetched
 * bytes are checked against the hashes). Device-only fields (recoverySaved) stay as they are.
 */
export function adopt(local: Profile, remote: SyncedProfile, fetched: { avatar?: ArrayBuffer; page?: string } = {}): Profile | null {
  const next: Profile = { ...local, name: remote.name, updatedAt: remote.updatedAt, by: remote.by }
  if (remote.bio !== undefined) next.bio = remote.bio
  if (remote.pronouns !== undefined) next.pronouns = remote.pronouns
  if (remote.accent !== undefined) next.accent = remote.accent
  if (remote.avatar === null) next.avatar = null
  else if (remote.avatar && local.avatar?.hash !== remote.avatar.hash) {
    const bytes = fetched.avatar
    if (!bytes || bytes.byteLength === 0 || sha256Hex(new Uint8Array(bytes)) !== remote.avatar.hash) return null
    next.avatar = { bytes, type: remote.avatar.type, hash: remote.avatar.hash }
  }
  if (remote.page === null) next.page = null
  else if (remote.page && local.page?.hash !== remote.page.hash) {
    const html = fetched.page
    if (html === undefined || utf8Length(html) > MAX_PAGE_BYTES || sha256Hex(new TextEncoder().encode(html)) !== remote.page.hash) return null
    next.page = { html, hash: remote.page.hash }
  }
  return next
}
