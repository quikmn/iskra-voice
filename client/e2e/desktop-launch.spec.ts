// The desktop app's splash window on start, "Updated to X" after an update, none when started hidden in the tray,
// and the "Updating Iskra to X…" overlay before restarting into an update (nothing is really installed here).
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { appWindow, SHOTS } from './helpers'
/** The bits of Electron's BrowserWindow these checks use (Electron's types aren't part of the client project). */type AppWin = { webContents: { getURL(): string; send(channel: string, ...args: unknown[]): void }; isVisible(): boolean }

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP = resolve(HERE, '../../desktop')
const ELECTRON = join(DESKTOP, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const SPLASH = join(DESKTOP, 'assets', 'splash.html')
const built = existsSync(join(DESKTOP, 'dist', 'main.js')) && existsSync(resolve(HERE, '../dist/index.html'))
const VERSION = (JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8')) as { version: string }).version

test.skip(!built, 'build desktop/ (npm run build) and the client (npm run build) first')

async function launch(userData: string, extra: string[] = []): Promise<ElectronApplication> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_OPTIONS')) as Record<string, string>
  return electron.launch({
    executablePath: ELECTRON,
    args: [DESKTOP, `--user-data-dir=${userData}`, '--lang=en-US', ...extra],
    cwd: DESKTOP,
    env: { ...env, ISKRA_E2E: '1', ISKRA_LOCAL_ONLY: '1', ISKRA_HOST_ROOT: join(userData, 'servers') },
  })
}

const launchLog = (app: ElectronApplication) => app.evaluate(() => (globalThis as { iskraLaunchLog?: string[] }).iskraLaunchLog ?? [])
const mainVisible = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w: AppWin) => w.webContents.getURL().startsWith('app://') && w.isVisible()))

test('the splash shows first, then fades into the app', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'iskra-launch-'))
  const app = await launch(userData)
  try {
    const page = await appWindow(app)
    await expect.poll(() => mainVisible(app)).toBe(true)
    await expect.poll(async () => (await launchLog(app)).filter((e) => !e.startsWith('splash view')))
      .toEqual(['splash shown', 'main shown', 'splash closed'])
    const log = await launchLog(app)
    // The first run: no "Updated to"; from starting to ready, left to right.
    expect(log[0]).toBe('splash view Iskra | Starting Iskra…')
    expect(log.filter((e) => e.startsWith('splash view')).at(-1)).toBe('splash view Iskra | Ready')
    expect(log.some((e) => e.includes('Updated to'))).toBe(false)
    expect(app.windows().filter((w) => w.url().startsWith('file:'))).toHaveLength(0)
    await expect(page.getByRole('button', { name: /I’m new to Iskra/ })).toBeVisible()
    // This version is remembered, for "Updated to X" next time.
    expect(JSON.parse(readFileSync(join(userData, 'desktop.json'), 'utf8')).lastRunVersion).toBe(VERSION)

    // "Restart to update": with nothing downloaded nothing happens; the overlay shows when the shell says it's quitting.
    expect(await page.evaluate(() => (window as unknown as { iskraDesktop: { updates: { restart(): Promise<boolean> } } }).iskraDesktop.updates.restart())).toBe(false)
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    const updating = (version: unknown) => app.evaluate(({ BrowserWindow }, v) =>
      BrowserWindow.getAllWindows().find((w: AppWin) => w.webContents.getURL().startsWith('app://'))!.webContents.send('iskra:updating', v), version)
    await updating('<b>nope</b>') // not a version: ignored
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await updating('9.9.9')
    const overlay = page.getByRole('alertdialog', { name: 'Updating Iskra to 9.9.9…' })
    await expect(overlay).toBeVisible()
    await expect(overlay).toContainText('It’ll be back in a few seconds.')
    await page.screenshot({ path: join(SHOTS, 'desktop-updating-overlay.png'), animations: 'disabled' })
    await updating(null) // it didn't quit after all
    await expect(overlay).toBeHidden()
  } finally {
    await app.close()
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

test('after an update the splash says "Updated to X"', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'iskra-launch-'))
  writeFileSync(join(userData, 'desktop.json'), JSON.stringify({ lastRunVersion: '1.0.0', language: 'en' }))
  const app = await launch(userData)
  try {
    await appWindow(app)
    await expect.poll(() => mainVisible(app)).toBe(true)
    await expect.poll(async () => (await launchLog(app)).includes('splash closed')).toBe(true)
    const views = (await launchLog(app)).filter((e) => e.startsWith('splash view'))
    expect(views[0]).toBe(`splash view Updated to ${VERSION} | Starting Iskra…`)
    expect(views.at(-1)).toBe(`splash view Updated to ${VERSION} | Ready`)
    expect(JSON.parse(readFileSync(join(userData, 'desktop.json'), 'utf8')).lastRunVersion).toBe(VERSION)
  } finally {
    await app.close()
  }
  // Only once: the next start is a plain one.
  const again = await launch(userData)
  try {
    await appWindow(again)
    await expect.poll(async () => (await launchLog(again)).includes('splash closed')).toBe(true)
    expect((await launchLog(again)).some((e) => e.includes('Updated to'))).toBe(false)
  } finally {
    await again.close()
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

test('started with the computer (hidden in the tray): no splash', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'iskra-launch-'))
  const app = await launch(userData, ['--hidden'])
  try {
    const page = await appWindow(app)
    await page.waitForLoadState('load')
    await page.waitForTimeout(1500)
    expect(await launchLog(app)).toEqual([])
    expect(await mainVisible(app)).toBe(false)
    expect(app.windows().filter((w) => w.url().startsWith('file:'))).toHaveLength(0)
  } finally {
    await app.close()
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

// Screenshots of the splash page itself, at its window size, in each state.
test('splash screenshots', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 250 })
  const shot = async (name: string, view: object) => {
    await page.goto('about:blank')
    await page.goto(`${pathToFileURL(SPLASH).href}#${encodeURIComponent(JSON.stringify(view))}`)
    await expect(page.getByRole('status')).toHaveText((view as { status: string }).status)
    await page.screenshot({ path: join(SHOTS, name), animations: 'disabled' })
  }
  await shot('desktop-splash.png', { heading: 'Iskra', status: 'Starting your servers…', progress: 0.54, lang: 'en' })
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '54')
  await shot('desktop-splash-updated.png', { heading: `Updated to ${VERSION}`, status: 'Connecting…', progress: 0.85, lang: 'en' })
  await shot('desktop-splash-updating.png', { heading: 'Updating Iskra to 9.9.9…', status: 'It’ll be back in a few seconds.', progress: null, lang: 'en' })
  await expect(page.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow', /.*/)
  expect(await page.title()).toBe('Updating Iskra to 9.9.9…')
})
