import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { createInviteLink, joinVia, send, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Disappearing Test')
})
test.afterAll(async () => server?.stop())

test('messages disappear on everyone’s screen when their timer is up, in channels and DMs', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  // The friend's browser clock can be moved forward, to see messages go without waiting.
  const friendContext = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const friend = await friendContext.newPage()
  await friend.clock.install()
  await joinVia(friend, await createInviteLink(host), 'Friend')

  // ── A channel: only people who manage channels set it ──
  await host.getByTestId('disappear-button').click()
  const dialog = host.getByRole('dialog', { name: 'Disappearing messages' })
  await expect(dialog.getByText('People can still take screenshots')).toBeVisible()
  await dialog.getByText('5 minutes', { exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(host.locator('.disappear-line', { hasText: 'You set new messages to disappear after 5 minutes.' })).toBeVisible()
  await expect(host.getByTestId('disappear-button')).toContainText('5m')

  await expect(friend.locator('.disappear-line', { hasText: 'Host set new messages to disappear after 5 minutes.' })).toBeVisible()
  await expect(friend.getByTestId('disappear-button')).toContainText('5m')
  // Members can look, not change.
  await friend.getByTestId('disappear-button').click()
  const look = friend.getByRole('dialog', { name: 'Disappearing messages' })
  await expect(look.getByText('Only people who can manage channels can change this.')).toBeVisible()
  await expect(look.getByRole('radio', { name: '1 hour' })).toBeDisabled()
  await friend.keyboard.press('Escape')

  await send(host, 'gone in five minutes')
  const message = friend.locator('.message', { hasText: 'gone in five minutes' })
  await expect(message).toBeVisible()
  await expect(message.locator('.expiry-badge')).toBeVisible()
  await friend.screenshot({ path: join(SHOTS, 'disappearing-channel-phone.png') })

  await friend.clock.fastForward('05:05')
  await expect(friend.locator('.message', { hasText: 'gone in five minutes' })).toHaveCount(0)
  // The line about the timer stays.
  await expect(friend.locator('.disappear-line')).toBeVisible()

  // ── A DM: either person sets it, both see the line ──
  await host.locator('.member-list').getByRole('button', { name: 'Friend' }).click()
  await host.getByRole('dialog').getByRole('button', { name: 'Message', exact: true }).click()
  await expect(host.locator('.e2e-badge')).toBeVisible()
  await host.getByPlaceholder('Message Friend').fill('hello first')
  await host.getByPlaceholder('Message Friend').press('Enter')
  await expect(host.locator('.message-text', { hasText: 'hello first' })).toBeVisible()
  await host.getByTestId('disappear-button').click()
  await host.getByRole('dialog', { name: 'Disappearing messages' }).getByText('1 hour', { exact: true }).click()
  await expect(host.locator('.disappear-line', { hasText: 'You set new messages to disappear after 1 hour.' })).toBeVisible()
  await host.getByPlaceholder('Message Friend').fill('this one disappears')
  await host.getByPlaceholder('Message Friend').press('Enter')
  await expect(host.locator('.message', { hasText: 'this one disappears' }).locator('.expiry-badge')).toBeVisible()
  await host.screenshot({ path: join(SHOTS, 'disappearing-dm.png') })

  // Find the DM on a wide window, then look at it at phone width.
  await friend.setViewportSize({ width: 1280, height: 800 })
  await friend.getByRole('button', { name: 'Direct messages' }).click()
  await friend.locator('.dm-row', { hasText: 'Host' }).click()
  await friend.setViewportSize({ width: 390, height: 844 })
  await expect(friend.locator('.disappear-line', { hasText: 'Host set new messages to disappear after 1 hour.' })).toBeVisible()
  await expect(friend.locator('.message-text', { hasText: 'this one disappears' })).toBeVisible()
  await expect(friend.getByTestId('disappear-button')).toContainText('1h')
  await expect(friend.locator('.nav-column')).not.toBeInViewport() // the drawer has slid away
  await friend.screenshot({ path: join(SHOTS, 'disappearing-dm-phone.png') })

  // An hour later on the friend's device: gone from the screen (and its storage); the earlier message stays.
  await friend.clock.fastForward('01:01:00')
  await expect(friend.locator('.message-text', { hasText: 'this one disappears' })).toHaveCount(0)
  await expect(friend.locator('.message-text', { hasText: 'hello first' })).toBeVisible()
})
