// Push handles: a phone's push token, sealed with a key only the relay has (AES-256-GCM, WebCrypto). Iskra servers
// store the handle inside a push endpoint URL and never see the token; the relay opens it when a push comes in.
// Nothing is stored: the handle carries everything, so the relay keeps no database of devices.
import { fromB64, toB64u, utf8 } from './b64'

export type Platform = 'ios' | 'android'

export interface Device {
  platform: Platform
  /** APNs device token (hex) or FCM registration token. */
  token: string
  /** iOS: the PushKit (VoIP) token, for incoming calls. */
  voip?: string
  /** iOS: a development build (APNs sandbox). */
  sandbox?: boolean
}

export interface HandleKeys {
  current: number
  keys: Map<number, CryptoKey>
}

const VERSION = 1
const AAD = utf8.encode('iskra-push-handle-v1')
const NONCE = 12

/**
 * HANDLE_KEYS: comma-separated `id:base64key` entries (id 0–255, 32-byte keys). The first one seals new handles;
 * the others still open old ones, so keys can be rotated without breaking handles servers already have.
 */
export async function parseHandleKeys(spec: string | undefined): Promise<HandleKeys> {
  const keys = new Map<number, CryptoKey>()
  let current = -1
  for (const part of (spec ?? '').split(',').map((p) => p.trim()).filter(Boolean)) {
    const match = /^(\d{1,3}):(.+)$/.exec(part)
    const raw = match ? fromB64(match[2]) : null
    const id = match ? Number(match[1]) : -1
    if (!match || id > 255 || !raw || raw.length !== 32 || keys.has(id)) throw new Error('HANDLE_KEYS is malformed')
    keys.set(id, await crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']))
    if (current < 0) current = id
  }
  if (current < 0) throw new Error('HANDLE_KEYS is not set')
  return { current, keys }
}

export async function sealHandle(keys: HandleKeys, device: Device): Promise<string> {
  const plain = utf8.encode(JSON.stringify({ p: device.platform === 'ios' ? 'i' : 'a', t: device.token, v: device.voip, s: device.sandbox ? 1 : undefined }))
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE))
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: AAD }, keys.keys.get(keys.current)!, plain),
  )
  const out = new Uint8Array(2 + NONCE + sealed.length)
  out[0] = VERSION
  out[1] = keys.current
  out.set(nonce, 2)
  out.set(sealed, 2 + NONCE)
  return toB64u(out)
}

/** Null for anything that isn't a handle this relay made (forged, damaged, or sealed with a retired key). */
export async function openHandle(keys: HandleKeys, handle: string): Promise<Device | null> {
  if (handle.length > 1500) return null
  const bytes = fromB64(handle)
  if (!bytes || bytes.length < 2 + NONCE + 16 || bytes[0] !== VERSION) return null
  const key = keys.keys.get(bytes[1])
  if (!key) return null
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.subarray(2, 2 + NONCE) as BufferSource, additionalData: AAD },
      key,
      bytes.subarray(2 + NONCE) as BufferSource,
    )
    const d = JSON.parse(new TextDecoder().decode(plain)) as { p?: string; t?: string; v?: string; s?: number }
    if ((d.p !== 'i' && d.p !== 'a') || typeof d.t !== 'string') return null
    return {
      platform: d.p === 'i' ? 'ios' : 'android',
      token: d.t,
      ...(typeof d.v === 'string' ? { voip: d.v } : {}),
      ...(d.s === 1 ? { sandbox: true } : {}),
    }
  } catch {
    return null
  }
}

/** A short, stable id for rate limits (not the token itself). */
export async function deviceId(device: Device): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(device.platform + ':' + device.token)))
  return toB64u(digest.subarray(0, 12))
}

const HEX_TOKEN = /^[0-9a-fA-F]{64,200}$/
const FCM_TOKEN = /^[A-Za-z0-9_:\-.]{32,512}$/

/** Checks what an app sends to /v1/register. Null if it isn't a device. */
export function parseDevice(body: unknown): Device | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  if (b.platform === 'ios') {
    if (typeof b.token !== 'string' || !HEX_TOKEN.test(b.token)) return null
    if (b.voip !== undefined && (typeof b.voip !== 'string' || !HEX_TOKEN.test(b.voip))) return null
    if (b.sandbox !== undefined && typeof b.sandbox !== 'boolean') return null
    return {
      platform: 'ios',
      token: b.token.toLowerCase(),
      ...(typeof b.voip === 'string' ? { voip: b.voip.toLowerCase() } : {}),
      ...(b.sandbox === true ? { sandbox: true } : {}),
    }
  }
  if (b.platform === 'android') {
    if (typeof b.token !== 'string' || !FCM_TOKEN.test(b.token) || b.voip !== undefined || b.sandbox !== undefined) return null
    return { platform: 'android', token: b.token }
  }
  return null
}
