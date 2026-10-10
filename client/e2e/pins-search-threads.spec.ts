import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { createInviteLink, joinVia, send, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Pins Search Threads')
})
test.afterAll(async () => server?.stop())

test('pin a message, talk in a thread, and search for it', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')

  await send(host, 'apple pie recipe is in the doc')
  await send(host, 'banana bread this weekend?')
  await expect(friend.locator('.message', { hasText: 'banana bread' })).toBeVisible()

  // Pins: the owner pins, the friend sees the note, the mark and the pinned list.
  const apple = host.locator('.message', { hasText: 'apple pie' })
  await apple.hover()
  await apple.getByRole('button', { name: 'Pin message' }).click()
  await expect(friend.locator('.pin-note')).toContainText('Host pinned a message')
  await expect(friend.locator('.message', { hasText: 'apple pie' }).locator('.pinned-mark')).toBeVisible()
  // Members aren't trusted, so they can't pin.
  const friendsView = friend.locator('.message', { hasText: 'banana bread' })
  await friendsView.hover()
  await expect(friendsView.getByRole('button', { name: 'Pin message' })).toHaveCount(0)
  await friend.getByRole('button', { name: 'Pinned messages' }).click()
  const pins = friend.getByRole('dialog', { name: 'Pinned in #general' })
  await expect(pins.locator('.pin-item')).toHaveCount(1)
  await expect(pins).toContainText('apple pie recipe')
  await friend.screenshot({ path: join(SHOTS, 'pins.png') })
  await friend.keyboard.press('Escape')

  // Threads: the friend starts one from a message and replies in it.
  await friendsView.hover()
  await friendsView.getByRole('button', { name: 'Start a thread' }).click()
  await friend.getByLabel('Thread name').fill('Baking plans')
  await friend.getByRole('button', { name: 'Create thread' }).click()
  const panel = friend.locator('.thread-panel')
  await expect(panel.getByRole('heading', { name: 'Baking plans' })).toBeVisible()
  await expect(panel.locator('.thread-root')).toContainText('banana bread')
  const reply = panel.getByPlaceholder('Reply in Baking plans')
  await reply.fill('I will bring the flour')
  await reply.press('Enter')
  await expect(panel.locator('.message', { hasText: 'bring the flour' })).toBeVisible()

  // The host sees "1 reply" under the message, with an unread dot, and opens it.
  const summary = host.locator('.thread-summary', { hasText: 'Baking plans' })
  await expect(summary).toContainText('1 reply')
  await expect(summary.locator('.thread-unread-dot')).toBeVisible()
  await summary.click()
  await expect(host.locator('.thread-panel .message', { hasText: 'bring the flour' })).toBeVisible()
  await expect(summary.locator('.thread-unread-dot')).toHaveCount(0)
  await host.screenshot({ path: join(SHOTS, 'thread.png') })
  await host.locator('.thread-panel').getByRole('button', { name: 'Close thread' }).click()

  // Search finds the thread reply and jumps into the thread.
  const box = host.getByRole('searchbox', { name: 'Search messages' }).first()
  await box.fill('flou')
  await box.press('Enter')
  const results = host.locator('.search-panel')
  await expect(results.getByRole('heading', { name: '1 result' })).toBeVisible()
  await expect(results.locator('.result-where')).toHaveText('#general › Baking plans')
  await expect(results.locator('mark')).toHaveText('flour')
  await host.screenshot({ path: join(SHOTS, 'search.png') })
  await results.locator('.result-card').click()
  await expect(host.locator('.thread-panel .message', { hasText: 'bring the flour' })).toBeVisible()

  // Filters: from:Host with a word, and jumping to a message in the channel.
  await box.fill('from:host apple')
  await box.press('Enter')
  await expect(host.locator('.search-panel .result-card')).toHaveCount(1)
  await host.locator('.search-panel .result-card').click()
  await expect(host.locator('.messages .message', { hasText: 'apple pie' })).toBeVisible()

  // Phones: search is a full-screen view.
  await friend.setViewportSize({ width: 390, height: 844 })
  await friend.locator('.thread-panel').getByRole('button', { name: 'Back to channel' }).click()
  await friend.locator('.mobile-search').click()
  const mobileBox = friend.locator('.search-panel').getByRole('searchbox', { name: 'Search messages' })
  await mobileBox.fill('bread')
  await mobileBox.press('Enter')
  await expect(friend.locator('.search-panel .result-card')).toHaveCount(1)
  await expect(friend.locator('.search-panel mark')).toHaveText('bread')
  await friend.screenshot({ path: join(SHOTS, 'search-mobile.png') })
  await friend.locator('.search-panel .result-card').click()
  await expect(friend.locator('.search-panel')).toHaveCount(0)
  await expect(friend.locator('.messages .message', { hasText: 'banana bread' })).toBeVisible()
})
