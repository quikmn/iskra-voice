// YouTube watch parties against the real YouTube (needs the internet): run with ISKRA_E2E_NETWORK=1.
// In the browser (http://localhost origin) and in the Electron app (app://iskra, which YouTube can't use as a referrer).
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect, test, type FrameLocator, type Page } from '@playwright/test'
import { agreeToTerms, createInviteLink, hasLiveKit, joinVia, SHOTS, startServer, type TestServer } from './helpers'

test.skip(process.env.ISKRA_E2E_NETWORK !== '1', 'talks to YouTube: set ISKRA_E2E_NETWORK=1')
test.skip(!hasLiveKit(), 'needs .tools/livekit-server (see scripts/get-livekit.ps1)')

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP = resolve(HERE, '../../desktop')
/** "Big Buck Bunny" from the Blender Foundation's channel: public and embeddable. */
const VIDEO = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'

// Each test gets its own server (the owner link works once).
let server: TestServer
test.beforeEach(async () => {
  server = await startServer('YouTube Test', true)
})
test.afterEach(async () => server?.stop())

const lounge = (page: Page) => page.locator('.voice-channel', { hasText: 'cinema' })
const youtube = (page: Page): FrameLocator => page.frameLocator('iframe.watch-video')
const ytTime = (page: Page) => youtube(page).locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)

async function createCinema(page: Page) {
  await page.getByRole('button', { name: 'Create voice channel' }).click()
  await page.getByRole('radio', { name: 'Voice' }).click()
  await page.getByLabel('Name').fill('cinema')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(lounge(page)).toBeVisible()
}

async function joinCinema(page: Page) {
  await lounge(page).getByRole('button').first().click()
  await expect(page.locator('.voice-status strong')).toHaveText('Voice connected', { timeout: 20_000 })
}

/** Starts a YouTube party and checks YouTube's player loads (no "Error 15x" screen) and plays when told to. */
async function startYouTubeParty(page: Page) {
  await page.locator('.call-controls').getByRole('button', { name: 'Watch together' }).click()
  const dialog = page.getByRole('dialog', { name: 'Watch together' })
  await dialog.getByLabel('Link').fill(VIDEO)
  await dialog.getByRole('button', { name: 'Start' }).click()
  await expect(page.locator('.watch-party')).toBeVisible()
  await expect(youtube(page).locator('video')).toBeAttached({ timeout: 30_000 })
  await page.waitForTimeout(1500) // YouTube shows its "Error 15x" screen a moment after loading
  expect(await youtube(page).locator('.ytp-error').allTextContents()).toEqual([])
  // The party drives the player: the host's Play reaches YouTube through the IFrame API.
  await expect(page.locator('.watch-controls').getByRole('button', { name: 'Play' })).toBeVisible()
  await expect.poll(() => page.locator('.watch-time').textContent(), { timeout: 30_000 }).not.toMatch(/\/ 0:00$/) // duration known: API ready
  await page.locator('.watch-controls').getByRole('button', { name: 'Play' }).click()
  await expect.poll(() => ytTime(page), { timeout: 30_000 }).toBeGreaterThan(2)
  await expect(youtube(page).locator('.ytp-error')).toHaveCount(0)
}

test('a YouTube watch party plays in step in the browser', async ({ browser }) => {
  test.setTimeout(150_000)
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  await createCinema(host)
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')
  await joinCinema(host)
  await joinCinema(friend)

  await startYouTubeParty(host)
  await expect.poll(() => ytTime(friend), { timeout: 30_000 }).toBeGreaterThan(2)
  await host.waitForTimeout(3000)
  const [a, b] = await Promise.all([ytTime(host), ytTime(friend)])
  expect(Math.abs(a - b)).toBeLessThan(2)
  await friend.screenshot({ path: join(SHOTS, 'watch-youtube.png') })
  await host.getByRole('button', { name: 'End watch party' }).click()
})

const electronBin = join(DESKTOP, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const desktopBuilt = existsSync(join(DESKTOP, 'dist', 'main.js')) && existsSync(resolve(HERE, '../dist/index.html')) && existsSync(electronBin)

test('a YouTube watch party plays in the desktop app (app:// origin)', async () => {
  test.skip(!desktopBuilt, 'build desktop/ (npm run build) and the client (npm run build) first')
  test.setTimeout(150_000)
  const userData = mkdtempSync(join(tmpdir(), 'iskra-desktop-'))
  const app = await electron.launch({
    executablePath: electronBin,
    args: [DESKTOP, `--user-data-dir=${userData}`, '--lang=en-US', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
    cwd: DESKTOP,
    env: { ...process.env, ISKRA_LOCAL_ONLY: '1' },
  })
  try {
    const page = await app.firstWindow()
    expect(page.url()).toMatch(/^app:\/\/iskra\//)
    await agreeToTerms(page)
    await page.getByRole('button', { name: /I’m new to Iskra/ }).click()
    await page.getByLabel('Your name').fill('Desk')
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('button', { name: 'I have an invite link' }).click()
    await page.getByLabel('Invite link').fill(server.ownerLink())
    await page.getByRole('button', { name: 'Join', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'general' })).toBeVisible()
    await createCinema(page)
    await joinCinema(page)

    await startYouTubeParty(page)
    await page.screenshot({ path: join(SHOTS, 'watch-youtube-desktop.png') })
    await page.getByRole('button', { name: 'End watch party' }).click()
  } finally {
    await app.close()
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
