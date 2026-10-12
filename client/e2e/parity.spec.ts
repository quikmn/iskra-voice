// Discord-parity bits: forwarding (to a channel and a DM, without leaking private channel names), unread
// navigation (divider, jump bar, Alt+↓, Esc, Shift+Esc), the shortcuts list, and server folders on the rail.
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { createInviteLink, joinVia, longPress, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
let second: TestServer
test.beforeAll(async () => {
  server = await startServer('Parity Test')
  second = await startServer('Second Place')
})
test.afterAll(async () => {
  await server?.stop()
  await second?.stop()
})

const channelRow = (page: Page, name: string) => page.locator('.org-row', { has: page.locator('.channel-name', { hasText: new RegExp(`^${name}$`) }) })

async function say(page: Page, channel: string, text: string) {
  const box = page.getByPlaceholder(`Message #${channel}`)
  await box.fill(text)
  await box.press('Enter')
}

async function createChannel(page: Page, name: string, readRole?: string) {
  await page.getByRole('button', { name: 'Create channel', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Create channel' })
  await dialog.getByLabel('Name').fill(name)
  if (readRole) await dialog.getByLabel('Who can see it').selectOption(readRole)
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(dialog).toBeHidden()
}

async function forward(page: Page, text: string, target: string) {
  const message = page.locator('.message', { hasText: text }).last()
  await message.hover()
  await message.getByRole('button', { name: 'Forward' }).click()
  const dialog = page.getByRole('dialog', { name: 'Forward message' })
  await dialog.getByLabel('Search channels and people').fill(target.replace(/^#/, ''))
  await dialog.getByRole('button', { name: `Forward to ${target}`, exact: true }).click()
  await expect(dialog).toBeHidden()
}

test('forwarding, unread navigation and shortcuts', async ({ browser }) => {
  const host = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const friend = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')
  await createChannel(host, 'memes')
  await createChannel(host, 'staff', 'admin')
  await channelRow(host, 'general').locator('.channel').click()

  // ── Forward to a channel ──
  await say(friend, 'general', 'pizza at 8?')
  await expect(host.locator('.message', { hasText: 'pizza at 8?' })).toBeVisible()
  await forward(host, 'pizza at 8?', '#memes')
  await channelRow(friend, 'memes').locator('.channel').click()
  const copy = friend.locator('.message', { hasText: 'pizza at 8?' })
  await expect(copy.locator('.forwarded-line')).toHaveText('Forwarded from #general')
  await copy.getByRole('button', { name: '#general' }).click()
  await expect(friend.getByRole('heading', { name: 'general' })).toBeVisible()

  // A private channel's message, forwarded somewhere public, doesn't name it.
  await channelRow(host, 'staff').locator('.channel').click()
  await say(host, 'staff', 'surprise party friday')
  await forward(host, 'surprise party friday', '#general')
  const leaked = friend.locator('.message', { hasText: 'surprise party friday' })
  await expect(leaked.locator('.forwarded-line')).toHaveText('Forwarded')
  await expect(friend.getByText('staff')).toHaveCount(0)

  // ── Forward to a DM (re-encrypted like any DM) ──
  await channelRow(host, 'general').locator('.channel').click()
  await forward(host, 'pizza at 8?', 'Friend')
  await expect(friend.locator('.server-icon.home .badge')).toHaveText('1')
  await friend.getByRole('button', { name: 'Direct messages' }).click()
  await friend.locator('.dm-row', { hasText: 'Host' }).click()
  const dm = friend.locator('.message', { hasText: 'pizza at 8?' })
  await expect(dm.locator('.forwarded-line')).toHaveText('Forwarded from #general on Parity Test')
  await friend.screenshot({ path: join(SHOTS, 'parity-forward-dm.png') })
  await friend.getByRole('button', { name: 'PT', exact: true }).click()

  // ── Unread: Alt+↓ goes to the next unread channel, with a divider and a jump bar ──
  await channelRow(friend, 'general').locator('.channel').click()
  const tall = (n: number) => Array.from({ length: 14 }, (_, i) => `line ${i + 1} of note ${n}`).join('\n')
  await channelRow(host, 'memes').locator('.channel').click()
  for (const n of [1, 2, 3]) await say(host, 'memes', tall(n))
  await expect(channelRow(friend, 'memes').locator('.channel')).toHaveClass(/unread/)
  await friend.locator('.chat-header').click() // focus the page, not the message box
  await friend.keyboard.press('Alt+ArrowDown')
  await expect(friend.getByRole('heading', { name: 'memes' })).toBeVisible()
  await expect(friend.locator('#unread-divider')).toHaveCount(1)
  const bar = friend.locator('.unread-bar')
  await expect(bar).toContainText('3 new messages')
  await friend.screenshot({ path: join(SHOTS, 'parity-unread.png') })
  await bar.getByRole('button', { name: /Jump to first unread/ }).click()
  await expect(friend.locator('#unread-divider')).toBeInViewport()
  await expect(bar).toBeHidden()
  // Esc marks the channel read: the divider goes.
  await friend.keyboard.press('Escape')
  await expect(friend.locator('#unread-divider')).toHaveCount(0)

  // Shift+Esc marks the whole server read.
  await channelRow(host, 'general').locator('.channel').click()
  await say(host, 'general', 'one more thing')
  await expect(channelRow(friend, 'general').locator('.channel')).toHaveClass(/unread/)
  await friend.keyboard.press('Shift+Escape')
  await expect(channelRow(friend, 'general').locator('.channel')).not.toHaveClass(/unread/)

  // ── Ctrl+/ lists every shortcut ──
  await friend.keyboard.press('Control+/')
  const help = friend.getByRole('dialog', { name: 'Keyboard shortcuts' })
  await expect(help).toContainText('Next unread channel')
  await expect(help).toContainText('Mark the whole server as read')
  await friend.screenshot({ path: join(SHOTS, 'parity-shortcuts.png') })
  await friend.keyboard.press('Escape')
  await expect(help).toBeHidden()
})

test('server folders on the rail, synced through the servers', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  const page = await context.newPage()
  await joinVia(page, second.ownerLink(), 'Owner')
  // A second server for the same account.
  const other = await (await browser.newContext()).newPage()
  const another = await startServer('Third Base')
  try {
    await joinVia(other, another.ownerLink(), 'Other')
    await page.goto(await createInviteLink(other))
    await page.getByRole('button', { name: 'Join server' }).click()
    await expect(page.getByRole('button', { name: 'TB', exact: true })).toBeVisible()

    // Drag Third Base onto Second Place: a folder.
    const icon = (name: string) => page.locator('.server-rail').getByTitle(name, { exact: true })
    await icon('Third Base').dragTo(icon('Second Place'), { targetPosition: { x: 24, y: 24 } })
    const folder = page.locator('.rail-folder')
    await expect(folder.locator('.server-icon[title="Second Place"]')).toBeVisible()
    await expect(folder.locator('.server-icon[title="Third Base"]')).toBeVisible()

    // Name and colour it.
    await folder.locator('.folder-icon').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Folder settings' }).click()
    const dialog = page.getByRole('dialog', { name: 'Folder settings' })
    await dialog.getByLabel('Folder name').fill('Hangouts')
    await dialog.getByRole('radio', { name: 'Colour #4ade80' }).click()
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await icon('Second Place').click() // look elsewhere, so Third Base's messages count as unread
    await page.getByRole('button', { name: 'Folder Hangouts' }).click() // collapse
    await expect(folder).toHaveClass(/collapsed/)

    // A mention on a server in the folder shows on the folder.
    const box = other.getByPlaceholder('Message #general')
    await box.pressSequentially('@Own')
    await expect(other.locator('.mention-popup')).toContainText('Owner')
    await box.press('Enter')
    await box.pressSequentially('hello in there')
    await box.press('Enter')
    await expect(page.getByRole('button', { name: 'Folder Hangouts' }).locator('.badge')).toHaveText('1')
    await page.screenshot({ path: join(SHOTS, 'parity-folders.png') })

    // The layout lives on the servers too (encrypted): forget it here and it comes back.
    await page.evaluate(() => localStorage.removeItem('iskra.rail'))
    await page.reload()
    await expect(page.getByRole('button', { name: 'Folder Hangouts' })).toBeVisible()

    // Phones: press and hold a server for its menu.
    const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage()
    await joinVia(phone, await createInviteLink(other), 'Pocket')
    await phone.getByRole('button', { name: 'Open channels' }).click()
    await longPress(phone, phone.locator('.server-rail').getByTitle('Third Base', { exact: true }))
    const sheet = phone.getByRole('dialog', { name: 'Third Base options' })
    await expect(sheet.getByRole('menuitem', { name: 'Mark as read' })).toBeVisible()
    await sheet.getByRole('menuitem', { name: 'Move / Folder' }).click()
    await sheet.getByRole('menuitem', { name: 'New folder' }).click()
    const settings = phone.getByRole('dialog', { name: 'Folder settings' })
    await settings.getByLabel('Folder name').fill('Mine')
    await settings.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(phone.getByRole('button', { name: 'Folder Mine' })).toBeVisible()
  } finally {
    await another.stop()
  }
})
