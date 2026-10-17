// While you're in voice: how the call reaches the voice server and how it sounds, in the diagnostic log.
//   VOI-130 route   ice=srflx peer=host proto=udp via=direct      (on connect, and whenever it changes)
//           sample  codec=opus loss=0.4 lossout=1.2 rtt=48ms jitter=6ms kbps=31.8 conceal=0.3   (every 30 s)
//   VOI-160 / VOI-170 poor   loss or round trip over the threshold for 20 s (at most once in 5 minutes each)
// Numbers and fixed words only (voiceStatsLogic.ts reads nothing else from the stats).
import type { Room } from 'livekit-client'
import { log, type LogValue } from '../core/log'
import { serverLogFields } from './logIds'
import { countersOf, QualityWatch, routeFields, routeOf, sameRoute, sampleFields, sampleOf, type Counters, type Route, type StatsLike } from './voiceStatsLogic'
import { activeRoom, useVoice, type VoiceSession } from './voice'

/** How often the stats are read; every SAMPLE_EVERY-th reading is logged. */
export const TICK_MS = 10_000
const SAMPLE_EVERY = 3
/** A call that has no route this long after connecting gets a warning. */
const NO_ROUTE_MS = 20_000

/** The two peer connections of a LiveKit room (it receives on one, sends on the other): their stats, primary first. */
async function readStats(room: Room): Promise<StatsLike[]> {
  const pcs = (room as unknown as { engine?: { pcManager?: { subscriber?: { getStats(): Promise<RTCStatsReport> | undefined }; publisher?: { getStats(): Promise<RTCStatsReport> | undefined } } } }).engine?.pcManager
  const reports = await Promise.all([pcs?.subscriber, pcs?.publisher].map((pc) => pc?.getStats()?.catch(() => undefined)))
  return reports.filter((r): r is RTCStatsReport => !!r) as unknown as StatsLike[]
}

function where(session: VoiceSession): [string, LogValue][] {
  const fields: [string, LogValue][] = serverLogFields(session.serverKey)
  if (session.call) fields.push(['call', 'dm'])
  else if (session.group) fields.push(['call', 'group'])
  else fields.push(['chan', session.channelId])
  return fields
}

/** One call's sampler: reads stats every TICK_MS until stopped. `read` and `now` are for tests. */
export class CallSampler {
  private route: Route | null = null
  private warnedNoRoute = false
  private prev: Counters | null = null
  /** The reading the last logged sample ended at: each logged sample covers the time since. */
  private logged: Counters | null = null
  private ticks = 0
  private readonly watch = new QualityWatch()
  private readonly startedAt: number
  private readonly session: () => VoiceSession | null
  private readonly read: () => Promise<StatsLike[]>
  private readonly now: () => number

  constructor(session: () => VoiceSession | null, read: () => Promise<StatsLike[]>, now: () => number = () => Date.now()) {
    this.session = session
    this.read = read
    this.now = now
    this.startedAt = now()
  }

  async tick(): Promise<void> {
    const session = this.session()
    if (!session || session.state !== 'connected') return
    const reports = await this.read()
    const at = this.now()
    // The route: the first peer connection that has one (the receiving one, unless only sending works).
    const route = reports.map(routeOf).find((r) => r !== null) ?? null
    if (route && !sameRoute(route, this.route)) {
      log('INFO', 'voice', 'route', 'VOI-130', [...where(session), ...routeFields(route), ['why', this.route ? 'change' : 'connect']])
      this.route = route
    } else if (!route && !this.route && !this.warnedNoRoute && at - this.startedAt >= NO_ROUTE_MS) {
      this.warnedNoRoute = true
      log('WARN', 'voice', 'route', 'VOI-130', [...where(session), ['why', 'no-route']])
    }
    const counters = countersOf(reports, at)
    const sample = sampleOf(this.prev, counters)
    this.prev = counters
    // The first reading only sets the baseline (its totals would cover the connect itself).
    if (this.ticks++ === 0) {
      this.logged = counters
      return
    }
    for (const warning of this.watch.feed(sample)) log('WARN', 'voice', 'poor', warning.code, [...where(session), ...warning.fields])
    if (this.ticks % SAMPLE_EVERY === 1) {
      log('INFO', 'voice', 'sample', null, [...where(session), ...sampleFields(sampleOf(this.logged, counters))])
      this.logged = counters
    }
  }
}

let started = false

/** Samples every call while it's connected (started with the diagnostics). */
export function startVoiceStats(): () => void {
  if (started) return () => undefined
  started = true
  let room: Room | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let first: ReturnType<typeof setTimeout> | null = null
  const stop = () => {
    if (timer) clearInterval(timer)
    if (first) clearTimeout(first)
    timer = first = null
    room = null
  }
  const sync = () => {
    const session = useVoice.getState().session
    const current = session ? activeRoom() : null
    if (!session || !current) return stop()
    if (current === room || session.state !== 'connected') return
    stop()
    room = current
    const own = current
    const s = new CallSampler(() => (activeRoom() === own ? useVoice.getState().session : null), () => readStats(own))
    const run = () => void s.tick().catch(() => undefined)
    // A moment after connecting the route is settled; then every TICK_MS.
    first = setTimeout(run, 2000)
    timer = setInterval(run, TICK_MS)
  }
  const unsubscribe = useVoice.subscribe(sync)
  sync()
  return () => {
    started = false
    unsubscribe()
    stop()
  }
}
