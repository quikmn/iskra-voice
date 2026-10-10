import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { createInviteLink, joinVia, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Presence Test')
})
test.afterAll(async () => server?.stop())

test('presence: do not disturb, custom status, invisible; voice messages in a channel', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')
  const hostRow = friend.locator('.member-list').getByRole('button', { name: /^Host,/ })
  await expect(hostRow).toHaveAttribute('aria-label', 'Host, Online')

  // Host chooses Do not disturb from the bar under the channels.
  await host.getByRole('button', { name: /Set your status/ }).click()
  await expect(host.getByRole('menu', { name: 'Your status' })).toBeVisible()
  await host.screenshot({ path: join(SHOTS, 'status-menu.png') })
  await host.getByRole('menuitemradio', { name: /Do not disturb/ }).click()
  await expect(hostRow).toHaveAttribute('aria-label', 'Host, Do not disturb')
  await expect(hostRow.locator('.presence.dnd')).toBeVisible()

  // And a custom status with an emoji, cleared after an hour.
  await host.getByRole('button', { name: /Set your status/ }).click()
  await host.getByRole('menuitem', { name: 'Set a custom status' }).click()
  const dialog = host.getByRole('dialog', { name: 'Custom status' })
  await dialog.getByRole('button', { name: 'Pick an emoji' }).click()
  await host.getByRole('dialog', { name: 'Emoji picker' }).getByLabel('Search emoji').fill('fire')
  await host.getByRole('dialog', { name: 'Emoji picker' }).locator('.emoji-cell').first().click()
  await dialog.getByLabel("What's happening?").fill('Building a pillow fort')
  await dialog.getByLabel('Clear after').selectOption('1h')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(host.locator('.me-bar .custom-status-text')).toHaveText('Building a pillow fort')

  // The friend sees it in the member list and on the profile card.
  await expect(hostRow.locator('.custom-status-text')).toHaveText('Building a pillow fort')
  await expect(hostRow.locator('.custom-status-emoji')).not.toBeEmpty()
  await hostRow.click()
  const card = friend.getByRole('dialog', { name: 'Profile of Host' })
  await expect(card.locator('.profile-status')).toContainText('Building a pillow fort')
  await expect(card.locator('.profile-status-label')).toHaveText('Do not disturb')
  await friend.screenshot({ path: join(SHOTS, 'status-profile-card.png') })

  // In DMs too.
  await card.getByRole('button', { name: 'Message', exact: true }).click()
  await friend.getByPlaceholder('Message Host').fill('fort update?')
  await friend.getByPlaceholder('Message Host').press('Enter')
  await expect(friend.locator('.dm-row', { hasText: 'Host' }).locator('.dm-status')).toHaveText(/Building a pillow fort/)

  // Invisible: Host looks offline but keeps chatting.
  await host.getByRole('button', { name: /Set your status/ }).click()
  await host.getByRole('menuitemradio', { name: /Invisible/ }).click()
  await friend.locator('.server-rail').getByTitle('Presence Test').click()
  const offlineRow = friend.locator('.member-list .offline').getByRole('button', { name: /^Host,/ })
  await expect(offlineRow).toHaveAttribute('aria-label', 'Host, Offline')
  await expect(offlineRow.locator('.custom-status')).toHaveCount(0)
  await expect(host.locator('.me-bar .presence.invisible')).toBeVisible()

  // Back online, then a voice message: the friend taps the mic (fake microphone), records, sends.
  await host.getByRole('button', { name: /Set your status/ }).click()
  await host.getByRole('menuitemradio', { name: /^Online/ }).click()
  await expect(friend.locator('.member-list').getByRole('button', { name: /^Host,/ })).toHaveAttribute('aria-label', 'Host, Online')

  await friend.getByRole('button', { name: 'Record a voice message' }).click()
  const bar = friend.getByRole('group', { name: 'Recording a voice message' })
  await expect(bar.getByRole('button', { name: 'Send voice message' })).toBeVisible()
  await friend.waitForTimeout(1800)
  await expect(bar.locator('.voice-rec-time')).not.toHaveText('0:00')
  await friend.screenshot({ path: join(SHOTS, 'voice-recording.png') })
  await bar.getByRole('button', { name: 'Send voice message' }).click()

  const player = host.locator('.voice-player').last()
  await expect(player).toBeVisible()
  await expect(player.locator('.voice-time')).toHaveText(/0:0[12]/)
  await expect(player.locator('.voice-wave span.played')).toHaveCount(0)
  await player.getByRole('button', { name: 'Playback speed 1×' }).click()
  await expect(player.getByRole('button', { name: 'Playback speed 1.5×' })).toBeVisible()
  await player.getByRole('button', { name: 'Play voice message' }).click()
  await expect(player.getByRole('button', { name: 'Pause voice message' })).toBeVisible()
  await expect(player.locator('.voice-wave span.played').first()).toBeVisible({ timeout: 5000 })
  await host.screenshot({ path: join(SHOTS, 'voice-message.png') })

  // Cancelling a recording sends nothing.
  await friend.getByRole('button', { name: 'Record a voice message' }).click()
  await friend.getByRole('button', { name: 'Cancel recording' }).click()
  await expect(friend.getByRole('group', { name: 'Recording a voice message' })).toHaveCount(0)
  await expect(host.locator('.voice-player')).toHaveCount(1)

  // On a phone the player fits the width.
  await host.setViewportSize({ width: 390, height: 844 })
  await expect(host.locator('.voice-player').last()).toBeVisible()
  await host.waitForTimeout(500) // let the layout settle
  await host.screenshot({ path: join(SHOTS, 'voice-message-mobile.png') })
})
