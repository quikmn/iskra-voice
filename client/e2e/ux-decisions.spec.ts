// The owner's UX decisions: Hide server (only off your list) vs Leave server (really leaves), "All messages" by
// default on a small server, example placeholders that look like examples, and the admin's way to turn on GIFs.
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { createInviteLink, joinVia, openSettings, SHOTS, startServer } from './helpers'

test('hide vs leave, small-server notifications, example placeholders, GIF setup', async ({ browser }) => {
  const server = await startServer('Weekend Crew')
  const host = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const friend = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')
  const friendIcon = friend.locator('.server-rail .server-icon[title="Weekend Crew"]')
  await expect(friendIcon).toBeVisible()

  // A small server: with nothing chosen, you hear about every message.
  await friendIcon.click({ button: 'right' })
  const menu = friend.getByRole('dialog', { name: 'Weekend Crew options' })
  await expect(menu.getByRole('menuitem', { name: /^Notifications/ })).toContainText('All messages')

  // Hide server: off the list, still a member, and My settings → Appearance brings it back.
  await menu.getByRole('menuitem', { name: 'Hide server' }).click()
  const hide = friend.getByRole('dialog', { name: 'Hide Weekend Crew?' })
  await expect(hide).toContainText('You stay a member')
  await expect(hide).toContainText('My settings → Appearance → Hidden servers')
  await friend.screenshot({ path: join(SHOTS, 'ux-hide-confirm.png') })
  await hide.getByRole('button', { name: 'Hide server' }).click()
  await expect(friendIcon).toHaveCount(0)
  await expect(host.locator('.member-list').getByRole('button', { name: /Friend/ })).toBeVisible()
  await openSettings(friend, 'Appearance')
  const hidden = friend.getByRole('dialog', { name: 'Settings' }).locator('.hidden-servers')
  await expect(hidden.getByText('Weekend Crew')).toBeVisible()
  await hidden.scrollIntoViewIfNeeded()
  await friend.screenshot({ path: join(SHOTS, 'ux-hidden-servers.png') })
  await hidden.getByRole('button', { name: 'Show again' }).click()
  await expect(hidden.getByText('No hidden servers.', { exact: false })).toBeVisible()
  await friend.keyboard.press('Escape')
  await expect(friendIcon).toBeVisible()

  // The owner can't leave without handing the server over first, and is told how.
  await host.locator('.server-rail .server-icon[title="Weekend Crew"]').click({ button: 'right' })
  await host.getByRole('dialog', { name: 'Weekend Crew options' }).getByRole('menuitem', { name: 'Leave server' }).click()
  const ownerLeave = host.getByRole('dialog', { name: 'Leave Weekend Crew?' })
  await expect(ownerLeave).toContainText("You own Weekend Crew, so you can't leave it yet.")
  await expect(ownerLeave).toContainText('Transfer ownership')
  await host.screenshot({ path: join(SHOTS, 'ux-owner-cant-leave.png') })
  await ownerLeave.getByRole('button', { name: 'OK' }).click()

  // Example placeholders read as examples, in a dimmer colour than typed text.
  await host.getByRole('button', { name: 'Create channel' }).first().click()
  const create = host.getByRole('dialog', { name: 'Create channel' })
  const name = create.getByPlaceholder('e.g. game-night')
  await expect(name).toBeVisible()
  const colours = await name.evaluate((input) => ({ text: getComputedStyle(input).color, placeholder: getComputedStyle(input, '::placeholder').color }))
  expect(colours.placeholder).not.toBe(colours.text)
  await host.screenshot({ path: join(SHOTS, 'ux-placeholder.png') })
  await host.keyboard.press('Escape')

  // GIFs off: the admin gets a button straight to the setup, which walks through the three steps.
  await host.getByRole('button', { name: 'GIFs', exact: true }).click()
  await host.getByRole('button', { name: 'Set up GIFs' }).click()
  const room = host.getByRole('dialog', { name: 'Weekend Crew · Server settings' })
  await expect(room.getByRole('heading', { name: 'GIFs', exact: true })).toBeVisible()
  const steps = room.locator('.gif-steps > li')
  await expect(steps).toHaveCount(3)
  await expect(steps.nth(0).getByRole('link', { name: 'Open KLIPY' })).toHaveAttribute('href', /klipy\.com/)
  await expect(room.getByRole('radio', { name: /Through this server/ })).toBeChecked()
  await expect(room.getByText("KLIPY sees their IP addresses", { exact: false })).toBeVisible()
  await host.screenshot({ path: join(SHOTS, 'ux-gif-setup.png') })
  await host.keyboard.press('Escape')

  // Leave server: really leaves. The friend drops off the member list and the server off their list.
  await friendIcon.click({ button: 'right' })
  await friend.getByRole('dialog', { name: 'Weekend Crew options' }).getByRole('menuitem', { name: 'Leave server' }).click()
  const leave = friend.getByRole('dialog', { name: 'Leave Weekend Crew?' })
  await expect(leave).toContainText('for real')
  await expect(leave).toContainText('Hide server instead')
  await friend.screenshot({ path: join(SHOTS, 'ux-leave-confirm.png') })
  await leave.getByRole('button', { name: 'Leave server' }).click()
  await expect(friendIcon).toHaveCount(0)
  await expect(host.locator('.member-list').getByRole('button', { name: /Friend/ })).toHaveCount(0)
  await openSettings(friend, 'Appearance')
  await expect(friend.locator('.hidden-servers').getByText('Weekend Crew')).toHaveCount(0)
})
