// One connection to one Iskra server: handshake, requests, events and automatic reconnects.
import { fromB64u } from './crypto'
import { signAuth, type Identity } from './identity'
import { socketUrl } from './invite'
import { CloseCodes, RequestError, type Events, type Requests, type Welcome } from './protocol'

export type ConnectionStatus =
  | { state: 'connecting' }
  | { state: 'online' }
  /** `closeCode`: the WebSocket close code of the attempt that just ended (none: the socket couldn't even be made).
   * `stopped`: the server said it stopped for good (close 1001, reason "stop"), not a restart; the usual backoff.
   * `timedOut`: the handshake (socket, hello, auth, welcome) didn't finish within HANDSHAKE_TIMEOUT_MS, so we gave up on it. */
  | { state: 'offline'; retryInMs: number; stopped?: boolean; closeCode?: number; timedOut?: true }
  /** The server said it's restarting (close 1012): we retry about every second for a while. `etaMs` is its own estimate;
   * `update`: it's restarting into a new version. */
  | { state: 'restarting'; since: number; etaMs?: number; update?: true }
  /** The server said no (no invite, banned, kicked, wrong server, key rotated). We don't retry. */
  | { state: 'rejected'; code: string; message: string; detail?: Record<string, unknown>; key?: string }
  /** Joined through an invite that needs a moderator's approval: we knock again every PENDING_RETRY_MS until they decide. */
  | { state: 'pending' }

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
  /** What this app supports beyond the basics, sent on every connect (auth `features`, PROTOCOL.md). */
  features?: string[]
  /**
   * Asked before every attempt for the address to use this time: `serverUrl`, or another way to the same server (the
   * desktop app's peer-to-peer tunnel when the address can't be reached). Null means try `serverUrl`.
   */
  resolveUrl?: () => Promise<string | null>
  onStatus: (status: ConnectionStatus) => void
  onWelcome: (welcome: Welcome) => void
  onEvent: <K extends keyof Events>(type: K, body: Events[K]) => void
  WebSocketImpl?: typeof WebSocket
  requestTimeoutMs?: number
  /** Tests: how long the handshake may take (HANDSHAKE_TIMEOUT_MS). */
  handshakeTimeoutMs?: number
}

/** Told about failed requests (type and error code only), for bug report diagnostics. */
export const requestErrorListeners = new Set<(type: string, code: string) => void>()
const reportRequestError = (type: string, code: string) => requestErrorListeners.forEach((listener) => listener(type, code))

interface Pending {
  type: string
  resolve: (body: unknown) => void
  reject: (error: RequestError) => void
  timer: ReturnType<typeof setTimeout>
}

const MIN_BACKOFF_MS = 500
const MAX_BACKOFF_MS = 30_000
/** After a restart signal: retry about this often (±25%), for at least RESTART_WINDOW_MS. */
export const RESTART_RETRY_MS = 1000
export const RESTART_WINDOW_MS = 120_000
/** While a moderator decides whether to let us in: a steady, slow knock (the server answers `join_pending` each time). */
export const PENDING_RETRY_MS = 15_000
/** A socket that doesn't get through the handshake (hello → auth → welcome) in this long is dropped and retried. */
export const HANDSHAKE_TIMEOUT_MS = 30_000

/** The reason of a 1012 or 1001 close: `{ v: 1, reason, etaMs? }`. Anything else counts as `restart`, without a hint. */
export function restartHint(reason: string): { reason: string; etaMs?: number } {
  try {
    const body = JSON.parse(reason) as { reason?: unknown; etaMs?: unknown }
    const etaMs = typeof body.etaMs === 'number' && body.etaMs >= 0 && body.etaMs <= 600_000 ? body.etaMs : undefined
    return { reason: typeof body.reason === 'string' ? body.reason.slice(0, 32) : 'restart', ...(etaMs !== undefined ? { etaMs } : {}) }
  } catch {
    return { reason: 'restart' }
  }
}

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
  /** While the server is restarting: when it said so, its estimate, and until when we retry fast. */
  private restart: { since: number; etaMs?: number; update?: true; until: number } | null = null
  /** The server said it stopped (not restarting), until we're back. */
  private serverStopped = false
  /** Waiting for a moderator to approve our join (status `pending`), until a welcome or a refusal. */
  private awaitingApproval = false
  /** The close code of the attempt that just ended, for the next offline status (diagnostics). */
  private lastCloseCode: number | undefined
  /** Gives up on a socket whose handshake doesn't finish (a tunnel or proxy that accepts but never answers). */
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null
  private handshakeTimedOut = false

  constructor(options: ConnectionOptions) {
    this.options = options
    this.invite = options.invite
  }

  start(): void {
    this.stopped = false
    this.rejected = false
    this.restart = null
    this.serverStopped = false
    this.tryOpen()
  }

  stop(): void {
    this.stopped = true
    this.clearHandshake()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    safeClose(this.socket)
    this.socket = null
    this.failPending('disconnected', 'Disconnected.')
  }

  /** Reconnect right away (e.g. the browser came back online, or the app came back to the front). */
  retryNow(): void {
    if (this.stopped || this.rejected || this.ready) return
    if (this.socket && !this.reconnectTimer) return // an attempt is already under way
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.tryOpen()
  }

  get isOnline(): boolean {
    return this.ready
  }

  /** `timeoutMs` overrides the usual wait for slow work (making a backup). */
  request<K extends keyof Requests>(type: K, body: Requests[K][0], timeoutMs?: number): Promise<Requests[K][1]> {
    const socket = this.socket
    if (!socket || !this.ready) return Promise.reject(new RequestError('disconnected', 'Not connected.', type))
    const id = `c${++this.nextId}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reportRequestError(type, 'timeout')
        reject(new RequestError('timeout', 'The server took too long to answer.', type))
      }, timeoutMs ?? this.options.requestTimeoutMs ?? 15_000)
      this.pending.set(id, { type, resolve: resolve as (b: unknown) => void, reject, timer })
      try {
        socket.send(JSON.stringify({ type, id, body }))
      } catch {
        // The socket is closing (InvalidStateError): its close event reconnects; this request fails now.
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new RequestError('disconnected', 'Not connected.', type))
      }
    })
  }

  /** Counts attempts, so an address resolved for an attempt that was stopped or superseded meanwhile is dropped. */
  private attempt = 0

  /** One attempt; whatever goes wrong in it (a status listener or the resolver throwing), the next one is scheduled. */
  private tryOpen(): void {
    try {
      this.open()
    } catch {
      this.socket = null
      if (!this.stopped && !this.rejected) this.scheduleReconnect()
    }
  }

  private open(): void {
    this.ready = false
    if (blockedAsInsecure(this.options.serverUrl)) {
      this.reject(
        'insecure_server',
        "This server doesn't use HTTPS, so browsers won't connect to it. Use the Iskra desktop app, or ask the host to turn on HTTPS.",
      )
      return
    }
    const attempt = ++this.attempt
    this.status(this.restartStatus() ?? (this.awaitingApproval ? { state: 'pending' } : { state: 'connecting' }))
    if (!this.options.resolveUrl) return this.openSocket(this.options.serverUrl)
    const stillWanted = () => attempt === this.attempt && !this.stopped && !this.rejected
    const go = (url: string | null) => {
      if (!stillWanted()) return
      try {
        this.openSocket(url ?? this.options.serverUrl)
      } catch {
        this.socket = null
        this.scheduleReconnect()
      }
    }
    let resolving: Promise<string | null>
    try {
      resolving = this.options.resolveUrl()
    } catch {
      resolving = Promise.resolve(null)
    }
    resolving.then(go, () => go(null))
  }

  /** Tells the app; a listener that throws must never stop the reconnect loop (the caller has already scheduled). */
  private status(status: ConnectionStatus): void {
    try {
      this.options.onStatus(status)
    } catch (e) {
      // Report it like an uncaught error (diagnostics see it), without unwinding the connection's own state.
      if (typeof globalThis.reportError === 'function') globalThis.reportError(e)
      else console.error(e)
    }
  }

  private openSocket(url: string): void {
    const Impl = this.options.WebSocketImpl ?? WebSocket
    let socket: WebSocket
    try {
      socket = new Impl(socketUrl(url))
    } catch {
      this.scheduleReconnect()
      return
    }
    this.socket = socket
    this.clearHandshake()
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null
      if (this.socket !== socket || this.ready || this.stopped || this.rejected) return
      this.handshakeTimedOut = true
      safeClose(socket)
      this.handleClose(1006)
    }, this.options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS)
    socket.onmessage = (event) => {
      if (this.socket === socket) this.handleFrame(String(event.data))
    }
    socket.onclose = (event) => {
      if (this.socket === socket) this.handleClose(event.code, event.reason)
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
        this.clearHandshake()
        this.attempts = 0
        this.restart = null
        this.serverStopped = false
        this.awaitingApproval = false
        this.invite = undefined // we're a member now
        this.status({ state: 'online' })
        this.options.onWelcome(body as unknown as Welcome)
        return
      case 'result':
      case 'error': {
        const pending = frame.id ? this.pending.get(frame.id) : undefined
        if (pending) {
          this.pending.delete(frame.id!)
          clearTimeout(pending.timer)
          if (frame.type === 'result') pending.resolve(body)
          else {
            reportRequestError(pending.type, String(body.code))
            pending.reject(new RequestError(body.code as RequestError['code'], String(body.message ?? 'Request failed.'), pending.type, ...errorKey(body)))
          }
        } else if (frame.type === 'error' && !this.ready) {
          if (body.code === 'join_pending') {
            // Not a no: a moderator has to let us in. The socket closes; we knock again in a while (handleClose).
            this.awaitingApproval = true
            this.status({ state: 'pending' })
            return
          }
          // Rejected during the handshake.
          this.reject(String(body.code ?? 'auth_failed'), String(body.message ?? 'The server refused the connection.'), body)
        }
        return
      }
      case 'kicked':
        this.reject('kicked', String(body.reason ?? 'You were removed from this server.'), undefined, errorKey(body)[0])
        this.options.onEvent('kicked', body as Events['kicked'])
        return
      default:
        if (frame.type && this.ready) this.options.onEvent(frame.type as keyof Events, body as never)
    }
  }

  private send(frame: unknown): void {
    const socket = this.socket
    if (!socket || (socket.readyState !== undefined && socket.readyState !== 1)) return // not open: its close event follows
    try {
      socket.send(JSON.stringify(frame))
    } catch {
      /* closing (InvalidStateError): the close event reconnects */
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
    // No name yet (restored from the recovery key): the server keeps the member's own, or answers name_required.
    const name = this.options.name()
    const profile = { ...this.options.profile?.(), ...(name ? { name } : {}), ...(this.options.bot ? { bot: true } : {}) }
    const body: Record<string, unknown> = { cert: identity.cert, sig, profile }
    if (this.invite) body.invite = this.invite
    const presence = this.options.presence?.()
    if (presence) body.presence = presence
    const rotations = this.options.rotations?.() ?? []
    if (rotations.length) body.rotations = rotations
    if (this.options.features?.length) body.features = this.options.features
    this.send({ type: 'auth', id: 'auth', body })
  }

  private clearHandshake(): void {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
    this.handshakeTimer = null
  }

  private reject(code: string, message: string, detail?: Record<string, unknown>, key?: string): void {
    this.rejected = true
    this.clearHandshake()
    this.ready = false
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    safeClose(this.socket)
    this.status({ state: 'rejected', code, message, ...(detail ? { detail } : {}), ...(key ? { key } : {}) })
  }

  private handleClose(code: number, reason = ''): void {
    this.socket = null
    this.clearHandshake()
    this.lastCloseCode = code
    this.ready = false
    this.failPending('disconnected', 'Connection lost.')
    if (this.stopped || this.rejected) return
    if (this.awaitingApproval && code === CloseCodes.AuthFailed) {
      this.schedule(PENDING_RETRY_MS)
      return
    }
    if (code === CloseCodes.Rotated) {
      this.reject('account_rotated', 'This account moved to a new key.')
      return
    }
    if (code === CloseCodes.Forbidden) {
      this.reject('forbidden', 'You no longer have access to this server.')
      return
    }
    if (code === CloseCodes.Restarting) {
      const now = Date.now()
      const hint = restartHint(reason)
      const etaMs = hint.etaMs
      // A second restart notice (it came back and went again) keeps the first one's start.
      const since = this.restart?.since ?? now
      const update = hint.reason === 'update' || !!this.restart?.update
      this.restart = { since, ...(etaMs !== undefined ? { etaMs } : {}), ...(update ? { update: true as const } : {}), until: now + Math.max(RESTART_WINDOW_MS, (etaMs ?? 0) + 60_000) }
      this.attempts = 0
      this.serverStopped = false
    } else if (code === CloseCodes.GoingAway && reason && restartHint(reason).reason === 'stop') {
      // Stopped for good (or for a while): the usual backoff, and "went offline" rather than "restarting".
      this.restart = null
      this.serverStopped = true
      this.attempts = 0
    }
    this.scheduleReconnect()
  }

  private restartStatus(): ConnectionStatus | null {
    const restart = this.restart
    if (!restart || Date.now() >= restart.until) return null
    return { state: 'restarting', since: restart.since, ...(restart.etaMs !== undefined ? { etaMs: restart.etaMs } : {}), ...(restart.update ? { update: true as const } : {}) }
  }

  private scheduleReconnect(): void {
    const restarting = this.restartStatus()
    if (restarting) {
      // Fast and steady while the server comes back; jitter so everyone doesn't knock at the same moment.
      this.schedule(Math.round(RESTART_RETRY_MS * (0.75 + Math.random() * 0.5)))
      this.status(restarting)
      return
    }
    this.restart = null
    const base = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** this.attempts)
    const delay = Math.round(base * (0.7 + Math.random() * 0.6)) // jitter so clients don't stampede after a restart
    this.attempts++
    const closeCode = this.lastCloseCode
    const timedOut = this.handshakeTimedOut
    this.lastCloseCode = undefined
    this.handshakeTimedOut = false
    // The timer first: nothing the status update does can stop the next attempt.
    this.schedule(delay)
    this.status({ state: 'offline', retryInMs: delay, ...(this.serverStopped ? { stopped: true } : {}), ...(closeCode !== undefined ? { closeCode } : {}), ...(timedOut ? { timedOut: true as const } : {}) })
  }

  private schedule(delay: number): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.stopped && !this.rejected) this.tryOpen()
    }, delay)
  }

  private failPending(code: 'disconnected', message: string): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new RequestError(code, message, pending.type))
    }
    this.pending.clear()
  }
}

/** close() on a socket that's already closing or broken must not throw into the reconnect path. */
function safeClose(socket: WebSocket | null): void {
  try {
    socket?.close(1000)
  } catch {
    /* already closed */
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

/** An error body's `key` and `args`, when they're well formed (anything else is ignored: the message still shows). */
function errorKey(body: Record<string, unknown>): [string?, Record<string, string | number>?] {
  if (typeof body.key !== 'string' || !/^[a-z0-9_]{1,64}$/.test(body.key)) return []
  const args: Record<string, string | number> = {}
  if (body.args && typeof body.args === 'object') {
    for (const [name, value] of Object.entries(body.args as Record<string, unknown>)) {
      if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) args[name] = value
    }
  }
  return [body.key, args]
}
