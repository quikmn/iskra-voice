import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { createInviteLink, hasLiveKit, joinVia, SHOTS, startServer, type TestServer } from './helpers'

test.skip(!hasLiveKit(), 'needs .tools/livekit-server (see scripts/get-livekit.ps1)')

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('E2EE Voice', true)
})
test.afterAll(async () => server?.stop())

async function setLevel(page: Page, name: string, level: string) {
  await page.locator('.member-list').getByRole('button', { name }).click()
  await page.getByRole('dialog', { name: `Profile of ${name}` }).getByRole('button', { name: 'More' }).click()
  const dialog = page.getByRole('dialog', { name })
  await dialog.getByLabel('Base role').selectOption(level)
  await expect(dialog.getByLabel('Base role')).toHaveValue(level)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
}

const vault = (page: Page) => page.locator('.voice-channel', { hasText: 'vault' })
const badge = (page: Page) => page.locator('.voice-bar').getByTestId('e2ee-voice')
const playing = (page: Page) => page.evaluate(() => [...document.querySelectorAll('audio')].some((a) => !a.paused && a.currentTime > 0))

test('an encrypted voice channel: media is end-to-end encrypted, and removing someone switches the key without a drop', async ({ browser }) => {
  test.setTimeout(180_000)
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const link = await createInviteLink(host)
  const [bob, carol] = await Promise.all(['Bob', 'Carol'].map(async (name) => {
    const page = await (await browser.newContext()).newPage()
    await joinVia(page, link, name)
    return page
  }))
  await host.locator('.member-list').getByRole('button', { name: 'Carol' }).waitFor()
  await setLevel(host, 'Bob', 'trusted')
  await setLevel(host, 'Carol', 'trusted')

  // The owner makes an encrypted voice channel only trusted people (and up) can see.
  await host.getByRole('button', { name: 'Create voice channel' }).click()
  const create = host.getByRole('dialog', { name: 'Create channel' })
  await create.getByRole('radio', { name: 'Voice' }).click()
  await create.getByLabel('Name').fill('vault')
  await create.getByLabel('Who can see it').selectOption('trusted')
  await create.getByTestId('e2ee-toggle').check()
  await expect(create).toContainText('3 people will be able to read it.')
  await expect(create).toContainText('Voice, video and screen shares are encrypted too.')
  await host.screenshot({ path: join(SHOTS, 'e2ee-voice-create.png') })
  await create.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(vault(host).getByTestId('e2ee-lock')).toBeVisible()

  // Everyone joins; each app encrypts with the channel's first key and hears the others, decrypted.
  for (const page of [host, bob, carol]) {
    await vault(page).getByRole('button').first().click()
    await expect(page.locator('.voice-status strong')).toHaveText('Voice connected', { timeout: 20_000 })
  }
  for (const page of [host, bob, carol]) {
    await expect(badge(page)).toHaveAttribute('data-active', 'true', { timeout: 20_000 })
    await expect(badge(page)).toHaveText('Encrypted voice')
    await expect(badge(page)).toHaveAttribute('data-version', '1')
    // LiveKit says every track of the two others is encrypted (their media is never played otherwise).
    await expect(page.locator('.stage').getByTestId('e2ee-peer-encrypted')).toHaveCount(2, { timeout: 20_000 })
    await expect(page.getByTestId('e2ee-unencrypted')).toHaveCount(0)
    await expect.poll(() => playing(page), { timeout: 15_000 }).toBe(true)
  }
  // The call screen says so too, and the details explain it.
  await expect(host.locator('.stage .chat-header').getByTestId('e2ee-voice')).toHaveText('Encrypted voice')
  await host.locator('.stage .chat-header').getByTestId('e2ee-voice').click()
  const details = host.getByRole('dialog', { name: 'Encryption' })
  await expect(details.getByTestId('e2ee-voice-explain')).toContainText('the server only passes on what it can')
  await expect(details.getByTestId('e2ee-members').locator('li')).toHaveCount(3)
  await host.keyboard.press('Escape')

  // Watch parties would show the server what's played: the button is off and says why.
  await expect(host.getByTestId('watch-e2ee-off')).toHaveClass(/watch-off/)
  await host.getByTestId('watch-e2ee-off').click()
  await expect(host.getByTestId('watch-e2ee-note')).toContainText('the server would see')
  await host.keyboard.press('Escape')

  // Video is encrypted too: Bob's camera reaches Host, decoded.
  await bob.locator('.call-controls').getByRole('button', { name: 'Turn camera on' }).click()
  const video = host.locator('.video-tile.camera video')
  await expect(video).toHaveCount(1, { timeout: 15_000 })
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 15_000 }).toBeGreaterThan(0)
  await host.waitForTimeout(500)
  await host.screenshot({ path: join(SHOTS, 'e2ee-voice.png') })
  await bob.setViewportSize({ width: 390, height: 844 })
  await bob.waitForTimeout(500)
  await bob.screenshot({ path: join(SHOTS, 'e2ee-voice-phone.png') })

  // Carol loses access: she's out of the room at once, the others' apps hand out a new key without her, and the call
  // carries on under it (same connection, no rejoin).
  await setLevel(host, 'Carol', 'member')
  await expect(carol.locator('.voice-bar')).toHaveCount(0, { timeout: 20_000 })
  for (const page of [host, bob]) {
    await expect(badge(page)).toHaveAttribute('data-version', '2', { timeout: 30_000 })
    await expect(badge(page)).toHaveAttribute('data-active', 'true')
    await expect(page.locator('.voice-status strong')).toHaveText('Voice connected')
    await expect(page.locator('.stage').getByTestId('e2ee-peer-encrypted')).toHaveCount(1, { timeout: 20_000 })
  }
  // Media still flows under the new key: Bob's camera keeps decoding at Host's end, and audio keeps playing.
  const frames = () => video.evaluate((v: HTMLVideoElement) => (v as HTMLVideoElement & { getVideoPlaybackQuality(): VideoPlaybackQuality }).getVideoPlaybackQuality().totalVideoFrames)
  const before = await frames()
  await expect.poll(frames, { timeout: 15_000 }).toBeGreaterThan(before + 10)
  await expect.poll(() => playing(bob), { timeout: 15_000 }).toBe(true)
  await expect(host.locator('.voice-bar .error-text')).toHaveCount(0)
  await host.screenshot({ path: join(SHOTS, 'e2ee-voice-rekeyed.png') })
})
