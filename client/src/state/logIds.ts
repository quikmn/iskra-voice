// The id the server gave each connection in its own log (welcome.logId, PROTOCOL.md "Log ids"), per server, so the
// app's diagnostics can name the same `conn=` the host sees. Kept in memory only; never sent back.
import { create } from 'zustand'
import { serverLogId } from '../core/log'
import { onWelcomeHook } from './store'

interface LogIdsState {
  /** serverKey → the current connection's log id (missing for servers that don't send one). */
  logIds: Record<string, string>
}

export const useLogIds = create<LogIdsState>(() => ({ logIds: {} }))

/** Only the shape the protocol promises: 1-8 lowercase letters and digits. */
export const validLogId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-z]{1,8}$/.test(value)

onWelcomeHook((serverKey, welcome) =>
  useLogIds.setState((s) => {
    const logIds = { ...s.logIds }
    if (validLogId(welcome.logId)) logIds[serverKey] = welcome.logId
    else delete logIds[serverKey]
    return { logIds }
  }),
)

const numbers = new Map<string, number>()

/**
 * How a server is named in this app's log lines: `srv=` (the 4 hex the server prints in its own log, from its key) and
 * `conn=` (this connection's welcome.logId). Before libsodium is ready: `s1`, `s2`… in the order servers are seen.
 */
export function serverLogFields(serverKey: string): [string, string][] {
  let srv = serverLogId(serverKey)
  if (!srv) {
    if (!numbers.has(serverKey)) numbers.set(serverKey, numbers.size + 1)
    srv = `s${numbers.get(serverKey)}`
  }
  const conn = useLogIds.getState().logIds[serverKey]
  if (!validLogId(conn)) return [['srv', srv]]
  return [['srv', srv], ['conn', conn]]
}
