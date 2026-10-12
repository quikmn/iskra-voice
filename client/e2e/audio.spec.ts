// Voice & audio: the mic test and meter, noise suppression on the mic in a real call, your own speaking ring (Silero VAD
// hears the fake mic talking: it plays e2e/fixtures/speech.wav), per-person volume.
import { expect, test, type Page } from '@playwright/test'
import { join } from 'node:path'
import { createInviteLink, FAKE_SPEECH_ARGS, hasLiveKit, joinVia, longPress, openSettings, SHOTS, startServer, type TestServer } from './helpers'

test.skip(!hasLiveKit(), 'needs .tools/livekit-server (see scripts/get-livekit.ps1)')
test.use({ launchOptions: { args: FAKE_SPEECH_ARGS } })

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Audio Test', true)
})
test.afterAll(async () => server?.stop())

const lounge = (page: Page) => page.locator('.voice-channel', { hasText: 'lounge' })
const meterLevel = (page: Page) =>
  page.locator('.mic-meter-fill').evaluate((el) => Number(/scaleX\(([\d.]+)\)/.exec((el as HTMLElement).style.transform)?.[1] ?? 0))
/** The loudest level (dBFS) the page receives from other people over a second and a half. */
const receivedLevel = (page: Page) =>
  page.evaluate(() => new Promise<number>((done) => {
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

test('mic test, noise suppression in a call, your own speaking ring and per-person volume', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')

  // Settings: AI noise suppression by default, and the mic test shows a live level.
  await openSettings(host, 'Voice & audio')
  const settings = host.getByRole('dialog', { name: 'Settings' })
  await expect(settings.getByRole('radio', { name: 'AI' })).toHaveAttribute('aria-checked', 'true')
  await expect(settings.getByLabel('Echo cancellation')).toBeChecked()
  await expect(settings.getByLabel('Automatic gain control')).toBeChecked()
  await expect(settings.getByLabel('Input device')).toBeVisible()
  await expect(settings.getByLabel('Output device')).toBeVisible() // Chromium can choose where sound plays
  await settings.getByRole('button', { name: 'Test microphone' }).click()
  await expect.poll(() => meterLevel(host), { timeout: 15_000 }).toBeGreaterThan(0.1) // the fake mic talks
  await expect(settings.getByText('Active: AI noise removal (DeepFilterNet3).')).toBeVisible()

  // Manual sensitivity puts a threshold on the meter.
  await settings.getByLabel('Set automatically').uncheck()
  const threshold = settings.getByLabel('Input sensitivity')
  await expect(threshold).toHaveValue('-50')
  await threshold.fill('-30')
  await expect(threshold).toHaveValue('-30')
  await host.screenshot({ path: join(SHOTS, 'audio-settings.png') })
  await settings.getByLabel('Set automatically').check()
  await settings.getByRole('button', { name: 'Stop test' }).click()
  await host.keyboard.press('Escape')

  // A voice channel with a friend.
  await host.getByRole('button', { name: 'Create voice channel' }).click()
  await host.getByRole('radio', { name: 'Voice' }).click()
  await host.getByLabel('Name').fill('lounge')
  await host.getByRole('button', { name: 'Create', exact: true }).click()
  const friendLink = await createInviteLink(host)
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, friendLink, 'Friend')

  await lounge(host).getByRole('button').first().click()
  await expect(host.locator('.voice-status strong')).toHaveText('Voice connected')
  await lounge(friend).getByRole('button').first().click()
  await expect(friend.locator('.voice-status strong')).toHaveText('Voice connected')
  await expect(lounge(friend).locator('.voice-participants li')).toHaveCount(2)

  // Your own speaking shows on your avatar and the mic button, measured locally from the processed mic.
  await expect(host.locator('.me-avatar.speaking')).toBeVisible({ timeout: 15_000 })
  await expect(host.locator('.call-controls .call-button.talking')).toBeVisible()
  await expect(lounge(host).locator('li.me.speaking')).toBeVisible()
  // ...and the friend hears it: the processed track carries sound.
  await expect.poll(() => receivedLevel(friend), { timeout: 15_000 }).toBeGreaterThan(-60)
  await host.screenshot({ path: join(SHOTS, 'audio-speaking.png') })

  // In the call, the settings meter follows the call's mic; switching noise modes keeps the call going.
  await openSettings(host, 'Voice & audio')
  await expect(settings.getByText('Showing your mic in the call.')).toBeVisible()
  await expect.poll(() => meterLevel(host), { timeout: 15_000 }).toBeGreaterThan(0.1)
  await settings.getByRole('radio', { name: 'Standard' }).click()
  await settings.getByRole('radio', { name: 'Strong' }).click()
  await settings.getByLabel('Echo cancellation').uncheck()
  await expect(host.locator('.voice-status strong')).toHaveText('Voice connected')
  await host.keyboard.press('Escape')
  await expect(host.locator('.me-avatar.speaking')).toBeVisible({ timeout: 15_000 })
  await expect.poll(() => receivedLevel(friend), { timeout: 15_000 }).toBeGreaterThan(-60)

  // Muted: no ring, and a badge on your avatar.
  await host.locator('.call-controls').getByRole('button', { name: 'Mute', exact: true }).click()
  await expect(host.locator('.me-avatar-flag[aria-label="Muted"]')).toBeVisible()
  await expect(host.locator('.me-avatar.speaking')).toHaveCount(0)
  await host.locator('.call-controls').getByRole('button', { name: 'Unmute' }).click()

  // Right-click someone in voice: their menu has their volume.
  await lounge(friend).locator('li', { hasText: 'Host' }).click({ button: 'right' })
  const menu = friend.getByRole('dialog', { name: 'Options for Host' })
  await expect(menu).toBeVisible()
  await menu.getByRole('slider', { name: 'Volume for Host' }).fill('1.5')
  await expect(menu).toContainText('150%')
  await friend.screenshot({ path: join(SHOTS, 'audio-volume-menu.png') })
  await friend.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  // Nothing to adjust for yourself.
  await lounge(friend).locator('li', { hasText: 'Friend' }).click({ button: 'right' })
  await expect(friend.getByRole('dialog', { name: 'Options for Friend' })).toBeVisible()
  await expect(friend.getByRole('slider', { name: /^Volume for/ })).toHaveCount(0)
  await friend.keyboard.press('Escape')

  // Phones: press and hold someone in voice for a volume sheet.
  const phoneLink = await createInviteLink(host)
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })).newPage()
  await joinVia(phone, phoneLink, 'Phone')
  await phone.getByRole('button', { name: 'Open channels' }).click()
  await lounge(phone).getByRole('button').first().click()
  await expect(phone.locator('.stage')).toBeVisible()
  await phone.getByRole('button', { name: 'Open channels' }).click()
  const hostRow = lounge(phone).locator('li', { hasText: 'Host' })
  await expect(hostRow).toBeVisible()
  await longPress(phone, hostRow)
  const sheet = phone.getByRole('dialog', { name: 'Options for Host' })
  await expect(sheet).toBeVisible()
  await expect(phone.locator('.action-sheet.org-sheet')).toBeVisible()
  await expect(phone.locator('.profile-card')).toHaveCount(0) // the hold didn't also open the profile
  await sheet.getByRole('button', { name: 'Mute for me' }).click()
  await expect(sheet).toContainText('0%')
  await phone.screenshot({ path: join(SHOTS, 'audio-volume-phone.png') })
})
