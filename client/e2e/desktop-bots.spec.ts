// Bots on this PC: the real Electron app runs the gallery's Starter bot (bundled, with the app's own Node) against a
// local server, with a bot invite the app makes itself, and the bot answers a /command. Localhost only.
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect, test } from '@playwright/test'
import { DESKTOP_SKIP, desktopBuilt } from './desktopBuild'
import { agreeToTerms, appWindow, SHOTS, startServer, type TestServer } from './helpers'

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP = resolve(HERE, '../../desktop')
const built = desktopBuilt(join(DESKTOP, 'dist', 'gallery', 'starter.cjs'))

test.skip(!built, DESKTOP_SKIP)

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Desktop Bots')
})
test.afterAll(async () => server?.stop())

test('runs a gallery bot from My settings and it answers a command', async () => {
  test.setTimeout(120_000)
  const userData = mkdtempSync(join(tmpdir(), 'iskra-desktop-bots-'))
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_OPTIONS')) as Record<string, string>
  const app = await electron.launch({
    executablePath: join(DESKTOP, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
    args: [DESKTOP, `--user-data-dir=${userData}`, '--lang=en-US'],
    cwd: DESKTOP,
    env: { ...env, ISKRA_E2E: '1', ISKRA_LOCAL_ONLY: '1' },
  })
  try {
    const page = await appWindow(app)
    await agreeToTerms(page)
    await page.getByRole('button', { name: /I’m new to Iskra/ }).click()
    await page.getByLabel('Your name').fill('Owner')
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('button', { name: 'I have an invite link' }).click()
    await page.getByLabel('Invite link').fill(server.ownerLink())
    await page.getByRole('button', { name: 'Join', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'general' })).toBeVisible()

    // My settings → Bots on this PC: the gallery, and a warning before running a bot from a folder.
    await page.locator('.me-bar').getByRole('button', { name: 'My settings' }).click()
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await settings.getByRole('button', { name: 'Bots on this PC', exact: true }).click()
    await expect(settings.getByText('No bots yet.')).toBeVisible()
    await expect(settings.getByText(/Only run bots you trust/)).toBeVisible()
    await expect(settings.getByRole('button', { name: 'Choose its folder…' })).toBeDisabled()
    await settings.getByRole('button', { name: 'Add: Starter' }).click()
    const card = settings.locator('.pc-bot', { hasText: 'Starter' })
    await expect(card.getByRole('status')).toHaveText('Stopped')

    // Start: it has no server yet, so the app offers to make a bot invite on a server where you're an admin.
    await card.getByRole('button', { name: 'Start' }).click()
    await expect(card.getByLabel('Server')).toHaveValue(/.+/)
    await card.getByRole('button', { name: 'Make an invite and start' }).click()
    await expect(card.getByRole('status')).toHaveText('Online', { timeout: 60_000 })
    await card.getByRole('button', { name: 'Log' }).click()
    await expect(card.locator('.pc-bot-log')).toContainText('Online in "Desktop Bots" as Starter')
    await expect(card.locator('.pc-bot-log')).not.toContainText('#/join/') // the invite never shows in its log
    await page.screenshot({ path: join(SHOTS, 'desktop-bots.png') })
    // Its keys are kept in the app's own folder for this bot.
    expect(readdirSync(join(userData, 'bots', 'starter'))).toContain('starter.bot.json')

    // In the chat: the bot is a member with a BOT badge and answers /hello.
    await page.keyboard.press('Escape')
    await expect(page.locator('.member', { hasText: 'Starter' }).locator('.bot-badge')).toBeVisible()
    const composer = page.getByPlaceholder('Message #general')
    await composer.fill('/hello')
    await expect(page.getByRole('listbox', { name: 'Bot commands' }).getByRole('option', { name: /\/hello Says hello Starter/ })).toBeVisible()
    await composer.press('Enter') // picks it
    await composer.press('Enter') // sends it (to the bot, not the channel)
    const answer = page.locator('.message', { hasText: /Good (night|morning|afternoon|evening), Owner!/ })
    await expect(answer.locator('.author')).toHaveText('Starter')
    await expect(answer.locator('.interaction-line')).toHaveText('Owner used /hello')

    // Stop it from the page; it goes offline on the server.
    await page.locator('.me-bar').getByRole('button', { name: 'My settings' }).click()
    await settings.getByRole('button', { name: 'Bots on this PC', exact: true }).click()
    await card.getByRole('button', { name: 'Stop' }).click()
    await expect(card.getByRole('status')).toHaveText('Stopped')
  } finally {
    await app.close()
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
