// The AFK channel: an admin sets it up in Server settings → Voice; someone idle in voice is moved there by the server,
// where LiveKit mutes and deafens them; the owner (a role that can talk there) can still talk.
import { expect, test, type Page } from '@playwright/test'
import { join } from 'node:path'
import { createInviteLink, hasLiveKit, joinVia, openServerSettings, SHOTS, startServer, type TestServer, VOICE_JOIN } from './helpers'

test.skip(!hasLiveKit(), 'needs .tools/livekit-server (see scripts/get-livekit.ps1)')

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('AFK Test', true)
})
test.afterAll(async () => server?.stop())

const voiceChannel = (page: Page, name: string) => page.locator('.voice-channel', { hasText: name })
/** Audio from other people that is actually playing here. */
const playing = (page: Page) => page.evaluate(() => [...document.querySelectorAll('audio')].filter((a) => !a.paused && a.currentTime > 0).length)

test('AFK channel: set it up, idle people are moved there muted and deafened, the owner can still talk', async ({ browser }) => {
  test.setTimeout(150_000)
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')

  await host.getByRole('button', { name: 'Create voice channel' }).first().click()
  await host.getByRole('radio', { name: 'Voice' }).click()
  await host.getByLabel('Name').fill('lounge')
  await host.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(voiceChannel(host, 'lounge')).toBeVisible()

  // ── Server settings → Voice: create the AFK channel, move idle people after 5 minutes.
  const room = await openServerSettings(host, 'Voice')
  const section = room.getByTestId('afk-section')
  await expect(section.getByLabel('AFK channel')).toHaveValue('')
  await section.getByRole('button', { name: 'Create AFK channel' }).click()
  await expect(section.getByLabel('AFK channel')).not.toHaveValue('')
  await expect(section.getByLabel('Move idle people after')).toHaveValue('30')
  await section.getByLabel('Move idle people after').selectOption('5')
  await expect(section.getByRole('status')).toHaveText('Saved')
  // Owner and admins can talk there by default.
  await expect(section.getByRole('checkbox', { name: 'Owner' })).toBeChecked()
  await expect(section.getByRole('checkbox', { name: 'Admins' })).toBeChecked()
  await expect(section.getByRole('checkbox', { name: 'Members' })).not.toBeChecked()
  await host.screenshot({ path: join(SHOTS, 'afk-settings.png') })
  await host.keyboard.press('Escape')

  // Everyone sees which channel it is.
  await expect(voiceChannel(friend, 'AFK').locator('.afk-badge')).toHaveText('AFK')

  // ── The friend joins the lounge, mutes, then does nothing for six minutes (the page's clock jumps ahead).
  await voiceChannel(friend, 'lounge').getByRole('button').first().click()
  await expect(friend.locator('.voice-status strong')).toHaveText('Voice connected', VOICE_JOIN)
  await friend.locator('.voice-bar').getByRole('button', { name: 'Mute', exact: true }).click()
  await friend.clock.install()
  await friend.clock.fastForward('06:00')

  // The server moves them (it checks every 15 s) and their app follows, muted and deafened by the server.
  await expect(friend.getByTestId('afk-toast')).toContainText(/Moved to afk/i, { timeout: 45_000 })
  await expect(friend.getByTestId('afk-toast')).toContainText('idle in voice for 5 minutes')
  await expect(friend.getByTestId('afk-forced')).toHaveText('AFK channel: muted and deafened', { timeout: 15_000 })
  await expect(friend.locator('.voice-bar').getByRole('button', { name: 'Mute', exact: true })).toHaveCount(0)
  await expect(friend.locator('.voice-bar').getByRole('button', { name: 'Unmute' })).toHaveCount(0)
  await expect(voiceChannel(host, 'AFK').locator('.voice-participants')).toContainText('Friend')
  await expect(voiceChannel(host, 'lounge').locator('.voice-participants')).toHaveCount(0)
  await expect(voiceChannel(host, 'AFK').getByTitle('Muted and deafened (AFK channel)')).toBeVisible()
  await friend.screenshot({ path: join(SHOTS, 'afk-moved.png') })

  // ── The owner (a role that can talk there) joins and talks; the friend hears nothing, LiveKit sends them no audio.
  await voiceChannel(host, 'AFK').getByRole('button').first().click()
  await expect(host.locator('.voice-status strong')).toHaveText('Voice connected', VOICE_JOIN)
  await expect(host.getByTestId('afk-forced')).toHaveCount(0)
  await expect(host.locator('.voice-bar').getByRole('button', { name: 'Mute', exact: true })).toBeVisible()
  await expect.poll(() => friend.locator('audio').count(), { timeout: 5_000 }).toBe(0)
  await host.waitForTimeout(2_000)
  expect(await playing(friend)).toBe(0)
  await host.screenshot({ path: join(SHOTS, 'afk-owner-talks.png') })

  // Coming back is a normal join: the friend can talk again in the lounge.
  await voiceChannel(friend, 'lounge').getByRole('button').first().click()
  await expect(friend.getByTestId('afk-forced')).toHaveCount(0, { timeout: 15_000 })
  await expect(friend.locator('.voice-status strong')).toHaveText('Voice connected', VOICE_JOIN)
  await expect(friend.locator('.voice-bar').getByRole('button', { name: /^(Mute|Unmute)$/ })).toBeVisible()
})
