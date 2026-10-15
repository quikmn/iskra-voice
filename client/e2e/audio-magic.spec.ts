// Voice processing, all on the device: DeepFilterNet3 on the mic (AI noise removal), Silero VAD for voice activity,
// leveling and clean-up of what you hear, and hi-fi channels. The fake mic plays someone talking (speech.wav).
// The pages run under the app's Content-Security-Policy (plus 'unsafe-inline' for Vite's dev scripts), so the
// WebAssembly, the worklets and the worker must all load without eval.
import { expect, test, type Browser, type Page } from '@playwright/test'
import { join } from 'node:path'
import { CSP } from '../src/csp'
import { createInviteLink, FAKE_SPEECH_ARGS, hasLiveKit, joinVia, openSettings, SHOTS, startServer, type TestServer } from './helpers'

test.skip(!hasLiveKit(), 'needs .tools/livekit-server (see scripts/get-livekit.ps1)')
// The pages get their CSP header from a route, which Chromium's local network checks would then treat as a public site.
test.use({ launchOptions: { args: [...FAKE_SPEECH_ARGS, '--disable-features=LocalNetworkAccessChecks'] } })

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Audio Magic', true)
})
test.afterAll(async () => server?.stop())

const DEV_CSP = CSP.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")

/** A page under the app's CSP that records violations and the processing's realtime factors. */
async function page(browser: Browser, log: string[], viewport?: { width: number; height: number }): Promise<Page> {
  const context = await browser.newContext(viewport ? { viewport } : {})
  await context.route('**/*', async (route) => {
    if (route.request().resourceType() !== 'document') return route.continue()
    const response = await route.fetch()
    await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': DEV_CSP } })
  })
  await context.addInitScript(() => {
    const w = window as unknown as { cspViolations: string[] }
    w.cspViolations = []
    document.addEventListener('securitypolicyviolation', (e) => w.cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`))
  })
  const p = await context.newPage()
  p.on('console', (m) => {
    if (process.env.AUDIO_DEBUG) console.log('CONSOLE', m.type(), m.text())
    if (/realtime factor|could not start|too slow|can't keep up/.test(m.text())) log.push(m.text())
  })
  return p
}

const violations = (p: Page) => p.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations)

/** The loudest level (dBFS) the page receives from other people over a second and a half. */
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

test('AI noise removal, Silero voice activity, cleaning up and leveling what you hear, hi-fi channels', async ({ browser }) => {
  test.setTimeout(180_000)
  const log: string[] = []
  const host = await page(browser, log)
  await joinVia(host, server.ownerLink(), 'Host')

  // ── Settings: RNNoise (Strong) by default; AI chosen here, and it really runs (the engine says which one is active).
  await openSettings(host, 'Voice & audio')
  const settings = host.getByRole('dialog', { name: 'Settings' })
  await expect(settings.getByRole('radio', { name: 'Strong' })).toHaveAttribute('aria-checked', 'true')
  await settings.getByRole('radio', { name: 'AI' }).click()
  await expect(settings.getByRole('radio', { name: 'AI' })).toHaveAttribute('aria-checked', 'true')
  for (const name of ['Off', 'Standard', 'Strong']) await expect(settings.getByRole('radio', { name })).toBeEnabled()
  await expect(settings.getByLabel('Even out voices')).toBeChecked()
  await expect(settings.getByLabel("Clean up others' audio")).not.toBeChecked()
  await settings.getByRole('button', { name: 'Test microphone' }).click()
  await expect(settings.getByText('Active: AI noise removal (DeepFilterNet3).')).toBeVisible()
  // Silero hears the voice: the meter lights up (automatic sensitivity has no threshold marker).
  await expect(settings.locator('.mic-meter.open')).toBeVisible({ timeout: 20_000 })
  await expect(settings.locator('.mic-meter-mark')).toHaveCount(0)
  await settings.getByRole('radio', { name: 'Strong' }).click()
  await expect(settings.getByText('Active: Strong (RNNoise).')).toBeVisible()
  await settings.getByRole('radio', { name: 'AI' }).click()
  await settings.getByLabel("Clean up others' audio").check()
  await settings.getByRole('button', { name: 'Stop test' }).click()
  await host.screenshot({ path: join(SHOTS, 'audio-magic-settings.png') })

  // Settings stay after a reload.
  await host.reload()
  await openSettings(host, 'Voice & audio')
  await expect(settings.getByRole('radio', { name: 'AI' })).toHaveAttribute('aria-checked', 'true')
  await expect(settings.getByLabel("Clean up others' audio")).toBeChecked()
  await settings.getByLabel("Clean up others' audio").uncheck()
  await host.keyboard.press('Escape')

  // ── A voice channel that allows hi-fi (an admin's channel setting).
  await host.getByRole('button', { name: 'Create channel' }).first().click()
  const create = host.getByRole('dialog', { name: 'Create channel' })
  await create.getByRole('radio', { name: 'Voice' }).click()
  await create.getByPlaceholder('game-night').fill('music')
  await create.getByRole('button', { name: 'Create' }).click()
  const row = host.locator('.org-row', { has: host.getByRole('button', { name: 'music', exact: true }) })
  await row.hover()
  await row.getByRole('button', { name: 'music options' }).click()
  await host.getByRole('menuitem', { name: 'Edit channel' }).click()
  const channelSettings = host.getByRole('dialog', { name: 'music settings' })
  await channelSettings.getByLabel('Allow hi-fi audio').check()
  await channelSettings.getByRole('button', { name: 'Save' }).click()
  await expect(channelSettings).toBeHidden()

  const friendLink = await createInviteLink(host)
  const friend = await page(browser, log)
  await joinVia(friend, friendLink, 'Friend')
  const music = (p: Page) => p.locator('.voice-channel', { hasText: 'music' })
  await music(host).getByRole('button').first().click()
  await expect(host.locator('.voice-status strong')).toHaveText('Voice connected')
  await music(friend).getByRole('button').first().click()
  await expect(friend.locator('.voice-status strong')).toHaveText('Voice connected')

  // The host talks through AI noise removal; Silero opens the mic and lights the ring; the friend hears them.
  await expect(host.locator('.me-avatar.speaking')).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => receivedLevel(friend), { timeout: 20_000 }).toBeGreaterThan(-60)
  await openSettings(host, 'Voice & audio')
  await expect(settings.getByText('Active: AI noise removal (DeepFilterNet3).')).toBeVisible()
  await expect(settings.getByText(/Uses about \d+% of one CPU core\./)).toBeVisible({ timeout: 10_000 })
  await host.keyboard.press('Escape')

  // ── The friend cleans up what they hear: DeepFilterNet in a worker, and they still hear the host.
  await openSettings(friend, 'Voice & audio')
  const friendSettings = friend.getByRole('dialog', { name: 'Settings' })
  // Cleaning up what you hear uses your own engine: the friend picks AI (the default is Strong).
  await friendSettings.getByRole('radio', { name: 'AI' }).click()
  await friendSettings.getByLabel("Clean up others' audio").check()
  // A shared CI runner can be too slow for a second DeepFilterNet (this one, on what the friend hears, next to the
  // host's): falling back to RNNoise is the designed answer there, so CI accepts either; a dev machine must run AI.
  const incomingAi = friendSettings.getByText('Running: AI noise removal (DeepFilterNet3).')
  await expect(process.env.CI ? friendSettings.getByText(/Running: (AI noise removal \(DeepFilterNet3\)|Strong \(RNNoise\))\./) : incomingAi)
    .toBeVisible({ timeout: 20_000 })
  const ranAi = await incomingAi.isVisible()
  await friend.keyboard.press('Escape')
  await expect.poll(() => receivedLevel(friend), { timeout: 20_000 }).toBeGreaterThan(-60)
  if (ranAi) await expect.poll(() => log.some((l) => l.startsWith('[iskra] incoming AI noise removal: worker')), { timeout: 15_000 }).toBe(true)

  // ── Hi-fi: the host turns it on; in this channel the mic goes out unprocessed, in stereo.
  await openSettings(host, 'Voice & audio')
  await settings.getByLabel('Hi-fi audio in channels that allow it').check()
  await expect(settings.getByText('Use headphones with hi-fi on.', { exact: false })).toBeVisible()
  await expect(settings.getByText('Hi-fi is on in this channel: your mic is sent in stereo, unprocessed.')).toBeVisible({ timeout: 15_000 })
  await host.screenshot({ path: join(SHOTS, 'audio-magic-hifi.png') })
  await host.keyboard.press('Escape')
  await expect(host.locator('.voice-status strong')).toHaveText('Voice connected')
  await expect.poll(() => receivedLevel(friend), { timeout: 20_000 }).toBeGreaterThan(-60)

  // The admin turns hi-fi off for the channel: the host goes back to AI noise removal by itself.
  await row.hover()
  await row.getByRole('button', { name: 'music options' }).click()
  await host.getByRole('menuitem', { name: 'Edit channel' }).click()
  await channelSettings.getByLabel('Allow hi-fi audio').uncheck()
  await channelSettings.getByRole('button', { name: 'Save' }).click()
  await openSettings(host, 'Voice & audio')
  // Restarting DeepFilterNet next to the friend's may fall back to RNNoise on a busy machine (a shared CI runner, or 4
  // test workers here: 1 of 20 stress runs): by design, and then the app says AI was too heavy. Either, never neither.
  await expect(settings.getByText(/Active: (AI noise removal \(DeepFilterNet3\)|Strong \(RNNoise\))\./)).toBeVisible({ timeout: 20_000 })
  if (await settings.getByText('Active: Strong (RNNoise).').isVisible())
    await expect(settings.getByText('AI noise removal was too heavy for this device, so RNNoise is used.', { exact: false })).toBeVisible()
  await host.keyboard.press('Escape')
  await expect.poll(() => receivedLevel(friend), { timeout: 20_000 }).toBeGreaterThan(-60)

  // Phone width: the settings fit.
  await openSettings(host, 'Voice & audio')
  await host.setViewportSize({ width: 390, height: 844 })
  await expect(host.getByRole('radio', { name: 'AI' })).toBeVisible()
  await expect(host.getByRole('radio', { name: 'Off' })).toBeVisible()
  await host.screenshot({ path: join(SHOTS, 'audio-magic-phone.png'), fullPage: true })

  expect(await violations(host)).toEqual([])
  expect(await violations(friend)).toEqual([])
  for (const line of log) console.log(line)
  // Never "could not start". "Too slow" is the designed fallback when the machine is busy (a shared CI runner, or
  // several of these specs at once here: most runs with 4 workers): it depends on the load, not the code, so it's noted.
  expect(log.some((l) => /could not start/.test(l))).toBe(false)
  if (log.some((l) => /too slow|can't keep up/.test(l)))
    test.info().annotations.push({ type: 'warning', description: 'AI noise removal was too slow on this machine and fell back to RNNoise (by design)' })
})
