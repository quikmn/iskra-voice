import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { createInviteLink, hasLiveKit, joinVia, SHOTS, startServer, type TestServer } from './helpers'

test.skip(!hasLiveKit(), 'needs .tools/livekit-server (see scripts/get-livekit.ps1)')

let server: TestServer
test.beforeAll(async () => {
  // A short ring so the "no answer" path doesn't take 45 s.
  server = await startServer('Call Test', true, { Calls__RingTimeoutMs: '5000' })
})
test.afterAll(async () => server?.stop())

const panel = (page: Page) => page.locator('.call-panel')
const incoming = (page: Page) => page.getByRole('alertdialog')

test('friends make end-to-end encrypted calls from a DM', async ({ browser }) => {
  test.setTimeout(150_000)
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')
  // The host takes calls on a phone-sized screen; the friend on a desktop browser.
  await host.setViewportSize({ width: 390, height: 844 })

  // The friend opens a DM with Host and calls.
  await friend.locator('.member-list').getByRole('button', { name: 'Host' }).click()
  await friend.getByRole('button', { name: 'Add friend' }).click()
  await friend.getByRole('dialog').getByRole('button', { name: 'Message', exact: true }).click()
  await friend.getByRole('button', { name: 'Start voice call' }).click()
  await expect(panel(friend).locator('.call-status')).toHaveText('Calling…')

  // Host gets the incoming call screen and answers.
  await expect(incoming(host)).toContainText('Friend')
  await expect(incoming(host)).toContainText('Incoming voice call')
  await host.screenshot({ path: join(SHOTS, 'call-incoming-phone.png') })
  await incoming(host).getByRole('button', { name: 'Accept' }).click()
  await expect(incoming(host)).toHaveCount(0)

  // Both are connected, with LiveKit's end-to-end encryption on.
  for (const page of [host, friend]) {
    await expect(panel(page).locator('.call-status')).toHaveText(/^\d+:\d\d$/, { timeout: 20_000 })
    await expect(panel(page).locator('.e2e-badge')).toHaveText('Encrypted call')
    await expect(panel(page).locator('.e2e-badge')).not.toHaveClass(/pending/) // keys in, not just the label
  }
  // Audio arrives and plays (decrypted, or it would be silence the browser never starts).
  await expect
    .poll(() => host.evaluate(() => [...document.querySelectorAll('audio')].some((a) => !a.paused && a.currentTime > 0)), { timeout: 15_000 })
    .toBe(true)

  // Video: the friend's camera shows up for the host, decoded from encrypted frames.
  await panel(friend).getByRole('button', { name: 'Turn camera on' }).click()
  const video = panel(host).locator('.video-tile video')
  await expect(video).toHaveCount(1, { timeout: 15_000 })
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 15_000 }).toBeGreaterThan(0)
  await host.screenshot({ path: join(SHOTS, 'call-phone.png') })
  await friend.screenshot({ path: join(SHOTS, 'call.png') })

  // The safety number is one tap away.
  await panel(friend).getByRole('button', { name: 'Safety number' }).click()
  await expect(friend.locator('.safety-number')).toBeVisible()
  await friend.keyboard.press('Escape')

  // Hanging up ends it for both, and the call shows up in the conversation.
  await panel(friend).getByRole('button', { name: 'Hang up' }).click()
  await expect(panel(host)).toHaveCount(0, { timeout: 10_000 })
  await expect(panel(friend)).toHaveCount(0, { timeout: 10_000 })
  await expect(host.locator('.call-log', { hasText: /Voice call · \d+:\d\d/ })).toBeVisible()
  await expect(friend.locator('.call-log', { hasText: /Voice call · \d+:\d\d/ })).toBeVisible()
  await expect(host.locator('.voice-bar')).toHaveCount(0)

  // Declining: the caller sees it and it's recorded.
  await friend.getByRole('button', { name: 'Start video call' }).click()
  await expect(incoming(host)).toContainText('Incoming video call')
  await incoming(host).getByRole('button', { name: 'Decline' }).click()
  await expect(panel(friend).locator('.call-status')).toHaveText('Declined')
  await expect(friend.locator('.call-log', { hasText: 'Host declined your video call' })).toBeVisible()
  await expect(host.locator('.call-log', { hasText: 'You declined a video call' })).toBeVisible()
  await expect(panel(friend)).toHaveCount(0, { timeout: 10_000 })

  // No answer: the ring times out on both sides and Host has a missed call.
  await friend.getByRole('button', { name: 'Start voice call' }).click()
  await expect(incoming(host)).toBeVisible()
  await expect(panel(friend).locator('.call-status')).toHaveText('No answer', { timeout: 15_000 })
  await expect(incoming(host)).toHaveCount(0)
  await expect(host.locator('.call-log.missed', { hasText: 'Missed voice call' })).toBeVisible()
  await expect(friend.locator('.call-log', { hasText: 'You called · no answer' })).toBeVisible()
  await host.screenshot({ path: join(SHOTS, 'call-log-phone.png') })
})
