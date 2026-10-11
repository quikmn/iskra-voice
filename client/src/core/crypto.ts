// Thin wrapper around libsodium. Everything crypto in the client goes through here.
// Wire format rules live in protocol/PROTOCOL.md.
import sodium from 'libsodium-wrappers-sumo'

export async function ready(): Promise<void> {
  await sodium.ready
}

export interface SigningKeyPair {
  publicKey: Uint8Array // 32 bytes
  secretKey: Uint8Array // 64 bytes (libsodium format: seed || publicKey)
}

export function b64u(bytes: Uint8Array): string {
  return sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING)
}

export function fromB64u(text: string): Uint8Array {
  return sodium.from_base64(text, sodium.base64_variants.URLSAFE_NO_PADDING)
}

export function generateSigningKeyPair(): SigningKeyPair {
  const kp = sodium.crypto_sign_keypair()
  return { publicKey: kp.publicKey, secretKey: kp.privateKey }
}

export function signingKeyPairFromSeed(seed: Uint8Array): SigningKeyPair {
  const kp = sodium.crypto_sign_seed_keypair(seed)
  return { publicKey: kp.publicKey, secretKey: kp.privateKey }
}

export function sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  return sodium.crypto_sign_detached(message, secretKey)
}

export function verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  if (signature.length !== 64 || publicKey.length !== 32) return false
  return sodium.crypto_sign_verify_detached(signature, message, publicKey)
}

export function randomBytes(length: number): Uint8Array {
  return sodium.randombytes_buf(length)
}

/** "context" || 0x00 || parts... — every signed payload is domain-separated this way. */
export function signedPayload(context: string, ...parts: Uint8Array[]): Uint8Array {
  const ctx = new TextEncoder().encode(context)
  const total = ctx.length + 1 + parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  out.set(ctx, 0)
  out[ctx.length] = 0
  let offset = ctx.length + 1
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

export function u64be(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('u64be: expected a non-negative safe integer')
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(value), false)
  return out
}

/**
 * Seals a secret to a server's identity key (crypto_box_seal to its Ed25519 key in X25519 form), as
 * context || 0x00 || serverKey(32) || data, so only that server can read it, and only for that purpose.
 */
export function sealToServer(serverKey: Uint8Array, context: string, data: Uint8Array): Uint8Array {
  const x25519 = sodium.crypto_sign_ed25519_pk_to_curve25519(serverKey)
  return sodium.crypto_box_seal(signedPayload(context, serverKey, data), x25519)
}
