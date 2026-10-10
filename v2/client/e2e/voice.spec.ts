import { expect, test, type Page } from '@playwright/test'
import { join } from 'node:path'
import { createInviteLink, hasLiveKit, joinVia, SHOTS, startServer, type TestServer } from './helpers'

test.skip(!hasLiveKit(), 'needs v2/.tools/livekit-server (see v2/scripts/get-livekit.ps1)')

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Voice Test', true)
})
test.afterAll(async () => server?.stop())

const lounge = (page: Page) => page.locator('.voice-channel', { hasText: 'lounge' })

test('friends talk in a voice channel', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')

  // Create a voice channel from the UI.
  await host.getByRole('button', { name: 'Create voice channel' }).click()
  await host.getByRole('radio', { name: 'Voice' }).click()
  await host.getByLabel('Name').fill('lounge')
  await host.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(lounge(host)).toBeVisible()

  const friendLink = await createInviteLink(host)
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, friendLink, 'Friend')

  // Both join; the server learns about it from LiveKit and tells everyone.
  await lounge(host).getByRole('button').first().click()
  await expect(host.locator('.voice-status strong')).toHaveText('Voice connected')
  await lounge(friend).getByRole('button').first().click()
  await expect(friend.locator('.voice-status strong')).toHaveText('Voice connected')

  for (const page of [host, friend]) {
    await expect(lounge(page).locator('.voice-participants li')).toHaveCount(2)
    await expect(lounge(page)).toContainText('Host')
    await expect(lounge(page)).toContainText('Friend')
  }

  // Audio from the other person is actually arriving and playing.
  await expect
    .poll(() => friend.evaluate(() => [...document.querySelectorAll('audio')].some((a) => !a.paused && a.currentTime > 0)), { timeout: 15_000 })
    .toBe(true)

  // Muting shows up for others.
  await host.getByRole('button', { name: 'Mute', exact: true }).click()
  await expect(lounge(friend).locator('li', { hasText: 'Host' }).getByTitle('Muted')).toBeVisible()

  await host.screenshot({ path: join(SHOTS, 'voice-host.png') })

  // Leaving removes you for everyone.
  await friend.getByRole('button', { name: 'Leave voice' }).click()
  await expect(friend.locator('.voice-bar')).toHaveCount(0)
  await expect(lounge(host).locator('.voice-participants li')).toHaveCount(1)
})
