// The whole "Discord is down, let's talk" path, timed: a fresh desktop app → Create a server → the setup wizard with
// the Gaming template → the channels are there → invite a friend (in a browser) → both talk in voice.
// Localhost only (ISKRA_LOCAL_ONLY=1): nothing here listens on the network, and no router is ever asked.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { APP_PORT } from '../playwright.config'
import { appWindow, agreeToTerms, hasLiveKit, joinVia, SHOTS } from './helpers'

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP = resolve(HERE, '../../desktop')
const built = existsSync(join(DESKTOP, 'dist', 'main.js')) && existsSync(resolve(HERE, '../dist/index.html'))

test.skip(!built, 'build desktop/ (npm run build) and the client (npm run build) first')
test.skip(!hasLiveKit(), 'needs .tools/livekit-server (see scripts/get-livekit.ps1)')

test('from a fresh install to friends talking in voice, timed', async ({ browser }) => {
  test.setTimeout(180_000)
  const userData = mkdtempSync(join(tmpdir(), 'iskra-walkthrough-'))
  const hostRoot = mkdtempSync(join(tmpdir(), 'iskra-walkthrough-hosted-'))
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_OPTIONS')) as Record<string, string>
  const timings: [string, number][] = []
  const started = Date.now()
  let last = started
  const lap = (what: string) => {
    const now = Date.now()
    timings.push([what, now - last])
    last = now
  }
  const shot = (page: Page, name: string) => page.screenshot({ path: join(SHOTS, `walkthrough-${name}.png`), animations: 'disabled' })

  const app = await electron.launch({
    executablePath: join(DESKTOP, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
    args: [DESKTOP, `--user-data-dir=${userData}`, '--lang=en-US', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    cwd: DESKTOP,
    env: { ...env, ISKRA_HOST_ROOT: hostRoot, ISKRA_LOCAL_ONLY: '1' },
  })
  try {
    // 1. First start: who are you?
    const host = await appWindow(app)
    await agreeToTerms(host)
    await shot(host, '1-welcome')
    await host.getByRole('button', { name: /I’m new to Iskra/ }).click()
    await host.getByLabel('Your name').fill('Ada')
    await host.getByRole('button', { name: 'Continue' }).click()
    lap('profile')

    // 2. Create a server: a name…
    await host.getByRole('button', { name: 'Create a server' }).click()
    const wizard = host.getByRole('dialog', { name: 'Create a server' })
    await wizard.getByLabel('Server name').fill('Game Night')
    await shot(host, '2-name')
    await wizard.getByRole('button', { name: 'Next' }).click()

    // …a starting point (the cards come from the bundled server's templates)…
    await expect(wizard.getByRole('radiogroup', { name: 'Starter templates' })).toBeVisible()
    await expect(wizard.getByRole('radio')).toHaveCount(4)
    const gaming = wizard.locator('[data-template="gaming"]')
    await expect(gaming).toContainText('Gaming group')
    await expect(gaming).toContainText('Squad 1')
    await gaming.click()
    await expect(gaming).toHaveAttribute('aria-checked', 'true')
    await shot(host, '3-template')
    await wizard.getByRole('button', { name: 'Create', exact: true }).click()
    lap('wizard')

    // …and it's running.
    await expect(wizard.getByRole('heading', { name: 'Game Night is ready' })).toBeVisible({ timeout: 45_000 })
    const invite = wizard.getByRole('button', { name: 'Invite friends' })
    await expect(invite).toBeEnabled({ timeout: 30_000 })
    lap('server started')

    // Keep my server running: Iskra starts with the computer and starts this server (a development build never
    // registers itself with the system, so this only changes the app's own settings).
    await wizard.getByLabel(/Keep my server running/).check()
    await expect.poll(() => JSON.parse(readFileSync(join(userData, 'desktop.json'), 'utf8')) as { keepRunning: string[]; openAtLogin: boolean; closeToTray: boolean })
      .toMatchObject({ keepRunning: ['game-night'], openAtLogin: true, closeToTray: true })
    await shot(host, '4-ready')

    // 3. The template's channels, voice rooms and roles are there.
    for (const name of ['general', 'clips', 'looking-for-group']) await expect(host.locator('.channel', { hasText: name }).first()).toBeVisible()
    for (const name of ['Lobby', 'Squad 1', 'Squad 2', 'Raid', 'AFK']) await expect(host.locator('.voice-channel', { hasText: name })).toBeVisible()
    const settings = JSON.parse(readFileSync(join(hostRoot, 'game-night', 'server.json'), 'utf8')) as { Template: string; LocalOnly: boolean }
    expect(settings).toMatchObject({ Template: 'gaming', LocalOnly: true })

    // 4. Invite a friend: the link points at this computer's network address, not localhost-as-seen-by-the-app.
    await invite.click()
    const linkInput = host.locator('.copy-row input')
    await expect(linkInput).toHaveValue(/#\/join\//)
    const link = await linkInput.inputValue()
    await shot(host, '5-invite')
    await host.keyboard.press('Escape')
    lap('invite')

    // The friend opens it in a browser (the web app on this test's port stands in for app.iskra.foo).
    const friend = await (await browser.newContext()).newPage()
    await joinVia(friend, `http://localhost:${APP_PORT}/#/join/${link.split('#/join/')[1]}`, 'Grace')
    await expect(friend.locator('.voice-channel', { hasText: 'Lobby' })).toBeVisible()
    lap('friend joined')

    // 5. Both in voice.
    const lobby = (page: Page) => page.locator('.voice-channel', { hasText: 'Lobby' })
    await lobby(host).getByRole('button').first().click()
    await expect(host.locator('.voice-status strong')).toHaveText('Voice connected', { timeout: 30_000 })
    await lobby(friend).getByRole('button').first().click()
    await expect(friend.locator('.voice-status strong')).toHaveText('Voice connected', { timeout: 30_000 })
    for (const page of [host, friend]) {
      await expect(lobby(page).locator('.voice-participants li')).toHaveCount(2, { timeout: 15_000 })
      await expect(lobby(page)).toContainText('Ada')
      await expect(lobby(page)).toContainText('Grace')
    }
    lap('both in voice')
    await shot(host, '6-voice-host')
    await friend.screenshot({ path: join(SHOTS, 'walkthrough-6-voice-friend.png'), animations: 'disabled' })

    const total = Date.now() - started
    console.log(`Walkthrough timings (automated clicks; people take longer reading):\n${timings.map(([what, ms]) => `  ${what.padEnd(16)} ${(ms / 1000).toFixed(1)} s`).join('\n')}\n  total            ${(total / 1000).toFixed(1)} s`)
    expect(total).toBeLessThan(150_000)
    await friend.context().close()
  } finally {
    await app.close()
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    rmSync(hostRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  }
})
