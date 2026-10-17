// Streamer mode in the desktop app: "turn on by itself while a program from my list runs". The list is the user's own
// program list (activity settings); the test adds the program it is itself running under, so the detector finds it.
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect, test } from '@playwright/test'
import { agreeToTerms, appWindow, openSettings, SHOTS, startServer, type TestServer } from './helpers'

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP = resolve(HERE, '../../desktop')
const ELECTRON = join(DESKTOP, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const built = existsSync(join(DESKTOP, 'dist', 'main.js')) && existsSync(resolve(HERE, '../dist/index.html'))

test.skip(!built, 'build desktop/ (npm run build) and the client (npm run build) first')

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Streamer Desk')
})
test.afterAll(async () => server?.stop())

test('the desktop app turns streamer mode on while a listed program runs, and off again', async () => {
  test.setTimeout(150_000)
  const userData = mkdtempSync(join(tmpdir(), 'iskra-desktop-'))
  const hostRoot = mkdtempSync(join(tmpdir(), 'iskra-host-'))
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_OPTIONS')) as Record<string, string>
  const app = await electron.launch({
    executablePath: ELECTRON,
    args: [DESKTOP, `--user-data-dir=${userData}`, '--lang=en-US'],
    cwd: DESKTOP,
    env: { ...env, ISKRA_E2E: '1', ISKRA_LOCAL_ONLY: '1', ISKRA_HOST_ROOT: hostRoot },
  })
  try {
    const page = await appWindow(app)
    await agreeToTerms(page)
    await page.getByRole('button', { name: /I’m new to Iskra/ }).click()
    await page.getByLabel('Your name').fill('Desk')
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('button', { name: 'I have an invite link' }).click()
    await page.getByLabel('Invite link').fill(server.ownerLink())
    await page.getByRole('button', { name: 'Join', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'general' })).toBeVisible()
    await expect(page.getByTestId('streamer-pill')).toHaveCount(0)

    // Desktop app settings: add "my streaming program" (the program this very app runs as), then turn auto on.
    await openSettings(page, 'Desktop app')
    const program = process.platform === 'win32' ? 'electron.exe' : 'electron'
    await page.getByLabel('Game name').fill('My Streamer')
    await page.getByLabel('Program file').fill(program)
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(page.locator('.custom-games')).toContainText('My Streamer')
    await page.getByTestId('streamer-auto').check()
    await page.screenshot({ path: join(SHOTS, 'streamer-desktop-settings.png') })
    await page.keyboard.press('Escape')
    // The detector lists programs right away (and every 30 s): the pill comes up by itself.
    await expect(page.getByTestId('streamer-pill')).toBeVisible({ timeout: 45_000 })
    await expect(page.getByTestId('streamer-pill')).toHaveText('Streamer mode')

    // The status menu says why, and leads to the settings instead of switching it off.
    await page.locator('.me-status-button').first().click()
    await expect(page.getByTestId('streamer-toggle')).toContainText('On while your streaming program runs')
    await page.keyboard.press('Escape')

    // Auto off: the pill goes (the manual switch was never on).
    await openSettings(page, 'Desktop app')
    await page.getByTestId('streamer-auto').uncheck()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('streamer-pill')).toHaveCount(0, { timeout: 15_000 })
  } finally {
    await app.close()
  }
})
