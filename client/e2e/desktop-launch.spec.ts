// The desktop app's splash window on start, "Updated to X" after an update, none when started hidden in the tray,
// and the "Updating Iskra to X…" overlay before restarting into an update (nothing is really installed here).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
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

async function launch(userData: string, extra: string[] = [], more: Record<string, string> = {}): Promise<ElectronApplication> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_OPTIONS')) as Record<string, string>
  return electron.launch({
    executablePath: ELECTRON,
    args: [DESKTOP, `--user-data-dir=${userData}`, '--lang=en-US', ...extra],
    cwd: DESKTOP,
    env: { ...env, ISKRA_E2E: '1', ISKRA_LOCAL_ONLY: '1', ISKRA_HOST_ROOT: join(userData, 'servers'), ...more },
  })
}

const freePort = () => new Promise<number>((done, fail) => {
  const probe = createServer().once('error', fail).listen(0, '127.0.0.1', () => {
    const { port } = probe.address() as { port: number }
    probe.close(() => done(port))
  })
})

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
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

// Quitting waits for hosted servers to stop, but only so long, and an error in a late callback meanwhile (a timer,
// a message for a window that's already closed) can't hold it up: Electron's modal error box would block the quit.
test('quitting with a hosted server still stopping finishes, even past a late error', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'iskra-launch-'))
  // A stand-in for iskra-server (run by this test's Node): answers like one on localhost, ignores the stop request
  // (stdin closing), so the app has to wait and then force-stop it.
  const world = join(userData, 'servers', 'slow')
  mkdirSync(world, { recursive: true })
  const port = await freePort()
  writeFileSync(join(world, 'server.json'), JSON.stringify({ Name: 'Slow', Port: port, LocalOnly: true, PublicUrl: `http://localhost:${port}`, Voice: { Enabled: false } }))
  writeFileSync(join(world, 'index.js'), [
    `require('fs').writeFileSync(require('path').join(__dirname, 'pid'), String(process.pid))`,
    `require('http').createServer((q, r) => r.end('{"name":"Slow"}')).listen(${port}, '127.0.0.1')`,
    `setTimeout(() => process.exit(0), 60000)`,
  ].join('\n'))
  const app = await launch(userData, [], { ISKRA_SERVER_EXE: process.execPath })
  try {
    await appWindow(app)
    await expect.poll(() => mainVisible(app)).toBe(true)
    await expect.poll(() => existsSync(join(world, 'pid'))).toBe(true)
    const pid = Number(readFileSync(join(world, 'pid'), 'utf8'))
    expect(alive(pid)).toBe(true)
    // Thrown while the app waits for the server, after its windows are gone.
    await app.evaluate(() => void setTimeout(() => { throw new Error('a late callback failed') }, 500))
    const started = Date.now()
    await app.close()
    expect(Date.now() - started).toBeLessThan(15_000)
    expect(alive(pid)).toBe(false) // force-stopped, not left running
  } finally {
    await app.close().catch(() => undefined)
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
