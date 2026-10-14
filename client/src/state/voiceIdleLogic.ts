// When this device counts as idle for the AFK channel: no input and no speaking. The server decides when to move
// someone (after the server's own timeout); the app only says when it went idle and when it's active again.

/** Say "idle" after this long without input or speaking; the server counts from when it really started. */
export const REPORT_AFTER_MS = 60_000
/** The most the server accepts as "idle for". */
export const MAX_IDLE_MS = 3_600_000

export interface Activity {
  now: number
  /** Last keyboard, mouse or touch input in the app (or the app coming into view). */
  lastInput: number
  /** Last moment your own mic picked up speech. */
  lastSpeaking: number
  /** Desktop app: how long the whole computer has had no input (null elsewhere, or unknown). */
  systemIdleMs: number | null
}

/** How long this device has had neither input nor speaking. */
export function idleFor(a: Activity): number {
  let last = Math.max(a.lastInput, a.lastSpeaking)
  if (a.systemIdleMs !== null && a.systemIdleMs >= 0) last = Math.max(last, a.now - a.systemIdleMs)
  return Math.max(0, a.now - last)
}

export type IdleReport = { idle: true; idleMs: number } | { idle: false }

/** What to tell servers now, given whether we last said idle; null = nothing changed. */
export function nextReport(reportedIdle: boolean, idleMs: number): IdleReport | null {
  if (!reportedIdle && idleMs >= REPORT_AFTER_MS) return { idle: true, idleMs: Math.min(Math.round(idleMs), MAX_IDLE_MS) }
  if (reportedIdle && idleMs < REPORT_AFTER_MS) return { idle: false }
  return null
}
