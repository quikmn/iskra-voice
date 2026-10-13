import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInviteLink, hasLiveKit, joinVia, openSettings, SHOTS, startServer, type TestServer } from './helpers'

test.skip(!hasLiveKit(), 'needs .tools/livekit-server (see scripts/get-livekit.ps1)')

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Voice Chat Test', true)
})
test.afterAll(async () => server?.stop())

const lounge = (page: Page) => page.locator('.voice-channel', { hasText: 'lounge' })

test('voice channels have their own chat, and clips save the last seconds with a notice', async ({ browser }) => {
  test.setTimeout(120_000)
  const host = await (await browser.newContext({ acceptDownloads: true })).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  await host.getByRole('button', { name: 'Create voice channel' }).click()
  await host.getByRole('radio', { name: 'Voice' }).click()
  await host.getByLabel('Name').fill('lounge')
  await host.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(lounge(host)).toBeVisible()

  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')

  // The friend opens the lounge's chat from the channel list without joining the call.
  await lounge(friend).getByRole('button', { name: 'Chat in lounge' }).click()
  await expect(friend.getByRole('heading', { name: 'lounge' })).toBeVisible()
  const friendBox = friend.getByPlaceholder('Message #lounge')
  await friendBox.fill('hop in, **movie** at 8')
  await friendBox.press('Enter')
  await expect(friend.locator('.message-text', { hasText: 'movie at 8' })).toBeVisible()

  // The host sees it as unread on the lounge's chat button.
  await expect(lounge(host).getByRole('button', { name: 'Chat in lounge (unread)' })).toBeVisible()

  // The host joins the call: the call screen's chat button counts the new message, and opens the chat beside it.
  await lounge(host).getByRole('button').first().click()
  await expect(host.locator('.voice-status strong')).toHaveText('Voice connected')
  const toggle = host.getByRole('button', { name: 'Open chat (1 new)' })
  await expect(toggle).toBeVisible()
  await toggle.click()
  const panel = host.getByRole('region', { name: 'Chat in lounge' })
  await expect(panel.locator('.message-text', { hasText: 'movie at 8' })).toBeVisible()
  await expect(lounge(host).getByRole('button', { name: 'Chat in lounge', exact: true })).toBeVisible() // read now
  await panel.getByPlaceholder('Message lounge').fill('@Friend on my way')
  await panel.getByPlaceholder('Message lounge').press('Enter')
  await expect(friend.locator('.message-text', { hasText: 'on my way' })).toBeVisible()
  await expect(friend.locator('.message-text .mention', { hasText: '@Friend' })).toBeVisible()

  // Clips are opt in: off, the button says so and offers to turn them on.
  await host.locator('.call-controls').getByRole('button', { name: 'Clips are off' }).click()
  const clipsOff = host.getByRole('alert').filter({ hasText: 'Clips are off' })
  await expect(clipsOff).toBeVisible()
  // Down by the controls, not over the header.
  expect((await clipsOff.boundingBox())!.y).toBeGreaterThan(400)
  await openSettings(host, 'Voice & audio')
  const settings = host.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('checkbox', { name: 'Let me save clips' }).check()
  await expect(settings.getByText('Clip length: 30 seconds')).toBeVisible()
  await settings.getByLabel('Clip length').fill('15')
  await expect(settings.getByText('Clip length: 15 seconds')).toBeVisible()
  await host.screenshot({ path: join(SHOTS, 'clip-settings.png') })
  await host.keyboard.press('Escape')

  // The friend joins too (their fake mic is what the host hears) and sees that the host has clips on.
  await lounge(friend).getByRole('button').first().click()
  await expect(friend.locator('.voice-status strong')).toHaveText('Voice connected')
  await expect(friend.locator('.clips-strip')).toHaveText('Clips on: Host')
  await expect(lounge(friend).locator('li', { hasText: 'Host' }).getByRole('img', { name: 'Clips on' })).toBeVisible()
  await friend.getByRole('button', { name: /Open chat/ }).click()
  const friendPanel = friend.getByRole('region', { name: 'Chat in lounge' })
  await expect
    .poll(() => host.evaluate(() => [...document.querySelectorAll('audio')].some((a) => !a.paused && a.currentTime > 0)), { timeout: 15_000 })
    .toBe(true)
  await host.waitForTimeout(4000) // a few seconds in the buffer

  await host.locator('.call-controls').getByRole('button', { name: 'Save the last 15 seconds' }).click()
  const dialog = host.getByRole('dialog', { name: 'Your clip' })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('video.clip-preview')).toBeVisible()
  // Everyone is told: a notice in the lounge's chat, and a toast in the call.
  await expect(friend.locator('.clip-toast', { hasText: 'Host saved a clip' })).toBeVisible()
  await expect(friendPanel.locator('.clip-notice', { hasText: 'Host saved a clip of this call' })).toBeVisible()
  await expect(panel.locator('.clip-notice', { hasText: 'Host saved a clip of this call' })).toBeVisible()
  // The preview plays the WebM the clip made.
  await expect.poll(() => dialog.locator('video').evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 10_000 }).toBeGreaterThan(0)
  await host.screenshot({ path: join(SHOTS, 'clip-dialog.png') })

  // Trim, then save: a WebM file comes out.
  await dialog.locator('input[type="range"]').first().fill('1000')
  await expect(dialog.getByText('Start 0:01')).toBeVisible()
  const download = host.waitForEvent('download')
  await dialog.getByRole('button', { name: 'Save' }).click()
  const file = await download
  expect(file.suggestedFilename()).toMatch(/^iskra-clip-\d{4}-\d{2}-\d{2}-\d{6}\.webm$/)
  const bytes = readFileSync((await file.path())!)
  expect(bytes.length).toBeGreaterThan(1000)
  expect([...bytes.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3])
  await expect(dialog.getByText('Saved.')).toBeVisible()

  // Share it into the lounge's chat.
  await dialog.getByRole('button', { name: 'Share in chat' }).click()
  await expect(dialog.getByText('Shared in the chat.')).toBeVisible({ timeout: 15_000 })
  await dialog.getByRole('button', { name: 'Close' }).last().click()
  await expect(friendPanel.locator('.message').last().locator('audio, video')).toBeAttached({ timeout: 15_000 })

  // The person who saved it can't take the notice down.
  await expect(panel.locator('.clip-notice').getByRole('button', { name: 'Remove notice' })).toHaveCount(0)
  await host.screenshot({ path: join(SHOTS, 'voice-chat-panel.png') })

  // Phones: the chat is a full-screen sheet over the call.
  await friend.setViewportSize({ width: 390, height: 844 })
  const sheet = friendPanel
  await expect(sheet).toBeVisible()
  expect((await sheet.boundingBox())!.width).toBeGreaterThanOrEqual(389)
  await friend.screenshot({ path: join(SHOTS, 'voice-chat-phone.png') })
  await sheet.getByRole('button', { name: 'Back to the call' }).click()
  await expect(sheet).toHaveCount(0)
  await friend.setViewportSize({ width: 1280, height: 720 })

  // DM calls are end-to-end encrypted: the "clips on" mark and the notice go over the call's own data channel.
  await friend.getByRole('button', { name: 'Leave voice' }).click()
  await friend.locator('.member-list').getByRole('button', { name: 'Host' }).click()
  await friend.getByRole('button', { name: 'Add friend' }).click()
  await friend.getByRole('dialog').getByRole('button', { name: 'Message', exact: true }).click()
  await friend.getByRole('button', { name: 'Start voice call' }).click()
  await host.getByRole('alertdialog').getByRole('button', { name: 'Accept' }).click()
  const call = (page: Page) => page.locator('.call-panel')
  for (const page of [host, friend]) await expect(call(page).locator('.call-status')).toHaveText(/^\d+:\d\d$/, { timeout: 20_000 })
  await expect(friend.locator('.clips-strip')).toHaveText('Clips on: Host', { timeout: 10_000 })
  await expect
    .poll(() => host.evaluate(() => [...document.querySelectorAll('audio')].some((a) => !a.paused && a.currentTime > 0)), { timeout: 15_000 })
    .toBe(true)
  await expect(friend.locator('.clip-toast')).toHaveCount(0, { timeout: 10_000 }) // the channel's toast has gone
  await call(host).getByRole('button', { name: 'Save the last 15 seconds' }).click()
  await expect(host.getByRole('dialog', { name: 'Your clip' })).toBeVisible()
  await expect(friend.locator('.clip-toast', { hasText: 'Host saved a clip' })).toBeVisible()
  await friend.screenshot({ path: join(SHOTS, 'clip-dm-call.png') })
  await host.getByRole('dialog', { name: 'Your clip' }).getByRole('button', { name: 'Discard' }).click()
  await call(friend).getByRole('button', { name: 'Hang up' }).click()
})
