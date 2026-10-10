// Keeping the desktop app up to date from GitHub releases.
// Installer (Windows) and AppImage (Linux) builds download updates in the background and restart into them.
// Builds that can't replace themselves (portable, deb/rpm, unsigned macOS) just say a new version is out.
import { app, net } from 'electron'
import { autoUpdater } from 'electron-updater'
import { newerRelease, updateMode, type GitHubRelease } from './platform'

const REPO = 'quikmn/iskra-voice'
const FIRST_CHECK_MS = 15_000
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000

export type UpdateStatus =
  | { state: 'none' }
  | { state: 'downloading'; version: string }
  | { state: 'ready'; version: string }
  | { state: 'available'; version: string; url: string }

const releaseUrl = (version: string) => `https://github.com/${REPO}/releases/tag/v${version}`

export class Updates {
  private status: UpdateStatus = { state: 'none' }
  private readonly mode = updateMode(process.platform, app.isPackaged, process.env)
  private readonly onChange: (status: UpdateStatus) => void

  constructor(onChange: (status: UpdateStatus) => void) {
    this.onChange = onChange
  }

  current(): UpdateStatus {
    return this.status
  }

  start(): void {
    if (this.mode === 'off') return
    if (this.mode === 'auto') this.setUpAutoUpdater()
    const check = () => void (this.mode === 'auto' ? this.checkAuto() : this.checkManually())
    setTimeout(check, FIRST_CHECK_MS)
    setInterval(check, CHECK_EVERY_MS).unref()
  }

  /** Restarts into a downloaded update. Returns false if there's nothing to install. */
  restart(beforeQuit: () => void): boolean {
    if (this.status.state !== 'ready') return false
    beforeQuit()
    autoUpdater.quitAndInstall(true, true) // silent install, then start the new version
    return true
  }

  private set(status: UpdateStatus): void {
    this.status = status
    this.onChange(status)
  }

  private setUpAutoUpdater(): void {
    autoUpdater.allowPrerelease = true // releases are prereleases during the alpha
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.logger = { info: () => undefined, warn: console.warn, error: console.error, debug: () => undefined }
    autoUpdater.on('update-available', (info) => this.set({ state: 'downloading', version: info.version }))
    autoUpdater.on('update-downloaded', (info) => this.set({ state: 'ready', version: info.version }))
    autoUpdater.on('error', (error) => {
      console.error('Update failed:', error)
      // A download or signature check failed: fall back to pointing at the release page.
      if (this.status.state === 'downloading') this.set({ state: 'available', version: this.status.version, url: releaseUrl(this.status.version) })
    })
  }

  private async checkAuto(): Promise<void> {
    if (this.status.state === 'ready' || this.status.state === 'downloading') return
    try {
      await autoUpdater.checkForUpdates()
    } catch (error) {
      console.error('Update check failed:', error)
    }
  }

  private async checkManually(): Promise<void> {
    try {
      const response = await net.fetch(`https://api.github.com/repos/${REPO}/releases?per_page=20`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': `Iskra/${app.getVersion()}` },
      })
      if (!response.ok) return
      const releases = (await response.json()) as unknown
      if (!Array.isArray(releases)) return
      const newer = newerRelease(releases as GitHubRelease[], app.getVersion())
      if (newer && (this.status.state !== 'available' || this.status.version !== newer.version)) this.set({ state: 'available', ...newer })
    } catch (error) {
      console.error('Update check failed:', error)
    }
  }
}
