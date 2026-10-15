// My settings vs the server room: the gear opens only personal settings; a server's menu opens that server's own
// full-window settings, named in a band in its colour, and pinned to it whatever server you're looking at.
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { createInviteLink, joinVia, longPress, openSettings, serverRoom, SHOTS, startServer } from './helpers'

/** Lets the open/slide animations finish, so screenshots show the settled view. */
const settled = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => null))))

const MINE = ['Profile', 'Appearance', 'Language', 'Devices', 'Recovery key', 'App lock', 'Notifications', 'Voice & audio', 'Camera', 'Blocked people', 'Account', 'Privacy & data', 'About & legal']
const SERVER_SECTIONS = [
  'Overview', 'Channels', 'Voice', 'Emoji & stickers', 'GIFs', 'Soundboard', 'Profile pages', 'Server rules', 'Translation',
  'Members', 'Roles', 'Reports', 'AutoMod', 'Activity log', 'Sign-ins & security',
  'Bots & webhooks', 'Bug inbox',
  'Internet access', 'Limits', 'Backup & move', 'Import from Discord', 'Server updates',
]

test('the server room belongs to one server; My settings has no server sections', async ({ browser }) => {
  const hangout = await startServer('Hangout')
  const dungeon = await startServer('Dungeon')
  const host = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
  await joinVia(host, hangout.ownerLink(), 'Host')
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')
  await host.goto(dungeon.ownerLink())
  await host.getByRole('button', { name: 'Join server' }).click()
  await expect(host.locator('.server-header-button')).toContainText('Dungeon')
  const rail = (name: string) => host.locator('.server-rail').getByTitle(name, { exact: true })

  // Dungeon is open; right-click Hangout in the rail: the common things flat, the rest under More settings.
  await rail('Hangout').click({ button: 'right' })
  const menu = host.getByRole('dialog', { name: 'Hangout options' })
  await expect(menu.getByRole('menuitem')).toHaveText([
    'Invite friends', 'Create channel…', 'Server settings', 'Members', 'Roles', 'Reports', 'More settings',
    /^Notifications/, /^Mute server/, /^Notify me for LFG/, 'Server nickname…', 'Mark as read', 'Move / Folder', 'Hide server', 'Leave server',
  ])
  await settled(host)
  await host.screenshot({ path: join(SHOTS, 'server-room-menu.png') })
  await menu.getByRole('menuitem', { name: 'Roles', exact: true }).click()

  // The room for THAT server: its name in the band, only its sections, Roles open.
  const room = serverRoom(host, 'Hangout')
  await expect(room).toBeVisible()
  await expect(room.getByRole('heading', { name: 'Hangout', level: 1 })).toBeVisible()
  await expect(room).toContainText('Server settings · your role: owner')
  const nav = room.getByRole('navigation', { name: 'Settings sections' })
  await expect(nav.getByRole('button')).toHaveText(SERVER_SECTIONS)
  for (const group of ['Server', 'Members & safety', 'Apps', 'Hosting & data']) await expect(nav.getByText(group, { exact: true })).toBeVisible()
  await expect(nav.getByRole('button', { name: 'Roles', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(nav.getByRole('button', { name: 'Profile', exact: true })).toHaveCount(0)
  await expect(host).toHaveTitle('Hangout · Server settings — Iskra')
  // The band is in the server's own colour, not the theme's.
  const band = await room.locator('.room-band').evaluate((el) => getComputedStyle(el).backgroundImage)
  expect(band).toContain('rgb(')
  await settled(host)
  await host.screenshot({ path: join(SHOTS, 'server-room-desktop.png') })

  // Members: everyone, each opening their member dialog on top of the room.
  await nav.getByRole('button', { name: 'Members', exact: true }).click()
  await room.getByRole('button', { name: /^Friend/ }).click()
  await expect(host.getByRole('dialog', { name: 'Friend' })).toBeVisible()
  await host.keyboard.press('Escape')
  await expect(host.getByRole('dialog', { name: 'Friend' })).toHaveCount(0)
  await expect(room).toBeVisible()

  // Esc closes it; the window is the chat again.
  await host.keyboard.press('Escape')
  await expect(room).toHaveCount(0)
  await expect(host.locator('.server-header-button')).toContainText('Dungeon')

  // The dropdown above the channels opens the room of the server you're looking at, via More settings.
  await host.locator('.server-header-button').click()
  await host.getByRole('menuitem', { name: 'More settings' }).click()
  await host.getByRole('menuitem', { name: 'Activity log' }).click()
  const dungeonRoom = serverRoom(host, 'Dungeon')
  await expect(dungeonRoom.getByRole('heading', { name: 'Dungeon', level: 1 })).toBeVisible()
  await expect(dungeonRoom.getByRole('button', { name: 'Activity log', exact: true })).toHaveAttribute('aria-current', 'page')
  // The browser's back button closes it too.
  await host.goBack()
  await expect(dungeonRoom).toHaveCount(0)

  // Switch to Hangout and open its room: Hangout's name, not Dungeon's.
  await rail('Hangout').click()
  await expect(host.locator('.server-header-button')).toContainText('Hangout')
  await host.locator('.server-header-button').click()
  await host.getByRole('menuitem', { name: 'Server settings', exact: true }).click()
  await expect(serverRoom(host, 'Hangout').getByRole('heading', { name: 'Hangout', level: 1 })).toBeVisible()
  await expect(serverRoom(host, 'Hangout').getByRole('button', { name: 'Overview', exact: true })).toHaveAttribute('aria-current', 'page')
  await serverRoom(host, 'Hangout').getByRole('button', { name: 'Close' }).click()
  await expect(serverRoom(host)).toHaveCount(0)

  // The gear by your name: My settings, only about you.
  await openSettings(host)
  const mine = host.getByRole('dialog', { name: 'Settings' })
  await expect(mine.getByRole('heading', { name: 'My settings', level: 1 })).toBeVisible()
  await expect(mine.getByRole('navigation', { name: 'Settings sections' }).getByRole('button')).toHaveText(MINE)
  for (const section of ['Overview', 'Roles', 'Activity log', 'Internet access']) await expect(mine.getByRole('button', { name: section, exact: true })).toHaveCount(0)
  await expect(mine).not.toContainText('Hangout')
  await settled(host)
  await host.screenshot({ path: join(SHOTS, 'my-settings-desktop.png') })
  await host.keyboard.press('Escape')
  await expect(mine).toHaveCount(0)

  // The person menu's way to roles leads to the room too.
  await host.locator('.member-list').getByRole('button', { name: /^Friend/ }).click({ button: 'right' })
  await host.getByRole('menuitem', { name: 'Create a role…' }).click()
  await expect(serverRoom(host, 'Hangout').getByRole('button', { name: 'Roles', exact: true })).toHaveAttribute('aria-current', 'page')
  await host.keyboard.press('Escape')

  // A member with no admin rights: no Server settings at all, just their own things.
  await friend.locator('.server-rail').getByTitle('Hangout', { exact: true }).click({ button: 'right' })
  const theirs = friend.getByRole('dialog', { name: 'Hangout options' })
  await expect(theirs.getByRole('menuitem')).toHaveText(['Invite friends', /^Notifications/, /^Mute server/, /^Notify me for LFG/, 'Server nickname…', 'Mark as read', 'Move / Folder', 'Hide server', 'Leave server'])
  await settled(friend)
  await friend.screenshot({ path: join(SHOTS, 'server-room-member-menu.png') })
  await theirs.getByRole('menuitem', { name: 'Server nickname…' }).click()
  await friend.getByLabel('Server nickname', { exact: true }).fill('Pal')
  await friend.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(friend.locator('.me-bar')).toContainText('Pal')
  await friend.keyboard.press('Escape')

  await hangout.stop()
  await dungeon.stop()
})

test('phone: the server room is a page stack under the server band', async ({ browser }) => {
  const own = await startServer('Pocket Place')
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage()
  await joinVia(phone, own.ownerLink(), 'Phone')

  // Press and hold the server tile: the same menu, as a sheet.
  await phone.getByRole('button', { name: 'Open channels' }).click()
  await longPress(phone, phone.locator('.server-rail').getByTitle('Pocket Place', { exact: true }))
  const sheet = phone.getByRole('dialog', { name: 'Pocket Place options' })
  await sheet.getByRole('menuitem', { name: 'Server settings', exact: true }).click()

  // First page: the band and the grouped list.
  const room = serverRoom(phone, 'Pocket Place')
  await expect(room.getByRole('heading', { name: 'Pocket Place', level: 1 })).toBeVisible()
  const nav = room.getByRole('navigation', { name: 'Settings sections' })
  await expect(nav.getByRole('button', { name: 'Roles', exact: true })).toBeVisible()
  await settled(phone)
  await phone.screenshot({ path: join(SHOTS, 'server-room-phone-list.png') })

  // A section page keeps a slim band: "[tile] Pocket Place › Roles". Back goes up a level.
  await nav.getByRole('button', { name: 'Roles', exact: true }).click()
  await expect(room.getByRole('heading', { name: /^Pocket Place.*Roles$/ })).toBeVisible()
  await expect(nav).toHaveCount(0)
  await settled(phone)
  await phone.screenshot({ path: join(SHOTS, 'server-room-phone-section.png') })
  await room.getByRole('button', { name: 'Back' }).click()
  await expect(nav).toBeVisible()
  // The phone's back button goes up a level too, then closes.
  await nav.getByRole('button', { name: 'Activity log', exact: true }).click()
  await expect(room.getByRole('heading', { name: /Activity log/ })).toBeVisible()
  await phone.goBack()
  await expect(nav).toBeVisible()
  await expect(room).toBeVisible()
  // ✕ returns to chat.
  await room.getByRole('button', { name: 'Close' }).click()
  await expect(room).toHaveCount(0)

  // My settings on a phone: the grey band with your name, the list, no server sections.
  await openSettings(phone)
  const mine = phone.getByRole('dialog', { name: 'Settings' })
  await expect(mine.getByRole('heading', { name: 'My settings', level: 1 })).toBeVisible()
  await expect(mine.getByRole('navigation', { name: 'Settings sections' }).getByRole('button')).toHaveText(MINE)
  await settled(phone)
  await phone.screenshot({ path: join(SHOTS, 'my-settings-phone.png') })
  await phone.keyboard.press('Escape')
  await expect(mine).toHaveCount(0)

  // Create channel fits the phone: its five channel types wrap instead of pushing Create off the screen.
  // The channels drawer is still open from My settings.
  await phone.locator('.nav-column').getByRole('button', { name: 'Create channel' }).first().click()
  const create = phone.getByRole('dialog', { name: 'Create channel' })
  await expect(create.getByRole('radio', { name: 'Docs' })).toBeVisible()
  await phone.waitForTimeout(400) // the dialog pops in
  for (const part of [create, create.getByRole('radio', { name: 'Docs' }), create.getByRole('button', { name: 'Create', exact: true })]) {
    const box = (await part.boundingBox())!
    expect(box.x + box.width).toBeLessThanOrEqual(390)
  }
  await phone.keyboard.press('Escape')
  await own.stop()
})
