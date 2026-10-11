// The real Electron app: app:// origin, the preload bridge, and joining a server from the desktop shell.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
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
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_OPTIONS')) as Record<string, string>
  const app = await electron.launch({
    executablePath: join(DESKTOP, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
    args: [DESKTOP, `--user-data-dir=${userData}`],
    cwd: DESKTOP,
    env: { ...env, ISKRA_E2E: '1' },
  })
  try {
    const page = await app.firstWindow()
    await expect(page.getByLabel('Your name')).toBeVisible()
    expect(page.url()).toMatch(/^app:\/\/iskra\//)

    // The preload bridge is there, and only that.
    const bridge = await page.evaluate(() => Object.keys((window as unknown as { iskraDesktop: object }).iskraDesktop).sort())
    expect(bridge).toEqual([
      'activity', 'attention', 'callAlert', 'capturePushToTalkKey', 'download', 'host', 'keychain', 'onActivity', 'onDeepLink', 'onPickScreen', 'onPushToTalk', 'openSystemSettings', 'pickScreen',
      'platform', 'pushToTalkStatus', 'setBadge', 'setPushToTalkKey', 'settings', 'takeDeepLink', 'updates',
    ])
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

    // Noise suppression: the RNNoise worklet and its WebAssembly load from app:// and start under the app's CSP.
    const assets = readdirSync(resolve(HERE, '../dist/assets'))
    const rnnoise = {
      worklet: assets.find((f) => /^workletProcessor-.*\.js$/.test(f) && readFileSync(resolve(HERE, '../dist/assets', f), 'utf8').includes('rnnoise')),
      wasm: assets.find((f) => /^rnnoise_simd-.*\.wasm$/.test(f)),
      gate: assets.find((f) => /^micGate\.worklet-.*\.js$/.test(f)),
    }
    expect(rnnoise.worklet && rnnoise.wasm && rnnoise.gate).toBeTruthy()
    const started = await page.evaluate(async ({ worklet, wasm, gate }) => {
      const ctx = new AudioContext({ sampleRate: 48000 })
      await ctx.audioWorklet.addModule(`/assets/${worklet}`)
      await ctx.audioWorklet.addModule(`/assets/${gate}`)
      const wasmBinary = await (await fetch(`/assets/${wasm}`)).arrayBuffer()
      const node = new AudioWorkletNode(ctx, '@sapphi-red/web-noise-suppressor/rnnoise', { processorOptions: { maxChannels: 1, wasmBinary } })
      const failed = await new Promise<boolean>((done) => {
        node.onprocessorerror = () => done(true)
        setTimeout(() => done(false), 500)
      })
      new AudioWorkletNode(ctx, 'iskra-mic-gate')
      await ctx.close()
      return !failed
    }, rnnoise)
    expect(started).toBe(true)

    // The tray menu: About, Check for updates (off in a development build), Quit.
    const trayLabels = () => app.evaluate(() =>
      ((globalThis as { iskraTrayMenu?: { label: string; action: string | null; enabled: boolean }[] }).iskraTrayMenu ?? [])
        .filter((i) => i.action).map((i) => `${i.label}${i.enabled ? '' : ' (off)'}`))
    expect(await trayLabels()).toEqual(['Open Iskra', 'About Iskra', 'Check for updates (off)', 'Quit Iskra'])

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
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Voice & audio' }).click()
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
    env: { ...env, ISKRA_HOST_ROOT: hostRoot, ISKRA_LOCAL_ONLY: "1" },
  })
  try {
    const page = await app.firstWindow()
    await page.getByLabel('Your name').fill('Host')
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('button', { name: 'Create a server' }).click()
    await page.getByLabel('Server name').fill('Living Room')
    await page.getByRole('button', { name: 'Create', exact: true }).click()

    await expect(page.getByRole('heading', { name: 'general' })).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.sidebar-header .server-name')).toHaveText('Living Room')
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

test('Desktop app settings, the unread badge, and iskra:// invite links', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'iskra-desktop-'))
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_OPTIONS')) as Record<string, string>
  const electronExe = join(DESKTOP, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
  const linkServer = await startServer('Desktop Links')
  const token = linkServer.ownerLink().split('/join/')[1]
  // Started by clicking an invite link: the app opens on that invite.
  const app = await electron.launch({ executablePath: electronExe, args: [DESKTOP, `--user-data-dir=${userData}`, `iskra://join/${token}`], cwd: DESKTOP, env })
  try {
    const page = await app.firstWindow()
    await expect(page.getByText("You've been invited")).toBeVisible()
    await page.getByLabel('Your name').fill('Linked')
    await page.getByRole('button', { name: 'Join' }).click()
    await expect(page.getByRole('heading', { name: 'general' })).toBeVisible()
    await expect(page.getByText('Open in the app')).toHaveCount(0) // that's only for browsers

    // A second launch with a link (another click) goes to the running app; only invites get through.
    const second = (link: string) => new Promise<void>((done) => {
      spawn(electronExe, [DESKTOP, `--user-data-dir=${userData}`, link], { cwd: DESKTOP, env, stdio: 'ignore' }).once('exit', () => done())
    })
    await second(`iskra://link/${token}`)
    await page.waitForTimeout(500)
    await expect(page.getByRole('dialog', { name: "You're invited" })).toHaveCount(0)
    await second(`iskra://join/${token}`)
    await expect(page.getByRole('dialog', { name: "You're invited" })).toBeVisible()
    await page.getByRole('button', { name: 'Not now' }).click()

    // The unread count reaches the taskbar (Windows: an overlay icon drawn by the page).
    const badge = await page.evaluate(async () => {
      const d = (window as unknown as { iskraDesktop: { setBadge(n: number, o: string | null): Promise<void> } }).iskraDesktop
      await d.setBadge(3, null)
      await d.setBadge(0, null)
      return 'ok'
    })
    expect(badge).toBe('ok')

    // Settings → Desktop app: off/on switches, kept by the app itself.
    await page.locator('.me-bar').getByRole('button', { name: 'Settings' }).click()
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await settings.getByRole('button', { name: 'Desktop app', exact: true }).click()
    await expect(settings.getByLabel(/Start Iskra with your computer/)).not.toBeChecked()
    await expect(settings.getByLabel(/Close button minimises to the tray/)).toBeChecked()
    await settings.getByLabel(/Close button minimises to the tray/).uncheck()
    await settings.getByLabel(/Hardware acceleration/).uncheck()
    await expect(settings.getByRole('button', { name: 'Restart now' })).toBeVisible()
    await page.screenshot({ path: join(SHOTS, 'desktop-settings-app.png') })
    await expect.poll(() => existsSync(join(userData, 'desktop.json')) && JSON.parse(readFileSync(join(userData, 'desktop.json'), 'utf8')))
      .toEqual({ openAtLogin: false, closeToTray: false, hardwareAcceleration: false, activity: false, customGames: [] })
    await settings.getByLabel(/Hardware acceleration/).check()
    await expect(settings.getByRole('button', { name: 'Restart now' })).toHaveCount(0)

    // Activity status: off by default. A program of your own (here: the app itself) shows as "Playing ...".
    await expect(settings.getByLabel(/Show the game you're playing/)).not.toBeChecked()
    await settings.getByLabel('Game name').fill('Test Game')
    await settings.getByLabel('Program file').fill(process.platform === 'win32' ? 'electron.exe' : 'electron')
    await settings.getByRole('button', { name: 'Add', exact: true }).click()
    await settings.getByLabel(/Show the game you're playing/).check()
    await expect(settings.getByText('Now: Playing Test Game')).toBeVisible()
    await page.screenshot({ path: join(SHOTS, 'desktop-activity-settings.png') })
    await page.keyboard.press('Escape')
    const meInList = page.locator('.member', { hasText: 'Linked' })
    await expect(meInList.locator('.activity-line')).toHaveText('Playing Test Game')
    // Only the game's name was stored, never the program list.
    const stored = JSON.parse(readFileSync(join(userData, 'desktop.json'), 'utf8'))
    expect(stored.activity).toBe(true)
    expect(Object.keys(stored).sort()).toEqual(['activity', 'closeToTray', 'customGames', 'hardwareAcceleration', 'openAtLogin'])
    // Turning it off clears it for everyone.
    await page.locator('.me-bar').getByRole('button', { name: 'Settings' }).click()
    await settings.getByRole('button', { name: 'Desktop app', exact: true }).click()
    await settings.getByLabel(/Show the game you're playing/).uncheck()
    await page.keyboard.press('Escape')
    await expect(meInList.locator('.activity-line')).toHaveCount(0)
  } finally {
    await app.close()
    await linkServer.stop()
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
