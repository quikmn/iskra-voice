// The real Electron app: app:// origin, the preload bridge, and joining a server from the desktop shell.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect, test } from '@playwright/test'
import { SHOTS, startServer, type TestServer } from './helpers'

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP = resolve(HERE, '../../desktop')
const built = existsSync(join(DESKTOP, 'dist', 'main.js')) && existsSync(resolve(HERE, '../dist/index.html'))

test.skip(!built, 'build desktop/ (npm run build) and the client (npm run build) first')

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
    expect(bridge).toEqual(['callAlert', 'capturePushToTalkKey', 'host', 'onPickScreen', 'onPushToTalk', 'openSystemSettings', 'pickScreen', 'platform', 'pushToTalkStatus', 'setPushToTalkKey', 'updates'])
    expect(await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require)).toBe('undefined')

    // Calls: LiveKit's end-to-end encryption worker loads from app:// under the app's CSP, and frames can be transformed.
    const worker = readdirSync(resolve(HERE, '../dist/assets')).find((f) => /^livekit-client\.e2ee\.worker-.*\.js$/.test(f) &&
      readFileSync(resolve(HERE, '../dist/assets', f)).length > 10_000)
    expect(worker).toBeTruthy()
    const ack = await page.evaluate((url) => new Promise<string>((done) => {
      const w = new Worker(url)
      w.onmessage = (e: MessageEvent<{ kind: string }>) => done(e.data.kind)
      w.onerror = () => done('error')
      w.postMessage({ kind: 'init', data: { keyProviderOptions: { sharedKey: true, ratchetSalt: 'iskra', ratchetWindowSize: 0, failureTolerance: -1, keyringSize: 16 }, loglevel: 'warn' } })
    }), `/assets/${worker}`)
    expect(ack).toBe('initAck')
    expect(await page.evaluate(() => 'RTCRtpScriptTransform' in window || 'createEncodedStreams' in RTCRtpSender.prototype)).toBe(true)

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

    // The shell's update notices show as a toast: restart when downloaded, a download link otherwise.
    const send = (status: object) =>
      app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].webContents.send('iskra:update', s), status)
    await send({ state: 'ready', version: '9.9.9' })
    const toast = page.getByRole('status').filter({ hasText: 'Update ready' })
    await expect(toast).toContainText('Iskra 9.9.9 is downloaded')
    await expect(toast.getByRole('button', { name: 'Restart' })).toBeVisible()
    await page.screenshot({ path: join(SHOTS, 'desktop-update.png'), animations: 'disabled' })
    await toast.getByRole('button', { name: 'Later' }).click()
    await expect(toast).toBeHidden()
    await send({ state: 'available', version: '9.9.10', url: 'https://github.com/quikmn/iskra-voice/releases/tag/v9.9.10' })
    await expect(page.getByRole('link', { name: 'Download' })).toHaveAttribute('href', /releases\/tag\/v9\.9\.10$/)
    await send({ state: 'available', version: '9.9.11', url: 'https://example.com/x.exe' }) // not a release page: ignored
    await expect(page.getByText('New version available')).toBeHidden()

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
    const logText = existsSync(log) ? readFileSync(log, 'utf8') : ''
    console.log(`--- hosted server.log ---\n${logText.slice(-3000)}`)
    rmSync(hostRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    // Quitting the app stops the server cleanly (so it can remove router port mappings), not with a kill.
    expect(logText).toContain('asked it to stop; shutting down')
  }
})
