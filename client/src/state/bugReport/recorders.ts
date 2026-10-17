// What writes to the diagnostics buffer: connection states per server (numbered, never named), failed requests (type
// and code), voice states, uncaught errors (class and bundle line), desktop update states, online/offline.
import { requestErrorListeners } from '../../core/connection'
import { desktop } from '../../platform/desktop'
import { parseUpdateStatus } from '../../platform/updates'
import { useApp } from '../store'
import { useVoice } from '../voice'
import { errorFrame, recordDiagnostic } from './diagnostics'

let started = false

export function startDiagnostics(): () => void {
  if (started) return () => undefined
  started = true
  recordDiagnostic({ kind: 'app', event: 'start' })

  // Servers get a number for this session, in the order they're seen.
  const numbers = new Map<string, number>()
  const last = new Map<string, string>()
  const stopServers = useApp.subscribe((state) => {
    for (const [key, server] of Object.entries(state.servers)) {
      const status = server.status
      const signature = `${status.state}:${'code' in status ? status.code : ''}`
      if (last.get(key) === signature) continue
      last.set(key, signature)
      if (!numbers.has(key)) numbers.set(key, numbers.size + 1)
      recordDiagnostic({
        kind: 'connection', server: numbers.get(key), state: status.state,
        ...(status.state === 'rejected' ? { code: status.code } : {}),
        ...(status.state === 'offline' ? { retryMs: status.retryInMs } : {}),
      })
    }
  })

  const onRequestError = (type: string, code: string) => {
    if (code !== 'disconnected') recordDiagnostic({ kind: 'request', type, code })
  }
  requestErrorListeners.add(onRequestError)

  let voiceState: string | null = null
  const stopVoice = useVoice.subscribe((v) => {
    const state = v.session?.state ?? 'left'
    if (state === voiceState || (state === 'left' && voiceState === null)) return
    voiceState = state
    recordDiagnostic({
      kind: 'voice', state,
      ...(v.session ? { call: v.session.call ? 'dm' : v.session.group ? 'group' : 'channel' } : {}),
      ...(v.micEngine ? { engine: v.micEngine } : {}),
      ...(state === 'left' && v.leftReason ? { reason: v.leftReason } : {}),
    })
  })

  const onError = (e: ErrorEvent) => recordDiagnostic({ kind: 'error', source: 'window', name: (e.error as Error | undefined)?.name, frame: errorFrame((e.error as Error | undefined)?.stack) })
  const onRejection = (e: PromiseRejectionEvent) => {
    const reason = e.reason as Error | undefined
    recordDiagnostic({ kind: 'error', source: 'promise', name: reason?.name, frame: errorFrame(reason?.stack) })
  }
  const onOnline = () => recordDiagnostic({ kind: 'app', event: 'online' })
  const onOffline = () => recordDiagnostic({ kind: 'app', event: 'offline' })
  const onVisibility = () => recordDiagnostic({ kind: 'app', event: document.visibilityState === 'hidden' ? 'hidden' : 'visible' })
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  window.addEventListener('online', onOnline)
  window.addEventListener('offline', onOffline)
  document.addEventListener('visibilitychange', onVisibility)

  const stopUpdates = desktop?.updates.onStatus((raw) => {
    const status = parseUpdateStatus(raw)
    recordDiagnostic({ kind: 'update', state: status.state, ...(status.state !== 'none' ? { version: status.version } : {}) })
  })

  return () => {
    started = false
    stopServers()
    stopVoice()
    stopUpdates?.()
    requestErrorListeners.delete(onRequestError)
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
    window.removeEventListener('online', onOnline)
    window.removeEventListener('offline', onOffline)
    document.removeEventListener('visibilitychange', onVisibility)
  }
}

