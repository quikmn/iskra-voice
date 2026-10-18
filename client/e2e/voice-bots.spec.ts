// Voice bots: an admin lets Jukebox join voice, a member in a voice channel types /play, the bot joins and the member
// hears it (the received level, as in audio-magic.spec). Its "Now playing" card has working buttons; the bot shows
// with the BOT badge in the channel; a moderator disconnects it.
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { Bot, encodeWav } from '../../bots/sdk/src/index'
import { jukebox } from '../../bots/gallery/jukebox/jukebox'
import { hasLiveKit, joinVia, SHOTS, startServer, type TestServer, VOICE_JOIN } from './helpers'

test.skip(!hasLiveKit(), 'needs .tools/livekit-server (see scripts/get-livekit.ps1)')

let server: TestServer
let dir: string
let bot: Bot | null = null
test.beforeAll(async () => {
  server = await startServer('Voice Bots Test', true)
  dir = mkdtempSync(join(tmpdir(), 'iskra-e2e-jukebox-'))
  // The music folder: two long tones (44.1 kHz mono WAV, which the bot resamples and makes stereo) around a short MP3.
  const rate = 44_100
  const tone = (hz: number) => Float32Array.from({ length: 45 * rate }, (_, i) => 0.4 * Math.sin((2 * Math.PI * hz * i) / rate))
  writeFileSync(join(dir, 'A tone.wav'), encodeWav([tone(440)], rate))
  copyFileSync(fileURLToPath(new URL('../interop/fixtures/tone.mp3', import.meta.url)), join(dir, 'B beep.mp3'))
  writeFileSync(join(dir, 'C tone.wav'), encodeWav([tone(330)], rate))
})
test.afterAll(async () => {
  await bot?.voice?.leave()
  bot?.stop()
  await server?.stop()
  rmSync(dir, { recursive: true, force: true })
})

/** The loudest level (dBFS) the page receives from others over a second and a half (as in audio-magic.spec). */
const receivedLevel = (p: Page) =>
  p.evaluate(() => new Promise<number>((done) => {
    const ctx = new AudioContext()
    const streams = [...document.querySelectorAll('audio')].map((a) => a.srcObject).filter((s): s is MediaStream => s instanceof MediaStream)
    const analysers = streams.map((s) => {
      const analyser = ctx.createAnalyser()
      ctx.createMediaStreamSource(s).connect(analyser)
      return analyser
    })
    const buf = new Float32Array(2048)
    let peak = -160
    const t = setInterval(() => {
      for (const a of analysers) {
        a.getFloatTimeDomainData(buf)
        const rms = Math.sqrt(buf.reduce((n, v) => n + v * v, 0) / buf.length)
        peak = Math.max(peak, 20 * Math.log10(rms || 1e-8))
      }
    }, 50)
    setTimeout(() => {
      clearInterval(t)
      void ctx.close()
      done(peak)
    }, 1500)
  }))

const lounge = (page: Page) => page.locator('.voice-channel', { hasText: 'lounge' })

test('a member plays music with Jukebox in a voice channel and hears it', async ({ browser }) => {
  test.setTimeout(120_000)
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')

  await host.getByRole('button', { name: 'Create voice channel' }).click()
  await host.getByRole('radio', { name: 'Voice' }).click()
  await host.getByLabel('Name').fill('lounge')
  await host.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(lounge(host)).toBeVisible()

  // A bot invite that lets the bot join voice (off unless the admin ticks it).
  await host.getByRole('button', { name: /server options/ }).click()
  await host.getByRole('menuitem', { name: 'More settings' }).click()
  await host.getByRole('menuitem', { name: 'Bots & webhooks' }).click()
  await host.getByRole('tab', { name: 'Bots' }).click()
  const voiceBox = host.getByRole('checkbox', { name: /Can join voice channels/ })
  await expect(voiceBox).not.toBeChecked()
  await voiceBox.check()
  await host.getByRole('button', { name: 'Create bot invite' }).click()
  const inviteBox = host.getByLabel('Bot invite link')
  await expect(inviteBox).toHaveValue(/#\/join\//)

  bot = new Bot({ name: 'Jukebox', invite: await inviteBox.inputValue(), stateFile: join(dir, 'jukebox.bot.json'), log: () => undefined })
  jukebox(bot, dir)
  await bot.start()
  const toggle = host.getByRole('checkbox', { name: 'Jukebox can join voice channels' })
  await expect(toggle).toBeChecked()
  await expect(host.locator('.bot-row', { hasText: 'Jukebox' })).toContainText('joins voice')
  await host.screenshot({ path: join(SHOTS, 'voice-bots-settings.png') })
  await host.keyboard.press('Escape')

  // /play from outside voice: the bot says to join first, privately.
  const box = host.getByPlaceholder('Message #general')
  await box.fill('/play ')
  await box.press('Enter')
  await expect(host.locator('.private-answer', { hasText: 'Join a voice channel first' })).toBeVisible()

  // In voice, /play: the bot joins the same channel and plays; the member hears it.
  await lounge(host).getByRole('button').first().click()
  await expect(host.locator('.voice-status strong')).toHaveText('Voice connected', VOICE_JOIN)
  await host.getByRole('button', { name: 'general', exact: true }).click() // back to the chat; voice stays on
  await box.fill('/play ')
  await box.press('Enter')
  const card = host.locator('.message').filter({ has: host.locator('.embed-title') }) // the bot's card, edited in place
  await expect(card.locator('.embed-title')).toHaveText('🎵 Now playing')
  await expect(card).toContainText('A tone')
  await expect(card).toContainText('B beep') // up next
  const botRow = lounge(host).locator('.voice-participants li', { hasText: 'Jukebox' })
  await expect(botRow).toBeVisible({ timeout: 15_000 })
  await expect(botRow.locator('.bot-badge')).toHaveText('BOT')
  await expect.poll(() => receivedLevel(host), { timeout: 20_000 }).toBeGreaterThan(-40)
  await host.screenshot({ path: join(SHOTS, 'voice-bots-playing.png') })

  // The card's buttons: pause (silence), resume.
  await card.getByRole('button', { name: 'Pause' }).click()
  await expect(card.locator('.embed-title')).toHaveText('⏸ Paused')
  await expect.poll(() => receivedLevel(host), { timeout: 15_000 }).toBeLessThan(-60)
  await card.getByRole('button', { name: 'Resume' }).click()
  await expect(card.locator('.embed-title')).toHaveText('🎵 Now playing')
  await expect.poll(() => receivedLevel(host), { timeout: 15_000 }).toBeGreaterThan(-40)

  // Muting the bot for yourself is the usual per-person volume.
  await botRow.click({ button: 'right' })
  await expect(host.getByRole('button', { name: 'Mute for me' })).toBeVisible()
  await host.keyboard.press('Escape')

  // Skip goes to the next song (a short one), then the one after it plays by itself; the card follows.
  await card.getByRole('button', { name: 'Skip' }).click()
  await expect(card.locator('.embed-description')).toContainText('C tone', { timeout: 15_000 })
  await expect(card).toContainText('Nothing: the queue ends here')
  await expect.poll(() => receivedLevel(host), { timeout: 15_000 }).toBeGreaterThan(-40)

  // A moderator (the owner here) disconnects the bot: it leaves the channel and says so on its card.
  await botRow.click({ button: 'right' })
  await host.getByRole('menuitem', { name: 'Disconnect from voice' }).click()
  await expect(lounge(host).locator('.voice-participants li', { hasText: 'Jukebox' })).toHaveCount(0, { timeout: 15_000 })
  await expect(card.locator('.embed-title')).toHaveText('⏹ Stopped', { timeout: 15_000 })
  await expect(card).toContainText('A moderator disconnected me.')
  await expect(card.locator('.bot-components button')).toHaveCount(0)

  // Phone width: the card and the voice list fit.
  await host.setViewportSize({ width: 390, height: 844 })
  await host.screenshot({ path: join(SHOTS, 'voice-bots-phone.png') })
})
