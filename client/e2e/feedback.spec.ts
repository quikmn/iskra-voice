import { closeSync, ftruncateSync, mkdtempSync, openSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { createInviteLink, hasLiveKit, joinVia, openSettings, SHOTS, startServer, type TestServer } from './helpers'

test.skip(!hasLiveKit(), 'needs .tools/livekit-server (see scripts/get-livekit.ps1)')

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Feedback Test', true)
})
test.afterAll(async () => server?.stop())

const lounge = (page: Page) => page.locator('.voice-channel', { hasText: 'lounge' })

async function inViewport(page: Page, selector: string) {
  const box = (await page.locator(selector).boundingBox())!
  const size = page.viewportSize()!
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.y + box.height).toBeLessThanOrEqual(size.height + 0.5)
  expect(box.x + box.width).toBeLessThanOrEqual(size.width + 0.5)
}

test('the profile card from a voice tile stays inside the window', async ({ browser }) => {
  const host = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  // A long bio makes the card taller than a short window.
  await openSettings(host)
  await host.getByLabel(/About me/).fill(Array.from({ length: 14 }, (_, i) => `Line ${i + 1} of a long story about me.`).join('\n'))
  await host.getByRole('button', { name: 'Save profile' }).click()
  await expect(host.getByText('Saved', { exact: true })).toBeVisible()
  await host.keyboard.press('Escape')
  await host.getByRole('button', { name: 'Create voice channel' }).click()
  await host.getByRole('radio', { name: 'Voice' }).click()
  await host.getByLabel('Name').fill('lounge')
  await host.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(lounge(host)).toBeVisible()
  const friend = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')

  await lounge(host).getByRole('button').first().click()
  await expect(host.locator('.voice-status strong')).toHaveText('Voice connected')
  await lounge(friend).getByRole('button').first().click()
  await expect(friend.locator('.person-tile')).toHaveCount(2)

  for (const size of [{ width: 1280, height: 800 }, { width: 1300, height: 520 }, { width: 390, height: 844 }]) {
    await friend.setViewportSize(size)
    const tile = friend.locator('.person-tile', { hasText: 'Host' })
    await tile.click()
    await expect(friend.locator('.profile-card')).toBeVisible()
    await friend.waitForTimeout(300) // the open animation and late content (friend buttons)
    await inViewport(friend, '.profile-card')
    // Its buttons stay in sight (the bio scrolls inside the card instead).
    const more = friend.locator('.profile-card').getByRole('button', { name: 'More' })
    await expect(more).toBeInViewport({ ratio: 1 })
    const card = (await friend.locator('.profile-card').boundingBox())!
    const button = (await more.boundingBox())!
    expect(button.y + button.height).toBeLessThanOrEqual(card.y + card.height)
    await friend.screenshot({ path: join(SHOTS, `profile-card-tile-${size.width}x${size.height}.png`) })
    if (size.height === 520) {
      // The card grows while open (a friend request adds a chip and a button): it stays inside.
      await friend.locator('.profile-card').getByRole('button', { name: 'Add friend' }).click()
      await expect(friend.locator('.profile-card').getByText('Request sent')).toBeVisible()
      await friend.waitForTimeout(200)
      await inViewport(friend, '.profile-card')
      await expect(more).toBeInViewport({ ratio: 1 })
      await friend.screenshot({ path: join(SHOTS, 'profile-card-tile-grown.png') })
    }
    await friend.keyboard.press('Escape')
    await expect(friend.locator('.profile-card')).toHaveCount(0)
  }
})

test('an invite on a fresh device says a new account is a new person, and offers linking instead', async ({ browser }) => {
  const own = await startServer('Invite Test')
  const owner = await (await browser.newContext()).newPage()
  await joinVia(owner, own.ownerLink(), 'Owner')
  const link = await createInviteLink(owner)
  const fresh = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage()
  await fresh.goto(link)
  await expect(fresh.getByText("You've been invited")).toBeVisible()
  await expect(fresh.getByText(/A new account shows up as a new person on the server/)).toBeVisible()
  await expect(fresh.getByRole('button', { name: /I already use Iskra on another device/ })).toBeVisible()
  await fresh.screenshot({ path: join(SHOTS, 'invite-fresh-device.png') })
  await own.stop()
})

test('a file too big for the server says why on its chip, at once', async ({ browser }) => {
  const own = await startServer('DM Files Test')
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, own.ownerLink(), 'Host')
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')
  await friend.locator('.member-list').getByRole('button', { name: 'Host' }).click()
  await friend.getByRole('dialog').getByRole('button', { name: 'Message', exact: true }).click()
  await expect(friend.getByPlaceholder('Message Host')).toBeVisible()

  // Encrypted DMs take anything the server does (512 MB by default); this is 600 MB, sparse on disk.
  const dir = mkdtempSync(join(tmpdir(), 'iskra-big-'))
  const path = join(dir, 'GoogleDriveSetup.exe')
  const fd = openSync(path, 'w')
  ftruncateSync(fd, 600 * 1024 * 1024)
  closeSync(fd)
  await friend.locator('.composer-wrap input[type=file]').setInputFiles(path)
  const chip = friend.locator('.pending-upload', { hasText: 'GoogleDriveSetup.exe' })
  await expect(chip.getByRole('alert')).toContainText('512 MB')
  await friend.screenshot({ path: join(SHOTS, 'dm-file-too-big.png') })
  rmSync(dir, { recursive: true, force: true })
  await own.stop()
})

test('server menus: the rail icon and the server name lead to its settings; the person menu offers roles', async ({ browser }) => {
  const own = await startServer('Menu Test')
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, own.ownerLink(), 'Host')
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')
  const settings = host.getByRole('dialog', { name: 'Settings' })
  const current = settings.locator('.settings-nav-item[aria-current="page"]')

  // Right-click the server in the rail: its config, grouped, for the owner.
  await host.locator('.server-icon[title="Menu Test"]').click({ button: 'right' })
  const menu = host.getByRole('dialog', { name: 'Menu Test options' })
  for (const item of ['Server settings', 'Roles', 'Edit rules', 'Limits', 'Invite friends', 'Create channel', 'Reports', 'AutoMod', 'Audit log',
    'Security log', 'Emoji', 'Soundboard', 'Bots & webhooks', 'Profile pages', 'Open to the internet', 'Backup & move', 'Import from Discord',
    'Updates', 'Notification settings', 'Mark as read', 'New folder']) {
    await expect(menu.getByRole('menuitem', { name: item, exact: true })).toBeVisible()
  }
  await host.screenshot({ path: join(SHOTS, 'server-menu-rail.png') })
  await menu.getByRole('menuitem', { name: 'Roles', exact: true }).click()
  await expect(current).toHaveText('Roles')
  await host.keyboard.press('Escape')
  await expect(settings).toHaveCount(0)

  // The server name is a real dropdown with the same entries, keyboard included.
  const header = host.getByRole('button', { name: /server options/ })
  await header.focus()
  await host.keyboard.press('Enter')
  await expect(header).toHaveAttribute('aria-expanded', 'true')
  const dropdown = host.getByRole('dialog', { name: 'Menu Test options' })
  await expect(dropdown.getByRole('menuitem', { name: 'Updates' })).toBeVisible()
  await host.keyboard.press('Escape')
  await expect(dropdown).toHaveCount(0)
  await header.click()
  await dropdown.getByRole('menuitem', { name: 'Create channel' }).click()
  await expect(host.getByRole('dialog', { name: /Create/ })).toBeVisible()
  await host.keyboard.press('Escape')

  // No roles yet: the person menu still shows the way to make one.
  await host.locator('.member-list').getByRole('button', { name: 'Friend' }).click({ button: 'right' })
  await host.getByRole('menuitem', { name: 'Create a role…' }).click()
  await expect(current).toHaveText('Roles')
  await host.keyboard.press('Escape')

  // A member sees only what they may use.
  await friend.locator('.server-icon[title="Menu Test"]').click({ button: 'right' })
  const theirs = friend.getByRole('dialog', { name: 'Menu Test options' })
  await expect(theirs.getByRole('menuitem', { name: 'Invite friends' })).toBeVisible()
  await expect(theirs.getByRole('menuitem', { name: 'Server settings' })).toBeVisible()
  for (const item of ['Roles', 'Create channel', 'Updates', 'Bots & webhooks', 'Backup & move']) {
    await expect(theirs.getByRole('menuitem', { name: item, exact: true })).toHaveCount(0)
  }
  await friend.screenshot({ path: join(SHOTS, 'server-menu-member.png') })
  await own.stop()
})
