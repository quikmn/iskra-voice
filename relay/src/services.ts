// Delivery to Apple (APNs, HTTP/2 with an ES256 provider token) and Google (FCM HTTP v1 with a service account).
// The relay passes the server's encrypted Web Push body through unchanged (`e`, base64): neither the relay nor
// Apple or Google can read it. The apps decrypt it on the phone (mobile/README.md "Push notifications").
import type { Device } from './handle'
import { importEs256, importRs256, signJwt } from './jwt'

export type SendResult = 'ok' | 'gone' | 'failed'

export interface PushMessage {
  /** 'call' rings (VoIP push on iOS when the app gave a VoIP token, a call-style notification on Android). */
  kind: 'note' | 'call'
  /** The aes128gcm body from the Iskra server, base64. */
  data: string
  ttl: number
  /** Pushes with the same id replace each other (from the Web Push Topic header). */
  collapse?: string
  urgent: boolean
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>

// ── APNs ──────────────────────────────────────────────────────────────────

export interface ApnsConfig {
  key: string
  keyId: string
  teamId: string
  topic: string
}

/** Apple wants a provider token refreshed every 20–60 minutes. iat is rounded so concurrent isolates agree. */
const APNS_TOKEN_SECONDS = 40 * 60

export class Apns {
  private key: Promise<CryptoKey> | null = null
  private token: { value: string; slot: number } | null = null
  private readonly config: ApnsConfig
  private readonly fetcher: Fetch
  private readonly now: () => number

  constructor(config: ApnsConfig, fetcher: Fetch = fetch, now: () => number = Date.now) {
    this.config = config
    this.fetcher = fetcher
    this.now = now
  }

  private async bearer(fresh: boolean): Promise<string> {
    const slot = Math.floor(this.now() / 1000 / APNS_TOKEN_SECONDS)
    if (!fresh && this.token?.slot === slot) return this.token.value
    this.key ??= importEs256(this.config.key)
    const iat = fresh ? Math.floor(this.now() / 1000) : slot * APNS_TOKEN_SECONDS
    const value = await signJwt(await this.key, { alg: 'ES256', kid: this.config.keyId }, { iss: this.config.teamId, iat })
    this.token = { value, slot }
    return value
  }

  async send(device: Device, message: PushMessage): Promise<SendResult> {
    const voip = message.kind === 'call' && device.voip !== undefined
    const token = voip ? device.voip! : device.token
    const host = device.sandbox ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com'
    const payload = voip
      ? { e: message.data, k: message.kind }
      : {
          // Shown only if the Notification Service Extension can't decrypt in time; it normally replaces this.
          aps: {
            alert: { title: 'Iskra', body: message.kind === 'call' ? 'Incoming call' : 'New notification' },
            'mutable-content': 1,
            sound: 'default',
            ...(message.collapse ? { 'thread-id': message.collapse } : {}),
          },
          e: message.data,
          k: message.kind,
        }
    const headers: Record<string, string> = {
      'apns-topic': voip ? `${this.config.topic}.voip` : this.config.topic,
      'apns-push-type': voip ? 'voip' : 'alert',
      'apns-priority': voip || message.urgent ? '10' : '5',
      'apns-expiration': message.ttl > 0 ? String(Math.floor(this.now() / 1000) + message.ttl) : '0',
      'content-type': 'application/json',
    }
    if (message.collapse && !voip) headers['apns-collapse-id'] = message.collapse

    for (let attempt = 0; attempt < 2; attempt++) {
      const authorization = `bearer ${await this.bearer(attempt > 0)}`
      const response = await this.fetcher(`${host}/3/device/${token}`, {
        method: 'POST',
        headers: { ...headers, authorization },
        body: JSON.stringify(payload),
      })
      if (response.status === 200) return 'ok'
      const reason = await reasonOf(response)
      if (response.status === 410) return 'gone'
      if (response.status === 400 && (reason === 'BadDeviceToken' || reason === 'DeviceTokenNotForTopic')) return 'gone'
      if (response.status === 403 && (reason === 'ExpiredProviderToken' || reason === 'InvalidProviderToken') && attempt === 0) continue
      return 'failed'
    }
    return 'failed'
  }
}

async function reasonOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { reason?: unknown }
    return typeof body.reason === 'string' ? body.reason : ''
  } catch {
    return ''
  }
}

// ── FCM ───────────────────────────────────────────────────────────────────

export interface FcmConfig {
  projectId: string
  clientEmail: string
  privateKey: string
  privateKeyId?: string
}

/** The service account JSON from the Firebase console (FCM_SERVICE_ACCOUNT). */
export function parseServiceAccount(json: string): FcmConfig {
  const sa = JSON.parse(json) as Record<string, unknown>
  const { project_id, client_email, private_key, private_key_id } = sa
  if (typeof project_id !== 'string' || typeof client_email !== 'string' || typeof private_key !== 'string') {
    throw new Error('FCM_SERVICE_ACCOUNT is not a service account key')
  }
  return { projectId: project_id, clientEmail: client_email, privateKey: private_key, privateKeyId: typeof private_key_id === 'string' ? private_key_id : undefined }
}

const OAUTH = 'https://oauth2.googleapis.com/token'
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'

export class Fcm {
  private key: Promise<CryptoKey> | null = null
  private access: { token: string; until: number } | null = null
  private readonly config: FcmConfig
  private readonly fetcher: Fetch
  private readonly now: () => number

  constructor(config: FcmConfig, fetcher: Fetch = fetch, now: () => number = Date.now) {
    this.config = config
    this.fetcher = fetcher
    this.now = now
  }

  private async accessToken(fresh: boolean): Promise<string | null> {
    if (!fresh && this.access && this.now() < this.access.until) return this.access.token
    this.key ??= importRs256(this.config.privateKey)
    const iat = Math.floor(this.now() / 1000)
    const assertion = await signJwt(
      await this.key,
      { alg: 'RS256', typ: 'JWT', ...(this.config.privateKeyId ? { kid: this.config.privateKeyId } : {}) },
      { iss: this.config.clientEmail, scope: FCM_SCOPE, aud: OAUTH, iat, exp: iat + 3600 },
    )
    const response = await this.fetcher(OAUTH, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    })
    if (!response.ok) return null
    const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown }
    if (typeof body.access_token !== 'string') return null
    const seconds = typeof body.expires_in === 'number' ? body.expires_in : 3600
    this.access = { token: body.access_token, until: this.now() + Math.max(60, seconds - 300) * 1000 }
    return body.access_token
  }

  async send(device: Device, message: PushMessage): Promise<SendResult> {
    const body = JSON.stringify({
      message: {
        token: device.token,
        // Data only: the app decrypts and shows the notification itself (IskraMessagingService).
        data: { e: message.data, k: message.kind },
        android: {
          priority: message.urgent || message.kind === 'call' ? 'HIGH' : 'NORMAL',
          ttl: `${message.ttl}s`,
          ...(message.collapse && message.kind !== 'call' ? { collapse_key: message.collapse } : {}),
        },
      },
    })
    const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.config.projectId)}/messages:send`
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accessToken(attempt > 0)
      if (!token) return 'failed'
      const response = await this.fetcher(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body,
      })
      if (response.ok) return 'ok'
      if (response.status === 401 && attempt === 0) continue
      const code = await fcmErrorCode(response)
      if (code === 'UNREGISTERED' || code === 'SENDER_ID_MISMATCH' || response.status === 404) return 'gone'
      if (code === 'INVALID_ARGUMENT' && response.status === 400) return 'gone' // a malformed token (our body is fixed)
      return 'failed'
    }
    return 'failed'
  }
}

async function fcmErrorCode(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { status?: string; details?: { errorCode?: string }[] } }
    return body.error?.details?.find((d) => d.errorCode)?.errorCode ?? body.error?.status ?? ''
  } catch {
    return ''
  }
}
