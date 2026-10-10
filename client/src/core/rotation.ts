// Account key rotation: the old account key signs over to a new one. See "Account key rotation" in protocol/PROTOCOL.md.
// Everything here is checked by the client itself; the server's word is never enough.
import sodium from 'libsodium-wrappers-sumo'
import { b64u, fromB64u, generateSigningKeyPair, sign, signedPayload, signingKeyPairFromSeed, u64be, verify, type SigningKeyPair } from './crypto'
import { certifyDevice, verifyDeviceCert, type DeviceCert, type Identity } from './identity'

export const ROTATE_CONTEXT = 'iskra/account-rotate/v1'

export interface Rotation {
  oldKey: string
  newKey: string
  rotatedAt: number
  oldSig: string
  newSig: string
}

/** A rotation as a server applied it, plus a second claim on the same old key (a dispute). */
export interface AppliedRotation extends Rotation {
  appliedAt: number
  contest: Rotation | null
  disputed: boolean
}

export interface Handover {
  device: string
  seal: string
}

function payload(oldKey: Uint8Array, newKey: Uint8Array, rotatedAt: number): Uint8Array {
  return signedPayload(ROTATE_CONTEXT, oldKey, newKey, u64be(rotatedAt))
}

export function signRotation(oldAccount: SigningKeyPair, newAccount: SigningKeyPair, rotatedAt = Date.now()): Rotation {
  const message = payload(oldAccount.publicKey, newAccount.publicKey, rotatedAt)
  return {
    oldKey: b64u(oldAccount.publicKey),
    newKey: b64u(newAccount.publicKey),
    rotatedAt,
    oldSig: b64u(sign(message, oldAccount.secretKey)),
    newSig: b64u(sign(message, newAccount.secretKey)),
  }
}

/** Both keys signed the same statement. */
export function verifyRotation(r: Rotation | null | undefined): r is Rotation {
  try {
    if (!r || typeof r.oldKey !== 'string' || typeof r.newKey !== 'string' || r.oldKey === r.newKey) return false
    if (!Number.isSafeInteger(r.rotatedAt) || r.rotatedAt < 0) return false
    const oldKey = fromB64u(r.oldKey)
    const newKey = fromB64u(r.newKey)
    if (oldKey.length !== 32 || newKey.length !== 32) return false
    const message = payload(oldKey, newKey, r.rotatedAt)
    return verify(fromB64u(r.oldSig), message, oldKey) && verify(fromB64u(r.newSig), message, newKey)
  } catch {
    return false
  }
}

/** Just the signed part (what other servers need). */
export const bareRotation = (r: Rotation): Rotation => ({ oldKey: r.oldKey, newKey: r.newKey, rotatedAt: r.rotatedAt, oldSig: r.oldSig, newSig: r.newSig })

const toX25519Public = (deviceKey: string) => sodium.crypto_sign_ed25519_pk_to_curve25519(fromB64u(deviceKey))

/** Seals the new account seed to one of the account's other devices. */
export function sealHandover(newSeed: Uint8Array, deviceKey: string): Handover {
  return { device: deviceKey, seal: b64u(sodium.crypto_box_seal(newSeed, toX25519Public(deviceKey))) }
}

/**
 * Opens this device's hand-over. Only accepted if the seed's public key is the new key of a rotation that is
 * correctly signed and starts at a key this device holds, so neither a server nor a third party can swap it.
 */
export function openHandover(identity: Identity, seal: string, rotations: Rotation[]): { account: SigningKeyPair; rotation: Rotation } | null {
  const pk = sodium.crypto_sign_ed25519_pk_to_curve25519(identity.device.publicKey)
  const sk = sodium.crypto_sign_ed25519_sk_to_curve25519(identity.device.secretKey)
  try {
    const seed = sodium.crypto_box_seal_open(fromB64u(seal), pk, sk)
    if (seed.length !== 32) return null
    const account = signingKeyPairFromSeed(seed)
    sodium.memzero(seed)
    const newKey = b64u(account.publicKey)
    const chain = chainFrom(b64u(identity.account.publicKey), rotations)
    const rotation = chain.find((r) => r.newKey === newKey)
    return rotation ? { account, rotation } : null
  } catch {
    return null
  } finally {
    sodium.memzero(sk)
  }
}

/** Verified rotations leading on from <paramref name="key"/>, in order (first valid link from each key). */
export function chainFrom(key: string, rotations: Rotation[]): Rotation[] {
  const chain: Rotation[] = []
  const seen = new Set([key])
  let current = key
  for (let i = 0; i < 16; i++) {
    const next = rotations.find((r) => r.oldKey === current && verifyRotation(r))
    if (!next || seen.has(next.newKey)) break
    chain.push(next)
    seen.add(next.newKey)
    current = next.newKey
  }
  return chain
}

/** The rotations (oldest first) that led to <paramref name="key"/>: what a server that missed them needs. */
export function chainTo(key: string, rotations: Rotation[], max = 4): Rotation[] {
  const chain: Rotation[] = []
  let current = key
  for (let i = 0; i < max; i++) {
    const link = rotations.find((r) => r.newKey === current && verifyRotation(r))
    if (!link || chain.some((c) => c.oldKey === link.oldKey)) break
    chain.unshift(link)
    current = link.oldKey
  }
  return chain
}

/**
 * Old key → current key for every account we know rotated, from verified rotations only.
 * `resolve` follows the chain, so messages to and from any earlier key land in one conversation.
 */
export class KeyMap {
  private readonly next = new Map<string, string>()

  constructor(rotations: Rotation[] = []) {
    for (const r of rotations) this.add(r)
  }

  /** Adds a verified rotation. A different claim on an already known old key is ignored here (that's a dispute). */
  add(r: Rotation): boolean {
    if (this.next.has(r.oldKey) || !verifyRotation(r)) return false
    this.next.set(r.oldKey, r.newKey)
    return true
  }

  /** Points an old key somewhere else (an admin settled a dispute the other way). */
  replace(r: Rotation): boolean {
    if (!verifyRotation(r)) return false
    this.next.set(r.oldKey, r.newKey)
    return true
  }

  resolve(key: string): string {
    let current = key
    for (let i = 0; i < 16 && this.next.has(current); i++) current = this.next.get(current)!
    return current
  }

  same(a: string, b: string): boolean {
    return a === b || this.resolve(a) === this.resolve(b)
  }

  /** Every key that resolves to <paramref name="key"/>'s current key, including itself. */
  aliases(key: string): string[] {
    const target = this.resolve(key)
    return [target, ...[...this.next.keys()].filter((k) => k !== target && this.resolve(k) === target)]
  }
}

/** A brand-new account key for this account, certificates for the devices it keeps, and sealed hand-overs for them. */
export function prepareRotation(identity: Identity, keepDevices: DeviceCert[], now = Date.now()) {
  const account = generateSigningKeyPair()
  const rotation = signRotation(identity.account, account, now)
  const seed = account.secretKey.slice(0, 32)
  const others = keepDevices.filter((d) => d.deviceKey !== identity.cert.deviceKey && verifyDeviceCert(d) && d.accountKey === rotation.oldKey)
  const cert = certifyDevice(account, identity.device.publicKey, now)
  const certs = [cert, ...others.map((d) => certifyDevice(account, fromB64u(d.deviceKey), now))]
  const handovers = others.map((d) => sealHandover(seed, d.deviceKey))
  sodium.memzero(seed)
  return { identity: { ...identity, account, cert } satisfies Identity, rotation, certs, handovers }
}
