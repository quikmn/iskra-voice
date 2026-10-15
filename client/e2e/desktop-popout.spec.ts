// Pop-outs in the desktop app: the voice panel, a video and a text channel in small windows of their own, rendered by
// the main page (one connection, one call). Always on top and click-through, remembered size, pop back in, and they
// close with the call.
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { agreeToTerms, appWindow, hasLiveKit, SHOTS, startServer, type TestServer } from './helpers'

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP = resolve(HERE, '../../desktop')
const ELECTRON = join(DESKTOP, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const built = existsSync(join(DESKTOP, 'dist', 'main.js')) && existsSync(resolve(HERE, '../dist/popout.html'))

test.skip(!built, 'build desktop/ (npm run build) and the client (npm run build) first')
test.skip(!hasLiveKit(), 'needs .tools/livekit-server (see scripts/get-livekit.ps1)')

type Info = { name: string; kind: string; alwaysOnTop: boolean; clickThrough: boolean; bounds: { width: number; height: number } }
type Win = { webContents: { getURL(): string }; getTitle(): string; setSize(w: number, h: number): void }

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Popout Test', true)
})
test.afterAll(async () => server?.stop())

const popouts = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { iskraPopouts: () => Info[] }).iskraPopouts())

/** The pop-out window's page, once it has something in it. */
async function popoutPage(app: ElectronApplication, testId: string): Promise<Page> {
  const find = async () => {
    for (const p of app.windows()) {
      if (!p.url().endsWith('/popout.html')) continue
      if (await p.getByTestId(testId).count().catch(() => 0)) return p
    }
    return null
  }
  await expect.poll(find, { timeout: 15_000 }).not.toBeNull()
  return (await find())!
}

test('pop out the voice panel, a video and a channel; they remember, stay on top, and close with the call', async () => {
  test.setTimeout(150_000)
  const userData = mkdtempSync(join(tmpdir(), 'iskra-desktop-'))
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_OPTIONS')) as Record<string, string>
  const app = await electron.launch({
    executablePath: ELECTRON,
    args: [DESKTOP, `--user-data-dir=${userData}`, '--lang=en-US', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
    cwd: DESKTOP,
    env: { ...env, ISKRA_E2E: '1' },
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

    // ── A text channel in its own window: the same messages, and you can write from there.
    await page.getByRole('button', { name: 'Pop out channel' }).click()
    const chat = await popoutPage(app, 'popout-chat')
    await expect(page.getByRole('button', { name: 'Pop back in' })).toHaveAttribute('aria-pressed', 'true')
    // No scripts of its own: the main page renders into it.
    expect(await chat.evaluate(() => document.scripts.length)).toBe(0)
    await expect(chat.locator('.popout-title')).toHaveText('#general · Popout Test')
    await chat.getByPlaceholder('Message #general').fill('hello from the pop-out')
    await chat.getByPlaceholder('Message #general').press('Enter')
    await expect(page.locator('.message').filter({ hasText: 'hello from the pop-out' })).toBeVisible()
    await expect(chat.locator('.message').filter({ hasText: 'hello from the pop-out' })).toBeVisible()
    expect((await popouts(app)).map((p) => [p.kind, p.alwaysOnTop])).toEqual([['chat', false]])
    await chat.screenshot({ path: join(SHOTS, 'popout-chat.png') })

    // ── Voice: join a channel, pop out the panel.
    await page.getByRole('button', { name: 'Create voice channel' }).first().click()
    await page.getByRole('radio', { name: 'Voice' }).click()
    await page.getByLabel('Name').fill('lounge')
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await page.locator('.voice-channel', { hasText: 'lounge' }).getByRole('button').first().click()
    await expect(page.locator('.voice-status strong')).toHaveText('Voice connected', { timeout: 20_000 })
    await page.getByTestId('voice-popout').click()
    const voice = await popoutPage(app, 'popout-voice')
    await expect(voice.locator('.popout-title')).toHaveText('lounge')
    await expect(voice.locator('.popout-person-name')).toHaveText(['Desk'])
    await expect(page.getByTestId('voice-popout')).toHaveAttribute('aria-pressed', 'true')
    // Voice floats over other windows by default.
    await expect.poll(async () => (await popouts(app)).find((p) => p.kind === 'voice')?.alwaysOnTop).toBe(true)
    // Its buttons act on the one call: muting there mutes here.
    await voice.getByRole('button', { name: 'Mute', exact: true }).click()
    await expect(page.locator('.voice-bar').getByRole('button', { name: 'Unmute' })).toBeVisible()
    await voice.getByRole('button', { name: 'Unmute' }).click()
    await expect(page.locator('.voice-bar').getByRole('button', { name: 'Mute', exact: true })).toBeVisible()
    await voice.screenshot({ path: join(SHOTS, 'popout-voice.png') })

    // Always on top off, then click-through on and off again by its handle.
    await voice.getByRole('button', { name: 'Always on top' }).click()
    await expect(voice.getByRole('button', { name: 'Always on top' })).toHaveAttribute('aria-pressed', 'false')
    await expect.poll(async () => (await popouts(app)).find((p) => p.kind === 'voice')?.alwaysOnTop).toBe(false)
    await voice.getByRole('button', { name: 'Click-through', exact: true }).click()
    await expect.poll(async () => (await popouts(app)).find((p) => p.kind === 'voice')?.clickThrough).toBe(true)
    const handle = voice.getByRole('button', { name: /Click-through is on/ })
    await expect(handle).toBeVisible()
    await voice.screenshot({ path: join(SHOTS, 'popout-voice-click-through.png') })
    await handle.click()
    await expect.poll(async () => (await popouts(app)).find((p) => p.kind === 'voice')?.clickThrough).toBe(false)
    await expect(voice.getByRole('button', { name: 'Always on top' })).toBeVisible()

    // A size it remembers: resize, pop back in, pop out again.
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w: Win) => w.webContents.getURL().endsWith('/popout.html') && w.getTitle().startsWith('lounge'))
      win!.setSize(333, 444)
    })
    await page.waitForTimeout(800)
    await voice.getByRole('button', { name: 'Pop back in' }).click()
    await expect.poll(async () => (await popouts(app)).map((p) => p.kind)).toEqual(['chat'])
    await expect(page.getByTestId('voice-popout')).toHaveAttribute('aria-pressed', 'false')
    await page.getByTestId('voice-popout').click()
    await popoutPage(app, 'popout-voice')
    await expect.poll(async () => (await popouts(app)).find((p) => p.kind === 'voice')).toMatchObject({ alwaysOnTop: false, clickThrough: false, bounds: { width: 333, height: 444 } })

    // ── A video: your camera, popped out, playing the same track.
    await page.locator('.voice-bar').getByTitle('Open the call').click()
    await page.getByRole('button', { name: 'Turn camera on' }).click()
    const tile = page.locator('.video-tile').first()
    await expect(tile).toBeVisible({ timeout: 15_000 })
    await tile.hover()
    await tile.getByRole('button', { name: 'Pop out video' }).click()
    const stream = await popoutPage(app, 'popout-stream')
    await expect.poll(() => stream.evaluate(() => document.querySelector('video')?.videoWidth ?? 0), { timeout: 15_000 }).toBeGreaterThan(0)
    await expect.poll(async () => (await popouts(app)).find((p) => p.kind === 'stream')?.alwaysOnTop).toBe(true)
    await stream.screenshot({ path: join(SHOTS, 'popout-stream.png') })

    // ── Leaving the call closes the voice panel and the video; the channel stays.
    await page.locator('.voice-bar').getByRole('button', { name: 'Leave voice' }).click()
    await expect.poll(async () => (await popouts(app)).map((p) => p.kind)).toEqual(['chat'])
    await expect.poll(() => app.windows().filter((p) => p.url().endsWith('/popout.html')).length).toBe(1)

    // Pop back in from the main window too.
    await page.locator('.org-row', { has: page.locator('.channel-name', { hasText: /^general$/ }) }).locator('.channel-name').click()
    await expect(page.getByRole('heading', { name: 'general' })).toBeVisible()
    await page.getByRole('button', { name: 'Pop back in' }).click()
    await expect.poll(async () => (await popouts(app)).length).toBe(0)
    await expect.poll(() => app.windows().filter((p) => p.url().endsWith('/popout.html')).length).toBe(0)
  } finally {
    await app.close()
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
