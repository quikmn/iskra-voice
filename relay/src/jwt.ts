// Signed JWTs for the push services, with WebCrypto: ES256 for APNs (the .p8 key), RS256 for Google's OAuth
// (the service account's key). Both keys come as PKCS#8 PEM.
import { fromB64, toB64u, utf8 } from './b64'

export function pemToDer(pem: string): Uint8Array {
  const body = pem.replace(/-----(BEGIN|END) [A-Z ]+-----/g, '').replace(/\\n/g, '').replace(/\s+/g, '')
  const der = fromB64(body)
  if (!der || der.length < 32) throw new Error('not a PEM private key')
  return der
}

export function importEs256(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', pemToDer(pem) as BufferSource, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
}

export function importRs256(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', pemToDer(pem) as BufferSource, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
}

/** header.claims.signature. WebCrypto's ECDSA signature is already JWS's raw r||s form. */
export async function signJwt(key: CryptoKey, header: Record<string, unknown>, claims: Record<string, unknown>): Promise<string> {
  const input = `${toB64u(utf8.encode(JSON.stringify(header)))}.${toB64u(utf8.encode(JSON.stringify(claims)))}`
  const algorithm = key.algorithm.name === 'ECDSA' ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' }
  const signature = new Uint8Array(await crypto.subtle.sign(algorithm, key, utf8.encode(input)))
  return `${input}.${toB64u(signature)}`
}

/**
 * Checks a Web Push request's VAPID authorization (RFC 8292: `vapid t=<jwt>, k=<key>`): the key is the one the handle
 * is bound to, the ES256 signature is good, `aud` is this relay and `exp` is in the next 24 hours.
 */
export async function verifyVapid(authorization: string | null, expectedKey: string, audience: string, now: number): Promise<boolean> {
  const match = /^vapid\s+(.+)$/i.exec(authorization?.trim() ?? '')
  if (!match) return false
  const params = new Map<string, string>()
  for (const part of match[1].split(',')) {
    const eq = part.indexOf('=')
    if (eq > 0) params.set(part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).trim())
  }
  const token = params.get('t')
  if (!token || params.get('k') !== expectedKey) return false
  const [h, c, s] = token.split('.')
  const point = fromB64(expectedKey)
  const signature = s ? fromB64(s) : null
  if (!h || !c || !point || !signature || signature.length !== 64) return false
  try {
    const header = JSON.parse(new TextDecoder().decode(fromB64(h) ?? new Uint8Array())) as { alg?: unknown }
    const claims = JSON.parse(new TextDecoder().decode(fromB64(c) ?? new Uint8Array())) as { aud?: unknown; exp?: unknown }
    if (header.alg !== 'ES256' || claims.aud !== audience || typeof claims.exp !== 'number') return false
    const seconds = now / 1000
    if (claims.exp <= seconds || claims.exp > seconds + 24 * 3600 + 300) return false
    const key = await crypto.subtle.importKey('raw', point as BufferSource, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature as BufferSource, utf8.encode(`${h}.${c}`))
  } catch {
    return false
  }
}
