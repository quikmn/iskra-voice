// Keeping the desktop app up to date from GitHub releases.
// Installer (Windows), AppImage (Linux) and Developer ID signed macOS builds download updates in the background and
// restart into them. Builds that can't replace themselves (portable, deb/rpm, ad-hoc signed macOS) just say a new
// version is out.
import { execFile } from 'node:child_process'
import path from 'node:path'
import { app, net } from 'electron'
import { autoUpdater } from 'electron-updater'
import { compareVersions, macSigning, newerRelease, updateMode, type GitHubRelease, type MacSigning, type UpdateMode, type UpdateState } from './platform'
import { autoFeed, errorLine, healState, UpdateLog } from './updateCheck'

const REPO = 'quikmn/iskra-voice'
const FIRST_CHECK_MS = 15_000
const CHECK_EVERY_MS = 60 * 60 * 1000
/** Coming back to the window checks again if the last check is at least this old. */
const RECHECK_ON_FOCUS_MS = 15 * 60 * 1000

export type UpdateStatus = UpdateState

/** What a check you asked for found. */
export type CheckResult = 'up-to-date' | 'found' | 'failed' | 'off'

const releaseUrl = (version: string) => `https://github.com/${REPO}/releases/tag/v${version}`

/** How the running .app is signed (codesign prints its details to stderr, and exits non-zero when it isn't signed). */
function readMacSigning(bundlePath: string): Promise<MacSigning> {
  return new Promise((resolve) => {
    execFile('/usr/bin/codesign', ['-dv', '--verbose=2', bundlePath], { timeout: 10_000 }, (error, _stdout, stderr) => {
      resolve(error ? 'none' : macSigning(String(stderr)))
    })
  })
}

export class Updates {
  private status: UpdateStatus = { state: 'none' }
  /** On macOS 'manual' until the app's signature has been read (see resolveMode). */
  private mode: UpdateMode = updateMode(process.platform, app.isPackaged, process.env)
  private resolving: Promise<UpdateMode> | null = null
  private autoUpdaterSetUp = false
  private readonly onChange: (status: UpdateStatus) => void
  /** Automatic checks (My settings → Privacy & data); "Check for updates" in the tray still works when they're off. */
  private automatic = true
  private timer: NodeJS.Timeout | null = null
  private started = false
  private lastCheck = 0
  /** When the status last changed (a download that never finishes is given up on, see healState). */
  private statusSince = Date.now()
  /** userData/logs/updates.log: the latest checks, for diagnosing updates (no links with tokens, no personal data). */
  private log: UpdateLog | null = null

  constructor(onChange: (status: UpdateStatus) => void) {
    this.onChange = onChange
  }

  current(): UpdateStatus {
    return this.status
  }

  /** Development builds don't update. */
  get enabled(): boolean {
    return this.mode !== 'off'
  }

  /** A check right now (the tray's "Check for updates"). New versions show up in the status as usual. */
  async check(): Promise<CheckResult> {
    if (this.mode === 'off') return 'off'
    this.log?.write('check from the tray')
    this.heal()
    if (this.status.state !== 'none') return 'found'
    await this.resolveMode()
    const ok = await this.checkNow()
    if (!ok) return 'failed'
    return this.status.state === 'none' ? 'up-to-date' : 'found'
  }

  start(automatic: boolean): void {
    if (this.mode === 'off' || this.started) return
    this.started = true
    this.automatic = automatic
    this.log = new UpdateLog(path.join(app.getPath('userData'), 'logs', 'updates.log'))
    this.log.write(`started ${app.getVersion()} (${process.platform}, ${this.mode}, automatic checks ${automatic ? 'on' : 'off'})`)
    // The automatic checks start once we know how this copy updates (a moment on macOS, at once elsewhere).
    void this.resolveMode().then(() => this.setAutomatic(this.automatic))
  }

  /** Settles the mode. On macOS: auto only for a Developer ID signed app that Squirrel.Mac can replace where it is. */
  private resolveMode(): Promise<UpdateMode> {
    this.resolving ??= (async () => {
      if (process.platform === 'darwin' && this.mode !== 'off') {
        // The executable is Iskra.app/Contents/MacOS/Iskra.
        const bundlePath = path.resolve(app.getPath('exe'), '..', '..', '..')
        const signing = await readMacSigning(bundlePath)
        this.mode = updateMode(process.platform, app.isPackaged, process.env, { signing, bundlePath })
        console.log(`Updates: ${this.mode} (${signing} signed, ${bundlePath})`)
      }
      if (this.mode === 'auto') this.setUpAutoUpdater()
      return this.mode
    })()
    return this.resolving
  }

  /** Turns the automatic checks on or off (each one tells GitHub this computer's address and the app's version). */
  setAutomatic(on: boolean): void {
    this.automatic = on
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.mode === 'off' || !this.started || !this.resolving) return
    this.log?.write(`automatic checks ${on ? 'on' : 'off'} (${this.mode})`)
    if (!on) return
    const check = () => void (this.automatic && this.checkNow())
    setTimeout(check, FIRST_CHECK_MS).unref()
    this.timer = setInterval(check, CHECK_EVERY_MS)
    this.timer.unref()
  }

  /** The window came back to the front: check again if the last check is a while ago (and checks are on). */
  checkSoon(): void {
    if (this.mode === 'off' || !this.started || !this.automatic || !this.resolving) return
    if (Date.now() - this.lastCheck < RECHECK_ON_FOCUS_MS) return
    void this.checkNow()
  }

  private async checkNow(): Promise<boolean> {
    this.lastCheck = Date.now()
    this.heal()
    const ok = await (this.mode === 'auto' ? this.checkAuto() : this.checkManually())
    this.log?.write(`check ${ok ? 'done' : 'failed'}: ${this.describe()}`)
    return ok
  }

  /** A status that no longer means anything (a download that never finished, an update we already run) is dropped. */
  private heal(): void {
    const healed = healState(this.status, this.statusSince, Date.now(), app.getVersion())
    if (healed === this.status) return
    this.log?.write(`reset stuck state ${this.describe()}`)
    this.set(healed)
  }

  private describe(): string {
    return 'version' in this.status ? `${this.status.state} ${this.status.version}` : this.status.state
  }

  /** Restarts into a downloaded update. Returns false if there's nothing to install. */
  restart(beforeQuit: () => void): boolean {
    if (this.status.state !== 'ready') return false
    beforeQuit()
    // Not silent: on Windows the one-click installer shows its own small "Installing" window, then starts the new
    // version (runAfterFinish). The AppImage is swapped and started again either way; on macOS Squirrel.Mac swaps in
    // the already checked .app and starts it (the arguments don't apply there).
    autoUpdater.quitAndInstall(false, true)
    return true
  }

  private set(status: UpdateStatus): void {
    this.status = status
    this.statusSince = Date.now()
    this.onChange(status)
  }

  private setUpAutoUpdater(): void {
    if (this.autoUpdaterSetUp) return
    this.autoUpdaterSetUp = true
    autoUpdater.allowPrerelease = true // releases are prereleases during the alpha
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.logger = { info: () => undefined, warn: console.warn, error: console.error, debug: () => undefined }
    autoUpdater.on('update-available', (info) => {
      this.log?.write(`downloading ${info.version}`)
      this.set({ state: 'downloading', version: info.version })
    })
    autoUpdater.on('update-downloaded', (info) => {
      this.log?.write(`downloaded ${info.version}, ready to install`)
      this.set({ state: 'ready', version: info.version })
    })
    autoUpdater.on('error', (error) => {
      console.error('Update failed:', error)
      this.log?.write(`error: ${errorLine(error)}`)
      // A download or signature check failed (on macOS also: Squirrel.Mac rejected the update's signature or can't
      // write where the app is): fall back to pointing at the release page.
      if (this.status.state === 'downloading') this.set({ state: 'available', version: this.status.version, url: releaseUrl(this.status.version) })
    })
  }

  /** Returns false if the check itself failed. */
  private async checkAuto(): Promise<boolean> {
    if (this.status.state === 'ready' || this.status.state === 'downloading') return true
    try {
      // We pick the release (see autoFeed): the GitHub provider's own pick can be a tag whose release is a draft.
      const releases = await this.fetchReleases()
      if (!releases) return false
      const feed = autoFeed(releases, app.getVersion(), REPO)
      if (!feed) return true
      this.log?.write(`newer release ${feed.version} found, checking its files`)
      autoUpdater.setFeedURL({ provider: 'generic', url: feed.url })
      const result = await autoUpdater.checkForUpdates()
      // 'update-available' sets the status too; this covers a check that resolves first.
      const version = result?.updateInfo.version
      if (version && compareVersions(version, app.getVersion()) > 0 && this.status.state === 'none') this.set({ state: 'downloading', version })
      return true
    } catch (error) {
      console.error('Update check failed:', error)
      this.log?.write(`check error: ${errorLine(error)}`)
      return false
    }
  }

  /** The latest published releases (the API leaves drafts out), or null if GitHub didn't answer. */
  private async fetchReleases(): Promise<GitHubRelease[] | null> {
    const response = await net.fetch(`https://api.github.com/repos/${REPO}/releases?per_page=20`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': `Iskra/${app.getVersion()}` },
    })
    if (!response.ok) {
      this.log?.write(`releases list: HTTP ${response.status}`)
      return null
    }
    const releases = (await response.json()) as unknown
    return Array.isArray(releases) ? (releases as GitHubRelease[]) : null
  }

  private async checkManually(): Promise<boolean> {
    try {
      const releases = await this.fetchReleases()
      if (!releases) return false
      const newer = newerRelease(releases, app.getVersion())
      if (newer && (this.status.state !== 'available' || this.status.version !== newer.version)) this.set({ state: 'available', ...newer })
      return true
    } catch (error) {
      console.error('Update check failed:', error)
      this.log?.write(`check error: ${errorLine(error)}`)
      return false
    }
  }
}
