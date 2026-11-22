import { expect, test, type Page } from '@playwright/test'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { callTool, createInviteLink, hasLiveKit, joinVia, SHOTS, startServer, type TestServer, VOICE_JOIN } from './helpers'

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

/**
 * How far apart two players are at the same moment. Each page reads its position together with the clock (all pages
 * share this machine's clock), and both are projected to the later reading, so the time between the two reads (long
 * on a busy CI runner) doesn't count as drift.
 */
async function drift(a: Page, b: Page): Promise<number> {
  const read = (page: Page) => video(page).evaluate((v: HTMLVideoElement) => ({ t: v.currentTime, at: Date.now(), rate: v.paused ? 0 : v.playbackRate }))
  const [x, y] = await Promise.all([read(a), read(b)])
  const at = Math.max(x.at, y.at)
  const position = (r: typeof x) => r.t + ((at - r.at) / 1000) * r.rate
  return Math.abs(position(x) - position(y))
}

async function joinCinema(page: Page) {
  await cinema(page).getByRole('button').first().click()
  await expect(page.locator('.voice-status strong')).toHaveText('Voice connected', VOICE_JOIN)
}

test('a watch party stays in step for everyone, late joiners included', async ({ browser }) => {
  test.setTimeout(180_000)
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
  await (await callTool(host, 'Together', 'Watch together')).click()
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
  // The controls lie over the video, End is in the panel's header (the host's only), and nothing sits under the player.
  const frameBox = (await host.locator('.watch-frame').boundingBox())!
  const controlsBox = (await host.getByRole('toolbar', { name: 'Watch party controls' }).boundingBox())!
  expect(controlsBox.y).toBeGreaterThan(frameBox.y)
  expect(controlsBox.y + controlsBox.height).toBeLessThanOrEqual(frameBox.y + frameBox.height + 1)
  await expect(host.locator('.watch-head').getByRole('button', { name: 'End watch party' })).toBeVisible()
  await expect(friend.getByRole('button', { name: 'End watch party' })).toHaveCount(0)
  await expect(friend.getByRole('button', { name: 'Watch party settings' })).toHaveCount(0)
  await expect(host.locator('.watch-bar')).toHaveCount(0)
  // Paused: they stay, however long the pointer rests.
  await host.mouse.move(5, 5)
  await host.waitForTimeout(3600)
  await expect(host.locator('.watch-frame')).not.toHaveClass(/idle/)

  // Play: the friend's copy plays too, and they stay together.
  await host.locator('.watch-controls').getByRole('button', { name: 'Play' }).click()
  await expect.poll(() => paused(friend), { timeout: 10_000 }).toBe(false)
  await host.waitForTimeout(2500)
  expect(await time(host)).toBeGreaterThan(1)
  await expect.poll(() => drift(host, friend), { timeout: 5_000 }).toBeLessThan(0.6)

  // Someone joining later lands where everyone else is.
  const late = await (await browser.newContext()).newPage()
  await joinVia(late, invite, 'Late')
  await joinCinema(late)
  await expect(party(late)).toBeVisible()
  await expect.poll(() => paused(late), { timeout: 10_000 }).toBe(false)
  // Within a second of the host, measured at the same moment, once its first correction has had a chance to land.
  await expect.poll(() => drift(host, late), { timeout: 10_000, intervals: [500] }).toBeLessThan(1)

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
  await host.getByRole('button', { name: 'Watch party settings' }).click()
  const hostMenu = host.getByRole('dialog', { name: 'Watch party settings' })
  await expect(hostMenu.getByRole('menuitemradio', { name: '1×', exact: true })).toBeChecked()
  await expect(hostMenu.getByRole('menuitemcheckbox', { name: 'Audio only' })).not.toBeChecked()
  await host.getByRole('menuitemcheckbox', { name: 'Anyone can control' }).click() // applied once the server confirms
  await expect(host.getByRole('menuitemcheckbox', { name: 'Anyone can control' })).toBeChecked()
  await host.waitForTimeout(300)
  await host.screenshot({ path: join(SHOTS, 'watch-party-settings.png') })
  await host.keyboard.press('Escape')
  // Now the friend's gear has the speed, but not the host's switches.
  await friend.getByRole('button', { name: 'Watch party settings' }).click()
  const friendMenu = friend.getByRole('dialog', { name: 'Watch party settings' })
  await expect(friendMenu.getByRole('menuitemradio', { name: '1×', exact: true })).toBeChecked()
  await expect(friendMenu.getByRole('menuitemcheckbox')).toHaveCount(0)
  await friend.keyboard.press('Escape')
  await friend.locator('.watch-controls').getByRole('button', { name: 'Play' }).click()
  await expect.poll(() => paused(host), { timeout: 10_000 }).toBe(false)
  await expect(party(host)).toContainText('anyone can control')

  // Party chat, beside the video.
  await friend.getByLabel('Message the party').fill('popcorn ready?')
  await friend.getByLabel('Message the party').press('Enter')
  await expect(host.locator('.watch-chat')).toContainText('popcorn ready?')
  await expect(late.locator('.watch-chat')).toContainText('popcorn ready?')
  const hostOver = (await host.locator('.watch-frame').boundingBox())!
  await host.mouse.move(hostOver.x + hostOver.width / 2, hostOver.y + hostOver.height / 2)
  await expect(host.locator('.watch-frame')).not.toHaveClass(/idle/)
  await host.waitForTimeout(300)
  await host.screenshot({ path: join(SHOTS, 'watch-party.png') })

  // While it plays the controls step aside once the pointer rests, and come back when it moves over the video.
  const hostFrame = host.locator('.watch-frame')
  const hostControls = host.getByRole('toolbar', { name: 'Watch party controls' })
  // (Escape left keyboard focus on the settings button, which keeps them up: focus goes elsewhere first.)
  await expect(hostFrame).not.toHaveClass(/idle/)
  await host.getByLabel('Message the party').click()
  await host.mouse.move(5, 5)
  await expect(hostFrame).toHaveClass(/idle/, { timeout: 6_000 })
  await expect(hostControls).toHaveCSS('opacity', '0')
  await host.screenshot({ path: join(SHOTS, 'watch-party-idle.png') })
  const over = (await hostFrame.boundingBox())!
  await host.mouse.move(over.x + over.width / 2, over.y + over.height / 2)
  await expect(hostFrame).not.toHaveClass(/idle/)
  await expect(hostControls).toHaveCSS('opacity', '1')
  // A keyboard on one of them keeps them up.
  await host.mouse.move(5, 5)
  await host.keyboard.press('Tab')
  await host.getByRole('slider', { name: 'Position' }).focus()
  await host.waitForTimeout(3600)
  await expect(hostFrame).not.toHaveClass(/idle/)
  await expect(hostControls).toHaveCSS('opacity', '1')
  await host.getByRole('slider', { name: 'Position' }).blur()
  await expect(hostFrame).toHaveClass(/idle/, { timeout: 6_000 })

  // A finger has no hover to bring them back: after a touch they stay while it plays.
  await late.locator('.watch-frame').dispatchEvent('pointerdown', { pointerType: 'touch', bubbles: true })
  await late.waitForTimeout(3600)
  await expect(late.locator('.watch-frame')).not.toHaveClass(/idle/)

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
  // Still over the video, in one piece, and nothing wider than the screen.
  const phoneFrame = (await friend.locator('.watch-frame').boundingBox())!
  const phoneControls = (await bar.boundingBox())!
  expect(phoneControls.y + phoneControls.height).toBeLessThanOrEqual(phoneFrame.y + phoneFrame.height + 1)
  expect(await friend.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await friend.mouse.move(phoneFrame.x + phoneFrame.width / 2, phoneFrame.y + 20)
  await expect(friend.locator('.watch-frame')).not.toHaveClass(/idle/)
  await friend.waitForTimeout(300)
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
