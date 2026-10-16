// Join-to-create voice rooms: an admin flags a voice channel as a lobby; joining it puts you in a room of your own,
// which you can rename and lock; invited friends get in; empty rooms go by themselves; the host passes on.
import { expect, test, type Page } from '@playwright/test'
import { join } from 'node:path'
import { createInviteLink, hasLiveKit, joinVia, SHOTS, startServer, type TestServer } from './helpers'

test.skip(!hasLiveKit(), 'needs .tools/livekit-server (see scripts/get-livekit.ps1)')

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Rooms Night', true)
})
test.afterAll(async () => server?.stop())

const voiceChannel = (page: Page, name: string) => page.locator('.voice-channel', { has: page.locator('.channel-name', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) })
const joinButton = (page: Page, name: string) => voiceChannel(page, name).locator('.org-row > .channel')
const PHONE = { width: 390, height: 844 }

test('rooms: join a lobby to get your own room, lock it, invite a friend, and it goes when empty', async ({ browser }) => {
  test.setTimeout(180_000)
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const invite = await createInviteLink(host)
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, invite, 'Friend')

  // A voice channel, flagged as a lobby in its settings.
  await host.getByRole('button', { name: 'Create voice channel' }).first().click()
  await host.getByRole('radio', { name: 'Voice' }).click()
  await host.getByLabel('Name').fill('hangout')
  await host.getByRole('button', { name: 'Create', exact: true }).click()
  await voiceChannel(host, 'hangout').hover()
  await host.getByRole('button', { name: 'hangout options' }).click()
  await host.getByRole('menuitem', { name: 'Edit channel' }).click()
  const settings = host.getByRole('dialog', { name: 'hangout settings' })
  await settings.getByRole('checkbox', { name: 'Join to create a room' }).check()
  await settings.getByRole('button', { name: 'Save' }).click()
  await expect(settings).toHaveCount(0)
  await expect(voiceChannel(friend, 'hangout').locator('.lobby-badge')).toHaveText('Lobby')

  // Joining the lobby lands you in "host's-room", right under it; the lobby stays empty.
  await joinButton(host, 'hangout').click()
  await expect(host.locator('.voice-status strong')).toHaveText('Voice connected', { timeout: 20_000 })
  await expect(voiceChannel(friend, "host's-room").locator('.voice-participants li')).toHaveCount(1, { timeout: 20_000 })
  await expect(voiceChannel(friend, 'hangout').locator('.voice-participants li')).toHaveCount(0)
  await expect(host.locator('.voice-bar')).toContainText("host's-room")
  await expect(voiceChannel(host, "host's-room")).toContainText('Host')

  // The friend gets a room of their own too, placed after the host's.
  await joinButton(friend, 'hangout').click()
  await expect(friend.locator('.voice-status strong')).toHaveText('Voice connected', { timeout: 20_000 })
  await expect(voiceChannel(host, "friend's-room").locator('.voice-participants li')).toHaveCount(1, { timeout: 20_000 })
  const names = await host.locator('.voice-channel .channel-name').allTextContents()
  expect(names.indexOf("host's-room")).toBe(names.indexOf('hangout') + 1)
  expect(names.indexOf("friend's-room")).toBe(names.indexOf('hangout') + 2)
  await host.screenshot({ path: join(SHOTS, 'rooms-two-rooms.png') })

  // The host renames and locks the room from the voice bar: the friend sees a lock and can't join.
  await host.getByTestId('room-button').click()
  const room = host.getByRole('dialog', { name: 'Room settings' })
  await room.getByLabel('Name').fill('Build Night')
  await expect(room.getByText('Shown as build-night.')).toBeVisible()
  await room.getByRole('checkbox', { name: 'Lock the room' }).check()
  await host.screenshot({ path: join(SHOTS, 'rooms-settings.png') })
  await room.getByTestId('room-save').click()
  await expect(room).toHaveCount(0)
  await expect(voiceChannel(friend, 'build-night').locator('.room-lock')).toBeVisible()
  await expect(joinButton(friend, 'build-night')).toBeDisabled()
  await expect(joinButton(friend, 'build-night')).toHaveAttribute('title', /locked/)

  // Invited from the room settings: the friend joins, and their own room goes once it has been empty for a while.
  await host.getByTestId('room-button').click()
  await room.getByLabel('Search members').fill('Fri')
  await room.locator('li', { hasText: 'Friend' }).getByRole('button', { name: 'Invite' }).click()
  await expect(room.locator('li', { hasText: 'Friend' })).toContainText('Invited')
  await room.getByRole('button', { name: 'Cancel' }).click()
  await expect(joinButton(friend, 'build-night')).toBeEnabled()
  await joinButton(friend, 'build-night').click()
  await expect(voiceChannel(host, 'build-night').locator('.voice-participants li')).toHaveCount(2, { timeout: 20_000 })
  await expect(voiceChannel(host, "friend's-room")).toHaveCount(0, { timeout: 60_000 })
  await expect(voiceChannel(friend, "friend's-room")).toHaveCount(0)

  // The lobby and the rooms work on a phone too.
  await friend.setViewportSize(PHONE)
  await friend.getByRole('button', { name: 'Open channels' }).click()
  await expect(voiceChannel(friend, 'hangout').locator('.lobby-badge')).toBeVisible()
  await friend.screenshot({ path: join(SHOTS, 'rooms-phone.png') })

  // The host leaves: the room passes to the friend, who now has the room button.
  await expect(friend.getByTestId('room-button')).toHaveCount(0)
  await host.getByRole('button', { name: 'Leave voice' }).click()
  await expect(friend.getByTestId('room-button')).toBeVisible({ timeout: 20_000 })
})
