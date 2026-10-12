import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { createInviteLink, joinVia, openServerSettings, openSettings, send, serverRoom, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Safety Test')
})
test.afterAll(async () => server?.stop())

/** Opens a member's full dialog from the member list (card → More). */
async function openMember(page: Page, name: string) {
  await page.locator('.member-list').getByRole('button', { name }).click()
  await page.getByRole('dialog', { name: `Profile of ${name}` }).getByRole('button', { name: 'More' }).click()
  const dialog = page.getByRole('dialog', { name })
  await expect(dialog).toBeVisible()
  return dialog
}

test('block, timeout, slowmode and the audit log', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')

  // ── Blocking: their messages collapse, and they can't DM you.
  await send(friend, 'hello from friend')
  await expect(host.locator('.message-text', { hasText: 'hello from friend' })).toBeVisible()
  let dialog = await openMember(host, 'Friend')
  await dialog.getByRole('button', { name: 'Block', exact: true }).click()
  await dialog.getByRole('group', { name: 'Block Friend?' }).getByRole('button', { name: 'Block', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Unblock' })).toBeVisible()
  await host.keyboard.press('Escape')
  await expect(host.locator('.blocked-message')).toHaveCount(1)
  await expect(host.locator('.message-text', { hasText: 'hello from friend' })).toHaveCount(0)
  await host.screenshot({ path: join(SHOTS, 'moderation-blocked.png') })
  await host.locator('.blocked-message').getByRole('button', { name: 'Show' }).click()
  await expect(host.locator('.message-text', { hasText: 'hello from friend' })).toBeVisible()

  await friend.locator('.member-list').getByRole('button', { name: 'Host' }).click()
  await friend.getByRole('dialog').getByRole('button', { name: 'Message', exact: true }).click()
  await friend.getByPlaceholder('Message Host').fill('can you hear me')
  await friend.getByPlaceholder('Message Host').press('Enter')
  await expect(friend.locator('.message-failed')).toContainText("You can't message this person.")

  // Unblock from Settings → Blocked people.
  await openSettings(host, 'Blocked people')
  const blockedList = host.locator('.blocked-list')
  await expect(blockedList).toContainText('Friend')
  await host.screenshot({ path: join(SHOTS, 'moderation-blocked-settings.png') })
  await blockedList.getByRole('button', { name: 'Unblock' }).click()
  await expect(host.getByText("You haven't blocked anyone.")).toBeVisible()
  await host.keyboard.press('Escape')

  // ── Timeouts: the member can't send until it ends or is removed.
  dialog = await openMember(host, 'Friend')
  await dialog.getByLabel('Timeout length').selectOption({ label: '5 minutes' })
  await dialog.getByLabel('Timeout reason').fill('cool off')
  await dialog.getByRole('button', { name: 'Time out' }).click()
  await expect(dialog.getByText(/Timed out until/).first()).toBeVisible()
  await host.keyboard.press('Escape')
  await expect(host.locator('.member-list .member', { hasText: 'Friend' }).locator('.timeout-badge')).toBeVisible()

  await friend.goto(friend.url().replace(/#.*$/, ''))
  await expect(friend.getByRole('heading', { name: 'general' })).toBeVisible()
  const bar = friend.locator('.timed-out-bar')
  await expect(bar).toContainText("You're timed out until")
  await expect(bar).toContainText('cool off')
  await expect(friend.getByPlaceholder('Message #general')).toHaveCount(0)
  await friend.screenshot({ path: join(SHOTS, 'moderation-timed-out.png') })

  dialog = await openMember(host, 'Friend')
  await dialog.getByRole('button', { name: 'Remove timeout' }).click()
  await expect(dialog.getByRole('button', { name: 'Time out' })).toBeVisible()
  await host.keyboard.press('Escape')
  await expect(friend.getByPlaceholder('Message #general')).toBeVisible()

  // ── Slowmode: a countdown after each message; admins aren't limited.
  await host.getByRole('button', { name: 'Channel settings' }).click()
  const settings = host.getByRole('dialog', { name: '#general settings' })
  await settings.getByLabel('Slowmode').fill('2') // 10 s
  await expect(settings).toContainText('one message every 10 s')
  await settings.getByRole('button', { name: 'Save' }).click()
  await expect(settings).toHaveCount(0)

  // Their last message may be recent enough to count already: wait until they can send.
  await expect(friend.locator('.slowmode-chip')).toHaveText(/10 s/, { timeout: 15_000 })
  await send(friend, 'slow and steady')
  await expect(friend.locator('[id^="msg-"] .message-text', { hasText: 'slow and steady' })).toBeVisible()
  await expect(friend.locator('.slowmode-chip.waiting')).toHaveText(/0:\d\d/)
  await expect(friend.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
  await friend.screenshot({ path: join(SHOTS, 'moderation-slowmode.png') })
  await send(host, 'admin one')
  await send(host, 'admin two')
  await expect(host.locator('.message-text', { hasText: 'admin two' })).toBeVisible()
  await expect(host.locator('.slowmode-chip')).toHaveCount(0)

  // ── Audit log: admins see who did what.
  await openServerSettings(host, 'Activity log')
  const log = host.locator('.audit-list')
  await expect(log).toContainText('Host edited #general: slowmode off → 10 s')
  await expect(log).toContainText("Host ended Friend's timeout")
  await expect(log).toContainText('Host timed out Friend for 5 minutes')
  await expect(log).toContainText('Reason: cool off')
  await host.screenshot({ path: join(SHOTS, 'moderation-audit.png') })
  await serverRoom(host).getByLabel('Action').selectOption({ label: 'Timeouts' })
  await expect(log.locator('.audit-entry')).toHaveCount(1)
  await host.keyboard.press('Escape')

  // Members don't get the audit log at all.
  await friend.locator('.server-header-button').click()
  await expect(friend.getByRole('menuitem', { name: 'Server settings', exact: true })).toHaveCount(0)
  await expect(friend.getByRole('menuitem', { name: 'More settings' })).toHaveCount(0)
  await friend.keyboard.press('Escape')

  // Phone width: the audit log still reads well.
  await host.setViewportSize({ width: 390, height: 800 })
  await host.getByRole('button', { name: 'Open channels' }).click()
  const phoneSettings = await openServerSettings(host)
  // Below the fold on a phone: scroll to it first.
  const auditItem = phoneSettings.getByRole('button', { name: 'Activity log' })
  await auditItem.scrollIntoViewIfNeeded()
  await host.waitForTimeout(300)
  await auditItem.click()
  await expect(host.locator('.audit-list')).toBeVisible()
  await host.waitForTimeout(400) // let the pane finish sliding in
  await host.screenshot({ path: join(SHOTS, 'moderation-audit-phone.png') })
})
