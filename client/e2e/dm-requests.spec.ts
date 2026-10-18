// Who can message me and message requests, against a real server: Bea takes new DMs as requests. Cal's first DM lands
// in her Message requests, without a badge, links shown as plain text until she accepts; Dan's is ignored without him
// knowing; with "Only people I've talked to" even the owner can't start a new conversation with her.
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { createInviteLink, joinVia, openSettings, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('DM Requests Test')
})
test.afterAll(async () => server?.stop())

async function dmFromMemberList(page: Page, name: string, text: string) {
  await page.getByRole('navigation', { name: 'Servers' }).getByRole('button', { name: 'DM Requests Test' }).click()
  await page.locator('.member-list').getByRole('button', { name }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Message', exact: true }).click()
  const box = page.getByPlaceholder(`Message ${name}`)
  await box.fill(text)
  await box.press('Enter')
}

test('new DMs wait as message requests, and the sender is never told', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const link = await createInviteLink(host)
  const bea = await (await browser.newContext()).newPage()
  await joinVia(bea, link, 'Bea')
  const cal = await (await browser.newContext()).newPage()
  await joinVia(cal, link, 'Cal')
  const dan = await (await browser.newContext()).newPage()
  await joinVia(dan, link, 'Dan')

  // Bea: My settings → Privacy & data → Who can message me.
  await openSettings(bea, 'Privacy & data')
  const settings = bea.getByTestId('dm-privacy-settings')
  await expect(settings.getByRole('radio', { name: /Anyone on my servers/ })).toBeChecked()
  await settings.getByRole('radio', { name: /Anyone, as a message request/ }).check()
  await expect(settings.getByRole('radio', { name: /Anyone, as a message request/ })).toBeChecked()
  await settings.screenshot({ path: join(SHOTS, 'dm-privacy-setting.png') })
  await bea.keyboard.press('Escape')

  // Cal writes first. For him it's an ordinary sent message.
  await dmFromMemberList(cal, 'Bea', 'hi Bea! my clips: https://example.com/clips')
  await expect(cal.locator('.message-text', { hasText: 'hi Bea!' })).toBeVisible()
  await expect(cal.locator('.message-failed')).toHaveCount(0)

  // Bea: in Message requests (name only), not in her conversations, no unread badge.
  await bea.getByRole('button', { name: 'Direct messages' }).click()
  const request = bea.getByTestId('dm-request-row').filter({ hasText: 'Cal' })
  await expect(request).toBeVisible()
  await expect(bea.getByTestId('dm-requests')).not.toContainText('hi Bea')
  await expect(bea.locator('.dm-row:not(.dm-request-row)', { hasText: 'Cal' })).toHaveCount(0)
  await expect(bea.locator('.server-icon.home .badge')).toHaveCount(0)

  // Opened: plain text, the link isn't a link yet, no composer until she answers.
  await request.click()
  await expect(bea.locator('.held-text', { hasText: 'https://example.com/clips' })).toBeVisible()
  await expect(bea.locator('.messages a[href="https://example.com/clips"]')).toHaveCount(0)
  const bar = bea.getByTestId('dm-request-bar')
  await expect(bar).toContainText('Cal wants to message you.')
  await expect(bea.getByPlaceholder('Message Cal')).toHaveCount(0)
  await bea.screenshot({ path: join(SHOTS, 'dm-request.png') })

  // Accept: it becomes an ordinary conversation, and the link a link.
  await bar.getByRole('button', { name: 'Accept' }).click()
  await expect(bea.getByPlaceholder('Message Cal')).toBeVisible()
  await expect(bea.locator('.messages a[href="https://example.com/clips"]')).toBeVisible()
  await expect(bea.locator('.dm-row:not(.dm-request-row)', { hasText: 'Cal' })).toBeVisible()
  await expect(bea.getByTestId('dm-requests')).toHaveCount(0)
  await bea.getByPlaceholder('Message Cal').fill('hey Cal')
  await bea.getByPlaceholder('Message Cal').press('Enter')
  await expect(cal.locator('.message-text', { hasText: 'hey Cal' })).toBeVisible()

  // Dan writes too; on a phone, Bea ignores him. He still just sees his message as sent.
  await dmFromMemberList(dan, 'Bea', 'psst')
  await expect(dan.locator('.message-text', { hasText: 'psst' })).toBeVisible()
  await bea.setViewportSize({ width: 390, height: 844 })
  await bea.getByRole('button', { name: 'Open menu' }).first().click()
  await bea.getByTestId('dm-request-row').filter({ hasText: 'Dan' }).click()
  await expect(bea.locator('.held-text', { hasText: 'psst' })).toBeVisible()
  for (const name of ['Accept', 'Ignore', 'Block']) await expect(bea.getByTestId('dm-request-bar').getByRole('button', { name })).toBeInViewport()
  await bea.waitForTimeout(400) // the drawer slides away
  await bea.screenshot({ path: join(SHOTS, 'dm-request-phone.png') })
  await bea.getByTestId('dm-request-bar').getByRole('button', { name: 'Ignore' }).click()
  await expect(bea.getByTestId('dm-request-bar')).toContainText('You ignored the request from Dan.')
  await dan.getByPlaceholder('Message Bea').fill('hello?')
  await dan.getByPlaceholder('Message Bea').press('Enter')
  await expect(dan.locator('.message-text', { hasText: 'hello?' })).toBeVisible()
  await expect(dan.locator('.message-failed')).toHaveCount(0)
  await bea.setViewportSize({ width: 1280, height: 800 })

  // "Only people I've talked to": the owner can't start a conversation now; Cal still can write.
  await openSettings(bea, 'Privacy & data')
  await bea.getByTestId('dm-privacy-settings').getByRole('radio', { name: /Only people I've talked to/ }).check()
  await bea.keyboard.press('Escape')
  await bea.waitForTimeout(1000) // the choice goes to the server in the background
  await dmFromMemberList(host, 'Bea', 'knock knock')
  await expect(host.locator('.message-failed')).toContainText("This person isn't taking new direct messages right now.")
  await cal.getByPlaceholder('Message Bea').fill('still here')
  await cal.getByPlaceholder('Message Bea').press('Enter')
  await bea.locator('.dm-row:not(.dm-request-row)', { hasText: 'Cal' }).click()
  await expect(bea.locator('.message-text', { hasText: 'still here' })).toBeVisible()

  // A device whose clock runs an hour ahead still changes the setting: it's stamped by the server's clock.
  const ahead = await browser.newContext()
  await ahead.addInitScript(() => {
    const real = Date.now.bind(Date)
    Date.now = () => real() + 3_600_000
  })
  const fay = await ahead.newPage()
  await joinVia(fay, link, 'Fay')
  const gus = await (await browser.newContext()).newPage()
  await joinVia(gus, link, 'Gus')

  await openSettings(fay, 'Privacy & data')
  const faySettings = fay.getByTestId('dm-privacy-settings')
  await faySettings.getByRole('radio', { name: /Only people I've talked to/ }).check()
  await fay.waitForTimeout(1000) // the choice goes to the server in the background
  await expect(faySettings.getByTestId('dm-privacy-refused')).toHaveCount(0)
  await fay.keyboard.press('Escape')

  await dmFromMemberList(gus, 'Fay', 'hi Fay')
  await expect(gus.locator('.message-failed')).toContainText("This person isn't taking new direct messages right now.")
})
