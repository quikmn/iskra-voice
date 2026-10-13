// Writing while a server can't be reached: Enter isn't ignored. The message waits as "sending", the composer says
// why, and it goes out when the server is back.
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { createInviteLink, joinVia, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Offline Test', false, { ISKRA_STOP_ON_STDIN_CLOSE: '1' })
})
test.afterAll(async () => server?.stop())

test('a message written while the server is down goes out when it is back', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const friend = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')

  const stopped = server.restart(5_000, 'stop')
  await expect(friend.getByRole('status').filter({ hasText: 'Offline Test went offline' })).toBeVisible({ timeout: 15_000 })
  const box = friend.getByPlaceholder('Message #general')
  await box.fill('written while it was down')
  await box.press('Enter')
  await expect(box).toHaveValue('')
  await expect(friend.getByRole('status').filter({ hasText: 'messages send when Offline Test is back' })).toBeVisible()
  await expect(friend.locator('.message', { hasText: 'written while it was down' })).toBeVisible()
  expect(await friend.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await friend.screenshot({ path: join(SHOTS, 'offline-send-phone.png') })

  await stopped
  await expect(host.locator('.message', { hasText: 'written while it was down' })).toHaveCount(1, { timeout: 20_000 })
  await expect(friend.getByRole('status').filter({ hasText: 'messages send when' })).toHaveCount(0)
})
