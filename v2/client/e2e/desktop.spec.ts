// The real Electron app: app:// origin, the preload bridge, and joining a server from the desktop shell.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect, test } from '@playwright/test'
import { SHOTS, startServer, type TestServer } from './helpers'

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP = resolve(HERE, '../../desktop')
const built = existsSync(join(DESKTOP, 'dist', 'main.js')) && existsSync(resolve(HERE, '../dist/index.html'))

test.skip(!built, 'build v2/desktop (npm run build) and the client (npm run build) first')

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Desktop Test')
})
test.afterAll(async () => server?.stop())

test('the desktop app runs the web app on app:// and can join a server', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'iskra-desktop-'))
  const app = await electron.launch({
    executablePath: join(DESKTOP, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
    args: [DESKTOP, `--user-data-dir=${userData}`],
    cwd: DESKTOP,
  })
  try {
    const page = await app.firstWindow()
    await expect(page.getByLabel('Your name')).toBeVisible()
    expect(page.url()).toMatch(/^app:\/\/iskra\//)

    // The preload bridge is there, and only that.
    const bridge = await page.evaluate(() => Object.keys((window as unknown as { iskraDesktop: object }).iskraDesktop).sort())
    expect(bridge).toEqual(['capturePushToTalkKey', 'host', 'onPickScreen', 'onPushToTalk', 'pickScreen', 'platform', 'setPushToTalkKey'])
    expect(await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require)).toBe('undefined')

    await page.getByLabel('Your name').fill('Desk')
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('button', { name: 'I have an invite link' }).click()
    await page.getByLabel('Invite link').fill(server.ownerLink())
    await page.getByRole('button', { name: 'Join', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'general' })).toBeVisible()

    // Invite links made in the desktop app point at the web app, not app://.
    await page.getByRole('button', { name: 'Invite friends' }).click()
    await expect(page.locator('.copy-row input')).toHaveValue(/^http:\/\/localhost:\d+\/#\/join\//)
    await page.keyboard.press('Escape')

    // Push-to-talk settings are available.
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('radio', { name: 'Push to talk' }).click()
    await expect(page.getByText('Works everywhere, even while a game has focus')).toBeVisible()
    await page.screenshot({ path: join(SHOTS, 'desktop-settings.png') })
  } finally {
    await app.close()
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

test('creating a server from the desktop app makes you its owner', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'iskra-desktop-'))
  const hostRoot = mkdtempSync(join(tmpdir(), 'iskra-hosted-'))
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_OPTIONS')) as Record<string, string>
  const app = await electron.launch({
    executablePath: join(DESKTOP, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
    args: [DESKTOP, `--user-data-dir=${userData}`],
    cwd: DESKTOP,
    env: { ...env, ISKRA_HOST_ROOT: hostRoot },
  })
  try {
    const page = await app.firstWindow()
    await page.getByLabel('Your name').fill('Host')
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('button', { name: 'Create a server' }).click()
    await page.getByLabel('Server name').fill('Living Room')
    await page.getByRole('button', { name: 'Create', exact: true }).click()

    await expect(page.getByRole('heading', { name: 'general' })).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.sidebar-header h2')).toHaveText('Living Room')
    await expect(page.locator('.me-text')).toContainText('owner')
    expect(existsSync(join(hostRoot, 'living-room', 'server.json'))).toBe(true)
    expect(existsSync(join(hostRoot, 'living-room', 'owner-invite.txt'))).toBe(false) // used up
    await page.screenshot({ path: join(SHOTS, 'desktop-hosted.png') })
  } finally {
    await app.close()
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    const log = join(hostRoot, 'living-room', 'server.log')
    if (existsSync(log)) console.log(`--- hosted server.log ---\n${readFileSync(log, 'utf8').slice(-3000)}`)
    rmSync(hostRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  }
})
