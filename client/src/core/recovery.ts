// Recovery key: the 32-byte account seed, written so a person can store and retype it.
// Whoever has it *is* you, so it's shown once, copied or downloaded, and never sent anywhere.
//
// Format: "ISKRA-" + 56 Crockford base32 characters (32-byte seed + 3-byte checksum) in groups of 4.
import sodium from 'libsodium-wrappers-sumo'
import { b64u, generateSigningKeyPair, signingKeyPairFromSeed } from './crypto'
import { certifyDevice, type Identity } from './identity'

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' // Crockford: no I, L, O, U
const PREFIX = 'ISKRA'

function checksum(seed: Uint8Array): Uint8Array {
  return sodium.crypto_generichash(3, seed, new TextEncoder().encode('iskra/recovery/v1'))
}

function toBase32(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

function fromBase32(text: string): Uint8Array | null {
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const char of text) {
    const index = ALPHABET.indexOf(char)
    if (index < 0) return null
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Uint8Array.from(out)
}

export function seedOf(identity: Identity): Uint8Array {
  return identity.account.secretKey.slice(0, 32) // libsodium secret keys are seed || public key
}

export function encodeRecoveryKey(seed: Uint8Array): string {
  const body = toBase32(new Uint8Array([...seed, ...checksum(seed)]))
  return [PREFIX, ...body.match(/.{1,4}/g)!].join('-')
}

/** Accepts the key with any spacing, dashes or case, and the usual look-alike typos (O→0, I/L→1). */
export function decodeRecoveryKey(input: string): Uint8Array | null {
  const compact = input.toUpperCase().replace(/[\s-]/g, '')
  if (!compact.startsWith(PREFIX)) return null
  const body = compact.slice(PREFIX.length).replace(/O/g, '0').replace(/[IL]/g, '1')
  const bytes = fromBase32(body)
  if (!bytes || bytes.length < 35) return null
  const seed = bytes.slice(0, 32)
  const check = bytes.slice(32, 35)
  return sodium.memcmp(check, checksum(seed)) ? seed : null
}

/** Your account on a new device: same account key, a fresh device key certified by it. */
export function restoreIdentity(seed: Uint8Array, now = Date.now()): Identity {
  const account = signingKeyPairFromSeed(seed)
  const device = generateSigningKeyPair()
  return { account, device, cert: certifyDevice(account, device.publicKey, now) }
}

export const accountKeyOf = (identity: Identity) => b64u(identity.account.publicKey)
