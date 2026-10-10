import { expect, test, type Page } from '@playwright/test'
import { join } from 'node:path'
import { createInviteLink, hasLiveKit, joinVia, SHOTS, startServer, type TestServer } from './helpers'

test.skip(!hasLiveKit(), 'needs .tools/livekit-server (see scripts/get-livekit.ps1)')

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

  // Joining opens the call screen with everyone on it.
  await expect(friend.locator('.stage')).toBeVisible()
  await expect(friend.locator('.person-tile')).toHaveCount(2)

  // Camera: the friend sees the host's video playing.
  await host.locator('.call-controls').getByRole('button', { name: 'Turn camera on' }).click()
  const hostVideo = friend.locator('.video-tile.camera video')
  await expect(hostVideo).toHaveCount(1)
  await expect.poll(() => hostVideo.evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 15_000 }).toBeGreaterThan(0)
  await expect(friend.locator('.person-tile')).toHaveCount(1) // the host moved from avatar to video

  // Screen share shows up big for the friend.
  await host.locator('.call-controls').getByRole('button', { name: 'Share your screen' }).click()
  const screen = friend.locator('.video-tile.screen.big video')
  await expect(screen).toHaveCount(1, { timeout: 15_000 })
  await expect.poll(() => screen.evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 15_000 }).toBeGreaterThan(0)
  await friend.screenshot({ path: join(SHOTS, 'call-screen-share.png') })
  await host.locator('.call-controls').getByRole('button', { name: 'Stop sharing' }).click()
  await expect(friend.locator('.video-tile.screen')).toHaveCount(0)

  // Muting shows up for others.
  await host.locator('.call-controls').getByRole('button', { name: 'Mute', exact: true }).click()
  await expect(lounge(friend).locator('li', { hasText: 'Host' }).getByTitle('Muted')).toBeVisible()

  await host.locator('.channel', { hasText: 'general' }).click()
  await host.screenshot({ path: join(SHOTS, 'voice-host.png') })

  // Leaving removes you for everyone.
  await friend.getByRole('button', { name: 'Leave voice' }).click()
  await expect(friend.locator('.voice-bar')).toHaveCount(0)
  await expect(lounge(host).locator('.voice-participants li')).toHaveCount(1)
})
