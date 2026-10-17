import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { createInviteLink, joinVia, openSettings, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Quiet Test')
})
test.afterAll(async () => server?.stop())

test('when quiet hours end, a card sums up what came in, opens it, and goes away', async ({ browser }) => {
  const host = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')

  // ── Quiet hours all day, every day; the summary is on by default ──
  await openSettings(host, 'Notifications')
  const settings = host.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('checkbox', { name: 'Quiet hours on a schedule' }).check()
  await settings.getByLabel('From', { exact: true }).fill('00:00')
  await settings.getByLabel('To', { exact: true }).fill('00:00')
  for (const day of ['Sun', 'Sat']) {
    const button = settings.locator('.quiet-day', { hasText: day })
    if ((await button.getAttribute('aria-pressed')) === 'false') await button.click()
  }
  await expect(settings.getByRole('checkbox', { name: 'Summary when quiet hours end' })).toBeChecked()
  await host.keyboard.press('Escape')

  // The host looks at another channel.
  await host.getByRole('button', { name: 'Create channel' }).click()
  await host.getByLabel('Name').fill('off-topic')
  await host.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(host.getByRole('heading', { name: 'off-topic' })).toBeVisible()

  // ── A friend mentions the host twice and sends a DM ──
  const box = friend.getByPlaceholder('Message #general')
  for (const text of ['are you up?', 'game tonight?']) {
    await box.pressSequentially('@Ho')
    await expect(friend.locator('.mention-popup')).toContainText('Host')
    await box.press('Enter')
    await box.pressSequentially(text)
    await box.press('Enter')
    await expect(friend.locator('.message-text', { hasText: text })).toBeVisible()
  }
  await friend.locator('.member-list').getByRole('button', { name: 'Host' }).click()
  await friend.getByRole('button', { name: 'Add friend' }).click()
  await friend.getByRole('dialog').getByRole('button', { name: 'Message', exact: true }).click()
  await friend.getByPlaceholder('Message Host').fill('call me when you wake up')
  await friend.getByPlaceholder('Message Host').press('Enter')
  await expect(friend.locator('.message-text', { hasText: 'call me when you wake up' })).toBeVisible()

  // Everything arrived, quietly: no card while quiet hours last.
  await expect(host.locator('.channel', { hasText: 'general' }).locator('.badge')).toHaveText('2')
  await expect(host.locator('.server-icon.home .badge')).toBeVisible()
  const card = host.getByRole('region', { name: 'While it was quiet' })
  await expect(card).toHaveCount(0)

  // ── Quiet hours end (turned off by hand here; the schedule ending works the same) ──
  await openSettings(host, 'Notifications')
  await settings.getByRole('checkbox', { name: 'Quiet hours on a schedule' }).uncheck()
  await host.keyboard.press('Escape')
  await expect(card).toBeVisible()
  await expect(card.getByRole('heading', { name: 'While it was quiet' })).toBeVisible()
  await expect(card.getByTestId('quiet-digest-count-mentions')).toHaveText('2')
  await expect(card.getByTestId('quiet-digest-count-messages')).toHaveText('1')
  await expect(card.getByRole('button', { name: /Friend mentioned you/ })).toHaveCount(2)
  await expect(card.getByRole('button', { name: /Friend.*1 message/ })).toBeVisible()
  await expect(card).not.toContainText('call me when') // who and how many, never the content
  await card.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))
  await host.screenshot({ path: join(SHOTS, 'quiet-digest.png') })

  // ── Each row opens its place; the card stays for the rest ──
  await card.getByRole('button', { name: /Friend mentioned you/ }).first().click()
  await expect(host.getByRole('heading', { name: 'general' })).toBeVisible()
  await expect(host.locator('.message', { hasText: 'game tonight?' })).toBeVisible()
  await expect(card).toBeVisible()

  // Phone width (the card is kept until it's dismissed, across a reload too).
  await host.setViewportSize({ width: 390, height: 844 })
  await host.reload()
  await expect(card).toBeVisible()
  await expect(card.getByTestId('quiet-digest-count-mentions')).toHaveText('2')
  await card.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))
  const box390 = await card.boundingBox()
  expect(box390!.x).toBeGreaterThanOrEqual(0)
  expect(box390!.x + box390!.width).toBeLessThanOrEqual(390)
  await host.screenshot({ path: join(SHOTS, 'quiet-digest-phone.png') })

  // ── Keyboard: reach it, Escape dismisses it, and it stays dismissed ──
  await card.getByRole('button', { name: 'Got it' }).focus()
  await host.keyboard.press('Escape')
  await expect(card).toHaveCount(0)
  await host.reload()
  await expect(host.locator('.server-icon[title="Quiet Test"]')).toBeVisible()
  await expect(host.getByRole('region', { name: 'While it was quiet' })).toHaveCount(0)
})
