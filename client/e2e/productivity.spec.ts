import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { createInviteLink, joinVia, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Productivity Test')
})
test.afterAll(async () => server?.stop())

/** A few seconds from now, as the date and time field wants it (the browser's local time, to the second). */
const soon = (page: Page, seconds: number) => page.evaluate((s) => {
  const d = new Date(Date.now() + s * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  // Chrome drops ":00" seconds from the field's value, so leave them out then.
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}${d.getSeconds() ? `:${p(d.getSeconds())}` : ''}`
}, seconds)

async function messageMenu(page: Page, text: string) {
  const message = page.locator('.message', { hasText: text }).last()
  await message.hover()
  await message.getByRole('button', { name: 'More', exact: true }).click()
  return page.getByRole('menu', { name: 'Message options' })
}

test('save, remind, send later, the inbox and edit history', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')

  // ── The inbox: a mention shows up under the bell, across servers ──
  await host.getByRole('button', { name: 'Direct messages' }).click() // somewhere else when it arrives
  const box = friend.getByPlaceholder('Message #general')
  await box.pressSequentially('@Ho')
  await expect(friend.locator('.mention-popup')).toContainText('Host')
  await box.press('Enter')
  await box.pressSequentially('lunch at noon?')
  await box.press('Enter')
  const bell = host.getByRole('button', { name: /^Inbox, 1 new/ })
  await expect(bell).toBeVisible()
  await bell.click()
  const inbox = host.getByRole('dialog', { name: 'Inbox' })
  await expect(inbox.locator('.inbox-row.unread', { hasText: 'Friend mentioned you' })).toContainText('lunch at noon?')
  await host.screenshot({ path: join(SHOTS, 'productivity-inbox.png') })
  await inbox.getByRole('button', { name: 'Mark all read' }).click()
  await expect(inbox.locator('.inbox-row.unread')).toHaveCount(0)
  await host.keyboard.press('Escape')
  await expect(host.getByRole('button', { name: 'Inbox', exact: true })).toBeVisible()
  await host.locator('.server-icon[title="Productivity Test"]').click()

  // ── Save a message, find it under Saved, jump back to it ──
  await (await messageMenu(host, 'lunch at noon?')).getByRole('menuitem', { name: 'Save message' }).click()
  await expect(host.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible()
  await host.getByRole('button', { name: 'Direct messages' }).click()
  await host.getByRole('button', { name: 'Saved messages' }).click()
  const saved = host.getByRole('dialog', { name: 'Inbox' })
  await expect(saved.getByRole('tab', { name: 'Saved' })).toHaveAttribute('aria-selected', 'true')
  await expect(saved.locator('.inbox-row', { hasText: 'lunch at noon?' })).toContainText('#general')
  await host.screenshot({ path: join(SHOTS, 'productivity-saved.png') })
  await saved.locator('.inbox-row-main', { hasText: 'lunch at noon?' }).click()
  await expect(host.getByRole('heading', { name: 'general' })).toBeVisible()
  await expect(host.locator('.message.flash', { hasText: 'lunch at noon?' })).toBeVisible()

  // ── Remind me: a few seconds ahead, it fires in the app ──
  await (await messageMenu(host, 'lunch at noon?')).getByRole('menuitem', { name: 'Remind me about this' }).click()
  const remind = host.getByRole('dialog', { name: 'Remind me' })
  await remind.getByLabel('Note (optional, only you can see it)').fill('answer Friend')
  await remind.getByRole('button', { name: 'Pick a date and time' }).click()
  await remind.getByTestId('when-custom').fill(await soon(host, 4))
  await remind.getByRole('button', { name: 'Set reminder' }).click()
  await expect(remind).toBeHidden()
  const toast = host.locator('.reminder-toast', { hasText: 'answer Friend' })
  await expect(toast).toBeVisible({ timeout: 15_000 })
  await expect(toast).toContainText('lunch at noon?')
  await host.screenshot({ path: join(SHOTS, 'productivity-reminder.png') })
  await toast.getByRole('button', { name: 'Done' }).click()
  await expect(toast).toBeHidden()

  // ── Send later: scheduled a few seconds ahead, it arrives as Host ──
  const hostBox = host.getByPlaceholder('Message #general')
  await hostBox.fill('see you at noon (scheduled)')
  await host.getByRole('button', { name: 'Send later', exact: true }).click()
  const later = host.getByRole('dialog', { name: 'Send later' })
  await later.getByRole('button', { name: 'Pick a date and time' }).click()
  await later.getByTestId('when-custom').fill(await soon(host, 5))
  await later.getByRole('button', { name: 'Schedule' }).click()
  await expect(later).toBeHidden()
  await expect(hostBox).toHaveValue('')
  await host.getByRole('button', { name: /^Inbox/ }).click()
  await host.getByRole('dialog', { name: 'Inbox' }).getByRole('tab', { name: 'Scheduled' }).click()
  await expect(host.locator('.inbox-row', { hasText: 'see you at noon (scheduled)' })).toContainText('Sends')
  await host.screenshot({ path: join(SHOTS, 'productivity-scheduled.png') })
  await host.keyboard.press('Escape')
  await expect(friend.locator('.message', { hasText: 'see you at noon (scheduled)' })).toContainText('Host', { timeout: 15_000 })

  // ── Send later in an encrypted DM: encrypted now, delivered at its time ──
  await friend.locator('.member-list').getByRole('button', { name: 'Host' }).click()
  await friend.getByRole('dialog').getByRole('button', { name: 'Message', exact: true }).click()
  const dmBox = friend.getByPlaceholder('Message Host')
  await dmBox.fill('a secret, a bit later')
  await friend.getByRole('button', { name: 'Send later', exact: true }).click()
  const dmLater = friend.getByRole('dialog', { name: 'Send later' })
  await expect(dmLater).toContainText('Encrypted now')
  await dmLater.getByRole('button', { name: 'Pick a date and time' }).click()
  await dmLater.getByTestId('when-custom').fill(await soon(friend, 4))
  await dmLater.getByRole('button', { name: 'Schedule' }).click()
  await expect(friend.locator('.message-text', { hasText: 'a secret, a bit later' })).toBeVisible({ timeout: 15_000 })
  await host.getByRole('button', { name: 'Direct messages' }).click()
  await host.locator('.dm-row', { hasText: 'Friend' }).click()
  await expect(host.locator('.message-text', { hasText: 'a secret, a bit later' })).toBeVisible({ timeout: 15_000 })

  // A DM can be saved too (hover actions).
  const dm = host.locator('.message', { hasText: 'a secret, a bit later' })
  await dm.hover()
  await dm.getByRole('button', { name: 'Save message' }).click()
  await expect(dm.getByRole('button', { name: 'Remove from saved' })).toBeVisible()

  // ── Edit history: "(edited)" opens the earlier versions ──
  await host.locator('.server-icon[title="Productivity Test"]').click()
  await expect(host.getByRole('heading', { name: 'general' })).toBeVisible()
  await hostBox.fill('first version')
  await hostBox.press('Enter')
  await expect(host.locator('.message-text', { hasText: 'first version' })).toBeVisible()
  await expect(host.locator('.message', { hasText: 'first version' })).not.toHaveClass(/sending/) // stored, so it's the one Up edits
  await hostBox.press('ArrowUp')
  const edit = host.locator('.edit-box textarea')
  await edit.fill('second version')
  await edit.press('Enter')
  const edited = host.locator('.message', { hasText: 'second version' })
  await edited.getByRole('button', { name: '(edited)' }).click()
  const history = host.getByRole('dialog', { name: 'Edit history' })
  await expect(history.locator('.history-item').first()).toContainText('second version')
  await expect(history.locator('.history-item').nth(1)).toContainText('first version')
  await expect(history).toContainText('Original')
  await host.screenshot({ path: join(SHOTS, 'productivity-history.png') })
  await host.keyboard.press('Escape')

  // On a phone: the bell is in the menu, and the inbox fills the screen.
  await host.setViewportSize({ width: 390, height: 844 })
  await host.getByRole('button', { name: 'Open channels' }).click()
  await host.getByRole('button', { name: /^Inbox/ }).click()
  await host.getByRole('dialog', { name: 'Inbox' }).getByRole('tab', { name: 'Saved' }).click()
  await expect(host.locator('.inbox-row', { hasText: 'a secret, a bit later' })).toBeVisible()
  await host.screenshot({ path: join(SHOTS, 'productivity-phone.png') })
})
