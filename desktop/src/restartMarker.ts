// "This stop is a restart" for the servers the app hosts: the same <world>/restart-expected file that
// `iskra-server expect-restart` writes (server/src/Iskra.Server/Sessions/RestartMarker.cs). Written just before the app
// installs an update, so members see "restarting for an update" rather than "went offline".
import { renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const RESTART_MARKER = 'restart-expected'

export type RestartReason = 'update' | 'restart'

/**
 * How the app stops its servers: `stop` (they're offline until the app starts them again), `restart` (the app starts
 * again right away) or `update` (it installs an update, then starts again).
 */
export type StopKind = 'stop' | 'restart' | 'update'

/**
 * What the app writes to a server's stdin before closing it: "restart" when it's coming back and no marker says why
 * (a relaunch, or an update whose marker couldn't be written). With a marker the close is plain, so the marker's reason
 * (update) is the one members see: a "restart" line would win over it.
 */
export function farewellLine(kind: StopKind, marked: boolean): string {
  return kind !== 'stop' && !marked ? 'restart\n' : ''
}

/** About how long installing an update and starting the servers again takes (a hint for members' apps). */
export const UPDATE_RESTART_ETA_SECONDS = 60

/** The server reads at most this many seconds (RestartMarker.MaxEtaSeconds). */
const MAX_ETA_SECONDS = 600

/** The marker's text: `{"v":1,"reason":…,"etaSeconds"?:…,"at":<unix ms>}` and a newline, as the server writes it. */
export function restartMarkerJson(reason: RestartReason, etaSeconds: number | null, now: number): string {
  const body: Record<string, unknown> = { v: 1, reason }
  if (etaSeconds !== null) body.etaSeconds = Math.max(0, Math.min(MAX_ETA_SECONDS, Math.round(etaSeconds)))
  body.at = Math.floor(now)
  return `${JSON.stringify(body)}\n`
}

/** Writes the marker atomically into a world folder. Returns false if it couldn't be written. */
export function writeRestartMarker(folder: string, reason: RestartReason, etaSeconds: number | null, now = Date.now()): boolean {
  const file = path.join(folder, RESTART_MARKER)
  const temp = `${file}.tmp`
  try {
    writeFileSync(temp, restartMarkerJson(reason, etaSeconds, now))
    renameSync(temp, file)
    return true
  } catch (error) {
    console.error('Writing the restart marker:', error)
    try {
      rmSync(temp, { force: true })
    } catch {
      // nothing more to do
    }
    return false
  }
}
