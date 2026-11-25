import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { createInviteLink, hasLiveKit, joinVia, openServerSettings, openSettings, SHOTS, startServer, type TestServer, VOICE_JOIN } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Join Sounds Test', hasLiveKit())
})
test.afterAll(async () => server?.stop())

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

/** Records the server files this page plays from now on. */
async function recordPlays(page: Page) {
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
const plays = (page: Page) => page.evaluate(() => (window as unknown as { played: string[] }).played.length)

test('the others in a voice channel hear the sound of someone who enters', async ({ browser }) => {
  test.skip(!hasLiveKit(), 'needs LiveKit in .tools')
  test.setTimeout(150_000)
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const link = await createInviteLink(host)
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, link, 'Friend')
  const guest = await (await browser.newContext()).newPage()
  await joinVia(guest, link, 'Guest')

  // The owner adds a short sound and one that is too long for a join sound.
  await openServerSettings(host, 'Soundboard')
  for (const [name, ms] of [['airhorn', 800], ['anthem', 6500]] as const) {
    await host.locator('input[aria-label="Sound file"]').setInputFiles({ name: `${name}.wav`, mimeType: 'audio/wav', buffer: wav(ms) })
    await host.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(host.locator(`.expression-row input[aria-label="Name of ${name}"]`)).toBeVisible()
  }
  // The owner's switch is there and on.
  const serverSwitch = host.getByTestId('server-join-sounds').getByRole('switch', { name: /^Join sounds/ })
  await expect(serverSwitch).toBeChecked()
  await host.keyboard.press('Escape')

  // Friend picks a join sound: only the short one is offered.
  await openSettings(friend, 'Voice & audio')
  const section = friend.getByTestId('join-sounds-section')
  const pick = section.getByLabel('Your join sound on Join Sounds Test')
  await expect(pick.locator('option')).toHaveText(['None', 'airhorn'])
  await pick.selectOption({ label: 'airhorn' })
  await expect(pick).toHaveValue(/.+/)
  await section.scrollIntoViewIfNeeded()
  await friend.screenshot({ path: join(SHOTS, 'join-sounds-settings.png') })
  await friend.keyboard.press('Escape')

  // Guest doesn't want to hear join sounds.
  await openSettings(guest, 'Voice & audio')
  await guest.getByTestId('join-sounds-section').getByRole('switch', { name: /^Play other people's join sounds/ }).uncheck()
  await guest.keyboard.press('Escape')

  // Host and Guest are in a voice channel.
  await host.getByRole('button', { name: 'Create voice channel' }).click()
  await host.getByRole('radio', { name: 'Voice' }).click()
  await host.getByLabel('Name').fill('lounge')
  await host.getByRole('button', { name: 'Create', exact: true }).click()
  const lounge = (page: Page) => page.locator('.voice-channel', { hasText: 'lounge' })
  for (const page of [host, guest]) {
    await lounge(page).getByRole('button').first().click()
    await expect(page.locator('.voice-status strong')).toHaveText('Voice connected', VOICE_JOIN)
    await recordPlays(page)
  }
  await expect(host.locator('.voice-participants li')).toHaveCount(2)
  await recordPlays(friend)

  // Friend enters: Host hears the airhorn, Guest (who turned join sounds off) and Friend don't.
  await lounge(friend).getByRole('button').first().click()
  await expect(friend.locator('.voice-status strong')).toHaveText('Voice connected', VOICE_JOIN)
  await expect(host.locator('.voice-participants li')).toHaveCount(3)
  await expect.poll(() => plays(host)).toBe(1)
  expect(await plays(guest)).toBe(0)
  expect(await plays(friend)).toBe(0)

  // The owner turns join sounds off for the server: members see that where they pick.
  await openServerSettings(host, 'Soundboard')
  await serverSwitch.click() // it turns once the server says so
  await expect(serverSwitch).not.toBeChecked()
  await host.keyboard.press('Escape')
  await openSettings(friend, 'Voice & audio')
  await expect(section).toContainText('The owner turned join sounds off on this server.')
  await expect(pick).toHaveCount(0)

  // The same settings on a phone.
  await friend.setViewportSize({ width: 390, height: 844 })
  await section.scrollIntoViewIfNeeded()
  await friend.screenshot({ path: join(SHOTS, 'join-sounds-settings-phone.png') })
})
