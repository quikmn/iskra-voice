// What the tunnel says in the log (src `p2p`, area `tunnel`): how each side got through and what it costs, in types,
// numbers and durations only. Never an address (ours, the peer's or a relay's), a key, the secret or an error's text:
// HyperDHT's error *codes* are fixed words (PEER_NOT_FOUND), its messages are not used.
//
//   friend: connected  path=punched nat=consistent took=1.4s kind=cold n=1      (the first, a new path, or a slow one)
//           failed     TUN-160 why=holepunch-aborted nat=randomized took=10.2s  (at most once a minute per reason)
//           closed     TUN-170 what=turn dur=12.5s                               (the voice link dropped; remade on use)
//   host:   announced  took=840ms nat=consistent
//           peers      count=2 total=5                                           (when it changes, at most every 30 s)
//           turn       count=2 in=1520 out=1498                                  (voice through the tunnel, every 5 min)
//           changed    what=nat nat=randomized                                   (only when the type changes)
import sodium from 'sodium-universal'

export type TunnelLogLevel = 'INFO' | 'WARN' | 'ERROR'
export type TunnelLogValue = string | number | boolean | null | undefined

export interface TunnelLogEvent {
  level: TunnelLogLevel
  event: string
  code?: string | null
  fields: [string, TunnelLogValue][]
}

export type TunnelLogger = (event: TunnelLogEvent) => void

export const noLog: TunnelLogger = () => undefined

/** HyperDHT's view of our NAT, as one word: open, consistent (punchable), randomized (hard to punch). */
export function natType(nat: { firewalled: boolean; randomized: boolean } | null | undefined): 'open' | 'consistent' | 'randomized' | undefined {
  if (!nat) return undefined
  return nat.randomized ? 'randomized' : nat.firewalled ? 'consistent' : 'open'
}

/** The node's NAT type right now, read without ever touching its public address. */
export function nodeNat(dht: { firewalled?: boolean; randomized?: boolean; destroyed?: boolean } | null | undefined): ReturnType<typeof natType> {
  if (!dht || dht.destroyed || typeof dht.firewalled !== 'boolean') return undefined
  return natType({ firewalled: dht.firewalled, randomized: dht.randomized === true })
}

/** HyperDHT's counters for how connections got through (dht.stats.punches). */
export interface PunchCounters {
  open: number
  consistent: number
  random: number
}

export function punchCounters(dht: unknown): PunchCounters {
  const p = (dht as { stats?: { punches?: Partial<PunchCounters> } } | null)?.stats?.punches
  return { open: p?.open ?? 0, consistent: p?.consistent ?? 0, random: p?.random ?? 0 }
}

/**
 * How one connection got through, from the punch counters before and after it opened: `open` (the other side needed no
 * punching), `punched` / `punched-random` (a hole punch on a consistent / randomized NAT), `relay` (carried by a blind
 * relay), or `lan` (the LAN shortcut, or this machine). Several connections opening at once can blur it; it's a hint.
 */
export function routeOf(before: PunchCounters, after: PunchCounters, opts: { relayed: boolean; local: boolean }): string {
  if (after.random > before.random) return 'punched-random'
  if (after.consistent > before.consistent) return 'punched'
  if (opts.relayed) return 'relay'
  if (after.open > before.open) return 'open'
  return opts.local ? 'lan' : 'open'
}

/** Is this one of our own or a private network's addresses? (Only to tell a LAN path apart; the address isn't kept.) */
export function isLocalAddress(host: string | undefined | null): boolean {
  if (!host) return false
  return /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd][0-9a-f]{2}:|fe80:)/i.test(host)
}

/** A HyperDHT error's code as a log word (PEER_NOT_FOUND → peer-not-found); anything else is `error`. */
export function errorWhy(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,39}$/.test(code) ? code.toLowerCase().replace(/_/g, '-') : 'error'
}

/** Milliseconds the way the log writes a duration (the same as log.ts). */
export function took(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return ms < 99_950 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 1000)}s`
}

/**
 * The server's id in log lines (`srv=`), as the server and the app print it: the first 4 hex of
 * BLAKE2b-256("iskra-log-v1" ‖ 0x00 ‖ server public key). Null for anything that isn't a 32-byte key.
 */
export function serverLogId(serverKey: string): string | null {
  const key = Buffer.from(serverKey, 'base64url')
  if (key.length !== 32) return null
  const context = Buffer.from('iskra-log-v1')
  const out = Buffer.alloc(32)
  sodium.crypto_generichash(out, Buffer.concat([context, Buffer.from([0]), key]))
  return out.toString('hex').slice(0, 4)
}

/** A connection slower than this is always worth a line. */
const SLOW_MS = 3000
const FAILURE_QUIET_MS = 60_000

/**
 * Which of a friend tunnel's connections get a line: every page load and API call rides its own DHT connection, so
 * not all of them. The first one (cold: lookup and punch from nothing), any that took a different path than the one
 * before, and slow ones; failures at most once a minute per reason (with how many were skipped).
 */
export class FriendNotes {
  private count = 0
  private lastPath: string | null = null
  private readonly failures = new Map<string, { at: number; skipped: number }>()

  constructor(private readonly log: TunnelLogger, private readonly base: () => [string, TunnelLogValue][] = () => [], private readonly now: () => number = () => Date.now()) {}

  connected(path: string, ms: number, nat: string | undefined): void {
    this.count++
    const first = this.count === 1
    if (!first && path === this.lastPath && ms < SLOW_MS) return
    this.lastPath = path
    this.log({ level: 'INFO', event: 'connected', fields: [...this.base(), ['path', path], ['nat', nat], ['took', took(ms)], ['kind', first ? 'cold' : 'warm'], ['n', this.count]] })
  }

  failed(why: string, ms: number, nat: string | undefined): void {
    const now = this.now()
    const seen = this.failures.get(why)
    if (seen && now - seen.at < FAILURE_QUIET_MS) {
      seen.skipped++
      return
    }
    this.failures.set(why, { at: now, skipped: 0 })
    this.log({ level: 'WARN', event: 'failed', code: 'TUN-160', fields: [...this.base(), ['why', why], ['nat', nat], ['took', took(ms)], ['count', seen?.skipped || undefined]] })
  }

  turnClosed(ms: number): void {
    this.log({ level: 'INFO', event: 'closed', code: 'TUN-170', fields: [...this.base(), ['what', 'turn'], ['dur', took(ms)]] })
  }
}

const PEERS_QUIET_MS = 30_000
export const TURN_SAMPLE_MS = 5 * 60_000

/**
 * The host's lines: friends connected (a count, never who), voice through the tunnel (flows and datagrams, every few
 * minutes while it's used) and NAT type changes. `tick` is called by a timer; tests call it with their own clock.
 */
export class HostNotes {
  private peersLogged = -1
  private peersAt = 0
  private nat: string | undefined
  private turnLogged = { in: 0, out: 0 }

  constructor(private readonly log: TunnelLogger, private readonly now: () => number = () => Date.now()) {}

  announced(ms: number, nat: string | undefined): void {
    this.nat = nat
    this.log({ level: 'INFO', event: 'announced', fields: [['took', took(ms)], ['nat', nat]] })
  }

  /** A change of the NAT type (a new network): one line, not one per refresh. */
  natSeen(nat: string | undefined): void {
    if (!nat || nat === this.nat) return
    const from = this.nat
    this.nat = nat
    if (from) this.log({ level: 'INFO', event: 'changed', fields: [['what', 'nat'], ['nat', nat]] })
  }

  /** Called on every connect and close, and by the timer: logs the count when it changed, at most every 30 s. */
  peers(open: number, total: number): void {
    const now = this.now()
    if (open === this.peersLogged || now - this.peersAt < PEERS_QUIET_MS) return
    this.peersLogged = open
    this.peersAt = now
    this.log({ level: 'INFO', event: 'peers', fields: [['count', open], ['n', total]] })
  }

  /** Voice through the tunnel since the last line: flows open now and datagrams each way. Nothing when idle. */
  turn(flows: number, datagramsIn: number, datagramsOut: number): void {
    const dIn = datagramsIn - this.turnLogged.in
    const dOut = datagramsOut - this.turnLogged.out
    if (dIn <= 0 && dOut <= 0) return
    this.turnLogged = { in: datagramsIn, out: datagramsOut }
    this.log({ level: 'INFO', event: 'turn', fields: [['count', flows], ['in', dIn], ['out', dOut]] })
  }
}
