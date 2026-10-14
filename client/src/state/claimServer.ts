// "Claim a server": a server made from an image (the DigitalOcean Marketplace droplet) shows a claim code on its
// console; typing its address and that code here makes you its owner. The claim is derived from the code, then it's
// the same proof and owner invite as "Rent a small server" (PROTOCOL.md, "Owner claim", generated codes).
import sodium from 'libsodium-wrappers-sumo'
import { b64u, ready } from '../core/crypto'
import type { InviteLink } from '../core/invite'
import { checkClaimProof, claimCode, vpsAddress } from './rentServer'

/** Crockford's base32: no I, L, O or U. 16 letters = 80 bits. */
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const CODE_LENGTH = 16

/** A code as typed: case, spaces and dashes don't matter; O, I and L read as 0, 1 and 1. Null if it isn't one. */
export function normalizeCode(typed: string): string | null {
  if (typed.length > 64) return null
  const chars = [...typed.toUpperCase()].filter((c) => c !== ' ' && c !== '-').map((c) => (c === 'O' ? '0' : c === 'I' || c === 'L' ? '1' : c))
  return chars.length === CODE_LENGTH && chars.every((c) => CODE_ALPHABET.includes(c)) ? chars.join('') : null
}

/** The 32-byte owner claim a code stands for: SHA-256("iskra-claim-code-v1\n" + code), base64url. */
export async function claimFromCode(code: string): Promise<string> {
  const normal = normalizeCode(code)
  if (!normal) throw new Error('bad code')
  await ready()
  return b64u(sodium.crypto_hash_sha256(new TextEncoder().encode(`iskra-claim-code-v1\n${normal}`)))
}

const PRIVATE_HOST = /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\[::1\])$/

/**
 * The server's address from what was typed: a full URL, a host name, or a bare IPv4 address (which becomes its
 * sslip.io name, as the droplet uses). HTTPS, except on this computer or the home network. Null if it's not usable.
 */
export function claimAddress(typed: string): string | null {
  const text = typed.trim()
  if (!text || text.length > 300) return null
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) return vpsAddress(text)
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return null
  }
  if (url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) return null
  if (url.protocol === 'http:' && !PRIVATE_HOST.test(url.hostname)) return null
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  return url.origin
}

export type ClaimError = 'unreachable' | 'noClaim' | 'wrongCode' | 'busy'

export class ClaimFailed extends Error {
  readonly reason: ClaimError
  constructor(reason: ClaimError) {
    super(reason)
    this.reason = reason
  }
}

/**
 * Asks the server for its proof of the claim this code stands for and checks it. On success the owner invite, which
 * the app shows (name, address, key) before joining. Nothing secret is sent: the code never leaves this device.
 */
export async function claimServer(address: string, code: string, { fetcher = fetch, signal }: { fetcher?: typeof fetch; signal?: AbortSignal } = {}): Promise<InviteLink> {
  const claim = await claimFromCode(code)
  await ready()
  const nonce = b64u(sodium.randombytes_buf(16))
  let response: Response
  try {
    response = await fetcher(`${address}/.well-known/iskra-claim?nonce=${nonce}`, { signal: signal ?? AbortSignal.timeout(15_000), cache: 'no-store', credentials: 'omit' })
  } catch (e) {
    if ((e as Error).name === 'AbortError' && signal?.aborted) throw e
    throw new ClaimFailed('unreachable')
  }
  if (response.status === 404) throw new ClaimFailed('noClaim')
  if (response.status === 429) throw new ClaimFailed('busy')
  if (!response.ok) throw new ClaimFailed('unreachable')
  let body: { key?: unknown; proof?: unknown }
  try {
    body = (await response.json()) as typeof body
  } catch {
    throw new ClaimFailed('unreachable')
  }
  if (typeof body.key !== 'string' || typeof body.proof !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.key)) throw new ClaimFailed('unreachable')
  // A wrong code (or another server at that address) can't make this proof.
  if (!(await checkClaimProof(claim, body.key, nonce, body.proof))) throw new ClaimFailed('wrongCode')
  return { serverUrl: address, serverKey: body.key, code: await claimCode(claim) }
}
