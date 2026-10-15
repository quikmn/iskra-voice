// Picture-in-picture in the browser: the voice panel and a video in Chromium's Document Picture-in-Picture window,
// rendered by the page itself (same call), and closed when you leave. No channel pop-out on the web.
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { hasLiveKit, joinVia, SHOTS, startServer, type TestServer } from './helpers'

test.skip(!hasLiveKit(), 'needs .tools/livekit-server (see scripts/get-livekit.ps1)')

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('PiP Test', true)
})
test.afterAll(async () => server?.stop())

type Pip = { documentPictureInPicture: { window: Window | null } }
/** What's in the picture-in-picture window right now (null: none open). */
const pip = (page: Page, selector: string) => page.evaluate((selector) => {
  const win = (window as unknown as Pip).documentPictureInPicture.window
  if (!win) return null
  return [...win.document.querySelectorAll(selector)].map((e) => e.textContent ?? '')
}, selector)
const clickInPip = (page: Page, label: string) => page.evaluate((label) => {
  const win = (window as unknown as Pip).documentPictureInPicture.window!
  ;(win.document.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement).click()
}, label)

test('the voice panel and a video in picture-in-picture', async ({ browser }) => {
  test.setTimeout(90_000)
  const page = await (await browser.newContext()).newPage()
  await joinVia(page, server.ownerLink(), 'Webby')
  expect(await page.evaluate(() => 'documentPictureInPicture' in window)).toBe(true)
  // A text channel can't pop out in a browser.
  await expect(page.getByRole('button', { name: 'Pop out channel' })).toHaveCount(0)

  await page.getByRole('button', { name: 'Create voice channel' }).first().click()
  await page.getByRole('radio', { name: 'Voice' }).click()
  await page.getByLabel('Name').fill('lounge')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.locator('.voice-channel', { hasText: 'lounge' }).getByRole('button').first().click()
  await expect(page.locator('.voice-status strong')).toHaveText('Voice connected', { timeout: 20_000 })

  // The voice panel: who's here, with buttons that act on this call.
  await page.getByTestId('voice-popout').click()
  await expect.poll(() => pip(page, '.popout-person-name')).toEqual(['Webby'])
  expect(await pip(page, '.popout-title')).toEqual(['lounge'])
  // Picture-in-picture is always on top and has no click-through: no buttons for them.
  expect(await pip(page, 'button[aria-label="Always on top"], button[aria-label="Click-through"]')).toEqual([])
  await clickInPip(page, 'Mute')
  await expect(page.locator('.voice-bar').getByRole('button', { name: 'Unmute' })).toBeVisible()
  await clickInPip(page, 'Unmute')
  await expect(page.locator('.voice-bar').getByRole('button', { name: 'Mute', exact: true })).toBeVisible()

  // A video takes the picture-in-picture window over (there's only one), playing the same camera track.
  await page.getByRole('button', { name: 'Turn camera on' }).click()
  const tile = page.locator('.video-tile').first()
  await expect(tile).toBeVisible({ timeout: 15_000 })
  await tile.hover()
  await tile.getByRole('button', { name: 'Pop out video' }).click()
  await expect.poll(() => page.evaluate(() => {
    const video = (window as unknown as Pip).documentPictureInPicture.window?.document.querySelector('video')
    return video?.videoWidth ?? 0
  }), { timeout: 15_000 }).toBeGreaterThan(0)
  expect(await pip(page, '[data-testid="popout-voice"]')).toEqual([])
  await expect(page.getByTestId('voice-popout')).toHaveAttribute('aria-pressed', 'false')
  await expect(tile.getByRole('button', { name: 'Pop back in' })).toHaveAttribute('aria-pressed', 'true')
  await page.screenshot({ path: join(SHOTS, 'popout-pip-web.png') })

  // Leaving the call closes it.
  await page.locator('.voice-bar').getByRole('button', { name: 'Leave voice' }).click()
  await expect.poll(() => page.evaluate(() => !!(window as unknown as Pip).documentPictureInPicture.window)).toBe(false)
})
