// Desktop-only settings, kept by the main process in userData/desktop.json (some apply before any window exists).
import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { autostartEntry, HIDDEN_FLAG, parseDesktopSettings, type DesktopSettings } from './platform'

const file = () => path.join(app.getPath('userData'), 'desktop.json')

/** Read synchronously at startup: hardware acceleration has to be decided before the app is ready. */
export function loadDesktopSettings(): DesktopSettings {
  try {
    return parseDesktopSettings(JSON.parse(readFileSync(file(), 'utf8')))
  } catch {
    return parseDesktopSettings(null)
  }
}

export function saveDesktopSettings(settings: DesktopSettings): void {
  const target = file()
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target + '.tmp', JSON.stringify(settings, null, 2))
  renameSync(target + '.tmp', target)
}

/** Starts Iskra (hidden in the tray) when you log in. Only installed builds register themselves. */
export function applyOpenAtLogin(on: boolean): void {
  if (!app.isPackaged) return
  if (process.platform === 'linux') {
    const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'autostart')
    const entry = path.join(dir, 'iskra.desktop')
    try {
      if (!on) {
        rmSync(entry, { force: true })
        return
      }
      mkdirSync(dir, { recursive: true })
      writeFileSync(entry, autostartEntry(process.env.APPIMAGE || process.execPath))
    } catch (error) {
      console.error('Autostart:', error)
    }
    return
  }
  app.setLoginItemSettings({ openAtLogin: on, args: [HIDDEN_FLAG] })
}

/** Whether this launch came from logging in (then the window stays in the tray). */
export function startedHidden(): boolean {
  if (process.argv.includes(HIDDEN_FLAG)) return true
  return process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin === true
}

