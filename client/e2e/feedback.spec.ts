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
