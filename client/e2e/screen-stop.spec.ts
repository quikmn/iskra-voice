import { expect, test, type Page } from '@playwright/test'
import { join } from 'node:path'
import { createInviteLink, hasLiveKit, joinVia, SHOTS, startServer, type TestServer, VOICE_JOIN } from './helpers'

test.skip(!hasLiveKit(), 'needs .tools/livekit-server (see scripts/get-livekit.ps1)')

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Screen Stop Test', true)
})
test.afterAll(async () => server?.stop())

const lounge = (page: Page) => page.locator('.voice-channel', { hasText: 'lounge' })

test('when a screen share stops, viewers lose its tile and can go back to chat', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  await host.getByRole('button', { name: 'Create voice channel' }).click()
  await host.getByRole('radio', { name: 'Voice' }).click()
  await host.getByLabel('Name').fill('lounge')
  await host.getByRole('button', { name: 'Create', exact: true }).click()
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')

  await lounge(host).getByRole('button').first().click()
  await lounge(friend).getByRole('button').first().click()
  await expect(friend.locator('.voice-status strong')).toHaveText('Voice connected', VOICE_JOIN)

  // Share with sound, the way people usually do.
  await host.locator('.call-controls').getByRole('button', { name: 'Share your screen' }).click()
  await host.getByRole('dialog', { name: 'Share your screen' }).getByRole('button', { name: 'Share screen' }).click()
  const screen = friend.locator('.video-tile.screen')
  await expect(screen).toHaveCount(1, { timeout: 15_000 })
  await expect.poll(() => screen.locator('video').evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 15_000 }).toBeGreaterThan(0)

  // The friend picks the share as their focus, then the host stops.
  await screen.click()
  await host.locator('.call-controls').getByRole('button', { name: 'Stop sharing' }).click()
  await expect(screen).toHaveCount(0, { timeout: 10_000 })
  await friend.screenshot({ path: join(SHOTS, 'screen-stopped-viewer.png') })

  // Text channels take them back to chat, still in voice.
  await friend.locator('.channel', { hasText: 'general' }).click()
  await expect(friend.locator('.stage')).toHaveCount(0)
  await expect(friend.getByPlaceholder('Message #general')).toBeVisible()
  await expect(friend.locator('.voice-status strong')).toHaveText('Voice connected', VOICE_JOIN)
})
