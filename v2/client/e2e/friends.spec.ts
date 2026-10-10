import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { createInviteLink, joinVia, send, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Game Night')
})
test.afterAll(async () => server?.stop())

test('two friends join with invite links and chat', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  await expect(host.locator('.me-text')).toContainText('owner')

  // The host makes an invite link from the UI.
  const friendLink = await createInviteLink(host)

  const friendContext = await browser.newContext()
  const friend = await friendContext.newPage()
  await joinVia(friend, friendLink, 'Friend')

  await send(friend, 'hey! 👋 is this thing on? https://iskra.foo')
  await expect(host.getByText('is this thing on?')).toBeVisible()
  await expect(host.locator('.message-text a[href="https://iskra.foo"]')).toBeVisible()

  await send(host, 'loud and clear')
  await expect(friend.getByText('loud and clear')).toBeVisible()

  // Both are listed online.
  await expect(host.locator('.member-list')).toContainText('Friend')

  // Markup in messages is shown as text, never run.
  await send(friend, '<img src=x onerror="document.title=\'pwned\'">')
  await expect(host.getByText('<img src=x onerror')).toBeVisible()
  expect(await host.title()).toBe('Iskra')

  await host.screenshot({ path: join(SHOTS, 'desktop-host.png') })

  // Reloading keeps your identity and your servers.
  await friend.reload()
  await expect(friend.getByRole('heading', { name: 'general' })).toBeVisible()
  await expect(friend.getByText('loud and clear')).toBeVisible()

  // Phone size.
  await friend.setViewportSize({ width: 390, height: 844 })
  await friend.waitForTimeout(400) // drawers slide out
  await expect(friend.locator('.nav-column')).not.toBeInViewport()
  await friend.screenshot({ path: join(SHOTS, 'phone-chat.png') })
  await friend.getByRole('button', { name: 'Open channels' }).click()
  await friend.waitForTimeout(400)
  await expect(friend.getByRole('button', { name: 'general' })).toBeInViewport()
  await friend.screenshot({ path: join(SHOTS, 'phone-nav.png') })
})

test('a fresh browser starts at onboarding', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage()
  await host.goto('/')
  await expect(host.getByLabel('Your name')).toBeVisible()
  await host.screenshot({ path: join(SHOTS, 'onboarding.png') })
})
