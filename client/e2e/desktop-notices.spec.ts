// The desktop shell's own messages show inside Iskra, as its toasts and dialogs in its language, never as native
// message boxes: the tray's "Check for updates" result, About (the app's About & legal page) and the macOS
// screen-recording permission (desktop/src/notices.ts, client/src/state/desktopNotices.ts).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect, test } from '@playwright/test'
import { DESKTOP_SKIP, desktopBuilt } from './desktopBuild'
import { agreeToTerms, appWindow, SHOTS } from './helpers'

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP = resolve(HERE, '../../desktop')
const built = desktopBuilt()
const DESKTOP_VERSION = (JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8')) as { version: string }).version
const ELECTRON_VERSION = (JSON.parse(readFileSync(join(DESKTOP, 'node_modules', 'electron', 'package.json'), 'utf8')) as { version: string }).version

/** The bits of Electron these checks use (Electron's types aren't part of the client project). */
type AppWin = { webContents: { getURL(): string; send(channel: string, ...args: unknown[]): void }; isVisible(): boolean; hide(): void }
type TestGlobals = { iskraTrayAction(action: string): Promise<void>; iskraUpdates: { check(): Promise<string> }; nativeBoxes: number }

test.skip(!built, DESKTOP_SKIP)

test('the tray’s "Check for updates" and About show inside the app, never as native boxes', async () => {
  test.setTimeout(120_000)
  const userData = mkdtempSync(join(tmpdir(), 'iskra-desktop-'))
  const hostRoot = mkdtempSync(join(tmpdir(), 'iskra-hosted-'))
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_OPTIONS')) as Record<string, string>
  const app = await electron.launch({
    executablePath: join(DESKTOP, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
    args: [DESKTOP, `--user-data-dir=${userData}`, '--lang=en-US'],
    cwd: DESKTOP,
    env: { ...env, ISKRA_E2E: '1', ISKRA_LOCAL_ONLY: '1', ISKRA_HOST_ROOT: hostRoot },
  })
  try {
    // Any native message box would be a regression: count them.
    await app.evaluate(({ dialog }) => {
      const g = globalThis as unknown as TestGlobals
      g.nativeBoxes = 0
      dialog.showMessageBox = (async () => {
        g.nativeBoxes++
        return { response: 0, checkboxChecked: false }
      }) as typeof dialog.showMessageBox
    })
    const page = await appWindow(app)
    const tray = (action: string) => app.evaluate((_electron, a) => (globalThis as unknown as TestGlobals).iskraTrayAction(a), action)
    const mainWindow = () => app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w: AppWin) => w.webContents.getURL().startsWith('app://'))!
      return { visible: win.isVisible() }
    })
    const send = (notice: object) =>
      app.evaluate(({ BrowserWindow }, n) => BrowserWindow.getAllWindows().find((w: AppWin) => w.webContents.getURL().startsWith('app://'))!.webContents.send('iskra:notice', n), notice)
    await agreeToTerms(page)
    await expect.poll(() => mainWindow().then((w) => w.visible)).toBe(true)

    // On the first run already (no settings page yet): a development build says updates are off, as a toast.
    await tray('check')
    const off = page.getByRole('status').filter({ hasText: 'Updates are off in this build' })
    await expect(off).toContainText("Development builds don't update themselves.")
    await off.getByRole('button', { name: 'Dismiss' }).click()
    await expect(off).toBeHidden()

    // Up to date (what an installed app usually hears; a development build never asks GitHub, so the check is stubbed).
    // Closed to the tray, the window comes back for it.
    await app.evaluate(() => {
      (globalThis as unknown as TestGlobals).iskraUpdates.check = async () => 'up-to-date'
    })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w: AppWin) => w.webContents.getURL().startsWith('app://'))!.hide())
    await expect.poll(() => mainWindow().then((w) => w.visible)).toBe(false)
    await tray('check')
    await expect.poll(() => mainWindow().then((w) => w.visible)).toBe(true)
    const upToDate = page.getByRole('status').filter({ hasText: "You're up to date" })
    await expect(upToDate).toContainText(`Iskra ${DESKTOP_VERSION} is the newest version.`)
    await page.screenshot({ path: join(SHOTS, 'desktop-update-toast.png'), animations: 'disabled' })
    // It goes by itself after a few seconds.
    await expect(upToDate).toBeHidden({ timeout: 15_000 })

    // About before signing in: a toast with the version and what the shell is built on.
    await tray('about')
    const aboutToast = page.getByRole('status').filter({ hasText: /^Iskra \d+\.\d+\.\d+/ })
    await expect(aboutToast).toContainText(`Electron ${ELECTRON_VERSION}`)
    await aboutToast.getByRole('button', { name: 'Dismiss' }).click()

    await page.getByRole('button', { name: /I’m new to Iskra/ }).click()
    await page.getByLabel('Your name').fill('Desk')
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByRole('button', { name: 'Create a server' })).toBeVisible()

    // About, signed in: the app's About & legal page, with everything the native box used to say.
    await tray('about')
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await expect(settings.getByRole('heading', { name: 'About & legal' })).toBeVisible()
    await expect(settings.getByText(`Desktop app: Electron ${ELECTRON_VERSION}`)).toBeVisible()
    await expect(settings.getByText('PolyForm Noncommercial License')).toBeVisible()
    await expect(settings.getByRole('link', { name: 'Website' })).toHaveAttribute('href', 'https://iskra.foo')
    await expect(settings.getByRole('link', { name: 'License', exact: true })).toHaveAttribute('href', 'https://iskra.foo/license')
    await expect(settings.getByRole('button', { name: 'Open source licenses' })).toBeVisible()
    await page.screenshot({ path: join(SHOTS, 'desktop-about.png'), animations: 'disabled' })
    await page.keyboard.press('Escape')
    await expect(settings).toBeHidden()

    // macOS asks for the Screen Recording permission: an in-app dialog, its buttons answered through the bridge.
    await send({ kind: 'screen-permission' })
    const permission = page.getByRole('dialog', { name: 'Allow Iskra to share your screen' })
    await expect(permission).toContainText('Screen & System Audio Recording')
    await expect(permission.getByRole('button', { name: 'Open System Settings' })).toBeVisible()
    await permission.getByRole('button', { name: 'Not now' }).click()
    await expect(permission).toBeHidden()

    // Nonsense from the shell shows nothing.
    await send({ kind: 'update-check', result: 'up-to-date', version: '<img src=x>' })
    await send({ kind: 'nope' })
    await page.waitForTimeout(300)
    await expect(page.locator('.update-toast')).toHaveCount(0)

    expect(await app.evaluate(() => (globalThis as unknown as TestGlobals).nativeBoxes)).toBe(0)
  } finally {
    await app.close()
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    rmSync(hostRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
