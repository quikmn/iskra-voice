// What the splash window says while Iskra starts: the steps, how far along it is, and "Updated to X" after an update.
// Pure logic (no Electron), unit-tested in launch.test.ts; splash.ts draws it.
import { compareVersions, isVersion } from './platform'

export type LaunchStep = 'starting' | 'servers' | 'connecting' | 'ready'

export interface LaunchState {
  /** Hosted servers starting with the app, and how many of them are up (or gave up). */
  servers: { total: number; done: number }
  /** We stopped waiting for slow servers: the app shows anyway, and they keep starting in the background. */
  serversGaveUp: boolean
  /** The app page: loading, loaded (now connecting to servers), or painted and ready to show. */
  page: 'loading' | 'loaded' | 'ready'
}

export const initialLaunch = (servers: number): LaunchState => ({ servers: { total: Math.max(0, servers), done: 0 }, serversGaveUp: false, page: 'loading' })

/** How long the app waits for its own servers before showing anyway. */
export const SERVER_WAIT_MS = 8000

const serversPending = (s: LaunchState) => !s.serversGaveUp && s.servers.done < s.servers.total

/** The main window shows once the page is ready and the servers are up (or we stopped waiting). */
export const readyToShow = (s: LaunchState): boolean => s.page === 'ready' && !serversPending(s)

export function launchStep(s: LaunchState): LaunchStep {
  if (readyToShow(s)) return 'ready'
  if (serversPending(s)) return 'servers'
  return s.page === 'loading' ? 'starting' : 'connecting'
}

/** 0–1, left to right: a little straight away, then an equal share for the page loading, painting, and each server. */
export function launchProgress(s: LaunchState): number {
  if (readyToShow(s)) return 1
  const total = 2 + s.servers.total
  const servers = s.serversGaveUp ? s.servers.total : Math.min(s.servers.done, s.servers.total)
  const done = (s.page === 'loading' ? 0 : s.page === 'loaded' ? 1 : 2) + servers
  return Math.round((0.08 + 0.92 * (done / total)) * 1000) / 1000
}

/** The version this run was updated to, if the last run was an older one (never on the first run or a downgrade). */
export function updatedTo(lastRun: string | null, current: string): string | null {
  if (!lastRun || !isVersion(lastRun) || !isVersion(current)) return null
  return compareVersions(current, lastRun) > 0 ? current : null
}

/** What the splash page shows. progress null: an indeterminate bar (an update installing). */
export interface SplashView {
  heading: string
  status: string
  progress: number | null
}

export interface SplashText {
  title: string
  starting: string
  servers: string
  connecting: string
  ready: string
  updatedTo: (version: string) => string
  updating: (version: string) => string
  updatingDetail: string
}

export function splashView(s: LaunchState, updated: string | null, t: SplashText): SplashView {
  return { heading: updated ? t.updatedTo(updated) : t.title, status: t[launchStep(s)], progress: launchProgress(s) }
}

export const updatingView = (version: string, t: SplashText): SplashView => ({ heading: t.updating(version), status: t.updatingDetail, progress: null })
