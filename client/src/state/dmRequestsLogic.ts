// Message requests, the pure part (state/dmRequests.ts wires it up). A conversation is with a person across every
// server you share; each server keeps its own answer to "is this a request?". This folds them into one status.

export type DmStatus = 'accepted' | 'request' | 'ignored'

export interface PeerRequests {
  /** What each server says, by server key; a server that isn't listed treats the person as accepted (or never saw them). */
  servers: Record<string, 'request' | 'ignored'>
  /** Your own newest decision (from this device or, through a server, another one). */
  decided?: { state: 'accepted' | 'ignored'; at: number }
}

/**
 * The person's status. Your decision wins; having written to them yourself counts as accepting (that's what the
 * server does too); otherwise any server that holds their DMs as a request makes it one.
 */
export function statusOf(info: PeerRequests | undefined, talked: boolean): DmStatus {
  if (info?.decided) return info.decided.state
  if (talked) return 'accepted'
  const flags = Object.values(info?.servers ?? {})
  if (flags.includes('request')) return 'request'
  if (flags.includes('ignored')) return 'ignored'
  return 'accepted'
}

/** Servers whose answer differs from the status: they get told (accept or ignore) so pushes and lists match everywhere. */
export function serversToSync(info: PeerRequests | undefined, status: DmStatus): { accept: string[]; ignore: string[] } {
  const entries = Object.entries(info?.servers ?? {})
  if (status === 'accepted') return { accept: entries.map(([key]) => key), ignore: [] }
  if (status === 'ignored' && info?.decided?.state === 'ignored') return { accept: [], ignore: entries.filter(([, s]) => s === 'request').map(([key]) => key) }
  return { accept: [], ignore: [] }
}

/** A server's full list (dm.requests.list) replaces what we knew from that server. */
export function applyServerList(
  peers: Record<string, PeerRequests>, serverKey: string, list: { accountKey: string; state: 'request' | 'ignored' }[],
): Record<string, PeerRequests> {
  const next: Record<string, PeerRequests> = {}
  for (const [peer, info] of Object.entries(peers)) {
    const { [serverKey]: _dropped, ...servers } = info.servers
    next[peer] = { ...info, servers }
  }
  for (const { accountKey, state } of list) {
    const info = next[accountKey] ?? { servers: {} }
    next[accountKey] = { ...info, servers: { ...info.servers, [serverKey]: state } }
  }
  return next
}

/** One server's answer for one person: a request, ignored, or accepted (null: drop the flag). */
export function applyServerState(
  peers: Record<string, PeerRequests>, serverKey: string, peer: string, state: 'request' | 'ignored' | null,
): Record<string, PeerRequests> {
  const info = peers[peer] ?? { servers: {} }
  if ((info.servers[serverKey] ?? null) === state) return peers
  const { [serverKey]: _dropped, ...rest } = info.servers
  return { ...peers, [peer]: { ...info, servers: state ? { ...rest, [serverKey]: state } : rest } }
}

/** Records a decision unless a newer one is already there. */
export function decide(
  peers: Record<string, PeerRequests>, peer: string, state: 'accepted' | 'ignored', at: number,
): Record<string, PeerRequests> {
  const info = peers[peer] ?? { servers: {} }
  if (info.decided && info.decided.at > at) return peers
  if (info.decided?.state === state) return peers
  return { ...peers, [peer]: { ...info, decided: { state, at } } }
}

/** Decisions kept on the device (the newest ones, at most <paramref name="max"/>). */
export function storedDecisions(peers: Record<string, PeerRequests>, max = 2000): Record<string, { state: 'accepted' | 'ignored'; at: number }> {
  const decided = Object.entries(peers).flatMap(([peer, info]) => (info.decided ? [[peer, info.decided] as const] : []))
  decided.sort(([, a], [, b]) => b.at - a.at)
  return Object.fromEntries(decided.slice(0, max))
}

/** Checks decisions read back from storage (dropping anything malformed). */
export function checkDecisions(raw: unknown): Record<string, { state: 'accepted' | 'ignored'; at: number }> {
  const out: Record<string, { state: 'accepted' | 'ignored'; at: number }> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [peer, value] of Object.entries(raw as Record<string, unknown>)) {
    const v = value as { state?: unknown; at?: unknown } | null
    if (peer.length <= 64 && v && (v.state === 'accepted' || v.state === 'ignored') && typeof v.at === 'number') out[peer] = { state: v.state, at: v.at }
  }
  return out
}

// ── Stamping the setting ("who can message me") ──

/** How far past the servers' clock a stamp may be before it counts as made by a clock that ran ahead. */
export const MAX_AHEAD_MS = 5 * 60_000

/** The servers' clock as best we know it: ours plus the median of the offsets they showed us (theirs − ours). */
export function serverClock(now: number, offsets: number[]): number {
  if (offsets.length === 0) return now
  const sorted = [...offsets].sort((a, b) => a - b)
  return now + sorted[Math.floor(sorted.length / 2)]
}

/** A stamp made by a clock that ran ahead can't be ordered against real ones: it counts as never set (0). */
export const saneStamp = (at: number, clock: number): number => (at > clock + MAX_AHEAD_MS ? 0 : at)

/** The stamp for a new choice: the servers' time, and after the current choice (unless that one is from a clock that ran ahead). */
export function stampAfter(current: number, clock: number): number {
  return Math.max(Math.round(clock), saneStamp(current, clock) + 1)
}
