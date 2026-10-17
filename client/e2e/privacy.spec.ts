// Privacy pass: nothing loads from another site until you say so, and the app says who it talks to.
import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { join } from 'node:path'
import { createInviteLink, hasLiveKit, joinVia, openSettings, send, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
test.beforeAll(async () => {
  server = await startServer('Privacy Test')
})
test.afterAll(async () => server?.stop())

/** Every request this context makes to anywhere but the test server and the app; third parties get a blank page. */
async function watchRequests(context: BrowserContext, own: TestServer = server): Promise<string[]> {
  const seen: string[] = []
  const ownHost = new URL(own.url).host
  context.on('request', (request) => {
    const url = new URL(request.url())
    if (/^(https?|wss?):$/.test(url.protocol) && url.host !== ownHost && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') seen.push(request.url())
  })
  await context.route(/^https:\/\/([a-z0-9-]+\.)*(youtube|youtube-nocookie|ytimg|googlevideo|twitch|twitter|reddit|redditmedia)\.(com|tv)\//, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>stand-in</title>' }))
  return seen
}

const youTube = (seen: string[]) => seen.filter((u) => /youtube(-nocookie)?\.com|ytimg\.com|googlevideo\.com/.test(new URL(u).hostname))

test('link embeds wait for a click, "Always load" is per site and per device, and the app lists who it talks to', async ({ browser }) => {
  const context = await browser.newContext()
  const seen = await watchRequests(context)
  const page = await context.newPage()
  await joinVia(page, server.ownerLink(), 'Host')

  // A YouTube link: a placeholder that says where it loads from, and nothing asked of YouTube.
  await send(page, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')
  const card = page.locator('.embed-card').last()
  await expect(card.getByTestId('embed-gate')).toBeVisible()
  await expect(card).toContainText('Loads from YouTube, who will see your IP address')
  await expect(card.getByLabel('Always load from YouTube on this device')).not.toBeChecked()
  await page.waitForTimeout(1500)
  expect(youTube(seen)).toEqual([])
  expect(seen).toEqual([]) // nothing at all outside the group's own server
  await page.screenshot({ path: join(SHOTS, 'privacy-embed-placeholder.png') })

  // Play: only now does it load, from the privacy-enhanced player.
  await card.getByRole('button', { name: /Play on YouTube/ }).click()
  await expect(card.locator('iframe')).toHaveAttribute('src', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1')
  await expect.poll(() => youTube(seen).length).toBeGreaterThan(0)
  expect(youTube(seen).every((u) => new URL(u).hostname === 'www.youtube-nocookie.com')).toBe(true)

  // "Always load from YouTube": ticked with a click, remembered after a reload, without autoplay.
  await send(page, 'https://youtu.be/aqz-KE-bpKQ')
  const second = page.locator('.embed-card').last()
  await second.getByLabel('Always load from YouTube on this device').check()
  await second.getByRole('button', { name: /Play on YouTube/ }).click()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'general' })).toBeVisible()
  await expect(page.locator('.embed-card iframe')).toHaveCount(2)
  await expect(page.locator('.embed-card iframe').first()).toHaveAttribute('src', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ')

  // Other sites still ask.
  await send(page, 'https://www.twitch.tv/somestreamer')
  await expect(page.locator('.embed-card').last().getByTestId('embed-gate')).toContainText('Loads from Twitch')
  expect(seen.filter((u) => /twitch\.tv$/.test(new URL(u).hostname))).toEqual([])

  // My settings → Privacy & data: who Iskra talks to, and the remembered site with a way to forget it.
  await openSettings(page, 'Privacy & data')
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  const who = dialog.getByTestId('who-iskra-talks-to')
  await expect(who.getByRole('heading', { name: 'Who Iskra talks to' })).toBeVisible()
  for (const party of ['Your servers', 'YouTube, Twitch, X and Reddit', 'KLIPY', 'GitHub', 'Mozilla translation', 'STUN', 'DigitalOcean', 'HyperDHT', 'bug inbox', 'link previews', 'AI provider you choose']) await expect(who).toContainText(party)
  const sites = dialog.getByTestId('always-load-sites')
  await expect(sites).toContainText('YouTube')
  await who.scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(SHOTS, 'privacy-who-iskra-talks-to.png') })
  await sites.getByRole('button', { name: 'Forget YouTube' }).click()
  await expect(sites).toContainText('No sites yet')
  await page.keyboard.press('Escape')
  await expect(page.locator('.embed-card iframe')).toHaveCount(0) // forgotten: they all ask again
  await expect(page.locator('.embed-card').first().getByTestId('embed-gate')).toBeVisible()

  // At phone width the list reads fine too.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Open channels' }).click()
  await openSettings(page, 'Privacy & data')
  await expect(page.getByTestId('who-iskra-talks-to')).toBeVisible()
  await page.getByTestId('who-iskra-talks-to').scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(SHOTS, 'privacy-who-mobile.png') })
  await context.close()
})

/** What each RTCPeerConnection was made with (recorded before the app's code runs). */
async function recordPeerConfigs(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const Original = window.RTCPeerConnection
    const configs: unknown[] = []
    ;(window as unknown as { __peerConfigs: unknown[] }).__peerConfigs = configs
    window.RTCPeerConnection = class extends Original {
      constructor(config?: RTCConfiguration) {
        configs.push(JSON.parse(JSON.stringify(config ?? {})))
        super(config)
      }
    } as typeof RTCPeerConnection
  })
}

test("voice asks no STUN server of anyone's, and a YouTube watch party says so before anything loads", async ({ browser }) => {
  test.skip(!hasLiveKit(), 'needs .tools/livekit-server (see scripts/get-livekit.ps1)')
  const voiceServer = await startServer('Voice Privacy', true)
  const context = await browser.newContext()
  const seen = await watchRequests(context, voiceServer)
  const page = await context.newPage()
  await recordPeerConfigs(page)
  await joinVia(page, voiceServer.ownerLink(), 'Talker')
  await page.getByRole('button', { name: 'Create voice channel' }).click()
  await page.getByRole('radio', { name: 'Voice' }).click()
  await page.getByLabel('Name').fill('lounge')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  const lounge = (p: Page) => p.locator('.voice-channel', { hasText: 'lounge' })
  await lounge(page).getByRole('button').first().click()
  await expect(page.locator('.voice-status strong')).toHaveText('Voice connected')

  // Voice: no STUN servers at all (LiveKit's default list is Google's), and no requests outside the server.
  const configs = await page.evaluate(() => (window as unknown as { __peerConfigs: { iceServers?: { urls: string | string[] }[] }[] }).__peerConfigs)
  expect(configs.length).toBeGreaterThan(0)
  const urls = configs.flatMap((c) => (c.iceServers ?? []).flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls])))
  expect(urls).toEqual([])
  expect(seen).toEqual([])

  // A friend in the call; the host starts a YouTube watch party (and is told where it plays from).
  const friendContext = await browser.newContext()
  const friendSeen = await watchRequests(friendContext, voiceServer)
  const friend = await friendContext.newPage()
  await joinVia(friend, await createInviteLink(page), 'Friend')
  await lounge(friend).getByRole('button').first().click()
  await expect(friend.locator('.voice-status strong')).toHaveText('Voice connected')
  await page.locator('.call-controls').getByRole('button', { name: 'Watch together' }).click()
  const dialog = page.getByRole('dialog', { name: 'Watch together' })
  await dialog.getByLabel('Link').fill('https://www.youtube.com/watch?v=aqz-KE-bpKQ')
  await expect(dialog.getByTestId('watch-start-note')).toContainText('Plays from YouTube: everyone who watches loads it from there')
  await dialog.getByRole('button', { name: 'Start' }).click()

  // The friend sees where it plays from, and nothing has asked YouTube anything yet.
  const gate = friend.getByTestId('watch-gate')
  await expect(gate).toContainText('This video plays from YouTube, which will see your IP address.')
  await friend.waitForTimeout(1500)
  expect(youTube(friendSeen)).toEqual([])
  await expect(friend.locator('iframe.watch-video')).toHaveCount(0)
  await friend.screenshot({ path: join(SHOTS, 'privacy-watch-gate.png') })
  await friend.getByRole('button', { name: 'Watch from YouTube' }).click()
  await expect(friend.locator('iframe.watch-video')).toHaveAttribute('src', /^https:\/\/www\.youtube-nocookie\.com\/embed\/aqz-KE-bpKQ/)
  await expect.poll(() => youTube(friendSeen).length).toBeGreaterThan(0)

  await friendContext.close()
  await context.close()
  await voiceServer.stop()
})
