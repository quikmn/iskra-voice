// What writes the app's log lines (core/log.ts) from the outside of things: connection states per server (srv= and
// conn= ids, the path, how long a connect took, the retry schedule, close codes, removal), voice sessions (joined,
// reconnecting, left with a reason and a code), failed requests (type and code), uncaught errors (class and bundle
// line), device changes during a call, and the app's lifecycle (start, visibility, online/offline, sleep).
import { requestErrorListeners, type ConnectionStatus } from '../../core/connection'
import { addLogSink, duration, errorFields, log, type LogLevel, type LogValue } from '../../core/log'
import { desktop } from '../../platform/desktop'
import { serverLogFields } from '../logIds'
import { useP2p } from '../p2p'
import { useApp } from '../store'
import { useAudio } from '../audio'
import { useVoice, type VoiceSession } from '../voice'
import type { VoiceLeftReason } from '../voiceLeft'
import { collectEnv } from './bugReport'

let started = false

/** How a WebSocket close code reads in a log line. */
export function closeWhy(code: number | undefined, stopped?: boolean): string {
  if (stopped) return 'stopped'
  if (code === undefined) return 'no-socket'
  if (code === 1000) return 'closed'
  if (code === 1001) return 'going-away'
  if (code === 1006) return 'socket-error'
  if (code === 1012) return 'restart'
  return code >= 4000 ? 'server-close' : 'closed'
}

/** Why voice ended, as a log line's level and code: ends nobody asked for carry a code. */
export function voiceLeftCode(reason: VoiceLeftReason | null): { level: LogLevel; code: string | null } {
  switch (reason) {
    case 'other_device': return { level: 'INFO', code: 'VOI-201' }
    case 'kicked':
    case 'removed': return { level: 'INFO', code: 'VOI-202' }
    case 'server': return { level: 'INFO', code: 'VOI-203' }
    case 'dropped': return { level: 'WARN', code: 'VOI-204' }
    // `failed`: the join's own line (VOI-120, with the error) comes just before.
    default: return { level: 'INFO', code: null }
  }
}

const pathOf = (key: string) => (useP2p.getState().via[key] ? 'tunnel' : 'direct')
const word = (text: string | undefined) => text?.replace(/[^A-Za-z0-9.]+/g, '-').slice(0, 40)

export type ConnectSeries = Map<string, { since: number; n: number; last: string }>

/** The lines for one server's status change. `series` follows one connect, from its first try until it's online. */
export function connectionLine(key: string, status: ConnectionStatus, series: ConnectSeries, now = Date.now()): void {
  const srv = serverLogFields(key)
  const path: [string, LogValue] = ['path', pathOf(key)]
  let run = series.get(key)
  const begin = () => {
    run = { since: now, n: 0, last: '' }
    series.set(key, run)
    return run
  }
  switch (status.state) {
    case 'connecting':
      if (!run) log('INFO', 'conn', 'connecting', null, [...srv, path, ['n', begin().n]])
      break
    case 'pending':
      if (run?.last !== 'pending') log('INFO', 'conn', 'pending', null, [...srv, path])
      break
    case 'online': {
      const took = run ? now - run.since : 0
      const n = run?.n ?? 0
      series.delete(key)
      // The welcome (and its logId) is handled right after this status: name the new conn= once it's in.
      queueMicrotask(() => log('INFO', 'conn', 'online', null, [...serverLogFields(key), path, ['took', duration(took)], ['n', n]]))
      return
    }
    case 'offline': {
      run ??= begin()
      run.n++
      log(status.stopped ? 'INFO' : 'WARN', 'conn', 'offline', status.stopped ? 'CON-140' : 'CON-110', [
        ...srv, path, ['close', status.closeCode], ['why', closeWhy(status.closeCode, status.stopped)], ['retry', duration(status.retryInMs)], ['n', run.n],
      ])
      break
    }
    case 'restarting':
      run ??= begin()
      if (run.last !== 'restarting') log('INFO', 'conn', 'restarting', 'CON-130', [...srv, path, ['why', status.update ? 'update' : 'restart']])
      break
    case 'rejected':
      series.delete(key)
      log('WARN', 'conn', 'rejected', 'CON-150', [...srv, path, ['code', status.code]])
      return
  }
  if (run) run.last = status.state
}

/** Where a voice session is: the server's ids and the channel, or the kind of call. */
function where(session: VoiceSession): [string, LogValue][] {
  const fields: [string, LogValue][] = serverLogFields(session.serverKey)
  if (session.call) fields.push(['call', 'dm'])
  else if (session.group) fields.push(['call', 'group'])
  else fields.push(['chan', session.channelId])
  return fields
}

/** Sends every entry to the desktop app's log file (it checks them again), at most 20 a second. */
function mirrorTo(write: (entry: unknown) => void): () => void {
  let since = 0
  let count = 0
  return addLogSink((entry) => {
    const now = Date.now()
    if (now - since > 1000) {
      since = now
      count = 0
    }
    if (++count <= 20) write(entry)
  })
}

export function startDiagnostics(): () => void {
  if (started) return () => undefined
  started = true
  const env = collectEnv()
  // The desktop app keeps this page's lines in its log file too (they outlive a reload or a crash).
  const write = desktop?.logs?.write
  const stopMirror = write ? mirrorTo(write) : () => undefined
  log('INFO', 'life', 'start', null, [['ver', env.version], ['kind', env.device], ['os', word(env.os)], ['browser', word(env.browser)], ['lang', env.language]])

  const series: ConnectSeries = new Map()
  const seen = new Map<string, ConnectionStatus>()
  const stopServers = useApp.subscribe((state) => {
    for (const [key, server] of Object.entries(state.servers)) {
      if (seen.get(key) === server.status) continue
      seen.set(key, server.status)
      connectionLine(key, server.status, series)
    }
    for (const key of [...seen.keys()]) {
      if (state.servers[key]) continue
      log('INFO', 'conn', 'stopped', 'CON-160', [...serverLogFields(key), ['why', 'removed']])
      seen.delete(key)
      series.delete(key)
    }
  })

  const onRequestError = (type: string, code: string) => {
    if (code !== 'disconnected') log('INFO', 'conn', 'request-failed', null, [['type', type], ['code', code]])
  }
  requestErrorListeners.add(onRequestError)

  let joinedAt = 0
  let reconnectingAt = 0
  const stopVoice = useVoice.subscribe((v, prev) => {
    const s = v.session
    const p = prev.session
    const now = Date.now()
    const same = !!s && !!p && s.serverKey === p.serverKey && s.channelId === p.channelId && s.call?.id === p.call?.id && s.group?.callId === p.group?.callId
    if (p && !same) {
      const reason: VoiceLeftReason | null = s ? 'switched' : v.leftReason
      const { level, code } = voiceLeftCode(reason)
      log(level, 'voice', 'left', code, [...where(p), ['reason', reason?.replace('_', '-')], ['dur', joinedAt ? duration(now - joinedAt) : undefined]])
      joinedAt = 0
    }
    if (s && !same) {
      joinedAt = now
      log('INFO', 'voice', 'connecting', null, [...where(s), ['path', pathOf(s.serverKey)]])
    }
    if (s && s.state !== (same ? p.state : 'connecting')) {
      if (s.state === 'reconnecting') {
        reconnectingAt = now
        log('INFO', 'voice', 'reconnecting', 'VOI-140', where(s))
      } else if (s.state === 'connected' && same && p.state === 'reconnecting') {
        log('INFO', 'voice', 'reconnected', null, [...where(s), ['dur', duration(now - reconnectingAt)]])
      } else if (s.state === 'connected') {
        log('INFO', 'voice', 'joined', null, [...where(s), ['took', duration(now - joinedAt)], ['engine', v.micEngine]])
      }
    }
    if (s && same && v.micEngine && v.micEngine !== prev.micEngine) log('INFO', 'media', 'changed', null, [['what', 'mic'], ['engine', v.micEngine]])
    if (s && v.cleanEngine && v.cleanEngine !== prev.cleanEngine) log('INFO', 'media', 'changed', null, [['what', 'incoming'], ['engine', v.cleanEngine]])
  })

  // A device plugged in or out during a call: say so, and whether the one chosen in settings went away.
  const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined
  const onDevices = () => {
    if (!useVoice.getState().session || !media?.enumerateDevices) return
    void media.enumerateDevices().then((devices) => {
      const { inputDevice, outputDevice } = useAudio.getState()
      const has = (id: string, kind: MediaDeviceKind) => !id || devices.some((d) => d.deviceId === id && d.kind === kind)
      const lost = !has(inputDevice, 'audioinput') ? 'input' : !has(outputDevice, 'audiooutput') ? 'output' : null
      if (lost) log('WARN', 'media', 'changed', 'MED-120', [['what', 'devices'], ['kind', lost], ['count', devices.length]])
      else log('INFO', 'media', 'changed', null, [['what', 'devices'], ['count', devices.length]])
    }, () => undefined)
  }
  media?.addEventListener?.('devicechange', onDevices)

  const onError = (e: ErrorEvent) => log('ERROR', 'ui', 'error', 'ERR-900', [['kind', 'window'], ...errorFields(e.error)])
  const onRejection = (e: PromiseRejectionEvent) => log('ERROR', 'ui', 'error', 'ERR-900', [['kind', 'promise'], ...errorFields(e.reason)])
  const onOnline = () => log('INFO', 'life', 'online')
  const onOffline = () => log('INFO', 'life', 'offline')
  const onVisibility = () => log('INFO', 'life', document.visibilityState === 'hidden' ? 'hidden' : 'visible')
  const onPageHide = () => log('INFO', 'life', 'stop')
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  window.addEventListener('online', onOnline)
  window.addEventListener('offline', onOffline)
  window.addEventListener('pagehide', onPageHide)
  document.addEventListener('visibilitychange', onVisibility)

  // Sleep: timers stop while the computer sleeps, so a tick that comes far too late means it slept (or froze).
  let tick = Date.now()
  const sleepTimer = setInterval(() => {
    const now = Date.now()
    if (now - tick > 60_000) log('INFO', 'life', 'resumed', null, [['dur', duration(now - tick)]])
    tick = now
  }, 15_000)

  return () => {
    started = false
    stopServers()
    stopVoice()
    stopMirror()
    clearInterval(sleepTimer)
    requestErrorListeners.delete(onRequestError)
    media?.removeEventListener?.('devicechange', onDevices)
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
    window.removeEventListener('online', onOnline)
    window.removeEventListener('offline', onOffline)
    window.removeEventListener('pagehide', onPageHide)
    document.removeEventListener('visibilitychange', onVisibility)
  }
}
