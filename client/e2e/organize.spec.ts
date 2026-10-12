// Organizing a server: categories (drag and drop, collapse, private ones hidden), notification levels and mutes,
// nicknames; plus the phone menu for moving channels.
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { createInviteLink, joinVia, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Organize Test')
})
test.afterAll(async () => server?.stop())

const row = (page: Page, name: string) => page.locator('.org-row', { has: page.locator('.channel-name', { hasText: new RegExp(`^${name}$`) }) })
const category = (page: Page, name: string) => page.getByRole('region', { name, exact: true })

async function createCategory(page: Page, name: string) {
  await page.getByRole('button', { name: 'Create category' }).click()
  await page.getByRole('dialog', { name: 'Create category' }).getByLabel('Name').fill(name)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(category(page, name)).toBeVisible()
}

async function createChannel(page: Page, button: string, name: string, readRole?: string) {
  await page.getByRole('button', { name: button, exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Create channel' })
  await dialog.getByLabel('Name').fill(name)
  if (readRole) await dialog.getByLabel('Who can see it').selectOption(readRole)
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(dialog).toBeHidden()
}

test('categories, notification levels and nicknames', async ({ browser }) => {
  const host = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const friend = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')

  // ── Categories ──
  await createCategory(host, 'Games')
  await createChannel(host, 'Create channel in Games', 'minecraft')
  await expect(category(host, 'Games').locator('.channel-name', { hasText: 'minecraft' })).toBeVisible()
  // Drag #general into Games, above #minecraft.
  await row(host, 'general').dragTo(row(host, 'minecraft'), { targetPosition: { x: 40, y: 4 } })
  await expect(category(host, 'Games').locator('.channel-name')).toHaveText(['general', 'minecraft'])

  // A category of admin-only channels doesn't exist for the friend.
  await createCategory(host, 'Staff room')
  await createChannel(host, 'Create channel in Staff room', 'staff', 'admin')
  await expect(category(host, 'Staff room').locator('.channel-name')).toHaveText(['staff'])
  await expect(category(friend, 'Games').locator('.channel-name')).toHaveText(['general', 'minecraft'])
  await expect(friend.getByText('Staff room')).toHaveCount(0)
  await expect(friend.getByText('staff', { exact: true })).toHaveCount(0)

  // Collapsing is per person and survives a reload.
  await friend.getByRole('button', { name: 'Games', exact: true }).click()
  await expect(row(friend, 'minecraft')).toBeHidden()
  await expect(row(friend, 'general')).toBeVisible() // the open channel stays in view
  await friend.reload()
  await expect(friend.getByRole('heading', { name: 'general' })).toBeVisible()
  await expect(row(friend, 'minecraft')).toBeHidden()
  await friend.getByRole('button', { name: 'Games', exact: true }).click()
  await expect(row(friend, 'minecraft')).toBeVisible()
  await expect(row(host, 'minecraft')).toBeVisible()

  // ── Notifications: mute #minecraft for an hour ──
  await row(friend, 'minecraft').hover()
  await friend.getByRole('button', { name: '#minecraft options' }).click()
  const menu = friend.getByRole('dialog', { name: '#minecraft options' })
  await menu.getByRole('menuitem', { name: 'Mute channel' }).click()
  await menu.getByRole('menuitem', { name: 'For 1 hour' }).click()
  await expect(menu).toBeHidden()
  await expect(row(friend, 'minecraft').locator('.channel')).toHaveClass(/muted/)

  await row(host, 'minecraft').locator('.channel').click()
  await host.getByPlaceholder('Message #minecraft').fill('anyone online?')
  await host.getByPlaceholder('Message #minecraft').press('Enter')
  await expect(friend.locator('.message', { hasText: 'anyone online?' })).toHaveCount(0)
  await friend.waitForTimeout(400)
  await expect(row(friend, 'minecraft').locator('.channel')).not.toHaveClass(/unread/)
  // Mentions still get through a mute...
  const box = host.getByPlaceholder('Message #minecraft')
  await box.pressSequentially('@Fri')
  await box.press('Enter')
  await box.pressSequentially('you there?')
  await box.press('Enter')
  await expect(row(friend, 'minecraft').locator('.badge')).toHaveText('1')
  await friend.screenshot({ path: join(SHOTS, 'organize-categories.png') })

  // ...unless the level is Nothing.
  await row(friend, 'minecraft').hover()
  await friend.getByRole('button', { name: '#minecraft options' }).click()
  await menu.getByRole('menuitem', { name: 'Notifications' }).click()
  await menu.getByRole('menuitemradio', { name: 'Nothing' }).click()
  await expect(row(friend, 'minecraft').locator('.badge')).toHaveCount(0)
  await row(friend, 'minecraft').hover()
  await friend.getByRole('button', { name: '#minecraft options' }).click()
  await expect(menu.getByRole('menuitem', { name: /Notifications/ })).toContainText('Nothing')
  await friend.screenshot({ path: join(SHOTS, 'organize-menu.png') })
  await expect(menu.getByRole('menuitem', { name: /Unmute channel/ })).toBeVisible()
  await menu.getByRole('menuitem', { name: /Unmute channel/ }).click()
  await expect(row(friend, 'minecraft').locator('.channel')).not.toHaveClass(/muted/)

  // The server-wide level lives in the server's menu, kept by the server (another device sees it).
  const serverMenu = friend.getByRole('dialog', { name: 'Organize Test options' })
  await friend.locator('.server-header-button').click()
  await serverMenu.getByRole('menuitem', { name: /^Notifications/ }).click()
  await serverMenu.getByRole('menuitemradio', { name: 'All messages' }).click()
  await expect(serverMenu).toHaveCount(0)
  await friend.locator('.server-header-button').click()
  await expect(serverMenu.getByRole('menuitem', { name: /^Notifications/ })).toContainText('All messages')
  await serverMenu.getByRole('menuitem', { name: 'Mute server' }).click()
  await serverMenu.getByRole('menuitem', { name: 'For 8 hours' }).click()
  await friend.locator('.server-header-button').click()
  await expect(serverMenu.getByRole('menuitem', { name: /Unmute server/ })).toContainText(/Muted until/)
  await friend.keyboard.press('Escape')
  await expect(row(friend, 'general').locator('.channel')).toHaveClass(/muted/)
  await friend.reload()
  await expect(row(friend, 'general').locator('.channel')).toHaveClass(/muted/)

  // ── Nicknames ──
  await friend.locator('.server-header-button').click()
  await serverMenu.getByRole('menuitem', { name: 'Server nickname…' }).click()
  await friend.getByLabel('Server nickname', { exact: true }).fill('Captain F')
  await friend.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(friend.getByText('Saved.')).toBeVisible()
  await friend.keyboard.press('Escape')
  await expect(friend.locator('.me-bar')).toContainText('Captain F')
  await expect(host.locator('.member-list')).toContainText('Captain F')
  await expect(host.locator('.message', { hasText: 'you there?' }).locator('.mention')).toHaveText('@Captain F')

  // The profile card shows the name too; admins can change it or go back to the name.
  await host.locator('.member-list .member', { hasText: 'Captain F' }).click()
  const card = host.getByRole('dialog', { name: 'Profile of Captain F' })
  await expect(card.locator('.profile-realname')).toHaveText('Name: Friend')
  await card.getByRole('button', { name: 'More' }).click()
  await expect(host.getByRole('dialog', { name: 'Captain F' })).toBeVisible()
  const details = host.locator('.modal', { has: host.getByLabel('Server nickname', { exact: true }) }) // its title follows the nickname
  await details.getByLabel('Server nickname', { exact: true }).fill('Freddie')
  await details.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(friend.locator('.me-bar')).toContainText('Freddie')
  await details.getByRole('button', { name: 'Use their name' }).click()
  await expect(friend.locator('.me-bar')).toContainText('Friend')
  await host.screenshot({ path: join(SHOTS, 'organize-nickname.png') })
})

test('phones arrange channels from a menu', async ({ browser }) => {
  const phoneServer = await startServer('Phone Organize')
  try {
    const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage()
    await joinVia(phone, phoneServer.ownerLink(), 'Owner')
    const openNav = async () => {
      if ((await phone.locator('.shell.panel-nav').count()) === 0) await phone.getByRole('button', { name: 'Open channels' }).click()
    }
    await openNav()
    await createCategory(phone, 'Hangout')
    await createChannel(phone, 'Create channel', 'memes')
    await openNav()

    // The ⋯ button is always there on touch screens; its menu is a sheet.
    await phone.getByRole('button', { name: '#memes options' }).click()
    const sheet = phone.getByRole('dialog', { name: '#memes options' })
    await expect(sheet).toHaveClass(/action-sheet/)
    await sheet.getByRole('menuitem', { name: 'Move up' }).click()
    await expect(phone.locator('.channel-list > .org-row .channel-name')).toHaveText(['memes', 'general'])

    await phone.getByRole('button', { name: '#memes options' }).click()
    await sheet.getByRole('menuitem', { name: /Move to category/ }).click()
    await sheet.getByRole('menuitemradio', { name: 'Hangout' }).click()
    await expect(category(phone, 'Hangout').locator('.channel-name')).toHaveText(['memes'])

    await phone.getByRole('button', { name: 'Hangout options' }).click()
    await expect(phone.getByRole('dialog', { name: 'Hangout options' }).getByRole('menuitem', { name: 'Rename category' })).toBeVisible()
    await phone.waitForTimeout(300) // the sheet slides in
    await phone.screenshot({ path: join(SHOTS, 'organize-phone.png') })
    await phone.getByRole('dialog', { name: 'Hangout options' }).getByRole('menuitem', { name: 'Delete category' }).click()
    await phone.getByRole('button', { name: 'Delete category' }).click()
    await expect(category(phone, 'Hangout')).toHaveCount(0)
    await expect(row(phone, 'memes')).toBeVisible()
  } finally {
    await phoneServer.stop()
  }
})
