// Mute and deafen keybinds in the browser: in-app shortcuts (the desktop app makes them global; see desktop.spec.ts).
import { expect, test, type Page } from '@playwright/test'
import { join } from 'node:path'
import { hasLiveKit, joinVia, openSettings, SHOTS, startServer, type TestServer } from './helpers'

test.skip(!hasLiveKit(), 'needs .tools/livekit-server (see scripts/get-livekit.ps1)')

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Hotkeys Test', true)
})
test.afterAll(async () => server?.stop())

const lounge = (page: Page) => page.locator('.voice-channel', { hasText: 'lounge' })
const bar = (page: Page) => page.locator('.voice-bar')
const muted = (page: Page) => bar(page).getByRole('button', { name: /^(Mute|Unmute)$/ })
const deafened = (page: Page) => bar(page).getByRole('button', { name: /^(Deafen|Undeafen)$/ })

test('mute and deafen keybinds work in the browser while Iskra is focused', async ({ browser }) => {
  const page = await (await browser.newContext()).newPage()
  await joinVia(page, server.ownerLink(), 'Gamer')

  // Set the keys: a combo for mute, a plain key for deafen.
  await openSettings(page, 'Voice & audio')
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await expect(settings.getByRole('heading', { name: 'Keybinds' })).toBeVisible()
  await expect(settings.getByText('For hotkeys that work while you\'re in a game, use the desktop app.')).toBeVisible()
  await expect(settings.locator('.hotkey-row', { hasText: 'Toggle mute' }).locator('.key-chip')).toHaveText('Not set')

  await settings.getByRole('button', { name: 'Set toggle mute key' }).click()
  await expect(settings.locator('.hotkey-row', { hasText: 'Toggle mute' }).locator('.key-chip')).toHaveText('Press a key…')
  await page.keyboard.down('Control') // a lone modifier waits for the key
  await page.keyboard.down('Shift')
  await page.keyboard.press('KeyM')
  await page.keyboard.up('Shift')
  await page.keyboard.up('Control')
  await expect(settings.locator('.hotkey-row', { hasText: 'Toggle mute' }).locator('.key-chip')).toHaveText('Ctrl + Shift + M')

  // Escape cancels and keeps what was there.
  await settings.getByRole('button', { name: 'Change toggle mute key' }).click()
  await page.keyboard.press('Escape')
  await expect(settings).toBeVisible()
  await expect(settings.locator('.hotkey-row', { hasText: 'Toggle mute' }).locator('.key-chip')).toHaveText('Ctrl + Shift + M')

  await settings.getByRole('button', { name: 'Set toggle deafen key' }).click()
  await page.keyboard.press('KeyK')
  await expect(settings.locator('.hotkey-row', { hasText: 'Toggle deafen' }).locator('.key-chip')).toHaveText('K')
  await settings.getByRole('heading', { name: 'Keybinds' }).evaluate((h) => h.scrollIntoView({ block: 'start' }))
  await page.screenshot({ path: join(SHOTS, 'hotkeys-settings.png') })
  await page.keyboard.press('Escape')
  await expect(settings).toBeHidden()

  // Keys do nothing outside voice.
  await page.locator('body').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('KeyK')

  await page.getByRole('button', { name: 'Create voice channel' }).click()
  await page.getByRole('radio', { name: 'Voice' }).click()
  await page.getByLabel('Name').fill('lounge')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await lounge(page).getByRole('button').first().click()
  await expect(page.locator('.voice-status strong')).toHaveText('Voice connected', { timeout: 20_000 })
  await expect(muted(page)).toHaveAttribute('aria-pressed', 'false')
  await expect(deafened(page)).toHaveAttribute('aria-pressed', 'false')

  // Back to the text channel: typing a plain key in the message box doesn't deafen; the combo still mutes.
  await page.getByRole('button', { name: 'general' }).click()
  const box = page.getByPlaceholder('Message #general')
  await box.click()
  await page.keyboard.type('ok k')
  await expect(box).toHaveValue('ok k')
  await expect(deafened(page)).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.press('Control+Shift+KeyM')
  await expect(muted(page)).toHaveAttribute('aria-pressed', 'true')
  await expect(box).toHaveValue('ok k')
  await page.keyboard.press('Control+Shift+KeyM')
  await expect(muted(page)).toHaveAttribute('aria-pressed', 'false')

  // Outside text fields the plain key works: deafen (which mutes too), then undeafen.
  await box.blur()
  await page.keyboard.press('KeyK')
  await expect(deafened(page)).toHaveAttribute('aria-pressed', 'true')
  await expect(muted(page)).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('KeyK')
  await expect(deafened(page)).toHaveAttribute('aria-pressed', 'false')
  await expect(muted(page)).toHaveAttribute('aria-pressed', 'false')

  // Kept across reloads; Clear removes one.
  await page.reload()
  await expect(page.getByRole('heading', { name: 'general' })).toBeVisible({ timeout: 15_000 })
  await openSettings(page, 'Voice & audio')
  await expect(settings.locator('.hotkey-row', { hasText: 'Toggle mute' }).locator('.key-chip')).toHaveText('Ctrl + Shift + M')
  await settings.getByRole('button', { name: 'Clear toggle mute key' }).click()
  await expect(settings.locator('.hotkey-row', { hasText: 'Toggle mute' }).locator('.key-chip')).toHaveText('Not set')
  await expect(settings.locator('.hotkey-row', { hasText: 'Toggle deafen' }).locator('.key-chip')).toHaveText('K')

  // Phone width: the rows still fit.
  await page.setViewportSize({ width: 390, height: 844 })
  const setMute = settings.getByRole('button', { name: 'Set toggle mute key' })
  await setMute.scrollIntoViewIfNeeded() // the clip row sits below now
  await expect(setMute).toBeInViewport()
  await page.screenshot({ path: join(SHOTS, 'hotkeys-settings-phone.png') })
})
