// The real Electron app: app:// origin, the preload bridge, and joining a server from the desktop shell.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { _electron as electron, expect, test } from '@playwright/test'
import { agreeToTerms, SHOTS, startServer, type TestServer } from './helpers'

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
    args: [DESKTOP, `--user-data-dir=${userData}`, '--lang=en-US'],
    cwd: DESKTOP,
    env: { ...env, ISKRA_E2E: '1' },
  })
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('button', { name: /I’m new to Iskra/ })).toBeVisible()
    expect(page.url()).toMatch(/^app:\/\/iskra\//)

    // The preload bridge is there, and only that.
    const bridge = await page.evaluate(() => Object.keys((window as unknown as { iskraDesktop: object }).iskraDesktop).sort())
    expect(bridge).toEqual([
      'activity', 'attention', 'callAlert', 'cancelHotkeyCapture', 'captureHotkey', 'capturePushToTalkKey', 'download', 'host', 'keychain', 'onActivity', 'onDeepLink',
      'onHotkey', 'onPickScreen', 'onPushToTalk', 'openSystemSettings', 'pickScreen', 'platform', 'pushToTalkStatus', 'setBadge', 'setHotkeys', 'setLanguage', 'setPushToTalkKey', 'settings',
      'takeDeepLink', 'updates',
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

    // AI noise removal and voice activity: DeepFilterNet3 (WebAssembly and model) and Silero VAD load from app:// and
    // start in their worklets under the app's CSP.
    const ai = {
      worklet: assets.find((f) => /^deepfilter\.worklet-.*\.js$/.test(f)),
      wasm: assets.find((f) => /^deepfilter-.*\.wasm$/.test(f)),
      model: assets.find((f) => /^DeepFilterNet3_onnx.*\.bin$/.test(f)),
      silero: assets.find((f) => /^silero_vad_16k_op15-.*\.onnx$/.test(f)),
      gate: rnnoise.gate,
    }
    expect(ai.worklet && ai.wasm && ai.model && ai.silero).toBeTruthy()
    const aiStarted = await page.evaluate(async ({ worklet, wasm, model, silero, gate }) => {
      const ctx = new AudioContext({ sampleRate: 48000 })
      await ctx.audioWorklet.addModule(`/assets/${worklet}`)
      await ctx.audioWorklet.addModule(`/assets/${gate}`)
      const [w, m, s] = await Promise.all([wasm, model, silero].map(async (f) => (await fetch(`/assets/${f}`)).arrayBuffer()))
      const reply = (node: AudioWorkletNode) => new Promise<string>((done) => {
        node.port.onmessage = (e: MessageEvent<{ type?: string }>) => e.data?.type && done(e.data.type)
        setTimeout(() => done('timeout'), 20_000)
      })
      const df = new AudioWorkletNode(ctx, 'iskra-deepfilter', { outputChannelCount: [1] })
      const dfReady = reply(df)
      df.port.postMessage({ wasm: w, model: m })
      const vad = new AudioWorkletNode(ctx, 'iskra-mic-gate')
      const vadReady = reply(vad)
      vad.port.postMessage({ type: 'vad-model', model: s })
      const result = `${await dfReady} ${await vadReady}`
      await ctx.close()
      return result
    }, ai)
    expect(aiStarted).toBe('ready vad-ready')

    // The tray menu: About, Check for updates (off in a development build), Quit.
    const trayLabels = () => app.evaluate(() =>
      ((globalThis as { iskraTrayMenu?: { label: string; action: string | null; enabled: boolean }[] }).iskraTrayMenu ?? [])
        .filter((i) => i.action).map((i) => `${i.label}${i.enabled ? '' : ' (off)'}`))
    expect(await trayLabels()).toEqual(['Open Iskra', 'About Iskra', 'Check for updates (off)', 'Quit Iskra'])

    await agreeToTerms(page)

    await page.getByRole('button', { name: /I’m new to Iskra/ }).click()
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
    await expect(page.getByText('Works everywhere, even while a game has focus').first()).toBeVisible()
    await page.screenshot({ path: join(SHOTS, 'desktop-settings.png') })

    // Mute/deafen keybinds are global here. The page only ever hears an action's name from the shell.
    await expect(page.getByRole('heading', { name: 'Keybinds' })).toBeVisible()
    await expect(page.getByText("Plain keys don't fire while you're typing in Iskra")).toBeVisible()
    await expect(page.getByText('use the desktop app')).toHaveCount(0)
    await page.evaluate(() => {
      const d = (window as unknown as { iskraDesktop: { onHotkey(cb: (a: string) => void): () => void } }).iskraDesktop
      const w = window as unknown as { heard: string[] }
      w.heard = []
      d.onHotkey((a) => w.heard.push(a))
    })
    await app.evaluate(({ BrowserWindow }) => {
      for (const action of ['mute', 'KeyA', 'deafen', 42]) BrowserWindow.getAllWindows()[0].webContents.send('iskra:hotkey', action)
    })
    await expect.poll(() => page.evaluate(() => (window as unknown as { heard: string[] }).heard)).toEqual(['mute', 'deafen'])
    // "Set key" listens to the global hook; Cancel ends it with nothing.
    const muteRow = page.locator('.hotkey-row', { hasText: 'Toggle mute' })
    await page.getByRole('button', { name: 'Set toggle mute key' }).click()
    await expect(muteRow.locator('.key-chip')).toHaveText('Press a key…')
    await muteRow.getByRole('button', { name: 'Cancel' }).click()
    await expect(muteRow.locator('.key-chip')).toHaveText('Not set')
    // Real keys through the OS hook (Windows): Ctrl+F24 as the mute key. No keyboard has F23/F24, so tapping them touches nothing else.
    if (process.platform === 'win32') {
      const tap = (key: 'F23' | 'F24', ctrl: boolean) => app.evaluate((_electron, { dir, key, ctrl }) => {
        const { createRequire } = process.getBuiltinModule('node:module')
        const { uIOhook, UiohookKey } = createRequire(`${dir}/package.json`)('uiohook-napi')
        uIOhook.keyTap(UiohookKey[key], ctrl ? [UiohookKey.Ctrl] : [])
      }, { dir: DESKTOP, key, ctrl })
      await page.getByRole('button', { name: 'Set toggle mute key' }).click()
      await expect(muteRow.locator('.key-chip')).toHaveText('Press a key…')
      await tap('F24', true)
      await expect(muteRow.locator('.key-chip')).toHaveText('Ctrl + F24')
      await page.evaluate(() => ((window as unknown as { heard: string[] }).heard = []))
      await tap('F23', true) // not a hotkey: never reported
      await tap('F24', false) // without Ctrl: not it either
      await tap('F24', true)
      await expect.poll(() => page.evaluate(() => (window as unknown as { heard: string[] }).heard)).toEqual(['mute'])
      await muteRow.getByRole('button', { name: 'Clear toggle mute key' }).click()
      await expect(muteRow.locator('.key-chip')).toHaveText('Not set')
    }
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
    args: [DESKTOP, `--user-data-dir=${userData}`, '--lang=en-US'],
    cwd: DESKTOP,
    env: { ...env, ISKRA_HOST_ROOT: hostRoot, ISKRA_LOCAL_ONLY: "1" },
  })
  try {
    const page = await app.firstWindow()
    await agreeToTerms(page)
    await page.getByRole('button', { name: /I’m new to Iskra/ }).click()
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
  const app = await electron.launch({ executablePath: electronExe, args: [DESKTOP, `--user-data-dir=${userData}`, '--lang=en-US', `iskra://join/${token}`], cwd: DESKTOP, env })
  try {
    const page = await app.firstWindow()
    await expect(page.getByText("You've been invited")).toBeVisible()
    await agreeToTerms(page)
    await page.getByRole('button', { name: /I’m new to Iskra/ }).click()
    await page.getByLabel('Your name').fill('Linked')
    await page.getByRole('button', { name: 'Join' }).click()
    await expect(page.getByRole('heading', { name: 'general' })).toBeVisible()
    await expect(page.getByText('Open in the app')).toHaveCount(0) // that's only for browsers

    // A second launch with a link (another click) goes to the running app; only invites get through.
    const second = (link: string) => new Promise<void>((done) => {
      spawn(electronExe, [DESKTOP, `--user-data-dir=${userData}`, '--lang=en-US', link], { cwd: DESKTOP, env, stdio: 'ignore' }).once('exit', () => done())
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
      .toEqual({ openAtLogin: false, closeToTray: false, hardwareAcceleration: false, activity: false, customGames: [], language: 'en' })
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
    expect(Object.keys(stored).sort()).toEqual(['activity', 'closeToTray', 'customGames', 'hardwareAcceleration', 'language', 'openAtLogin'])
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

test('restoring a server from a backup in the desktop app', async () => {
  test.setTimeout(240_000)
  const userData = mkdtempSync(join(tmpdir(), 'iskra-desktop-'))
  const hostRoot = mkdtempSync(join(tmpdir(), 'iskra-hosted-'))
  const saved = join(mkdtempSync(join(tmpdir(), 'iskra-desktop-backup-')), 'moving.iskrabackup')
  const original = await startServer('Moving House')
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_OPTIONS')) as Record<string, string>
  const app = await electron.launch({
    executablePath: join(DESKTOP, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
    args: [DESKTOP, `--user-data-dir=${userData}`, '--lang=en-US'],
    cwd: DESKTOP,
    env: { ...env, ISKRA_HOST_ROOT: hostRoot, ISKRA_LOCAL_ONLY: '1' },
  })
  try {
    // Native dialogs can't be clicked by a test: "Save as" and "Open" answer with our temp file.
    await app.evaluate(({ dialog, session }, file) => {
      session.defaultSession.on('will-download', (_e: unknown, item: { setSavePath(path: string): void }) => item.setSavePath(file))
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as typeof dialog.showOpenDialog
    }, saved)
    const page = await app.firstWindow()
    await agreeToTerms(page)
    await page.getByRole('button', { name: /I’m new to Iskra/ }).click()
    await page.getByLabel('Your name').fill('Host')
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('button', { name: 'I have an invite link' }).click()
    await page.getByLabel('Invite link').fill(original.ownerLink())
    await page.getByRole('button', { name: 'Join', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'general' })).toBeVisible()
    await page.getByPlaceholder('Message #general').fill('packed and ready')
    await page.getByPlaceholder('Message #general').press('Enter')
    await expect(page.locator('.message', { hasText: 'packed and ready' })).toBeVisible()

    // Back it up from Settings; the app saves the file.
    await page.locator('.me-bar').getByRole('button', { name: 'Settings' }).click()
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await settings.getByRole('button', { name: 'Backup & move', exact: true }).click()
    await settings.getByLabel('Passphrase', { exact: true }).fill('correct horse battery staple')
    await settings.getByLabel('Passphrase again').fill('correct horse battery staple')
    await settings.getByRole('button', { name: 'Make backup' }).click()
    await expect(settings.getByText(/Backup ready/)).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => existsSync(saved) && readFileSync(saved).subarray(0, 8).toString(), { timeout: 15_000 }).toBe('ISKRABK1')
    await page.keyboard.press('Escape')

    // Restore it on "this computer": a new server folder, its own port, localhost only, same server key.
    await page.getByRole('button', { name: 'Join a server' }).click()
    await page.getByRole('button', { name: 'start your own server' }).click()
    await page.getByRole('button', { name: 'Restore from a backup' }).click()
    const restore = page.getByRole('dialog', { name: 'Restore a server from backup' })
    await restore.getByRole('button', { name: 'Choose backup file…' }).click()
    await expect(restore.getByText('Moving House')).toBeVisible()
    await restore.getByLabel('Passphrase').fill('wrong passphrase')
    await restore.getByRole('button', { name: 'Restore', exact: true }).click()
    await expect(restore.getByText(/Wrong passphrase/)).toBeVisible({ timeout: 30_000 })
    await page.screenshot({ path: join(SHOTS, 'desktop-restore.png') })
    await restore.getByLabel('Passphrase').fill('correct horse battery staple')
    await restore.getByRole('button', { name: 'Restore', exact: true }).click()
    await expect(restore).toBeHidden({ timeout: 60_000 })

    const folder = join(hostRoot, 'moving-house')
    const json = JSON.parse(readFileSync(join(folder, 'server.json'), 'utf8')) as { Port: number; LocalOnly: boolean; PublicUrl: string }
    expect(json.LocalOnly).toBe(true)
    expect(json.PublicUrl).toBe(`http://localhost:${json.Port}`)
    expect(`http://localhost:${json.Port}`).not.toBe(original.url)
    // The saved server now points at the restored copy, with everything it had; you're still its owner.
    await original.stop()
    await expect(page.locator('.message', { hasText: 'packed and ready' })).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.me-text')).toContainText('owner')
    await page.getByPlaceholder('Message #general').fill('unpacked')
    await page.getByPlaceholder('Message #general').press('Enter')
    await expect(page.locator('.message:not(.sending):not(.failed)', { hasText: 'unpacked' })).toBeVisible({ timeout: 15_000 })
    await page.screenshot({ path: join(SHOTS, 'desktop-restored.png') })
  } finally {
    await app.close()
    await original.stop()
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    rmSync(dirname(saved), { recursive: true, force: true })
    rmSync(hostRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  }
})
