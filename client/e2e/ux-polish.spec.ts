// Regression checks for the UX audit's P3 polish: previews without markdown marks, channel icons and forums in the
// quick switcher, an empty docs channel with one way to start, Saved to Saved messages, app-styled file choosers,
// the phone composer's room, and the gear by your name called My settings.
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { createInviteLink, joinVia, openServerSettings, send, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Polish')
})
test.afterAll(async () => server?.stop())

async function createChannel(page: Page, kind: string, name: string) {
  await page.getByRole('button', { name: 'Create channel' }).first().click()
  const create = page.getByRole('dialog', { name: 'Create channel' })
  await create.getByRole('radio', { name: kind }).click()
  await create.getByLabel('Name').fill(name)
  await create.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(create).toHaveCount(0)
}

test('previews, icons, docs, saved, file choosers and the phone composer', async ({ browser }) => {
  const host = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  await expect(host.locator('.me-bar').getByRole('button', { name: 'My settings', exact: true })).toBeVisible()
  await send(host, 'Welcome to **Game Night**! Who is in for ~~Valheim~~ Catan?')

  // Search shows the words, not the marks, and keeps the highlight.
  const box = host.getByRole('searchbox', { name: 'Search messages' }).first()
  await box.fill('night')
  await box.press('Enter')
  const result = host.locator('.result-card').first()
  await expect(result.locator('.result-text')).toHaveText('Welcome to Game Night! Who is in for Valheim Catan?')
  await expect(result.locator('mark')).toHaveText('Night')
  await host.screenshot({ path: join(SHOTS, 'ux-polish-search.png') })
  await host.keyboard.press('Escape')

  // Saving says where it went; the saved list reads without marks too.
  const message = host.locator('.message', { hasText: 'Welcome to' })
  await message.hover()
  await message.getByRole('button', { name: 'More', exact: true }).click()
  await host.getByRole('menuitem', { name: 'Save message' }).click()
  await expect(host.getByRole('status').filter({ hasText: 'Saved to Saved messages' })).toBeVisible()
  await host.getByRole('button', { name: 'Direct messages' }).click()
  await host.getByRole('button', { name: 'Saved messages' }).click()
  const saved = host.getByRole('dialog', { name: 'Saved messages' })
  await expect(saved).toContainText('Welcome to Game Night! Who is in for Valheim Catan?')
  await host.keyboard.press('Escape')
  await host.locator('.server-rail').getByRole('button', { name: 'Polish' }).click()

  // A forum and a docs channel: their own icons, and both in the quick switcher.
  await createChannel(host, 'Forum', 'ideas')
  await createChannel(host, 'Docs', 'handbook')
  await host.keyboard.press('Control+k')
  const switcher = host.getByRole('dialog', { name: 'Jump to a conversation' })
  await expect(switcher.getByRole('option', { name: /ideas/ })).toBeVisible()
  await expect(switcher.getByRole('option', { name: /handbook/ })).toBeVisible()
  await host.screenshot({ path: join(SHOTS, 'ux-polish-switcher.png') })
  await host.keyboard.press('Escape')

  // An empty docs channel: one way to start (no empty page tree with its own New page beside it).
  await host.locator('.channel-list .channel', { hasText: 'handbook' }).click()
  await expect(host.getByRole('button', { name: 'Write the first page' })).toBeVisible()
  await expect(host.getByRole('button', { name: 'New page' })).toHaveCount(0)
  await host.screenshot({ path: join(SHOTS, 'ux-polish-docs-empty.png') })

  // File choosers speak the app's language.
  const room = await openServerSettings(host, 'Bots & webhooks')
  await expect(room.getByRole('button', { name: 'Choose a file: Picture (optional)' })).toBeVisible()
  await expect(room.getByText('No file chosen')).toBeVisible()
  await room.locator('input[type=file]').first().setInputFiles({ name: 'hook.png', mimeType: 'image/png', buffer: Buffer.from('x') })
  await expect(room.getByText('hook.png')).toBeVisible()
  await host.keyboard.press('Escape')

  // A phone: with nothing typed, the mic stands in for the send button, so the placeholder has room.
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage()
  await joinVia(phone, await createInviteLink(host), 'Sam')
  const composer = phone.locator('.composer')
  await expect(composer.getByRole('button', { name: 'Send' })).toBeHidden()
  await composer.getByPlaceholder('Message #general').fill('hi')
  await expect(composer.getByRole('button', { name: 'Send' })).toBeVisible()
  await composer.getByPlaceholder('Message #general').fill('')
  await phone.screenshot({ path: join(SHOTS, 'ux-polish-phone-composer.png') })
})
