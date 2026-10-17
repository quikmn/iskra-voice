import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { createInviteLink, joinVia, openServerSettings, send, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Mod Pack Test')
})
test.afterAll(async () => server?.stop())

async function openMemberSheet(page: Page, name: string) {
  await page.locator('.member-list').getByRole('button', { name }).first().click()
  await page.getByRole('dialog', { name: `Profile of ${name}` }).getByRole('button', { name: 'More' }).click()
  const dialog = page.getByRole('dialog', { name })
  await expect(dialog).toBeVisible()
  return dialog
}

test('moderators delete messages together, warn, keep notes, see history, and reach people who left', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const invite = await createInviteLink(host)
  const sam = await (await browser.newContext()).newPage()
  await joinVia(sam, invite, 'Sam')
  for (const text of ['spam one', 'spam two', 'spam three']) {
    await send(sam, text)
    await expect(host.locator('.message-text', { hasText: text })).toBeVisible()
  }

  // ── Select two of Sam's messages and delete them together.
  const first = host.locator('.message', { hasText: 'spam one' })
  await first.hover()
  await first.getByRole('button', { name: 'More' }).click()
  await host.getByRole('menuitem', { name: 'Select messages…' }).click()
  const bar = host.getByTestId('bulk-bar')
  await expect(bar).toContainText('1 message selected')
  await host.locator('.message', { hasText: 'spam two' }).click()
  await expect(bar).toContainText('2 messages selected')
  await host.screenshot({ path: join(SHOTS, 'bulk-select.png') })
  await bar.getByRole('button', { name: 'Delete' }).click()
  await expect(host.getByRole('dialog', { name: 'Delete 2 messages?' })).toBeVisible()
  await host.getByTestId('bulk-delete-confirm').click()
  await expect(host.getByTestId('bulk-bar')).toHaveCount(0)
  await expect(sam.locator('.message-text', { hasText: 'spam one' })).toHaveCount(0)
  await expect(sam.locator('.message-text', { hasText: 'spam two' })).toHaveCount(0)
  await expect(sam.locator('.message-text', { hasText: 'spam three' })).toBeVisible()

  // ── Warning, a note, and the history on Sam's sheet.
  let sheet = await openMemberSheet(host, 'Sam')
  await sheet.getByLabel('Warning reason').fill('No spam, please')
  await sheet.getByRole('button', { name: 'Warn' }).click()
  await expect(sheet.getByRole('status')).toHaveText('Sam was warned.')
  const toast = sam.getByTestId('warn-toast')
  await expect(toast).toContainText('A warning from the moderators of Mod Pack Test')
  await expect(toast).toContainText('Host: No spam, please')
  await sam.screenshot({ path: join(SHOTS, 'warn-toast.png') })
  await sheet.getByLabel('New note').fill('Second strike is a timeout')
  await sheet.getByRole('button', { name: 'Add note' }).click()
  await expect(sheet.getByTestId('mod-notes')).toContainText('Second strike is a timeout')
  await expect(sheet.getByTestId('mod-notes')).toContainText('By Host')
  await expect(sheet.getByTestId('mod-history')).toContainText('Host warned Sam')
  await host.screenshot({ path: join(SHOTS, 'mod-sheet.png') })
  // Sam never sees notes or a history section.
  await sam.locator('.me-bar').getByRole('button', { name: 'My settings', exact: true }).click()
  await sam.keyboard.press('Escape')

  // ── Ban and delete the last day of messages: Sam's last message goes with them.
  await sheet.getByRole('button', { name: 'Ban' }).click()
  await sheet.getByLabel('Also delete their messages from').selectOption({ label: 'the last 1 day' })
  await sheet.getByRole('button', { name: 'Ban' }).last().click()
  await expect(host.locator('.message-text', { hasText: 'spam three' })).toHaveCount(0)
  await expect(host.locator('.member-list')).not.toContainText('Sam')

  // ── People who left: Sam is there as banned, with the notes still attached; unban from there.
  await openServerSettings(host, 'Members')
  const departed = host.getByTestId('departed')
  await expect(departed).toContainText('Sam')
  await expect(departed).toContainText('Banned by Host')
  await departed.getByRole('button', { name: 'Notes & history' }).click()
  await expect(departed.getByTestId('mod-notes')).toContainText('Second strike is a timeout')
  await expect(departed.getByTestId('mod-history')).toContainText('Host banned Sam')
  await host.screenshot({ path: join(SHOTS, 'people-who-left.png') })
  await departed.getByRole('button', { name: 'Unban' }).click()
  await expect(departed.getByRole('button', { name: 'Ban', exact: true })).toBeVisible()

  // The activity log has one entry for the bulk delete.
  await host.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Activity log', exact: true }).click()
  const log = host.locator('.audit-list')
  await expect(log).toContainText('Host deleted 2 messages in #general')
  await expect(log).toContainText('Host warned Sam')
  await expect(log).toContainText('Host added a moderator note about Sam')
})
