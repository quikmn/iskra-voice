// Voice's route and quality in the log: RTCStats (mocked as plain objects) → fields, thresholds and their rate limits,
// and that nothing from a candidate but its type and protocol gets through.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addLogSink, formatLine, setLogClock, type LogEntry } from '../core/log'
import { CallSampler } from './voiceStats'
import { countersOf, QualityWatch, routeOf, sameRoute, sampleFields, sampleOf, type Sample, type StatLike } from './voiceStatsLogic'
import type { VoiceSession } from './voice'

const HOSTILE = {
  address: '198.51.100.23', port: 51234, relatedAddress: '10.1.2.3', relatedPort: 51234, foundation: '842163049',
  usernameFragment: 'CANARYUFRAG', url: 'turn:203.0.113.9:3478?transport=udp', candidate: 'candidate:1 1 udp 2122260223 192.168.1.20 61000 typ host',
}

/** One peer connection's stats: a selected pair between a local and a remote candidate, plus audio counters. */
function pcStats(o: {
  local?: string; remote?: string; protocol?: string; relayProtocol?: string; viaTransport?: boolean
  inbound?: { lost: number; received: number; bytes: number; concealed: number; samples: number; jitter?: number }
  outbound?: { sent: number }; remoteInbound?: { lost: number; rtt?: number }; pairRtt?: number
}): StatLike[] {
  const stats: StatLike[] = [
    { id: 'L1', type: 'local-candidate', candidateType: o.local ?? 'srflx', protocol: o.protocol ?? 'udp', relayProtocol: o.relayProtocol, networkType: 'wifi', ip: HOSTILE.address, ...HOSTILE },
    { id: 'R1', type: 'remote-candidate', candidateType: o.remote ?? 'host', protocol: o.protocol ?? 'udp', ip: '203.0.113.7', ...HOSTILE },
    { id: 'P1', type: 'candidate-pair', localCandidateId: 'L1', remoteCandidateId: 'R1', state: 'succeeded', nominated: true, currentRoundTripTime: o.pairRtt },
    { id: 'P0', type: 'candidate-pair', localCandidateId: 'R1', remoteCandidateId: 'L1', state: 'failed', nominated: false },
    { id: 'C1', type: 'codec', mimeType: 'audio/opus', sdpFmtpLine: 'minptime=10' },
  ]
  if (o.viaTransport !== false) stats.push({ id: 'T1', type: 'transport', selectedCandidatePairId: 'P1', dtlsState: 'connected' })
  if (o.inbound) stats.push({ id: 'I1', type: 'inbound-rtp', kind: 'audio', codecId: 'C1', packetsLost: o.inbound.lost, packetsReceived: o.inbound.received, bytesReceived: o.inbound.bytes, concealedSamples: o.inbound.concealed, totalSamplesReceived: o.inbound.samples, jitter: o.inbound.jitter })
  if (o.inbound) stats.push({ id: 'V1', type: 'inbound-rtp', kind: 'video', packetsLost: 9999, packetsReceived: 1 })
  if (o.outbound) stats.push({ id: 'O1', type: 'outbound-rtp', kind: 'audio', codecId: 'C1', packetsSent: o.outbound.sent })
  if (o.remoteInbound) stats.push({ id: 'RI1', type: 'remote-inbound-rtp', kind: 'audio', packetsLost: o.remoteInbound.lost, roundTripTime: o.remoteInbound.rtt })
  return stats
}

describe('voice route from RTCStats', () => {
  it('reads the selected pair: candidate types and protocol, relayed or not', () => {
    expect(routeOf(pcStats({ local: 'srflx', remote: 'host' }))).toEqual({ ice: 'srflx', peer: 'host', proto: 'udp', via: 'direct' })
    expect(routeOf(pcStats({ local: 'relay', remote: 'host', relayProtocol: 'tcp' }))).toEqual({ ice: 'relay', peer: 'host', proto: 'udp', via: 'turn', turn: 'tcp' })
    expect(routeOf(pcStats({ local: 'host', protocol: 'tcp' }))?.proto).toBe('tcp')
    // Firefox: no transport stats, the pair is nominated and succeeded
    expect(routeOf(pcStats({ viaTransport: false }))).toEqual({ ice: 'srflx', peer: 'host', proto: 'udp', via: 'direct' })
    // a Map, as getStats() returns it
    expect(routeOf(new Map(pcStats({}).map((s) => [s.id, s])))?.ice).toBe('srflx')
  })

  it('has no route without a selected pair or with unknown types', () => {
    expect(routeOf([])).toBeNull()
    expect(routeOf(pcStats({ local: '198.51.100.23' }))).toBeNull()
    expect(routeOf(pcStats({ protocol: 'sctp' }))).toBeNull()
    expect(sameRoute(routeOf(pcStats({})), routeOf(pcStats({})))).toBe(true)
    expect(sameRoute(routeOf(pcStats({})), routeOf(pcStats({ local: 'relay' })))).toBe(false)
  })
})

describe('voice quality samples', () => {
  const at = Date.parse('2026-10-17T13:00:00.000Z')
  const reading = (t: number, lost: number, received: number, opts: { sent?: number; outLost?: number; rtt?: number } = {}) =>
    countersOf([
      pcStats({ inbound: { lost, received, bytes: received * 80, concealed: lost * 960, samples: (lost + received) * 960, jitter: 0.012 } }),
      pcStats({ outbound: { sent: opts.sent ?? 0 }, remoteInbound: { lost: opts.outLost ?? 0, rtt: opts.rtt } }),
    ], t)

  it('turns counters into per-interval percentages, ms and kbit/s; audio only', () => {
    const first = reading(at, 10, 990, { sent: 1000, outLost: 0, rtt: 0.048 })
    const second = reading(at + 10_000, 30, 1470, { sent: 1500, outLost: 6, rtt: 0.051 })
    const s = sampleOf(first, second)
    expect(s).toEqual({ from: at, to: at + 10_000, codec: 'opus', loss: 4, lossout: 1.2, rtt: 51, jitter: 12, kbps: 30.7, conceal: 4 })
    expect(sampleFields(s)).toEqual([['codec', 'opus'], ['loss', 4], ['lossout', 1.2], ['rtt', '51ms'], ['jitter', '12ms'], ['kbps', 30.7], ['conceal', 4]])
    // a counter that went down (a new track) starts over instead of going negative
    expect(sampleOf(second, reading(at + 20_000, 1, 99)).loss).toBe(1)
    // the round trip falls back to the selected pair's
    expect(countersOf([pcStats({ pairRtt: 0.2 })], at).rtt).toBe(0.2)
  })

  it('warns after 20 s over a threshold, once, then not again for 5 minutes', () => {
    const watch = new QualityWatch()
    const sample = (t: number, loss: number, rtt = 40): Sample => ({ from: at + t - 10_000, to: at + t, loss, rtt })
    expect(watch.feed(sample(10_000, 8))).toEqual([])
    expect(watch.feed(sample(20_000, 12))).toEqual([{ code: 'VOI-160', fields: [['what', 'loss'], ['loss', 12], ['dur', '20s']] }])
    expect(watch.feed(sample(30_000, 9))).toEqual([]) // the same spell
    expect(watch.feed(sample(40_000, 1))).toEqual([]) // fine again
    expect(watch.feed(sample(50_000, 9))).toEqual([])
    expect(watch.feed(sample(60_000, 9))).toEqual([]) // a new spell, but within 5 minutes of the last warning
    expect(watch.feed(sample(330_000, 9))).toEqual([{ code: 'VOI-160', fields: [['what', 'loss'], ['loss', 9], ['dur', '290s']] }])
    // the round trip, on its own
    const rtt = new QualityWatch()
    expect(rtt.feed(sample(10_000, 0, 350))).toEqual([])
    expect(rtt.feed(sample(20_000, 0, 420))).toEqual([{ code: 'VOI-170', fields: [['what', 'rtt'], ['rtt', '420ms'], ['dur', '20s']] }])
    // a gap without a value ends a spell
    const gap = new QualityWatch()
    gap.feed(sample(10_000, 9))
    gap.feed({ from: at + 10_000, to: at + 20_000 })
    expect(gap.feed(sample(30_000, 9))).toEqual([])
  })
})

describe('the call sampler', () => {
  let lines: string[]
  let stopSink: () => void
  let now: number
  beforeEach(() => {
    lines = []
    now = Date.parse('2026-10-17T13:00:00.000Z')
    setLogClock(() => now)
    stopSink = addLogSink((e: LogEntry) => lines.push(formatLine(e)))
  })
  afterEach(() => {
    stopSink()
    setLogClock(null)
  })

  // Bytes 1..32 as base64url, built here so no key-like literal sits in the repo (gitleaks).
  const KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i + 1))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const session: VoiceSession = { serverKey: KEY, channelId: 12, state: 'connected', canSpeak: true }

  it('logs the route on connect and on change, samples every third reading, and warns on loss', async () => {
    let local = 'srflx'
    let lost = 0
    let received = 0
    const sampler = new CallSampler(() => session, async () => [
      pcStats({ local, inbound: { lost, received, bytes: received * 80, concealed: 0, samples: received * 960, jitter: 0.01 } }),
      pcStats({ local, outbound: { sent: received }, remoteInbound: { lost: 0, rtt: 0.05 } }),
    ], () => now)
    for (let i = 0; i < 5; i++) {
      if (i === 3) local = 'relay'
      lost += i >= 2 ? 100 : 0
      received += 500
      await sampler.tick()
      now += 10_000
    }
    const text = lines.join('\n')
    const ours = lines.map((l) => l.slice(25))
    expect(ours.filter((l) => l.includes(' route '))).toEqual([
      expect.stringMatching(/^INFO  app   voice  route       VOI-130 srv=\w+ chan=12 ice=srflx peer=host proto=udp via=direct why=connect$/),
      expect.stringMatching(/^INFO  app   voice  route       VOI-130 srv=\w+ chan=12 ice=relay peer=host proto=udp via=turn why=change$/),
    ])
    expect(ours.filter((l) => l.includes(' sample '))).toEqual([
      expect.stringMatching(/^INFO  app   voice  sample      -       srv=\w+ chan=12 codec=opus loss=11.8 lossout=0 rtt=50ms jitter=10ms kbps=\d+(\.\d)? conceal=0$/),
    ])
    expect(ours.filter((l) => l.includes(' poor '))).toEqual([
      expect.stringMatching(/^WARN  app   voice  poor        VOI-160 srv=\w+ chan=12 what=loss loss=16.7 dur=20s$/),
    ])
    for (const bad of Object.values(HOSTILE).map(String).concat(['198.51', '203.0.113', '10.1.2', '192.168', 'wifi', 'typ'])) expect(text).not.toContain(bad)
  })

  it('warns once when no route turns up, and stays quiet while not connected', async () => {
    let state: VoiceSession['state'] = 'reconnecting'
    const sampler = new CallSampler(() => ({ ...session, state }), async () => [[]], () => now)
    await sampler.tick()
    expect(lines).toEqual([])
    state = 'connected'
    for (let i = 0; i < 4; i++) {
      await sampler.tick()
      now += 10_000
    }
    expect(lines.filter((l) => l.includes('VOI-130'))).toEqual([expect.stringMatching(/ WARN  app   voice  route       VOI-130 srv=\w+ chan=12 why=no-route$/)])
  })
})
