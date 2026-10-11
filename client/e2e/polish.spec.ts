// App-wide behaviour: settings navigation by role, Escape closing only the top layer, the quick switcher, and phone message actions.
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { createInviteLink, joinVia, longPress, openSettings, send, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Polish Test')
})
test.afterAll(async () => server?.stop())

test('settings, Escape, quick switcher and phone message actions', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage()
  await joinVia(phone, await createInviteLink(host), 'Phone')

  // Owners see every server section; Profile opens first on a wide screen.
  await openSettings(host)
  const settings = host.getByRole('dialog', { name: 'Settings' })
  const nav = settings.getByRole('navigation', { name: 'Settings sections' })
  await expect(nav.getByRole('button')).toHaveText([
    'Profile', 'Appearance', 'Devices', 'Recovery key', 'App lock', 'Notifications', 'Voice & audio', 'Blocked people',
    'Overview', 'Roles', 'Emoji', 'Soundboard', 'Bots & webhooks', 'Profile pages', 'Open to the internet', 'Audit log', 'Limits', 'Backup & move', 'Import from Discord',
  ])
  await expect(nav.getByRole('button', { name: 'Profile', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(settings.getByLabel('Display name')).toBeVisible()

  // A dialog inside Settings: Escape closes just that one, then Settings.
  await nav.getByRole('button', { name: 'Devices', exact: true }).click()
  await settings.getByRole('button', { name: 'Link a device' }).click()
  await expect(host.getByRole('dialog', { name: 'Link a device' })).toBeVisible()
  await host.keyboard.press('Escape')
  await expect(host.getByRole('dialog', { name: 'Link a device' })).toHaveCount(0)
  await expect(settings).toBeVisible()
  await host.keyboard.press('Escape')
  await expect(settings).toHaveCount(0)

  // Members only see the server's overview; on a phone it's a list, then a section with a back button.
  await phone.getByRole('button', { name: 'Open channels' }).click()
  await openSettings(phone)
  const phoneSettings = phone.getByRole('dialog', { name: 'Settings' })
  const phoneNav = phoneSettings.getByRole('navigation', { name: 'Settings sections' })
  await expect(phoneNav.getByRole('button')).toHaveText(['Profile', 'Appearance', 'Devices', 'Recovery key', 'App lock', 'Notifications', 'Voice & audio', 'Blocked people', 'Overview'])
  await phone.screenshot({ path: join(SHOTS, 'settings-phone-list.png') })
  await phoneNav.getByRole('button', { name: 'Appearance' }).click()
  await expect(phoneSettings.getByRole('heading', { name: 'Appearance' })).toBeVisible()
  await expect(phoneNav).toHaveCount(0)
  await phoneSettings.getByRole('button', { name: 'Back' }).click()
  await expect(phoneNav).toBeVisible()
  await phone.keyboard.press('Escape')
  await phone.keyboard.press('Escape') // and the channels drawer it was opened from
  await expect(phone.locator('.panel-nav')).toHaveCount(0)

  // Ctrl+K jumps to a channel or a conversation.
  await host.getByRole('button', { name: 'Create channel' }).first().click()
  await host.getByLabel('Name').fill('memes')
  await host.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(host.getByRole('heading', { name: 'memes' })).toBeVisible()
  await host.keyboard.press('Control+k')
  const switcher = host.getByRole('dialog', { name: 'Jump to a conversation' })
  await switcher.getByRole('combobox').fill('gen')
  await expect(switcher.getByRole('option').first()).toContainText('general')
  await host.screenshot({ path: join(SHOTS, 'quick-switcher.png') })
  await host.keyboard.press('Enter')
  await expect(switcher).toHaveCount(0)
  await expect(host.getByRole('heading', { name: 'general', exact: true })).toBeVisible()

  // On a phone, press and hold a message for its actions; reply from the sheet.
  await send(host, 'press and hold me')
  const message = phone.locator('.message', { hasText: 'press and hold me' })
  await longPress(phone, message.locator('.message-body'))
  const sheet = phone.getByRole('dialog', { name: 'Message actions' })
  await expect(sheet.getByRole('menuitem', { name: 'Copy text' })).toBeVisible()
  await expect(sheet.getByRole('menuitem', { name: /Pin message|Delete message/ })).toHaveCount(0) // a member, not the author
  await phone.screenshot({ path: join(SHOTS, 'message-sheet-phone.png') })
  await sheet.getByRole('menuitem', { name: 'Reply' }).click()
  await expect(sheet).toHaveCount(0)
  await expect(phone.locator('.reply-bar')).toContainText('Replying to Host')

  // The owner's own message offers edit, pin and delete.
  await host.setViewportSize({ width: 390, height: 844 })
  const own = host.locator('.message', { hasText: 'press and hold me' })
  await longPress(host, own.locator('.message-body'))
  const ownSheet = host.getByRole('dialog', { name: 'Message actions' })
  await expect(ownSheet.getByRole('menuitem')).toHaveText(['Reply', 'Start a thread', 'Pin message', 'Forward', 'Edit message', 'Copy text', 'Copy message link', 'Mark unread', 'Delete message'])
  await host.keyboard.press('Escape')
  await expect(ownSheet).toHaveCount(0)
})
