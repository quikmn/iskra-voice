// One connection to one Iskra server: handshake, requests, events and automatic reconnects.
import { fromB64u } from './crypto'
import { signAuth, type Identity } from './identity'
import { socketUrl } from './invite'
import { CloseCodes, RequestError, type Events, type Requests, type Welcome } from './protocol'

export type ConnectionStatus =
  | { state: 'connecting' }
  | { state: 'online' }
  | { state: 'offline'; retryInMs: number }
  /** The server said no (no invite, banned, kicked, wrong server, key rotated). We don't retry. */
  | { state: 'rejected'; code: string; message: string; detail?: Record<string, unknown> }

export interface ConnectionOptions {
  serverUrl: string
  identity: Identity
  /** The server key from the invite link. If set, we refuse to talk to a server with a different key. */
  expectedServerKey?: string
  /** Display name sent on every connect. */
  name: () => string
  /** Other profile fields sent on every connect (bio, pronouns, accent). */
  profile?: () => Record<string, unknown>
  /** Your chosen status, sent with auth so you never flash online when you're invisible. */
  presence?: () => unknown
  /** Only needed until the first successful join. */
  invite?: string
  /** Bot accounts say so on every connect (see "Bots and webhooks" in PROTOCOL.md). */
  bot?: boolean
  /** Account key rotations that led to this identity, for servers that missed them (see "Account key rotation"). */
  rotations?: () => unknown[]
  onStatus: (status: ConnectionStatus) => void
  onWelcome: (welcome: Welcome) => void
  onEvent: <K extends keyof Events>(type: K, body: Events[K]) => void
  WebSocketImpl?: typeof WebSocket
  requestTimeoutMs?: number
}

interface Pending {
  resolve: (body: unknown) => void
  reject: (error: RequestError) => void
  timer: ReturnType<typeof setTimeout>
}

const MIN_BACKOFF_MS = 500
const MAX_BACKOFF_MS = 30_000

export class Connection {
  private readonly options: ConnectionOptions
  private socket: WebSocket | null = null
  private readonly pending = new Map<string, Pending>()
  private nextId = 0
  private attempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private rejected = false
  private ready = false
  private invite: string | undefined

  constructor(options: ConnectionOptions) {
    this.options = options
    this.invite = options.invite
  }

  start(): void {
    this.stopped = false
    this.rejected = false
    this.open()
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.socket?.close(1000)
    this.socket = null
    this.failPending('disconnected', 'Disconnected.')
  }

  /** Reconnect right away (e.g. the browser came back online). */
  retryNow(): void {
    if (this.stopped || this.rejected || this.ready) return
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.open()
  }

  get isOnline(): boolean {
    return this.ready
  }

  /** `timeoutMs` overrides the usual wait for slow work (making a backup). */
  request<K extends keyof Requests>(type: K, body: Requests[K][0], timeoutMs?: number): Promise<Requests[K][1]> {
    const socket = this.socket
    if (!socket || !this.ready) return Promise.reject(new RequestError('disconnected', 'Not connected.'))
    const id = `c${++this.nextId}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new RequestError('timeout', 'The server took too long to answer.'))
      }, timeoutMs ?? this.options.requestTimeoutMs ?? 15_000)
      this.pending.set(id, { resolve: resolve as (b: unknown) => void, reject, timer })
      socket.send(JSON.stringify({ type, id, body }))
    })
  }

  private open(): void {
    const Impl = this.options.WebSocketImpl ?? WebSocket
    this.ready = false
    if (blockedAsInsecure(this.options.serverUrl)) {
      this.reject(
        'insecure_server',
        "This server doesn't use HTTPS, so browsers won't connect to it. Use the Iskra desktop app, or ask the host to turn on HTTPS.",
      )
      return
    }
    this.options.onStatus({ state: 'connecting' })
    let socket: WebSocket
    try {
      socket = new Impl(socketUrl(this.options.serverUrl))
    } catch {
      this.scheduleReconnect()
      return
    }
    this.socket = socket
    socket.onmessage = (event) => {
      if (this.socket === socket) this.handleFrame(String(event.data))
    }
    socket.onclose = (event) => {
      if (this.socket === socket) this.handleClose(event.code)
    }
  }

  private handleFrame(text: string): void {
    let frame: { type?: string; id?: string; body?: unknown }
    try {
      frame = JSON.parse(text)
    } catch {
      return
    }
    const body = (frame.body ?? {}) as Record<string, unknown>

    switch (frame.type) {
      case 'hello':
        this.sendAuth(body as { serverKey: string; nonce: string })
        return
      case 'welcome':
        this.ready = true
        this.attempts = 0
        this.invite = undefined // we're a member now
        this.options.onStatus({ state: 'online' })
        this.options.onWelcome(body as unknown as Welcome)
        return
      case 'result':
      case 'error': {
        const pending = frame.id ? this.pending.get(frame.id) : undefined
        if (pending) {
          this.pending.delete(frame.id!)
          clearTimeout(pending.timer)
          if (frame.type === 'result') pending.resolve(body)
          else pending.reject(new RequestError(body.code as RequestError['code'], String(body.message ?? 'Request failed.')))
        } else if (frame.type === 'error' && !this.ready) {
          // Rejected during the handshake.
          this.reject(String(body.code ?? 'auth_failed'), String(body.message ?? 'The server refused the connection.'), body)
        }
        return
      }
      case 'kicked':
        this.reject('kicked', String(body.reason ?? 'You were removed from this server.'))
        this.options.onEvent('kicked', body as Events['kicked'])
        return
      default:
        if (frame.type && this.ready) this.options.onEvent(frame.type as keyof Events, body as never)
    }
  }

  private sendAuth(hello: { serverKey: string; nonce: string }): void {
    const { identity, expectedServerKey } = this.options
    if (expectedServerKey && hello.serverKey !== expectedServerKey) {
      this.reject('server_key_mismatch', "This server's identity doesn't match the invite link. It may be an impostor.")
      return
    }
    let sig: string
    try {
      sig = signAuth(identity.device, fromB64u(hello.serverKey), fromB64u(hello.nonce))
    } catch {
      this.reject('auth_failed', 'The server sent an invalid handshake.')
      return
    }
    const profile = { ...this.options.profile?.(), name: this.options.name(), ...(this.options.bot ? { bot: true } : {}) }
    const body: Record<string, unknown> = { cert: identity.cert, sig, profile }
    if (this.invite) body.invite = this.invite
    const presence = this.options.presence?.()
    if (presence) body.presence = presence
    const rotations = this.options.rotations?.() ?? []
    if (rotations.length) body.rotations = rotations
    this.socket?.send(JSON.stringify({ type: 'auth', id: 'auth', body }))
  }

  private reject(code: string, message: string, detail?: Record<string, unknown>): void {
    this.rejected = true
    this.ready = false
    this.options.onStatus({ state: 'rejected', code, message, ...(detail ? { detail } : {}) })
    this.socket?.close(1000)
  }

  private handleClose(code: number): void {
    this.socket = null
    this.ready = false
    this.failPending('disconnected', 'Connection lost.')
    if (this.stopped || this.rejected) return
    if (code === CloseCodes.Rotated) {
      this.reject('account_rotated', 'This account moved to a new key.')
      return
    }
    if (code === CloseCodes.Forbidden) {
      this.reject('forbidden', 'You no longer have access to this server.')
      return
    }
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    const base = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** this.attempts)
    const delay = Math.round(base * (0.7 + Math.random() * 0.6)) // jitter so clients don't stampede after a restart
    this.attempts++
    this.options.onStatus({ state: 'offline', retryInMs: delay })
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.stopped && !this.rejected) this.open()
    }, delay)
  }

  private failPending(code: 'disconnected', message: string): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new RequestError(code, message))
    }
    this.pending.clear()
  }
}

/** Browsers refuse ws:// from an https:// page, except to this computer. */
export function blockedAsInsecure(serverUrl: string, pageProtocol = globalThis.location?.protocol): boolean {
  if (pageProtocol !== 'https:' || !serverUrl.startsWith('http://')) return false
  const host = new URL(serverUrl).hostname
  return !(host === 'localhost' || host === '127.0.0.1' || host === '[::1]')
}

/** Short, human-friendly fingerprint of a key for display ("a1b2-c3d4-e5f6"). */
export function fingerprint(key: string): string {
  const hex = Array.from(fromB64u(key).slice(0, 6), (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`
}

