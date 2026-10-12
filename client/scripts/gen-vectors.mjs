// Regenerates protocol/vectors.json. Run from client/: node scripts/gen-vectors.mjs
// Only rerun if the protocol itself changes; both test suites pin these values.
import sodium from 'libsodium-wrappers-sumo'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
await sodium.ready
const V = sodium.base64_variants.URLSAFE_NO_PADDING
const b64 = (b) => sodium.to_base64(b, V)
const fill = (n) => new Uint8Array(32).fill(n)
const payload = (ctx, ...parts) => {
  const c = new TextEncoder().encode(ctx)
  const out = new Uint8Array(c.length + 1 + parts.reduce((n, p) => n + p.length, 0))
  out.set(c, 0); let o = c.length + 1
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}
const u64be = (v) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v)); return b }
const account = sodium.crypto_sign_seed_keypair(fill(1))
const device = sodium.crypto_sign_seed_keypair(fill(2))
const server = sodium.crypto_sign_seed_keypair(fill(3))
const nonce = fill(4)
const created = 1760000000000
const certSig = sodium.crypto_sign_detached(payload('iskra/device-cert/v1', device.publicKey, u64be(created)), account.privateKey)
const authSig = sodium.crypto_sign_detached(payload('iskra/auth/v1', server.publicKey, nonce), device.privateKey)
const v1 = {
  accountSeed: b64(fill(1)), deviceSeed: b64(fill(2)), serverSeed: b64(fill(3)),
  accountKey: b64(account.publicKey), deviceKey: b64(device.publicKey), serverKey: b64(server.publicKey),
  nonce: b64(nonce), created,
  cert: { accountKey: b64(account.publicKey), deviceKey: b64(device.publicKey), created, sig: b64(certSig) },
  authSig: b64(authSig),
}
// Account key rotation: the account above hands over to a new key (seed 5). Both keys sign the same payload.
const next = sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(5))
const rotatedAt = 1760000000000
const rotationPayload = payload('iskra/account-rotate/v1', account.publicKey, next.publicKey, u64be(rotatedAt))
const rotation = {
  newSeed: b64(new Uint8Array(32).fill(5)),
  rotation: {
    oldKey: b64(account.publicKey), newKey: b64(next.publicKey), rotatedAt,
    oldSig: b64(sodium.crypto_sign_detached(rotationPayload, account.privateKey)),
    newSig: b64(sodium.crypto_sign_detached(rotationPayload, next.privateKey)),
  },
}
// Encrypted DM files: secretstream headers are random, so these are made once and kept on later runs.
// Plaintext byte i is i % 251. Two files: empty, and one chunk plus 3 bytes (a full chunk, then a short FINAL one).
const out = new URL('../../protocol/vectors.json', import.meta.url)
const previous = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : {}
const CHUNK = 64 * 1024
const AD = new TextEncoder().encode('iskra/dm-file/v1')
const dmFileVector = (size) => {
  const plain = Uint8Array.from({ length: size }, (_, i) => i % 251)
  const key = sodium.crypto_secretstream_xchacha20poly1305_keygen()
  const { state, header } = sodium.crypto_secretstream_xchacha20poly1305_init_push(key)
  const parts = [header]
  for (let at = 0; ; at += CHUNK) {
    const last = at + CHUNK >= size
    const tag = last ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE
    parts.push(sodium.crypto_secretstream_xchacha20poly1305_push(state, plain.subarray(at, Math.min(size, at + CHUNK)), AD, tag))
    if (last) break
  }
  const ciphertext = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { ciphertext.set(p, o); o += p.length }
  return { size, key: b64(key), hash: b64(sodium.crypto_generichash(32, ciphertext, null)), ciphertext: b64(ciphertext) }
}
const dmFile = previous.dmFile ?? { plaintext: 'byte i = i % 251', files: [dmFileVector(0), dmFileVector(CHUNK + 3)] }
writeFileSync(out, JSON.stringify({ v1, rotation, dmFile }, null, 2) + '\n')
console.log('wrote vectors.json')
