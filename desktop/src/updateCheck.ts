// The parts of the update checks that don't need Electron (so the unit tests can run them): which release to update
// to, unsticking an updater state that no longer means anything, and the small update log.
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
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

/** One line for the log: no line breaks, no query strings or fragments (signed download links carry tokens there). */
export function logLine(text: string, max = 300): string {
  const clean = text
    .replace(/\s+/g, ' ')
    .replace(/\b(https?:\/\/[^\s?#"'<>]*)[?#][^\s"'<>]*/gi, '$1')
    .replace(/\b(token|access_token|sig|signature|x-amz-[a-z-]+)=[^\s&"'<>]+/gi, '$1=…')
    .trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

/** The first line of an error (electron-updater's messages go on with stacks and whole feeds). */
export function errorLine(error: unknown): string {
  const e = error as { code?: unknown; message?: unknown }
  const message = typeof e?.message === 'string' ? e.message : String(error)
  const first = message.split('\n')[0]
  return typeof e?.code === 'string' ? `${e.code}: ${first}` : first
}

/** A few KB of the latest update checks (what was checked, what it found, what failed), for diagnosing updates. */
export class UpdateLog {
  constructor(
    private readonly file: string,
    private readonly maxBytes = 16 * 1024,
    private readonly now: () => Date = () => new Date(),
  ) {}

  write(text: string): void {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true })
      appendFileSync(this.file, `${this.now().toISOString()} ${logLine(text)}\n`)
      if (statSync(this.file).size > this.maxBytes) {
        // Over the limit: keep the newest lines that fill half of it.
        const lines = readFileSync(this.file, 'utf8').split('\n').filter(Boolean)
        const kept: string[] = []
        let bytes = 0
        for (let i = lines.length - 1; i >= 0; i--) {
          bytes += Buffer.byteLength(lines[i]) + 1
          if (bytes > this.maxBytes / 2) break
          kept.unshift(lines[i])
        }
        writeFileSync(this.file, kept.length > 0 ? `${kept.join('\n')}\n` : '')
      }
    } catch {
      // The log is a convenience: never let it break an update.
    }
  }
}
