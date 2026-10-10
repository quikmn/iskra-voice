import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { createInviteLink, hasLiveKit, joinVia, send, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Expressions Test', hasLiveKit())
})
test.afterAll(async () => server?.stop())

// A 3×2 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAEUlEQVR4nGNgYGD4z4AEMDgAHNoB/zrD+5kAAAAASUVORK5CYII=', 'base64')

/** A short 8 kHz mono WAV tone. */
function wav(ms: number): Buffer {
  const samples = 8 * ms
  const b = Buffer.alloc(44 + samples)
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples, 4); b.write('WAVEfmt ', 8)
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(8000, 28)
  b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(samples, 40)
  for (let i = 0; i < samples; i++) b[44 + i] = 128 + Math.round(60 * Math.sin(i / 4))
  return b
}

async function openSettings(page: Page) {
  await page.locator('.me-bar').getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
}

test('polls, server emoji, reactions and the soundboard', async ({ browser }) => {
  test.setTimeout(150_000)
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const friendContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const friend = await friendContext.newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')

  // ── A poll ──
  await host.getByRole('button', { name: 'Create a poll' }).click()
  const dialog = host.getByRole('dialog', { name: 'Create a poll' })
  await dialog.getByLabel('Question').fill('What do we play tonight?')
  await dialog.getByRole('textbox', { name: 'Answer 1' }).fill('Minecraft')
  await dialog.getByRole('textbox', { name: 'Answer 2' }).fill('Valheim')
  await dialog.getByRole('button', { name: 'Add answer' }).click()
  await dialog.getByRole('textbox', { name: 'Answer 3' }).fill('Lethal Company')
  await dialog.getByRole('button', { name: 'Post poll' }).click()
  await expect(dialog).toHaveCount(0)

  const friendPoll = friend.locator('.poll', { hasText: 'What do we play tonight?' })
  await expect(friendPoll).toBeVisible()
  await friendPoll.getByRole('radio', { name: 'Valheim' }).click()
  await friendPoll.getByRole('button', { name: 'Vote' }).click()
  await expect(friendPoll.locator('.poll-result.mine')).toContainText('Valheim')

  // The host sees the vote live, votes too, then ends the poll.
  const hostPoll = host.locator('.poll', { hasText: 'What do we play tonight?' })
  await expect(hostPoll.locator('.poll-footer')).toContainText('1 vote')
  await hostPoll.getByRole('radio', { name: 'Valheim' }).click()
  await hostPoll.getByRole('button', { name: 'Vote' }).click()
  await expect(friendPoll.locator('.poll-footer')).toContainText('2 votes')
  await expect(friendPoll.locator('.poll-result', { hasText: 'Valheim' })).toContainText('2 · 100%')
  await hostPoll.getByRole('button', { name: 'End poll' }).click()
  await expect(friendPoll).toContainText('Final results')
  await expect(friendPoll.locator('.poll-result.leading')).toContainText('Valheim')
  await expect(friendPoll.getByRole('button', { name: 'Change vote' })).toHaveCount(0)
  await friend.screenshot({ path: join(SHOTS, 'poll-mobile.png') })

  // ── A server emoji ──
  await openSettings(host)
  await host.locator('input[aria-label="Emoji image"]').setInputFiles({ name: 'Blob Wave.png', mimeType: 'image/png', buffer: PNG })
  await expect(host.getByLabel('Emoji name')).toHaveValue('blob_wave')
  await host.getByLabel('Emoji name').fill('blob')
  await host.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(host.locator('.expression-row input[aria-label="Name of :blob:"]')).toBeVisible()
  await host.screenshot({ path: join(SHOTS, 'emoji-settings.png') })
  await host.keyboard.press('Escape')

  // Typed as :blob:, shown as the image for everyone (autocomplete offers it too).
  const box = host.getByPlaceholder('Message #general')
  await box.fill('hello :bl')
  await expect(host.locator('.emoji-suggest')).toContainText(':blob:')
  await box.press('Tab')
  await expect(box).toHaveValue('hello :blob: ')
  await box.press('Enter')
  const emojiImage = friend.locator('.message-text img.custom-emoji[alt=":blob:"]')
  await expect(emojiImage).toBeVisible()
  await expect.poll(() => emojiImage.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(3)

  // An emoji-only message is big.
  await send(host, ':blob: :fire:')
  await expect(friend.locator('.message-text .jumbo').last()).toContainText('🔥')

  // The friend reacts with the server emoji from the full picker (a bottom sheet on a phone).
  const message = friend.locator('.message', { hasText: 'hello' }).first()
  await message.locator('.message-body').click()
  await message.getByRole('button', { name: 'Add reaction' }).click()
  await friend.getByRole('menuitem', { name: 'More emoji' }).click()
  const picker = friend.getByRole('dialog', { name: 'Emoji picker' })
  await expect(friend.locator('.emoji-picker-layer.sheet')).toBeVisible()
  await friend.screenshot({ path: join(SHOTS, 'emoji-picker-mobile.png') })
  await picker.getByLabel('Search emoji').fill('blo')
  await picker.getByRole('button', { name: ':blob:' }).click()
  await expect(picker).toHaveCount(0)
  await expect(host.locator('.message', { hasText: 'hello' }).first().locator('.reaction img.custom-emoji')).toBeVisible()
  await expect(host.locator('.message', { hasText: 'hello' }).first().locator('.reaction')).toContainText('1')

  // The composer's picker inserts standard emoji at the caret.
  await host.getByRole('button', { name: 'Emoji', exact: true }).click()
  await host.getByRole('dialog', { name: 'Emoji picker' }).getByLabel('Search emoji').fill('tada')
  await host.getByRole('dialog', { name: 'Emoji picker' }).getByRole('button', { name: ':tada:' }).click()
  await host.keyboard.press('Escape')
  await expect(box).toHaveValue('🎉')
  await host.screenshot({ path: join(SHOTS, 'emoji-and-polls.png') })

  // ── The soundboard (needs LiveKit) ──
  if (!hasLiveKit()) return
  // Record what each page plays.
  for (const page of [host, friend]) {
    await page.evaluate(() => {
      const w = window as unknown as { played: string[] }
      w.played = []
      const original = HTMLMediaElement.prototype.play
      HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
        if (this.src.includes('/files/')) w.played.push(this.src)
        return original.call(this)
      }
    })
  }

  // A trusted member (here the owner) adds a sound.
  await openSettings(host)
  await host.locator('input[aria-label="Sound file"]').setInputFiles({ name: 'airhorn.wav', mimeType: 'audio/wav', buffer: wav(800) })
  await host.getByLabel('Sound emoji').fill('📯')
  await host.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(host.locator('.expression-row input[aria-label="Name of airhorn"]')).toBeVisible()
  await host.keyboard.press('Escape')

  // A voice channel, both in it.
  await host.getByRole('button', { name: 'Create voice channel' }).click()
  await host.getByRole('radio', { name: 'Voice' }).click()
  await host.getByLabel('Name').fill('lounge')
  await host.getByRole('button', { name: 'Create', exact: true }).click()
  const lounge = (page: Page) => page.locator('.voice-channel', { hasText: 'lounge' })
  await lounge(host).getByRole('button').first().click()
  await expect(host.locator('.voice-status strong')).toHaveText('Voice connected')
  await friend.getByRole('button', { name: 'Open channels' }).first().click()
  await lounge(friend).getByRole('button').first().click()
  await expect(friend.locator('.call-controls')).toBeVisible()
  await expect(host.locator('.voice-participants li')).toHaveCount(2)

  // Play it from the call screen: everyone in the call hears it and sees who played it.
  await friend.locator('.call-controls').getByRole('button', { name: 'Soundboard' }).click()
  await friend.getByRole('dialog', { name: 'Soundboard' }).getByRole('button', { name: /airhorn/ }).click()
  await expect(host.locator('.sound-toast')).toContainText('Friend played airhorn')
  await expect(friend.locator('.sound-toast')).toContainText('Friend played airhorn')
  await expect.poll(() => host.evaluate(() => (window as unknown as { played: string[] }).played.length)).toBe(1)
  await host.screenshot({ path: join(SHOTS, 'soundboard-toast.png') })
  await friend.screenshot({ path: join(SHOTS, 'soundboard-mobile.png') })

  // Muting the soundboard in settings: you still see who played, but nothing plays.
  await friend.keyboard.press('Escape')
  await openSettings(host)
  await host.getByLabel(/Mute the soundboard/).check()
  await host.keyboard.press('Escape')
  await host.locator('.voice-controls').getByRole('button', { name: 'Soundboard' }).click()
  await host.getByRole('dialog', { name: 'Soundboard' }).getByRole('button', { name: /airhorn/ }).click()
  await expect(friend.locator('.sound-toast', { hasText: 'Host played airhorn' })).toBeVisible()
  await expect.poll(() => friend.evaluate(() => (window as unknown as { played: string[] }).played.length)).toBe(2)
  expect(await host.evaluate(() => (window as unknown as { played: string[] }).played.length)).toBe(1)
})
