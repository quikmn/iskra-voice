// Voice's network route and quality from WebRTC's getStats(), as log fields: candidate *types*, protocols, codec and
// numbers. Never a candidate's address, port, foundation or ufrag: only the fields named here are read at all.
// voiceStats.ts samples a call with these; tests feed them plain objects shaped like RTCStats.
import type { LogValue } from '../core/log'

/** One RTCStats entry, as far as this file cares. */
export type StatLike = { id: string; type: string } & Record<string, unknown>
/** An RTCStatsReport (Map-like) or a plain list of stats. */
export type StatsLike = { forEach(callback: (value: StatLike) => void): void } | StatLike[]

function toMap(report: StatsLike): Map<string, StatLike> {
  const map = new Map<string, StatLike>()
  report.forEach((s) => {
    if (s && typeof s.id === 'string' && typeof s.type === 'string') map.set(s.id, s)
  })
  return map
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined => (allowed.includes(v as T) ? (v as T) : undefined)

const CANDIDATE_TYPES = ['host', 'srflx', 'prflx', 'relay'] as const
const PROTOCOLS = ['udp', 'tcp'] as const
const RELAY_PROTOCOLS = ['udp', 'tcp', 'tls'] as const

export interface Route {
  /** Our side's candidate type: host (direct), srflx (through our NAT), prflx, relay (through TURN). */
  ice: (typeof CANDIDATE_TYPES)[number]
  /** The other side's (the voice server's) candidate type. */
  peer?: (typeof CANDIDATE_TYPES)[number]
  proto: (typeof PROTOCOLS)[number]
  via: 'turn' | 'direct'
  /** How we reach the TURN server, when relayed. */
  turn?: (typeof RELAY_PROTOCOLS)[number]
}

/** The candidate pair in use: the transport's selected pair, else (Firefox) the pair marked selected or nominated. */
function selectedPair(stats: Map<string, StatLike>): StatLike | undefined {
  for (const s of stats.values()) {
    if (s.type === 'transport' && typeof s.selectedCandidatePairId === 'string') {
      const pair = stats.get(s.selectedCandidatePairId)
      if (pair) return pair
    }
  }
  const pairs = [...stats.values()].filter((s) => s.type === 'candidate-pair')
  return pairs.find((p) => p.selected === true) ?? pairs.find((p) => p.nominated === true && p.state === 'succeeded')
}

/** The route of one peer connection, or null while there is none. */
export function routeOf(report: StatsLike): Route | null {
  const stats = toMap(report)
  const pair = selectedPair(stats)
  if (!pair) return null
  const local = typeof pair.localCandidateId === 'string' ? stats.get(pair.localCandidateId) : undefined
  const remote = typeof pair.remoteCandidateId === 'string' ? stats.get(pair.remoteCandidateId) : undefined
  const ice = oneOf(local?.candidateType, CANDIDATE_TYPES)
  const proto = oneOf(local?.protocol, PROTOCOLS)
  if (!ice || !proto) return null
  const route: Route = { ice, proto, via: ice === 'relay' ? 'turn' : 'direct' }
  const peer = oneOf(remote?.candidateType, CANDIDATE_TYPES)
  if (peer) route.peer = peer
  const turn = ice === 'relay' ? oneOf(local?.relayProtocol, RELAY_PROTOCOLS) : undefined
  if (turn) route.turn = turn
  return route
}

export const sameRoute = (a: Route | null, b: Route | null): boolean =>
  a === b || (!!a && !!b && a.ice === b.ice && a.peer === b.peer && a.proto === b.proto && a.via === b.via && a.turn === b.turn)

export const routeFields = (r: Route): [string, LogValue][] => [['ice', r.ice], ['peer', r.peer], ['proto', r.proto], ['via', r.via], ['turn', r.turn]]

/** Running totals of a call's audio, from the stats of both peer connections (LiveKit sends on one, receives on the other). */
export interface Counters {
  at: number
  codec?: string
  inLost: number
  inReceived: number
  inBytes: number
  concealed: number
  samples: number
  /** Seconds, averaged over the incoming tracks (WebRTC keeps it as a running estimate, not a total). */
  jitter?: number
  outSent: number
  /** Lost on the way to the server, as the server reported back (remote-inbound-rtp). */
  outLost: number
  /** Seconds (the latest estimate). */
  rtt?: number
}

const CODEC = /^audio\/([a-z0-9]{1,12})$/i

export function countersOf(reports: StatsLike[], at: number): Counters {
  const c: Counters = { at, inLost: 0, inReceived: 0, inBytes: 0, concealed: 0, samples: 0, outSent: 0, outLost: 0 }
  let jitterSum = 0
  let jitterCount = 0
  for (const report of reports) {
    const stats = toMap(report)
    const codecOf = (s: StatLike) => {
      const codec = typeof s.codecId === 'string' ? stats.get(s.codecId) : undefined
      const m = CODEC.exec(typeof codec?.mimeType === 'string' ? codec.mimeType : '')
      return m ? m[1].toLowerCase() : undefined
    }
    for (const s of stats.values()) {
      if (s.kind !== undefined && s.kind !== 'audio' && s.mediaType !== 'audio') continue
      if (s.type === 'inbound-rtp') {
        c.inLost += Math.max(0, num(s.packetsLost) ?? 0)
        c.inReceived += num(s.packetsReceived) ?? 0
        c.inBytes += num(s.bytesReceived) ?? 0
        c.concealed += num(s.concealedSamples) ?? 0
        c.samples += num(s.totalSamplesReceived) ?? 0
        const jitter = num(s.jitter)
        if (jitter !== undefined) {
          jitterSum += jitter
          jitterCount++
        }
        c.codec ??= codecOf(s)
      } else if (s.type === 'outbound-rtp') {
        c.outSent += num(s.packetsSent) ?? 0
        c.codec ??= codecOf(s)
      } else if (s.type === 'remote-inbound-rtp') {
        c.outLost += Math.max(0, num(s.packetsLost) ?? 0)
        const rtt = num(s.roundTripTime)
        if (rtt !== undefined) c.rtt = rtt
      }
    }
    if (c.rtt === undefined) {
      const rtt = num(selectedPair(stats)?.currentRoundTripTime)
      if (rtt !== undefined) c.rtt = rtt
    }
  }
  if (jitterCount) c.jitter = jitterSum / jitterCount
  return c
}

/** One interval's quality: percentages, milliseconds and kbit/s. Missing when there was nothing to measure. */
export interface Sample {
  from: number
  to: number
  codec?: string
  /** Incoming packets lost, percent. */
  loss?: number
  /** Our packets lost on the way to the server, percent. */
  lossout?: number
  rtt?: number
  jitter?: number
  /** Incoming audio, kbit/s. */
  kbps?: number
  /** Incoming audio that had to be made up (concealed), percent of samples. */
  conceal?: number
}

const percent = (part: number, whole: number) => (whole > 0 ? Math.round((1000 * part) / whole) / 10 : undefined)

/** The change between two readings (or, for the first, the totals so far). Counters that went down (a new track) restart. */
export function sampleOf(prev: Counters | null, cur: Counters): Sample {
  const d = (key: 'inLost' | 'inReceived' | 'inBytes' | 'concealed' | 'samples' | 'outSent' | 'outLost') => {
    const before = prev?.[key] ?? 0
    return cur[key] >= before ? cur[key] - before : cur[key]
  }
  const from = prev?.at ?? cur.at
  const seconds = (cur.at - from) / 1000
  const lost = d('inLost')
  const received = d('inReceived')
  const sample: Sample = { from, to: cur.at }
  if (cur.codec) sample.codec = cur.codec
  if (lost + received > 0) sample.loss = percent(lost, lost + received)
  const sent = d('outSent')
  if (sent > 0) sample.lossout = percent(Math.min(d('outLost'), sent), sent)
  if (cur.rtt !== undefined) sample.rtt = Math.round(cur.rtt * 1000)
  if (cur.jitter !== undefined) sample.jitter = Math.round(cur.jitter * 1000)
  if (seconds > 0 && received > 0) sample.kbps = Math.round((d('inBytes') * 8) / seconds / 100) / 10
  if (d('samples') > 0) sample.conceal = percent(d('concealed'), d('samples'))
  return sample
}

export const sampleFields = (s: Sample): [string, LogValue][] => [
  ['codec', s.codec], ['loss', s.loss], ['lossout', s.lossout],
  ['rtt', s.rtt === undefined ? undefined : `${s.rtt}ms`], ['jitter', s.jitter === undefined ? undefined : `${s.jitter}ms`],
  ['kbps', s.kbps], ['conceal', s.conceal],
]

export interface Thresholds {
  /** Incoming loss above this percent... */
  lossPct: number
  /** ...or a round trip above this... */
  rttMs: number
  /** ...for this long is a warning... */
  holdMs: number
  /** ...at most once in this long per kind. */
  quietMs: number
}
export const THRESHOLDS: Thresholds = { lossPct: 5, rttMs: 300, holdMs: 20_000, quietMs: 5 * 60_000 }

export interface QualityWarning {
  code: 'VOI-160' | 'VOI-170'
  fields: [string, LogValue][]
}

/**
 * Watches the samples for a bad stretch: loss or round trip over the threshold in every sample for `holdMs` gives one
 * warning (with the worst value seen), then nothing for that kind until it has been fine again and `quietMs` passed.
 */
export class QualityWatch {
  private readonly spells = {
    loss: { since: null as number | null, worst: 0, warned: false, lastAt: -Infinity },
    rtt: { since: null as number | null, worst: 0, warned: false, lastAt: -Infinity },
  }

  private readonly limits: Thresholds

  constructor(limits: Thresholds = THRESHOLDS) {
    this.limits = limits
  }

  feed(sample: Sample): QualityWarning[] {
    const out: QualityWarning[] = []
    const check = (kind: 'loss' | 'rtt', value: number | undefined, over: number) => {
      const spell = this.spells[kind]
      if (value === undefined || value <= over) {
        spell.since = null
        spell.worst = 0
        spell.warned = false
        return
      }
      spell.since ??= sample.from
      spell.worst = Math.max(spell.worst, value)
      if (spell.warned || sample.to - spell.since < this.limits.holdMs || sample.to - spell.lastAt < this.limits.quietMs) return
      spell.warned = true
      spell.lastAt = sample.to
      const dur = `${Math.round((sample.to - spell.since) / 1000)}s`
      out.push(kind === 'loss'
        ? { code: 'VOI-160', fields: [['what', 'loss'], ['loss', spell.worst], ['dur', dur]] }
        : { code: 'VOI-170', fields: [['what', 'rtt'], ['rtt', `${spell.worst}ms`], ['dur', dur]] })
    }
    check('loss', sample.loss, this.limits.lossPct)
    check('rtt', sample.rtt, this.limits.rttMs)
    return out
  }
}
