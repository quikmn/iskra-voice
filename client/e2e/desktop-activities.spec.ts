// Activities added to a server, in the desktop app: they run in the walled page view (the iskra-pages session), get
// their own files through the app, and talk to the app over the SDK's console bridge: ready → init, send → the
// server → back in as a message. Nothing else reaches the network from there (page-sandbox.spec.ts measures the wall).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect, test } from '@playwright/test'
import { DESKTOP_SKIP, desktopBuilt } from './desktopBuild'
import { agreeToTerms, appWindow, hasLiveKit, openServerSettings, SHOTS, startServer, type TestServer } from './helpers'
import { zip } from './zipFiles'

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP = resolve(HERE, '../../desktop')
const ELECTRON = join(DESKTOP, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const built = desktopBuilt(resolve(HERE, '../dist/activities/four.html'))

test.skip(!built, DESKTOP_SKIP)
test.skip(!hasLiveKit(), 'needs .tools/livekit-server (see scripts/get-livekit.ps1)')

type Guest = { getType(): string; getURL(): string; session: unknown; executeJavaScript(code: string): Promise<unknown> }

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Desk Games', true)
})
test.afterAll(async () => server?.stop())

/** An activity that says hello once it's ready, and lists every message it gets (with who sent it). */
const ECHO = zip({
  'manifest.json': JSON.stringify({ name: 'Echo', description: 'Says hello.', maxPlayers: 4 }),
  'index.html': '<!doctype html><html><body><p id="who"></p><ul id="log"></ul><script src="js/echo.js"></script></body></html>',
  'js/echo.js': `iskra.ready().then(function (init) {
  document.getElementById('who').textContent = 'me:' + init.me.name
  iskra.on('message', function (data, from) {
    var li = document.createElement('li')
    li.textContent = 'got:' + data.t + ':' + (from === iskra.me.id ? 'me' : 'other')
    document.getElementById('log').append(li)
  })
  iskra.send({ t: 'hello' })
})`,
})

test('an added activity runs walled off in the desktop app and talks over the bridge', async () => {
  test.setTimeout(150_000)
  const userData = mkdtempSync(join(tmpdir(), 'iskra-desktop-'))
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_OPTIONS')) as Record<string, string>
  const app = await electron.launch({
    executablePath: ELECTRON,
    args: [DESKTOP, `--user-data-dir=${userData}`, '--lang=en-US', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    cwd: DESKTOP,
    env: { ...env, ISKRA_E2E: '1', ISKRA_LOCAL_ONLY: '1' },
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

    // Add the activity.
    const settings = await openServerSettings(page, 'Activities')
    await settings.getByTestId('activity-upload').setInputFiles({ name: 'echo.zip', mimeType: 'application/zip', buffer: ECHO })
    await expect(settings.getByTestId('activity-settings-list')).toContainText('Echo')
    await page.keyboard.press('Escape')

    // Into a call, and start it: here it can run.
    await page.getByRole('button', { name: 'Create voice channel' }).first().click()
    await page.getByRole('radio', { name: 'Voice' }).click()
    await page.getByLabel('Name').fill('arcade')
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await page.locator('.voice-channel', { hasText: 'arcade' }).getByRole('button').first().click()
    await expect(page.locator('.voice-status strong')).toHaveText('Voice connected', { timeout: 20_000 })
    await page.getByTestId('activity-button').click()
    const launcher = page.getByRole('dialog', { name: 'Start an activity' })
    await expect(launcher.getByTestId('activity-desktop-only')).toHaveCount(0)
    await launcher.getByRole('button', { name: 'Start Echo' }).click()
    await expect(page.getByTestId('activity-panel').locator('webview.activity-frame')).toBeVisible()

    // The view is walled, loaded its script through the app, and its hello went round the server and back.
    const view = () => app.evaluate(async ({ session, webContents }) => {
      const guest = (webContents.getAllWebContents() as unknown as Guest[]).find((w) => w.getType() === 'webview' && w.getURL().includes('/activities/'))
      if (!guest) return null
      return {
        walled: guest.session === session.fromPartition('iskra-pages'),
        text: (await guest.executeJavaScript("document.body.innerText").catch(() => '')) as string,
      }
    })
    await expect.poll(async () => (await view())?.text ?? '', { timeout: 20_000 }).toContain('got:hello:me')
    const shown = (await view())!
    expect(shown.walled).toBe(true)
    expect(shown.text).toContain('me:Desk')
    await page.screenshot({ path: join(SHOTS, 'activities-desktop.png') })
  } finally {
    await app.close()
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
