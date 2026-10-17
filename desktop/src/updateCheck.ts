// The parts of the update checks that don't need Electron (so the unit tests can run them): which release to update
// to, and unsticking an updater state that no longer means anything. (The updater logs to the app log, log.ts.)
import { compareVersions, newerRelease, type GitHubRelease, type UpdateState } from './platform'

/** A download that hasn't finished in this long is treated as failed and the next check starts over. */
export const STALE_DOWNLOAD_MS = 30 * 60 * 1000

/**
 * Where the installing copies fetch the newest published release from.
 *
 * electron-updater's GitHub provider takes the newest entry of the repository's releases.atom feed, and that feed also
 * lists tags whose release is still a draft (or was never published). Such a tag has no latest.yml, so every check
 * failed ("Cannot find latest.yml") until a newer release was published. We pick the release ourselves from the
 * releases API (published releases only) and point the updater straight at its files.
 */
export function autoFeed(releases: GitHubRelease[], running: string, repo: string): { version: string; url: string } | null {
  const newer = newerRelease(releases, running)
  if (!newer) return null
  return { version: newer.version, url: `https://github.com/${repo}/releases/download/v${newer.version}` }
}

/**
 * The state an automatic or tray check should start from. A 'downloading' that has gone on too long (the download
 * stalled or its error was lost), or a 'ready'/'available' for a version that isn't newer than the running one, goes
 * back to 'none' so the check runs again instead of stopping there.
 */
export function healState(status: UpdateState, since: number, now: number, running: string): UpdateState {
  if (status.state === 'none') return status
  if (compareVersions(status.version, running) <= 0) return { state: 'none' }
  if (status.state === 'downloading' && now - since >= STALE_DOWNLOAD_MS) return { state: 'none' }
  return status
}
