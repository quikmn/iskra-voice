import { expect, test, type Page } from '@playwright/test'
import { join } from 'node:path'
import { createInviteLink, hasLiveKit, joinVia, SHOTS, startServer, type TestServer } from './helpers'

test.skip(!hasLiveKit(), 'needs .tools/livekit-server (see scripts/get-livekit.ps1)')

let server: TestServer
test.beforeAll(async () => {
  // A clean stop through stdin, so the server says "restarting" like it does for an update or a restart.
  server = await startServer('Restart Test', true, { ISKRA_STOP_ON_STDIN_CLOSE: '1' })
})
test.afterAll(async () => server?.stop())

const lounge = (page: Page) => page.locator('.voice-channel', { hasText: 'lounge' })
const composer = (page: Page) => page.getByPlaceholder('Message #general')

test('a server restart: "hold on", then everyone is back in voice and nothing is lost', async ({ browser }) => {
  test.setTimeout(150_000)
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  await host.getByRole('button', { name: 'Create voice channel' }).click()
  await host.getByRole('radio', { name: 'Voice' }).click()
  await host.getByLabel('Name').fill('lounge')
  await host.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(lounge(host)).toBeVisible()
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')

  // Both in voice; the host muted and the friend deafened, both reading #general.
  for (const page of [host, friend]) {
    await lounge(page).getByRole('button').first().click()
    await expect(page.locator('.voice-status strong')).toHaveText('Voice connected')
  }
  await host.locator('.call-controls').getByRole('button', { name: 'Mute', exact: true }).click()
  await friend.locator('.call-controls').getByRole('button', { name: 'Deafen', exact: true }).click()
  await expect(lounge(friend).locator('li', { hasText: 'Host' }).getByTitle('Muted')).toBeVisible()
  for (const page of [host, friend]) await page.locator('.channel', { hasText: 'general' }).click()
  await composer(host).fill('a draft I have not sent')

  const restarting = server.restart(3_000)

  // A calm "hold on" instead of an error or a countdown.
  for (const page of [host, friend]) {
    await expect(page.getByRole('status').filter({ hasText: 'Restart Test is restarting, hold on…' })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(/Reconnecting in/)).toHaveCount(0)
    await expect(page.getByText(/Can't reach/)).toHaveCount(0)
  }
  await host.screenshot({ path: join(SHOTS, 'restart-banner.png') })
  // Written while it's down: waits as "sending", goes out once it's back.
  await composer(friend).fill('sent while it restarted')
  await composer(friend).press('Enter')

  await restarting
  const back = Date.now()

  // Back: everyone rejoins voice by themselves, with the same mute and deafen.
  for (const page of [host, friend]) {
    await expect(page.locator('.voice-status strong')).toHaveText('Voice connected', { timeout: 15_000 })
    await expect(lounge(page).locator('.voice-participants li')).toHaveCount(2, { timeout: 15_000 })
  }
  console.log(`both back in voice ${((Date.now() - back) / 1000).toFixed(1)} s after the server was up`)
  expect(Date.now() - back).toBeLessThan(15_000)
  await expect(lounge(friend).locator('li', { hasText: 'Host' }).getByTitle('Muted')).toBeVisible()
  await expect(lounge(host).locator('li', { hasText: 'Friend' }).getByTitle('Deafened')).toBeVisible()
  await expect(host.locator('.me-bar').getByLabel('Muted')).toBeVisible()
  await expect(friend.locator('.me-bar').getByLabel('Deafened')).toBeVisible()
  // Still in the chat they were reading, not pulled into the call screen.
  await expect(host.getByRole('heading', { name: 'general' })).toBeVisible()

  // "Back" for a moment, then the banner goes.
  await expect(host.getByRole('status').filter({ hasText: 'Restart Test is back.' })).toBeVisible()
  await expect(host.locator('.restart-banner')).toHaveCount(0, { timeout: 10_000 })

  // The message written during the restart reached everyone; the unsent draft is still there.
  for (const page of [host, friend]) await expect(page.locator('.message').filter({ hasText: 'sent while it restarted' })).toHaveCount(1, { timeout: 15_000 })
  await expect(composer(host)).toHaveValue('a draft I have not sent')
  await host.screenshot({ path: join(SHOTS, 'restart-back.png') })

  // Camera and screen share are offered again after a restart, never turned back on by themselves.
  await lounge(host).getByRole('button').first().click() // back to the call screen
  await host.locator('.call-controls').getByRole('button', { name: 'Turn camera on' }).click()
  await expect(host.locator('.call-controls').getByRole('button', { name: 'Turn camera off' })).toBeVisible()
  await server.restart(1_000)
  await expect(host.locator('.voice-status strong')).toHaveText('Voice connected', { timeout: 15_000 })
  const offer = host.locator('.resume-offer')
  await expect(offer).toBeVisible({ timeout: 15_000 })
  await expect(host.locator('.call-controls').getByRole('button', { name: 'Turn camera on', exact: true })).toBeVisible()
  await expect(host.locator('.call-controls').getByRole('button', { name: 'Unmute', exact: true })).toBeVisible() // still muted
  await host.screenshot({ path: join(SHOTS, 'restart-camera-again.png') })
  await offer.getByRole('button', { name: 'Turn camera on again' }).click()
  await expect(host.locator('.call-controls').getByRole('button', { name: 'Turn camera off' })).toBeVisible()
  await expect(offer).toHaveCount(0)

  // Stopped for good (the host quit the app): "went offline", not "restarting", and the usual backoff.
  const stopped = server.restart(4_000, 'stop')
  await expect(friend.getByRole('status').filter({ hasText: "Restart Test went offline. Iskra reconnects when it's back." }))
    .toBeVisible({ timeout: 15_000 })
  await expect(friend.locator('.restart-banner')).toHaveCount(0)
  await expect(friend.getByText(/is restarting/)).toHaveCount(0)
  await friend.screenshot({ path: join(SHOTS, 'restart-went-offline.png') })
  // If it does come back, you're put back in voice all the same.
  await stopped
  await expect(friend.locator('.voice-status strong')).toHaveText('Voice connected', { timeout: 30_000 })
  await expect(lounge(friend).locator('li', { hasText: 'Friend' }).getByTitle('Deafened')).toBeVisible()

  // A plain stop after `iskra-server expect-restart` (an update script before `systemctl restart`): "restarting", not offline.
  const updating = server.restart(2_000, 'marker')
  await expect(friend.getByRole('status').filter({ hasText: 'Restart Test is restarting, hold on…' })).toBeVisible({ timeout: 15_000 })
  await expect(friend.getByText(/went offline/)).toHaveCount(0)
  await friend.screenshot({ path: join(SHOTS, 'restart-marker.png') })
  await updating
  await expect(friend.locator('.voice-status strong')).toHaveText('Voice connected', { timeout: 15_000 })
})
