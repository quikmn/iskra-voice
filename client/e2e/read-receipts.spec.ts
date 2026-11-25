import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Browser, type Page } from '@playwright/test'
import { createInviteLink, joinVia, openSettings, SHOTS, startServer, type TestServer } from './helpers'

// One server per test: the owner invite works once.
let server: TestServer
test.beforeEach(async () => {
  server = await startServer('Receipts Test')
})
test.afterEach(async () => server?.stop())

async function people(browser: Browser, names: string[]): Promise<Page[]> {
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), names[0])
  const link = await createInviteLink(host)
  const pages = [host]
  for (const name of names.slice(1)) {
    const page = await (await browser.newContext()).newPage()
    await joinVia(page, link, name)
    pages.push(page)
  }
  return pages
}

const home = (page: Page) => page.getByRole('button', { name: 'Direct messages' }).click()

/** Turns "Send read receipts" on or off in My settings → Privacy & data. */
async function receipts(page: Page, on: boolean) {
  await openSettings(page, 'Privacy & data')
  const toggle = page.getByTestId('read-receipt-settings').getByRole('switch', { name: /^Send read receipts/ })
  if (on) await toggle.check()
  else await toggle.uncheck()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0)
}

async function say(page: Page, to: string, text: string) {
  const box = page.getByPlaceholder(`Message ${to}`)
  await box.fill(text)
  await box.press('Enter')
}

const seen = (page: Page) => page.getByTestId('seen')
/** The message right above the "Seen" line. */
const seenUnder = (page: Page) => seen(page).locator('xpath=preceding-sibling::*[1]')

/** Everything the server wrote to its database files, as text. */
function serverBytes(world: string): string {
  return readdirSync(world).filter((f) => f.startsWith('iskra.db')).map((f) => readFileSync(join(world, f)).toString('latin1')).join('')
}

test('read receipts in a DM: off by default, mutual, and kept across a reload', async ({ browser }) => {
  test.setTimeout(150_000)
  const [ana, ben] = await people(browser, ['Ana', 'Ben'])

  // Ben writes to Ana, Ana answers. Nobody turned receipts on: nobody is shown "Seen".
  await ben.locator('.member-list .member', { hasText: 'Ana' }).click({ button: 'right' })
  await ben.getByRole('menuitem', { name: 'Message' }).click()
  await say(ben, 'Ana', 'hi Ana, are you there')
  await home(ana)
  await ana.locator('.dm-row', { hasText: 'Ben' }).click()
  await expect(ana.locator('.message-text', { hasText: 'hi Ana, are you there' })).toBeVisible()
  await say(ana, 'Ben', 'yes, hi Ben')
  await expect(ben.locator('.message-text', { hasText: 'yes, hi Ben' })).toBeVisible()
  await ben.waitForTimeout(1000)
  await expect(seen(ana)).toHaveCount(0)
  await expect(seen(ben)).toHaveCount(0)

  // The switch is off by default and says what it does.
  await openSettings(ana, 'Privacy & data')
  const section = ana.getByTestId('read-receipt-settings')
  await expect(section.getByRole('switch', { name: /^Send read receipts/ })).not.toBeChecked()
  await expect(section).toContainText('While this is off you send none and see none.')
  await section.scrollIntoViewIfNeeded()
  await ana.screenshot({ path: join(SHOTS, 'read-receipts-setting.png') })
  await ana.keyboard.press('Escape')

  // Only Ana turns them on: she sends hers, but Ben (who doesn't) is not shown them, and Ana sees none from Ben.
  await receipts(ana, true)
  await ana.waitForTimeout(1500)
  await expect(seen(ben)).toHaveCount(0)
  await expect(seen(ana)).toHaveCount(0)

  // Ben turns them on too: each sees "Seen" under the last message the other has read.
  await receipts(ben, true)
  await expect(seen(ben)).toHaveCount(1)
  await expect(seen(ben)).toHaveText('Seen')
  await expect(seenUnder(ben)).toContainText('hi Ana, are you there')
  await expect(seen(ana)).toHaveCount(1)
  await expect(seenUnder(ana)).toContainText('yes, hi Ben')

  // A new message is seen as soon as the other side is looking at the conversation: the line moves down.
  await say(ana, 'Ben', 'second one from Ana')
  await expect(ben.locator('.message-text', { hasText: 'second one from Ana' })).toBeVisible()
  await expect(seenUnder(ana)).toContainText('second one from Ana')
  await expect(seen(ana)).toHaveCount(1)
  await ana.screenshot({ path: join(SHOTS, 'read-receipts-dm.png') })

  // After a reload the newest receipt comes back from the server (sealed: only Ana's devices can read it).
  await ana.reload()
  await expect(ana.getByRole('heading', { name: 'general', exact: true })).toBeVisible({ timeout: 15_000 })
  await home(ana)
  await ana.locator('.dm-row', { hasText: 'Ben' }).click()
  await expect(seenUnder(ana)).toContainText('second one from Ana')

  // The server holds receipts but can't read which message they name.
  const bytes = serverBytes(server.world)
  expect(bytes).toContain('dm_receipts')
  expect(bytes).not.toContain('second one from Ana')
  expect(bytes).not.toContain('"receipt"')

  // Ben turns his off: he stops being shown Ana's, and stops sending his own.
  await receipts(ben, false)
  await expect(seen(ben)).toHaveCount(0)
  await say(ana, 'Ben', 'third one from Ana')
  await expect(ben.locator('.message-text', { hasText: 'third one from Ana' })).toBeVisible()
  await ana.waitForTimeout(1500)
  await expect(seenUnder(ana)).toContainText('second one from Ana')
})

test('read receipts in a group show who has seen your message, and work on a phone', async ({ browser }) => {
  test.setTimeout(150_000)
  const [host, bob, carol] = await people(browser, ['Host', 'Bob', 'Carol'])
  for (const page of [host, bob]) await receipts(page, true)

  // Host makes a group and writes.
  await home(host)
  await host.getByRole('button', { name: 'New group' }).first().click()
  const dialog = host.getByRole('dialog', { name: 'New group' })
  await dialog.getByLabel('Group name (optional)').fill('Trip')
  for (const member of ['Bob', 'Carol']) await dialog.locator('.person-pick', { hasText: member }).click()
  await dialog.getByRole('button', { name: 'Create group' }).click()
  await expect(host.locator('.group-title')).toHaveText('Trip')
  await say(host, 'Trip', 'who brings the tent')

  // Bob (receipts on) and Carol (off) both read it; only Bob is shown as having seen it.
  for (const page of [bob, carol]) {
    await home(page)
    await page.locator('.group-row', { hasText: 'Trip' }).click()
    await expect(page.locator('.message-text', { hasText: 'who brings the tent' })).toBeVisible()
  }
  await expect(seen(host)).toHaveCount(1)
  await expect(seen(host)).toHaveAttribute('aria-label', 'Seen by Bob')
  await expect(seenUnder(host)).toContainText('who brings the tent')
  await host.screenshot({ path: join(SHOTS, 'read-receipts-group.png') })

  // Carol turns hers on while looking at the group: now both have seen it.
  await receipts(carol, true)
  await expect(seen(host)).toHaveAttribute('aria-label', /^Seen by (Bob, Carol|Carol, Bob)$/)

  // Bob answers; Host is looking, so Bob sees that Host has seen it. On a phone-sized screen it reads the same.
  await say(bob, 'Trip', 'I have one')
  await expect(host.locator('.message-text', { hasText: 'I have one' })).toBeVisible()
  await expect(seen(bob)).toHaveAttribute('aria-label', /Host/)
  await bob.setViewportSize({ width: 390, height: 844 })
  await expect(seen(bob)).toBeVisible()
  await bob.screenshot({ path: join(SHOTS, 'read-receipts-group-phone.png') })
})
