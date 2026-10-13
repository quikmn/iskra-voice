// The tunnel's keys, all from the server's p2p secret (p2p.key, carried by invite links): keyed BLAKE2b with a context
// string per key, then an Ed25519 key pair from the 32-byte seed (what HyperDHT uses). The server derives the host's
// public key the same way to show the owner (server/src/Iskra.Server/Crypto/P2pKeys.cs); PROTOCOL.md has the rules.
import DHT, { type KeyPair } from 'hyperdht'
import b4a from 'b4a'
import sodium from 'sodium-universal'

export const SECRET_BYTES = 32
const HOST_CONTEXT = 'iskra/p2p/v1/host-seed'
const FRIEND_CONTEXT = 'iskra/p2p/v1/friend-seed'

/** BLAKE2b-256(key = secret, message = context). */
export function seed(secret: Uint8Array, context: string): Buffer {
  if (secret.length !== SECRET_BYTES) throw new Error('The p2p secret must be 32 bytes.')
  const out = Buffer.alloc(32)
  sodium.crypto_generichash(out, Buffer.from(context), secret)
  return out
}

/** The key pair the host announces on the DHT. Its public key isn't secret (DHT nodes learn it). */
export const hostKeyPair = (secret: Uint8Array): KeyPair => DHT.keyPair(seed(secret, HOST_CONTEXT))

/**
 * The key pair friends connect with. The host only accepts this key: proof of knowing the secret, checked before
 * any byte reaches the server. (Iskra's own signed handshake and the invite code still decide membership.)
 */
export const friendKeyPair = (secret: Uint8Array): KeyPair => DHT.keyPair(seed(secret, FRIEND_CONTEXT))

/** The host's `firewall` rule: only the friend key pair of this secret. */
export function onlyFriends(secret: Uint8Array): (remotePublicKey: Buffer) => boolean {
  const friend = friendKeyPair(secret).publicKey
  return (remotePublicKey) => b4a.equals(remotePublicKey, friend)
}

/** A secret as invite links and the server write it (43 b64u characters), or null. */
export function parseSecret(text: unknown): Buffer | null {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(text)) return null
  const bytes = Buffer.from(text, 'base64url')
  return bytes.length === SECRET_BYTES ? bytes : null
}

export const hostKeyHex = (secret: Uint8Array): string => hostKeyPair(secret).publicKey.toString('hex')
