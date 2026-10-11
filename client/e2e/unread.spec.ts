// One read state behind every unread signal: the sidebar row, the mention badge and the title count agree with the
// "New messages" divider and jump bar; Mark unread moves them together, Esc clears them together, in channels and DMs.
// (Read state is kept per device: the server doesn't sync it, so there's no second-device check here.)
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { createInviteLink, joinVia, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Unread Test')
})
test.afterAll(async () => server?.stop())

const channelRow = (page: Page, name: string) => page.locator('.org-row', { has: page.locator('.channel-name', { hasText: new RegExp(`^${name}$`) }) })

async function say(page: Page, place: string, text: string) {
  const box = page.getByPlaceholder(`Message ${place}`)
  await box.fill(text)
  await box.press('Enter')
}

async function markUnread(page: Page, text: string) {
  const message = page.locator('.message', { hasText: text }).last()
  await message.hover()
  await message.getByRole('button', { name: 'More', exact: true }).click()
  await page.getByRole('menu', { name: 'Message options' }).getByRole('menuitem', { name: 'Mark unread' }).click()
}

test('badges and the New messages divider follow one read state', async ({ browser }) => {
  const host = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const friend = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')
  await host.getByRole('button', { name: 'Create channel', exact: true }).click()
  await host.getByRole('dialog', { name: 'Create channel' }).getByLabel('Name').fill('memes')
  await host.getByRole('dialog', { name: 'Create channel' }).getByRole('button', { name: 'Create', exact: true }).click()
  await channelRow(host, 'memes').locator('.channel').click()

  const memes = channelRow(friend, 'memes').locator('.channel')
  const divider = friend.locator('#unread-divider')

  // ── Unread elsewhere: the row, its mention badge and the title count ──
  await say(host, '#memes', 'meme one')
  await say(host, '#memes', '@everyone meme two')
  await say(host, '#memes', 'meme three')
  await expect(memes).toHaveClass(/unread/)
  await expect(channelRow(friend, 'memes').locator('.badge')).toHaveText('1')
  await expect(friend).toHaveTitle('(1) Iskra')

  // Opening it: the badges clear and the divider sits above the first of the three, with the same count in the bar.
  await memes.click()
  await expect(divider).toHaveCount(1)
  await expect(divider.locator('+ .message')).toContainText('meme one')
  await expect(memes).not.toHaveClass(/unread/)
  await expect(friend).toHaveTitle('Iskra')
  await friend.screenshot({ path: join(SHOTS, 'unread-divider.png') })

  // ── Mark unread moves the divider and the badge together ──
  await markUnread(friend, 'meme two')
  await expect(divider.locator('+ .message')).toContainText('meme two')
  await expect(memes).toHaveClass(/unread/)
  await expect(friend).toHaveTitle('(1) Iskra') // the @everyone in it counts again
  await friend.screenshot({ path: join(SHOTS, 'unread-marked.png') })

  // ── Esc clears both ──
  await friend.locator('.chat-header').click() // focus the page, not the message box
  await friend.keyboard.press('Escape')
  await expect(divider).toHaveCount(0)
  await expect(memes).not.toHaveClass(/unread/)
  await expect(friend).toHaveTitle('Iskra')

  // ── Marked unread, away and back: still unread while away, the divider at the same message on return ──
  await markUnread(friend, 'meme three')
  await channelRow(friend, 'general').locator('.channel').click()
  await expect(memes).toHaveClass(/unread/)
  await expect(divider).toHaveCount(0)
  await memes.click()
  await expect(divider.locator('+ .message')).toContainText('meme three')
  await expect(memes).not.toHaveClass(/unread/)
  await friend.locator('.chat-header').click()
  await friend.keyboard.press('Escape')
  await expect(divider).toHaveCount(0)

  // ── DMs: the Home badge and the DM row count, then the divider when you open it ──
  await host.locator('.member-list').getByRole('button', { name: 'Friend' }).click()
  await host.getByRole('dialog').getByRole('button', { name: 'Message', exact: true }).click()
  await say(host, 'Friend', 'are you coming?')
  await say(host, 'Friend', 'bring snacks')
  await expect(friend.locator('.server-icon.home .badge')).toHaveText('2')
  await expect(friend).toHaveTitle('(2) Iskra')
  await friend.getByRole('button', { name: 'Direct messages' }).click()
  await expect(friend.locator('.dm-row', { hasText: 'Host' }).locator('.badge')).toHaveText('2')
  await friend.locator('.dm-row', { hasText: 'Host' }).click()
  await expect(divider.locator('+ .message')).toContainText('are you coming?')
  await expect(friend.locator('.dm-row', { hasText: 'Host' }).locator('.badge')).toHaveCount(0)
  await expect(friend).toHaveTitle('Iskra')
  await friend.screenshot({ path: join(SHOTS, 'unread-dm.png') })
  await friend.locator('.chat-header').click()
  await friend.keyboard.press('Escape')
  await expect(divider).toHaveCount(0)
})
