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
