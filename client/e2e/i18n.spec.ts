// Languages: switch to Svenska in Settings → Appearance, look around (chat, settings, voice), then back to English.
// "Automatic" follows the browser: a Swedish browser gets Swedish without asking.
import { expect, test } from '@playwright/test'
import { join } from 'node:path'
import { sv } from '../src/i18n/sv'
import { hasLiveKit, joinVia, openSettings, send, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Språkserver', hasLiveKit())
})
test.afterAll(async () => server?.stop())

test('switch to Svenska and back', async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
  await joinVia(page, server.ownerLink(), 'Viktor')
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await send(page, 'Hej allihop! 👋')

  if (hasLiveKit()) {
    await page.getByRole('button', { name: 'Create voice channel' }).click()
    await page.getByRole('radio', { name: 'Voice' }).click()
    await page.getByLabel('Name').fill('lounge')
    await page.getByRole('button', { name: 'Create', exact: true }).click()
  }

  // Settings → Appearance → Language: Svenska applies right away, no reload.
  await openSettings(page, 'Appearance')
  await page.getByRole('combobox', { name: 'Language' }).selectOption('sv')
  await expect(page.locator('html')).toHaveAttribute('lang', 'sv')
  const dialog = page.getByRole('dialog', { name: sv.common.settings })
  await expect(dialog.getByRole('heading', { name: sv.common.language.title })).toBeVisible()
  await expect(dialog.getByRole('combobox', { name: sv.common.language.title })).toHaveValue('sv')
  await page.screenshot({ path: join(SHOTS, 'i18n-settings-sv.png') })
  await page.keyboard.press('Escape')

  // The chat in Swedish; the message itself is untouched.
  await expect(page.getByText('Hej allihop! 👋')).toBeVisible()
  await expect(page.getByRole('button', { name: sv.app.sidebar.inviteFriends })).toBeVisible()
  await page.screenshot({ path: join(SHOTS, 'i18n-chat-sv.png') })

  // Remembered across reloads.
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('lang', 'sv')
  await expect(page.getByText('Hej allihop! 👋')).toBeVisible()

  if (hasLiveKit()) {
    const lounge = page.locator('.voice-channel', { hasText: 'lounge' })
    await lounge.getByRole('button').first().click()
    await expect(page.locator('.stage')).toBeVisible({ timeout: 15_000 })
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(SHOTS, 'i18n-voice-sv.png') })
  }

  // And back to English.
  await page.locator('.me-bar').getByRole('button', { name: sv.common.settings, exact: true }).click()
  const settings = page.getByRole('dialog', { name: sv.common.settings })
  await settings.getByRole('navigation').getByRole('button', { name: sv.settings.sections.appearance, exact: true }).click()
  await settings.getByRole('combobox', { name: sv.common.language.title }).selectOption('en')
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Invite friends' })).toBeVisible()
})

test('automatic follows a Swedish browser', async ({ browser }) => {
  const page = await (await browser.newContext({ locale: 'sv-SE' })).newPage()
  await page.goto('/')
  await expect(page.locator('html')).toHaveAttribute('lang', 'sv')
  await page.screenshot({ path: join(SHOTS, 'i18n-welcome-sv.png') })
})
