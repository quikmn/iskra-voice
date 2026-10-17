// Search everywhere: one query, every server you're on (each answers for itself; an offline one says so) and the
// direct messages on this device, grouped by server. Reached from the search panel's scope switch and from Ctrl+K.
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { createInviteLink, joinVia, send, SHOTS, startServer } from './helpers'

test('one search asks every server and the DMs, grouped by server, and knows when a server is offline', async ({ browser }) => {
  const home = await startServer('Home Base')
  const away = await startServer('Away Team')
  try {
    const viktor = await (await browser.newContext()).newPage()
    await joinVia(viktor, home.ownerLink(), 'Viktor')
    await send(viktor, 'apple pie at home')
    const owner = await (await browser.newContext()).newPage()
    await joinVia(owner, away.ownerLink(), 'Owner')
    await viktor.goto(await createInviteLink(owner))
    await viktor.getByRole('button', { name: 'Join server' }).click()
    await expect(viktor.getByRole('navigation', { name: 'Servers' }).getByRole('button', { name: /^Away Team/ })).toBeVisible()
    await viktor.locator('.server-rail').getByTitle('Away Team', { exact: true }).click()
    await expect(viktor.getByRole('heading', { name: 'general', exact: true })).toBeVisible()
    await send(owner, 'apple crumble away')
    await expect(viktor.locator('.message', { hasText: 'apple crumble away' })).toBeVisible()

    // This server first; then everywhere: a group per server, newest first.
    const box = viktor.getByRole('searchbox', { name: 'Search messages' }).first()
    await box.fill('apple')
    await box.press('Enter')
    const panel = viktor.locator('.search-panel')
    await expect(panel.getByRole('heading', { name: '1 message' })).toBeVisible()
    await panel.getByRole('radio', { name: 'Everywhere' }).click()
    await expect(panel.getByRole('heading', { name: '2 messages' })).toBeVisible()
    const groups = panel.locator('.search-group')
    await expect(groups.locator('.search-group-name')).toHaveText(['Away Team', 'Home Base', 'Direct messages and groups'])
    await expect(groups.nth(0).locator('.result-card')).toContainText('apple crumble away')
    await expect(groups.nth(1).locator('.result-card')).toContainText('apple pie at home')
    await expect(groups.nth(2).locator('.search-group-status')).toHaveText('0 messages')
    await viktor.screenshot({ path: join(SHOTS, 'search-everywhere.png') })

    // A filter that only means something on one server skips the other, and from: works per server.
    await box.fill('from:owner apple')
    await box.press('Enter')
    await expect(groups.filter({ hasText: 'Away Team' }).locator('.result-card')).toHaveCount(1)
    await expect(groups.filter({ hasText: 'Home Base' }).locator('.search-group-status')).toContainText('Nobody called "owner"')

    // A hit on the other server jumps there.
    await box.fill('apple')
    await box.press('Enter')
    await groups.filter({ hasText: 'Home Base' }).locator('.result-card').click()
    await expect(viktor.locator('.messages .message', { hasText: 'apple pie at home' })).toBeVisible()
    await expect(viktor.locator('.server-header-button')).toContainText('Home Base')

    // Ctrl+K: "Search everywhere for …" opens the panel in that scope.
    await viktor.keyboard.press('Escape')
    await viktor.keyboard.press('Control+k')
    const switcher = viktor.getByRole('dialog', { name: 'Jump to a conversation' })
    await switcher.getByRole('combobox').fill('crumble')
    await switcher.getByRole('button', { name: 'Search everywhere for “crumble”' }).click()
    await expect(panel.getByRole('radio', { name: 'Everywhere' })).toHaveAttribute('aria-checked', 'true')
    await expect(panel.locator('.result-card')).toContainText(['apple crumble away'])

    // Phones: a full-screen list.
    await viktor.setViewportSize({ width: 390, height: 844 })
    await viktor.waitForTimeout(400)
    await expect(panel).toBeVisible()
    await viktor.screenshot({ path: join(SHOTS, 'search-everywhere-mobile.png') })
    await viktor.setViewportSize({ width: 1280, height: 720 })

    // A server that is down says "Offline" instead of silently missing (the app notices within a few seconds).
    await away.stop()
    await expect(async () => {
      await box.fill('apple')
      await box.press('Enter')
      await expect(groups.filter({ hasText: 'Away Team' }).locator('.search-group-status')).toHaveText('Offline', { timeout: 3000 })
    }).toPass({ timeout: 30_000 })
    await expect(groups.filter({ hasText: 'Home Base' }).locator('.result-card')).toHaveCount(1)
  } finally {
    await home.stop()
    await away.stop().catch(() => undefined)
  }
})
