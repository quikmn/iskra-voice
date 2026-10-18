// Whether the desktop specs can launch the app, checked when a spec file loads, before any electron.launch. A missing
// build file (say desktop/dist/entry.js after "main" moved, in a worktree with an older build) made Electron show a
// modal "Error launching app" box on Windows for every test; now the run stops at once with one message instead.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../..')
export const DESKTOP = join(REPO, 'desktop')
export const ELECTRON = join(DESKTOP, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
export const DESKTOP_SKIP = "no Electron here (desktop/: npm ci, then node node_modules/electron/install.js); CI's e2e job has none"

/** The files the app needs to start: desktop/package.json's "main" and the built web client. */
export function desktopBuildProblems(extra: string[] = [], exists: (path: string) => boolean = existsSync): string[] {
  const main = (JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8')) as { main: string }).main
  const needed = [join(DESKTOP, main), join(REPO, 'client', 'dist', 'index.html'), ...extra]
  return needed.filter((path) => !exists(path)).map((path) => relative(REPO, path).replaceAll('\\', '/'))
}

/**
 * true: launch away. false: no Electron on this machine (skip the spec with DESKTOP_SKIP). Throws when Electron is
 * there but the build isn't complete, so the run fails before anything starts.
 */
export function desktopBuilt(...extra: string[]): boolean {
  if (!existsSync(ELECTRON)) return false
  const missing = desktopBuildProblems(extra)
  if (missing.length) {
    throw new Error(`The desktop app isn't built: ${missing.join(', ')} missing. Run "npm run build" in desktop/ and in client/, then run the desktop specs again.`)
  }
  return true
}
