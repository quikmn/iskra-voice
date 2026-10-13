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
  // Copying the ID says so before the menu closes (it used to close with no sign it worked).
  await menu.getByRole('menuitem', { name: 'Copy user ID' }).click()
  await expect(menu.getByRole('status')).toHaveText('User ID copied')
  await expect(menu).toBeHidden()

  // Bob gets a badge, and the request waits on the Friends page.
  await expect(bob.locator('.server-icon.home .badge')).toHaveText('1')
  await bob.getByRole('button', { name: 'Direct messages' }).click()
  await expect(bob.locator('.channel', { hasText: 'Friends' }).locator('.badge')).toHaveText('1')
  await bob.locator('.channel', { hasText: 'Friends' }).click()
  // All (the default tab) shows the request on top instead of "No friends yet" (UX audit P1).
  await expect(bob.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'true')
  const requests = bob.getByRole('region', { name: 'Friend requests — 1' })
  await expect(requests.locator('.friend-row', { hasText: 'Alice' })).toContainText('Incoming friend request')
  await expect(requests.getByRole('button', { name: 'Accept friend request' })).toBeVisible()
  await expect(bob.getByText('No friends yet')).toHaveCount(0)
  await bob.screenshot({ path: join(SHOTS, 'friends-all-request.png') })
  // Alice sees hers under Sent.
  await alice.getByRole('button', { name: 'Direct messages' }).click()
  await alice.locator('.channel', { hasText: 'Friends' }).click()
  await expect(alice.getByRole('region', { name: 'Sent — 1' }).locator('.friend-row', { hasText: 'Bob' })).toBeVisible()
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

  // A narrow phone (360 px): Bob asks again; Alice's Accept/Ignore stay on screen, in the DM header and on Friends.
  await bob.getByRole('dialog', { name: 'Options for Alice' }).getByRole('menuitem', { name: 'Add friend' }).click()
  await alice.setViewportSize({ width: 360, height: 740 })
  const noSpill = async (button: ReturnType<typeof alice.locator>, other?: ReturnType<typeof alice.locator>) => {
    const box = (await button.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(360)
    if (other) {
      const o = (await other.boundingBox())!
      const overlap = box.x < o.x + o.width && o.x < box.x + box.width && box.y < o.y + o.height && o.y < box.y + box.height
      expect(overlap).toBe(false)
    }
  }
  const header = alice.locator('.chat-header')
  await expect(header.getByRole('button', { name: 'Accept friend request' })).toBeVisible()
  await noSpill(header.getByRole('button', { name: 'Accept friend request' }), header.getByRole('button', { name: 'Verify' }))
  await noSpill(header.getByRole('button', { name: 'Ignore friend request' }), header.getByRole('button', { name: 'Verify' }))
  await alice.screenshot({ path: join(SHOTS, 'friends-dm-header-360.png') })
  await alice.getByRole('button', { name: 'Open menu' }).first().click()
  await alice.locator('.channel', { hasText: 'Friends' }).click()
  const narrow = alice.getByRole('region', { name: 'Friend requests — 1' })
  await expect(narrow.locator('.section-title')).toBeInViewport({ ratio: 1 })
  await noSpill(narrow.getByRole('button', { name: 'Accept friend request' }))
  await noSpill(narrow.getByRole('button', { name: 'Ignore friend request' }))
  expect(await alice.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360)
  await alice.screenshot({ path: join(SHOTS, 'friends-all-request-360.png') })
})
