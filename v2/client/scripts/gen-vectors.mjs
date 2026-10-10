// Regenerates v2/protocol/vectors.json. Run from v2/client: node scripts/gen-vectors.mjs
// Only rerun if the protocol itself changes; both test suites pin these values.
import sodium from 'libsodium-wrappers-sumo'
import { writeFileSync } from 'node:fs'
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
writeFileSync(new URL('../../protocol/vectors.json', import.meta.url), JSON.stringify({ v1 }, null, 2) + '\n')
console.log('wrote vectors.json')
