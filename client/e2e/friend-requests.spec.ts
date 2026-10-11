import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { createInviteLink, joinVia, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Friend Requests')
})
test.afterAll(async () => server?.stop())

test('friend requests: right-click to send, accept, friends on both sides, then a quiet removal', async ({ browser }) => {
  const alice = await (await browser.newContext()).newPage()
  await joinVia(alice, server.ownerLink(), 'Alice')
  const bob = await (await browser.newContext()).newPage()
  await joinVia(bob, await createInviteLink(alice), 'Bob')

  // Alice right-clicks Bob in the member list and sends a friend request.
  await alice.locator('.member-list').getByRole('button', { name: /^Bob/ }).click({ button: 'right' })
  const menu = alice.getByRole('dialog', { name: 'Options for Bob' })
  await expect(menu.getByRole('menuitem', { name: 'Profile' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Copy user ID' })).toBeVisible()
  await alice.screenshot({ path: join(SHOTS, 'friends-menu.png') })
  await menu.getByRole('menuitem', { name: 'Add friend' }).click()
  await expect(menu).toBeHidden()

  // The menu now offers to cancel it.
  await alice.locator('.member-list').getByRole('button', { name: /^Bob/ }).click({ button: 'right' })
  await expect(menu.getByRole('menuitem', { name: /Cancel friend request/ })).toBeVisible()
  await alice.keyboard.press('Escape')

  // Bob gets a badge, and the request waits on the Friends page.
  await expect(bob.locator('.server-icon.home .badge')).toHaveText('1')
  await bob.getByRole('button', { name: 'Direct messages' }).click()
  await expect(bob.locator('.channel', { hasText: 'Friends' }).locator('.badge')).toHaveText('1')
  await bob.locator('.channel', { hasText: 'Friends' }).click()
  await bob.getByRole('tab', { name: /Pending/ }).click()
  const request = bob.locator('.friend-row', { hasText: 'Alice' })
  await expect(request).toContainText('Incoming friend request')
  await bob.screenshot({ path: join(SHOTS, 'friends-pending.png') })
  // A request alone doesn't add a conversation.
  await expect(bob.locator('.dm-row')).toHaveCount(0)
  await request.getByRole('button', { name: 'Accept friend request' }).click()

  // Both see each other as friends.
  await bob.getByRole('tab', { name: 'All' }).click()
  await expect(bob.locator('.friend-row', { hasText: 'Alice' })).toBeVisible()
  await expect(bob.locator('.channel', { hasText: 'Friends' }).locator('.badge')).toHaveCount(0)
  await alice.getByRole('button', { name: 'Direct messages' }).click()
  await alice.locator('.channel', { hasText: 'Friends' }).click()
  await alice.getByRole('tab', { name: 'All' }).click()
  const bobRow = alice.locator('.friend-row', { hasText: 'Bob' })
  await expect(bobRow).toBeVisible()
  await alice.screenshot({ path: join(SHOTS, 'friends-all.png') })

  // Alice messages Bob; the DM shows the request line, and the header has no "Add friend" any more.
  await bobRow.getByRole('button', { name: 'Message' }).click()
  await expect(alice.locator('.friend-line').first()).toContainText('You sent Bob a friend request.')
  await expect(alice.locator('.friend-line').last()).toContainText('Bob accepted your friend request.')
  await expect(alice.locator('.chat-header').getByRole('button', { name: /Add friend/ })).toHaveCount(0)
  await alice.getByPlaceholder('Message Bob').fill('friends now!')
  await alice.getByPlaceholder('Message Bob').press('Enter')
  await expect(bob.locator('.dm-row', { hasText: 'Alice' })).toBeVisible()

  // The same menu on a DM row: remove the friend (quietly, for both).
  await alice.locator('.dm-row', { hasText: 'Bob' }).click({ button: 'right' })
  await expect(menu.getByRole('menuitem', { name: 'Message' })).toBeVisible()
  await menu.getByRole('menuitem', { name: 'Remove friend' }).click()
  await alice.screenshot({ path: join(SHOTS, 'friends-remove.png') })
  await menu.getByRole('button', { name: 'Remove' }).click()
  await expect(alice.locator('.chat-header').getByRole('button', { name: /Add friend/ })).toBeVisible()
  await bob.locator('.channel', { hasText: 'Friends' }).click()
  await bob.getByRole('tab', { name: 'All' }).click()
  await expect(bob.locator('.friend-row', { hasText: 'Alice' })).toHaveCount(0)

  // Phones: press and hold a DM row for the same menu, as a sheet.
  await bob.setViewportSize({ width: 390, height: 844 })
  await bob.getByRole('button', { name: 'Open menu' }).first().click()
  await bob.locator('.dm-row', { hasText: 'Alice' }).dispatchEvent('contextmenu')
  await expect(bob.locator('.action-sheet.org-sheet')).toBeVisible()
  await expect(bob.getByRole('dialog', { name: 'Options for Alice' }).getByRole('menuitem', { name: 'Add friend' })).toBeVisible()
  await bob.screenshot({ path: join(SHOTS, 'friends-menu-phone.png') })
})
