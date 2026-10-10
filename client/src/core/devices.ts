// Device revocations and signed prekeys. See "Devices" and "Forward secrecy" in protocol/PROTOCOL.md.
import sodium from 'libsodium-wrappers-sumo'
import { b64u, fromB64u, sign, signedPayload, u64be, verify } from './crypto'
import type { Identity } from './identity'

export const REVOKE_CONTEXT = 'iskra/device-revoke/v1'
export const PREKEY_CONTEXT = 'iskra/prekey/v1'

const DAY = 24 * 60 * 60 * 1000
/** A new prekey every week… */
export const PREKEY_ROTATE_MS = 7 * DAY
/** …and the old one's secret is kept this long after that, for messages still on their way, then deleted. */
export const PREKEY_GRACE_MS = 30 * DAY
/** Senders ignore prekeys older than this (the device hasn't been online for ages). Servers refuse them too. */
export const PREKEY_MAX_AGE_MS = 60 * DAY

/** An account-signed statement that one of its devices no longer belongs to it. */
export interface Revocation {
  deviceKey: string
  revokedAt: number
  sig: string
}

/** A device's current X25519 prekey, signed by its Ed25519 device key. */
export interface SignedPrekey {
  deviceKey: string
  key: string
  created: number
  sig: string
}

/** A prekey as this device keeps it. `retiredAt` is set once a newer one replaces it. */
export interface PrekeyPair {
  publicKey: Uint8Array
  secretKey: Uint8Array
  created: number
  retiredAt?: number
}

export function signRevocation(identity: Identity, deviceKey: string, revokedAt = Date.now()): Revocation {
  const payload = signedPayload(REVOKE_CONTEXT, fromB64u(deviceKey), u64be(revokedAt))
  return { deviceKey, revokedAt, sig: b64u(sign(payload, identity.account.secretKey)) }
}

export function verifyRevocation(accountKey: string, r: Revocation): boolean {
  try {
    const device = fromB64u(r.deviceKey)
    if (device.length !== 32 || !Number.isSafeInteger(r.revokedAt) || r.revokedAt < 0) return false
    return verify(fromB64u(r.sig), signedPayload(REVOKE_CONTEXT, device, u64be(r.revokedAt)), fromB64u(accountKey))
  } catch {
    return false
  }
}

/** Device keys an account has revoked, counting only revocations really signed by that account. */
export function revokedSet(accountKey: string, revocations: Revocation[] | undefined): Set<string> {
  return new Set((revocations ?? []).filter((r) => verifyRevocation(accountKey, r)).map((r) => r.deviceKey))
}

export function generatePrekey(now = Date.now()): PrekeyPair {
  const kp = sodium.crypto_box_keypair()
  return { publicKey: kp.publicKey, secretKey: kp.privateKey, created: now }
}

export function signPrekey(identity: Identity, prekey: PrekeyPair): SignedPrekey {
  const payload = signedPayload(PREKEY_CONTEXT, prekey.publicKey, u64be(prekey.created))
  return { deviceKey: b64u(identity.device.publicKey), key: b64u(prekey.publicKey), created: prekey.created, sig: b64u(sign(payload, identity.device.secretKey)) }
}

export function verifyPrekey(p: SignedPrekey): boolean {
  try {
    const key = fromB64u(p.key)
    if (key.length !== 32 || !Number.isSafeInteger(p.created) || p.created < 0) return false
    return verify(fromB64u(p.sig), signedPayload(PREKEY_CONTEXT, key, u64be(p.created)), fromB64u(p.deviceKey))
  } catch {
    return false
  }
}

/** The prekey this device hands out right now. */
export function currentPrekey(prekeys: PrekeyPair[] | undefined): PrekeyPair | undefined {
  return prekeys?.filter((p) => p.retiredAt === undefined).sort((a, b) => b.created - a.created)[0]
}

/**
 * Weekly rotation: retires the current prekey once it's a week old (or makes the first one), and deletes
 * retired secrets after the grace period. That deletion is what gives forward secrecy.
 */
export function rotatePrekeys(prekeys: PrekeyPair[], now = Date.now()): { prekeys: PrekeyPair[]; changed: boolean } {
  let changed = false
  let next = prekeys.filter((p) => {
    const expired = p.retiredAt !== undefined && now - p.retiredAt > PREKEY_GRACE_MS
    if (expired) {
      sodium.memzero(p.secretKey)
      changed = true
    }
    return !expired
  })
  const current = currentPrekey(next)
  if (!current || now - current.created >= PREKEY_ROTATE_MS) {
    next = next.map((p) => (p.retiredAt === undefined ? { ...p, retiredAt: now } : p))
    next.push(generatePrekey(now))
    changed = true
  }
  return { prekeys: next, changed }
}

/** The newest usable prekey per device: correctly signed, not stale, not from the future. */
export function usablePrekeys(prekeys: SignedPrekey[] | undefined, now = Date.now()): Map<string, SignedPrekey> {
  const best = new Map<string, SignedPrekey>()
  for (const p of prekeys ?? []) {
    if (now - p.created > PREKEY_MAX_AGE_MS || p.created - now > DAY || !verifyPrekey(p)) continue
    const seen = best.get(p.deviceKey)
    if (!seen || p.created > seen.created) best.set(p.deviceKey, p)
  }
  return best
}
