import { expect, test, type Page } from '@playwright/test'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInviteLink, hasLiveKit, joinVia, SHOTS, startServer, type TestServer } from './helpers'

test.skip(!hasLiveKit(), 'needs .tools/livekit-server (see scripts/get-livekit.ps1)')

const FILM = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'party.webm') // 20 s test pattern with a tone

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Watch Test', true)
})
test.afterAll(async () => server?.stop())

const cinema = (page: Page) => page.locator('.voice-channel', { hasText: 'cinema' })
const party = (page: Page) => page.locator('.watch-party')
const video = (page: Page) => page.locator('.watch-party video')
const time = (page: Page) => video(page).evaluate((v: HTMLVideoElement) => v.currentTime)
const paused = (page: Page) => video(page).evaluate((v: HTMLVideoElement) => v.paused)

async function joinCinema(page: Page) {
  await cinema(page).getByRole('button').first().click()
  await expect(page.locator('.voice-status strong')).toHaveText('Voice connected')
}

test('a watch party stays in step for everyone, late joiners included', async ({ browser }) => {
  test.setTimeout(120_000)
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  await host.getByRole('button', { name: 'Create voice channel' }).click()
  await host.getByRole('radio', { name: 'Voice' }).click()
  await host.getByLabel('Name').fill('cinema')
  await host.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(cinema(host)).toBeVisible()
  const invite = await createInviteLink(host)

  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, invite, 'Friend')
  await joinCinema(host)
  await joinCinema(friend)
  await expect(cinema(host).locator('.voice-participants li')).toHaveCount(2)

  // The host uploads a video and starts the party; it shows for both, paused at the start.
  await host.locator('.call-controls').getByRole('button', { name: 'Watch together' }).click()
  const dialog = host.getByRole('dialog', { name: 'Watch together' })
  await dialog.getByLabel('Title (optional)').fill('Test pattern')
  await dialog.locator('input[type=file]').setInputFiles(FILM)
  for (const page of [host, friend]) {
    await expect(party(page)).toBeVisible()
    await expect(party(page)).toContainText('Test pattern')
    await expect.poll(() => video(page).evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThan(0)
  }
  // Only the host controls it for now.
  await expect(friend.locator('.watch-controls').getByRole('button', { name: 'Play' })).toHaveCount(0)

  // Play: the friend's copy plays too, and they stay together.
  await host.locator('.watch-controls').getByRole('button', { name: 'Play' }).click()
  await expect.poll(() => paused(friend), { timeout: 10_000 }).toBe(false)
  await host.waitForTimeout(2500)
  const [a, b] = await Promise.all([time(host), time(friend)])
  expect(a).toBeGreaterThan(1)
  expect(Math.abs(a - b)).toBeLessThan(0.6)

  // Someone joining later lands where everyone else is.
  const late = await (await browser.newContext()).newPage()
  await joinVia(late, invite, 'Late')
  await joinCinema(late)
  await expect(party(late)).toBeVisible()
  await expect.poll(() => paused(late), { timeout: 10_000 }).toBe(false)
  await late.waitForTimeout(1200)
  const [h, l] = await Promise.all([time(host), time(late)])
  expect(Math.abs(h - l)).toBeLessThan(1)

  // Pause and seek: everyone stops at the same spot.
  await host.locator('.watch-controls').getByRole('button', { name: 'Pause' }).click()
  await expect.poll(() => paused(friend), { timeout: 10_000 }).toBe(true)
  const seek = host.getByRole('slider', { name: 'Position' })
  await seek.fill('12')
  await seek.blur()
  await expect.poll(() => time(friend), { timeout: 10_000 }).toBeGreaterThan(11.5)
  expect(await time(friend)).toBeLessThan(12.5)
  await expect.poll(() => time(late), { timeout: 10_000 }).toBeGreaterThan(11.5)

  // Anyone can control: now the friend can press play.
  await host.getByLabel('Anyone can control').click() // applied once the server confirms
  await expect(host.getByLabel('Anyone can control')).toBeChecked()
  await friend.locator('.watch-controls').getByRole('button', { name: 'Play' }).click()
  await expect.poll(() => paused(host), { timeout: 10_000 }).toBe(false)
  await expect(party(host)).toContainText('anyone can control')

  // Party chat, beside the video.
  await friend.getByLabel('Message the party').fill('popcorn ready?')
  await friend.getByLabel('Message the party').press('Enter')
  await expect(host.locator('.watch-chat')).toContainText('popcorn ready?')
  await expect(late.locator('.watch-chat')).toContainText('popcorn ready?')
  await host.screenshot({ path: join(SHOTS, 'watch-party.png') })

  // A wide player shows mute and the volume slider right in the bar.
  await friend.setViewportSize({ width: 1920, height: 1080 })
  const bar = friend.getByRole('toolbar', { name: 'Watch party controls' })
  await expect(bar.getByRole('slider', { name: 'Video volume' })).toBeVisible()
  await expect(bar.getByRole('button', { name: 'Mute video' })).toBeVisible()
  await expect(bar.getByRole('button', { name: 'Volume', exact: true })).toBeHidden()

  // Phones: the video on top, controls and chat below.
  await friend.setViewportSize({ width: 390, height: 844 })
  await friend.waitForTimeout(500)
  await expect(video(friend)).toBeVisible()
  await expect(friend.locator('.watch-chat')).toBeVisible()
  await friend.screenshot({ path: join(SHOTS, 'watch-party-phone.png') })

  // Volume on a narrow player: the speaker button opens a vertical slider (arrow keys work), only for this viewer.
  const controls = bar
  await expect(controls.getByRole('slider', { name: 'Video volume' })).toBeHidden()
  await expect(controls.getByRole('button', { name: 'Mute video' })).toBeHidden()
  const speaker = controls.getByRole('button', { name: 'Volume', exact: true })
  await speaker.click()
  await expect(speaker).toHaveAttribute('aria-expanded', 'true')
  const slider = controls.locator('.watch-volume-vertical')
  await expect(slider).toBeVisible()
  await slider.fill('0.5')
  await slider.press('ArrowDown')
  await expect.poll(() => video(friend).evaluate((v: HTMLVideoElement) => v.volume)).toBeCloseTo(0.45, 2)
  await expect.poll(() => video(host).evaluate((v: HTMLVideoElement) => v.volume)).toBe(1) // never anyone else's
  await friend.screenshot({ path: join(SHOTS, 'watch-party-phone-volume.png') })
  await slider.press('Escape')
  await expect(slider).toHaveCount(0)
  await expect(speaker).toBeFocused()
  // Remembered on this device.
  expect(await friend.evaluate(() => localStorage.getItem('iskra.watchVolume'))).toBe('0.45')

  // The host ends it for everyone.
  await host.getByRole('button', { name: 'End watch party' }).click()
  await expect(party(friend)).toHaveCount(0)
  await expect(party(late)).toHaveCount(0)
})
