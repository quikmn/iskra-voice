// Camera background effects and live captions, all on the device. The fake camera is Chromium's test pattern (no
// person in it, so the whole picture counts as background), the fake mic plays someone talking (speech.wav).
// Pages run under the app's Content-Security-Policy; no request may leave for anywhere but this machine.
// The captions model isn't in git: `node scripts/get-models.mjs` downloads it into client/.models (CI caches it), and
// the test servers fetch it from there instead of Hugging Face (Captions.ModelSource). Without it the captions test is
// skipped.
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CSP } from '../src/csp'
import { createInviteLink, FAKE_SPEECH_ARGS, hasLiveKit, joinVia, openSettings, SHOTS, startServer, type TestServer } from './helpers'

test.skip(!hasLiveKit(), 'needs .tools/livekit-server (see scripts/get-livekit.ps1)')
test.use({ launchOptions: { args: [...FAKE_SPEECH_ARGS, '--disable-features=LocalNetworkAccessChecks'] } })

const MODEL_DIR = 'whisper-base-1846881b'
const MODEL = resolve(dirname(fileURLToPath(import.meta.url)), `../.models/models/${MODEL_DIR}/decoder.q8.onnx.part2.bin`)

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Blur Captions', true)
})
test.afterAll(async () => server?.stop())

const DEV_CSP = CSP.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")

async function page(browser: Browser, log: string[], away: string[]): Promise<Page> {
  const context = await browser.newContext()
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
  // Everything stays on this machine (workers' requests included).
  context.on('request', (r) => {
    const host = new URL(r.url()).hostname
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) away.push(r.url())
  })
  const p = await context.newPage()
  p.on('console', (m) => {
    if (process.env.MEDIA_DEBUG) console.log('CONSOLE', m.type(), m.text())
    if (/\[iskra\] (background effect|captions)/.test(m.text())) log.push(m.text())
  })
  p.on('worker', (w) => w.on('console', (m) => {
    if (process.env.MEDIA_DEBUG) console.log('WORKER', m.type(), m.text())
  }))
  return p
}

const violations = (p: Page) => p.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations)

/** The mean colour and the sharpness (mean absolute difference between neighbours) of what a <video> shows. */
const look = (video: Locator) =>
  video.evaluate((v: HTMLVideoElement) => {
    const w = 160
    const h = 90
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const g = canvas.getContext('2d', { willReadFrequently: true })!
    g.drawImage(v, 0, 0, w, h)
    const d = g.getImageData(0, 0, w, h).data
    let r = 0, gr = 0, b = 0, edges = 0
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4
        r += d[i]; gr += d[i + 1]; b += d[i + 2]
        if (x > 0) edges += Math.abs(d[i] - d[i - 4]) + Math.abs(d[i + 1] - d[i - 3]) + Math.abs(d[i + 2] - d[i - 2])
      }
    }
    const n = w * h
    return { r: r / n, g: gr / n, b: b / n, sharpness: edges / n }
  })

const playing = (video: Locator) => expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 20_000 }).toBeGreaterThan(0)

test('background blur and replace on the camera', async ({ browser }) => {
  test.setTimeout(240_000)
  const log: string[] = []
  const away: string[] = []
  const host = await page(browser, log, away)
  await joinVia(host, server.ownerLink(), 'Host')

  // ── Settings → Camera: off by default; the preview shows the effect running on this device.
  await openSettings(host, 'Camera')
  const settings = host.getByRole('dialog', { name: 'Settings' })
  await expect(settings.getByRole('radio', { name: 'Off' })).toHaveAttribute('aria-checked', 'true')
  await settings.getByRole('button', { name: 'Preview' }).click()
  const preview = settings.getByLabel('Camera preview')
  await playing(preview)
  await host.waitForTimeout(1000)
  const raw = await look(preview)

  await settings.getByRole('radio', { name: 'Blur' }).click()
  await expect(preview).toHaveAttribute('data-effect', 'blur')
  await playing(preview)
  // Blurred: much softer than the camera's own picture (the test pattern has nobody in it, so it's all background).
  await expect.poll(async () => (await look(preview)).sharpness, { timeout: 30_000 }).toBeLessThan(raw.sharpness * 0.6)
  await host.screenshot({ path: join(SHOTS, 'background-blur-settings.png') })

  // Replace with a solid colour: the picture turns that colour.
  await settings.getByRole('radio', { name: 'Replace' }).click()
  await settings.getByRole('radio', { name: 'Colour' }).click()
  await settings.getByLabel('Pick a colour').fill('#d02020')
  await expect.poll(async () => {
    const c = await look(preview)
    return c.r > 150 && c.g < 80 && c.b < 80
  }, { timeout: 20_000 }).toBe(true)
  await settings.getByRole('radio', { name: 'Sunset' }).click()
  await host.screenshot({ path: join(SHOTS, 'background-replace-settings.png') })
  await settings.getByRole('button', { name: 'Stop preview' }).click()

  // Remembered on this device.
  await host.reload()
  await openSettings(host, 'Camera')
  await expect(settings.getByRole('radio', { name: 'Replace' })).toHaveAttribute('aria-checked', 'true')
  await expect(settings.getByRole('radio', { name: 'Sunset' })).toHaveAttribute('aria-checked', 'true')
  await settings.getByRole('radio', { name: 'Colour' }).click()
  expect(await host.evaluate(() => JSON.parse(localStorage.getItem('iskra.background') ?? '{}'))).toMatchObject({ mode: 'replace', backdrop: 'color', color: '#d02020' })
  await host.keyboard.press('Escape')

  // ── A call: the friend sees the processed camera (red: the published track is the processed one), never the room.
  await host.getByRole('button', { name: 'Create voice channel' }).click()
  await host.getByRole('radio', { name: 'Voice' }).click()
  await host.getByLabel('Name').fill('lounge')
  await host.getByRole('button', { name: 'Create', exact: true }).click()
  const lounge = (p: Page) => p.locator('.voice-channel', { hasText: 'lounge' })
  const friendLink = await createInviteLink(host)
  const friend = await page(browser, log, away)
  await joinVia(friend, friendLink, 'Friend')
  // Joining starts the camera effect next to LiveKit's handshake: under load (4 workers) the signal connection took
  // over 5 s once (still connecting, no error). The time a11y and the desktop specs give it too.
  await lounge(host).getByRole('button').first().click()
  await expect(host.locator('.voice-status strong')).toHaveText('Voice connected', { timeout: 20_000 })
  await lounge(friend).getByRole('button').first().click()
  await expect(friend.locator('.voice-status strong')).toHaveText('Voice connected', { timeout: 20_000 })

  await host.locator('.call-controls').getByRole('button', { name: 'Turn camera on' }).click()
  const hostVideo = friend.locator('.video-tile.camera video')
  await playing(hostVideo)
  await expect.poll(async () => {
    const c = await look(hostVideo)
    return c.r > 150 && c.g < 80 && c.b < 80
  }, { timeout: 30_000 }).toBe(true)
  // Switching to blur mid-call keeps the effect running; turning it off sends the camera itself again (the host's
  // own tile shows what's sent: Chromium's fake camera is labelled as such, the processed track isn't).
  const sentLabel = () => host.locator('.video-tile.camera video').evaluate((v: HTMLVideoElement) => (v.srcObject as MediaStream | null)?.getVideoTracks()[0]?.label ?? '')
  expect(await sentLabel()).not.toMatch(/fake/)
  await openSettings(host, 'Camera')
  await settings.getByRole('radio', { name: 'Blur' }).click()
  await expect.poll(async () => (await look(hostVideo)).r < 150 || (await look(hostVideo)).g > 80, { timeout: 20_000 }).toBe(true)
  await expect(settings.getByText(/Running at \d+ frames a second/)).toBeVisible({ timeout: 15_000 })
  expect(await sentLabel()).not.toMatch(/fake/)
  await settings.getByRole('radio', { name: 'Off' }).click()
  await expect.poll(sentLabel, { timeout: 10_000 }).toMatch(/fake/)
  await host.keyboard.press('Escape')

  expect(await violations(host)).toEqual([])
  expect(await violations(friend)).toEqual([])
  expect(away).toEqual([])
  for (const line of log) console.log(line)
  expect(log.some((l) => /could not start|can't keep up/.test(l))).toBe(false)
})

test('live captions of what people say, with the model downloaded once and checked', async ({ browser }) => {
  test.skip(!existsSync(MODEL), 'the captions model is not downloaded: run node scripts/get-models.mjs from the repo root')
  test.setTimeout(240_000)
  const log: string[] = []
  const away: string[] = []
  const captionsServer = await startServer('Captions', true)
  try {
    const host = await page(browser, log, away)
    await joinVia(host, captionsServer.ownerLink(), 'Host')
    await host.getByRole('button', { name: 'Create voice channel' }).click()
    await host.getByRole('radio', { name: 'Voice' }).click()
    await host.getByLabel('Name').fill('lounge')
    await host.getByRole('button', { name: 'Create', exact: true }).click()
    const lounge = (p: Page) => p.locator('.voice-channel', { hasText: 'lounge' })
    const friend = await page(browser, log, away)
    await joinVia(friend, await createInviteLink(host), 'Friend')
    await lounge(host).getByRole('button').first().click()
    await expect(host.locator('.voice-status strong')).toHaveText('Voice connected')
    await lounge(friend).getByRole('button').first().click()
    await expect(friend.locator('.voice-status strong')).toHaveText('Voice connected')

    // ── Captions: the friend opts in; the host's voice turns into text under their name, on the friend's device.
    // The first time it asks before the one-time download; a failed download says so, and the call goes on.
    await friend.route('**/models/**', (route) => route.fulfill({ status: 503, body: 'down' }))
    await friend.locator('.call-controls').getByRole('button', { name: 'Show captions' }).click()
    const overlay = friend.getByRole('region', { name: 'Live captions' })
    await expect(overlay).toBeVisible()
    await expect(overlay).toContainText(/Captions need a one-time [\d.,]+ MB download/)
    await friend.screenshot({ path: join(SHOTS, 'captions-download.png') })
    await overlay.getByRole('button', { name: 'Download' }).click()
    await expect(overlay).toContainText("Couldn't get the speech model from this server", { timeout: 20_000 })
    await expect(friend.locator('.voice-status strong')).toHaveText('Voice connected')
    // A file that isn't the pinned one is refused.
    await friend.unroute('**/models/**')
    await friend.route('**/models/**/vocab.json.part0.bin?*', (route) => route.fulfill({ status: 200, body: 'not the vocabulary' }))
    await overlay.getByRole('button', { name: 'Try again' }).click()
    await expect(overlay).toContainText("wasn't the right file", { timeout: 60_000 })
    await friend.unroute('**/models/**/vocab.json.part0.bin?*')
    await overlay.getByRole('button', { name: 'Try again' }).click()
    // The parts came from the call's own server, which fetched the model once into its world folder.
    await expect(overlay.locator('[aria-live="polite"]')).toHaveCount(1)
    await expect(overlay.locator('.caption-line', { hasText: 'Host' })).toContainText(/Donald|Trump|Sarah|Palin|endorsement|encore/i, { timeout: 120_000 })
    await friend.screenshot({ path: join(SHOTS, 'captions-call.png') })
    expect(await friend.evaluate(() => JSON.parse(localStorage.getItem('iskra.captions') ?? '{}'))).toMatchObject({ enabled: true })
    await expect.poll(() => log.some((l) => l.startsWith('[iskra] captions:')), { timeout: 30_000 }).toBe(true)

    // The model is kept on the device: Settings says so, and it's in Cache Storage.
    await openSettings(friend, 'Voice & audio')
    const friendSettings = friend.getByRole('dialog', { name: 'Settings' })
    await expect(friendSettings.getByLabel('Show captions in calls')).toBeChecked()
    await expect(friendSettings.getByText('The speech model is on this device.')).toBeVisible()
    expect(await friend.evaluate(async () => (await (await caches.open('iskra-models')).keys()).length)).toBe(6)
    // Members only: without the link the app got over its connection, the server refuses the model.
    const anonymous = await friend.request.get(`${captionsServer.url}/models/${MODEL_DIR}/vocab.json.part0.bin`)
    expect(anonymous.status()).toBe(403)
    await friendSettings.getByLabel('Caption language').selectOption('sv')
    await friend.keyboard.press('Escape')

    // Phone width: the overlay and the controls fit.
    await friend.setViewportSize({ width: 390, height: 844 })
    await friend.waitForTimeout(600)
    await expect(overlay).toBeVisible()
    const box = (await overlay.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(390)
    await friend.screenshot({ path: join(SHOTS, 'captions-phone.png') })

    // Dismissing turns captions off for this listener.
    await overlay.getByRole('button', { name: 'Hide captions' }).click()
    await expect(overlay).toHaveCount(0)
    expect(await friend.evaluate(() => JSON.parse(localStorage.getItem('iskra.captions') ?? '{}'))).toMatchObject({ enabled: false, language: 'sv' })

    expect(await violations(host)).toEqual([])
    expect(await violations(friend)).toEqual([])
    expect(away).toEqual([])
    for (const line of log) console.log(line)
    // Over 7 s per phrase pauses captions by design: a shared CI runner, or this machine under load (2 of 20 stress
    // runs with 4 workers). Whether it kept up depends on the machine's load, not the code, so it's noted, not failed.
    if (log.some((l) => /can't keep up/.test(l)))
      test.info().annotations.push({ type: 'warning', description: "captions couldn't keep up on this machine (paused by design)" })
  } finally {
    await captionsServer.stop()
  }
})
