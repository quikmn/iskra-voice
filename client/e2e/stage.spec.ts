import { expect, test, type Page } from '@playwright/test'
import { join } from 'node:path'
import { createInviteLink, hasLiveKit, joinVia, SHOTS, startServer, type TestServer, VOICE_JOIN } from './helpers'

test.skip(!hasLiveKit(), 'needs .tools/livekit-server (see scripts/get-livekit.ps1)')

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Stage Test', true)
})
test.afterAll(async () => server?.stop())

const entry = (page: Page) => page.locator('.stage-entry', { hasText: 'town-hall' })
const controls = (page: Page) => page.locator('.call-controls')
/** Audio from other people that is actually playing here. */
const playing = (page: Page) => page.evaluate(() => [...document.querySelectorAll('audio')].filter((a) => !a.paused && a.currentTime > 0).length)
const audioCount = (page: Page) => page.evaluate(() => document.querySelectorAll('audio').length)

test('a stage: listeners ask to speak, LiveKit lets them only once a moderator says so', async ({ browser }) => {
  test.setTimeout(120_000)
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')

  await host.getByRole('button', { name: 'Create channel' }).first().click()
  await host.getByRole('radio', { name: 'Stage' }).click()
  await host.getByLabel('Name').fill('town hall')
  await host.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(entry(host)).toBeVisible()

  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')

  // The host joins and goes live with a topic.
  await entry(host).getByRole('button').first().click()
  await expect(host.locator('.voice-status strong')).toHaveText('Voice connected', VOICE_JOIN)
  await expect(host.getByText('Start the stage')).toBeVisible()
  await host.getByLabel('Topic').fill('Friday game night')
  await host.getByRole('button', { name: 'Go live' }).click()
  await expect(host.locator('.stage-topic h2')).toHaveText('Friday game night')
  await expect(host.locator('.stage-channel .chat-header .live-pill')).toBeVisible()
  // LiveKit lets the host publish now; speakers start muted and open the mic themselves.
  await controls(host).getByRole('button', { name: 'Unmute' }).click()
  await expect(controls(host).getByRole('button', { name: 'Mute', exact: true })).toBeVisible()

  // Everyone sees it live in the sidebar, with the topic.
  await expect(entry(friend).locator('.live-pill')).toBeVisible()
  await expect(entry(friend)).toContainText('Friday game night')

  // The friend joins listen-only and hears the host.
  await entry(friend).getByRole('button').first().click()
  await expect(friend.locator('.voice-status strong')).toHaveText('Voice connected', VOICE_JOIN)
  await expect(friend.locator('.voice-status')).toContainText('Listening only')
  await expect(friend.locator('.stage-speakers .person-tile')).toHaveCount(1)
  await expect(friend.locator('.stage-audience li')).toHaveCount(1)
  await expect(controls(friend).getByRole('button', { name: 'Mute', exact: true })).toHaveCount(0)
  await expect.poll(() => playing(friend), { timeout: 15_000 }).toBeGreaterThan(0)
  await expect(entry(host)).toContainText('1 listening')

  // Asking to speak: the host sees the request and accepts.
  await controls(friend).getByRole('button', { name: 'Raise hand' }).click()
  await expect(host.locator('.stage-requests li', { hasText: 'Friend' })).toBeVisible()
  await expect(host.locator('.stage-audience .hand-badge')).toHaveCount(1)
  await host.screenshot({ path: join(SHOTS, 'stage-requests.png') })
  await host.getByRole('button', { name: 'Let Friend speak' }).click()

  // LiveKit now lets the friend publish (the server changed their permissions); they start muted.
  const unmute = controls(friend).getByRole('button', { name: 'Unmute' })
  await expect(unmute).toBeVisible({ timeout: 15_000 })
  await expect(friend.locator('.stage-speakers .person-tile')).toHaveCount(2)
  await expect(friend.getByText("You're on stage")).toBeVisible()
  await expect(controls(friend).getByRole('button', { name: 'Turn camera on' })).toBeVisible()
  await unmute.click()
  await expect.poll(() => playing(host), { timeout: 15_000 }).toBeGreaterThan(0) // the host hears the friend

  // A moderator mutes a speaker through LiveKit.
  await host.locator('.stage-speakers .person-tile', { hasText: 'Friend' }).click()
  await host.getByRole('dialog', { name: 'Friend on the stage' }).getByRole('menuitem', { name: 'Mute' }).click()
  await expect(controls(friend).getByRole('button', { name: 'Unmute' })).toBeVisible({ timeout: 15_000 })
  await controls(friend).getByRole('button', { name: 'Unmute' }).click()

  // Phone width: speakers on top, the audience below, controls in reach.
  await friend.setViewportSize({ width: 390, height: 844 })
  await expect(friend.locator('.stage-speakers')).toBeVisible()
  await friend.waitForTimeout(500) // the drawers slide away
  await friend.screenshot({ path: join(SHOTS, 'stage-phone.png') })
  await friend.setViewportSize({ width: 1280, height: 720 })

  // Back to the audience: LiveKit takes the right away and their audio is gone for the host.
  await host.locator('.stage-speakers .person-tile', { hasText: 'Friend' }).click()
  await host.getByRole('dialog', { name: 'Friend on the stage' }).getByRole('menuitem', { name: 'Move to audience' }).click()
  await expect(controls(friend).getByRole('button', { name: /^(Mute|Unmute)$/ })).toHaveCount(0, { timeout: 15_000 })
  await expect(friend.locator('.voice-status')).toContainText('Listening only')
  await expect.poll(() => audioCount(host), { timeout: 15_000 }).toBe(0)
  await expect(friend.locator('.stage-speakers .person-tile')).toHaveCount(1)
  await friend.screenshot({ path: join(SHOTS, 'stage-listener.png') })

  // Ending the stage sends everyone off.
  await host.getByRole('button', { name: 'End stage' }).click()
  await host.getByRole('dialog', { name: 'End the stage?' }).getByRole('button', { name: 'End stage' }).click()
  await expect(friend.locator('.voice-bar')).toHaveCount(0, { timeout: 15_000 })
  await expect(entry(friend).locator('.live-pill')).toHaveCount(0)
})
