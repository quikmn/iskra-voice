import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { expect, test, type BrowserContext } from '@playwright/test'
import { createInviteLink, freePort, joinVia, openServerSettings, openSettings, SHOTS, startServer, type TestServer } from './helpers'

// A 3×2 PNG, served as every GIF.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAEUlEQVR4nGNgYGD4z4AEMDgAHNoB/zrD+5kAAAAASUVORK5CYII=', 'base64')
const KEY = 'e2e-klipy-key-123'

/** Stands in for KLIPY (the server reaches it only because this test lets it use loopback). */
let fake: Server
const seen: string[] = []
let server: TestServer

const item = (slug: string) => ({
  slug, title: `A ${slug} GIF`, type: 'gif',
  file: {
    md: { gif: { url: `https://static.klipy.com/ii/${slug}/md.gif`, width: 300, height: 200 } },
    sm: { gif: { url: `https://static.klipy.com/ii/${slug}/sm.gif`, width: 150, height: 100 } },
  },
})

test.beforeAll(async () => {
  const port = await freePort()
  fake = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake')
    seen.push(url.pathname + url.search)
    if (url.pathname.startsWith('/media/static.klipy.com/')) {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG.length })
      res.end(PNG)
      return
    }
    if (!url.pathname.startsWith(`/api/v1/${KEY}/gifs/`)) {
      res.writeHead(401).end()
      return
    }
    const kind = url.pathname.split('/').pop()
    const body = kind === 'categories'
      ? { result: true, data: { categories: [{ category: 'Cats', query: 'cat', preview_url: 'https://static.klipy.com/ii/cat-1/sm.gif' }] } }
      : { result: true, data: { data: (kind === 'search' ? ['cat-1', 'cat-2'] : ['party', 'wave', 'cat-1']).map(item), has_next: false } }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }).listen(port, '127.0.0.1')
  server = await startServer('Gif Test', false, { Previews__AllowLoopbackForTests: 'true', Gifs__TestUpstream: `http://127.0.0.1:${port}` })
})
test.afterAll(async () => {
  await server?.stop()
  fake?.close()
})

/** Direct mode: this browser context talks to (a stand-in for) KLIPY itself. Returns what it asked for. */
async function fakeKlipyInBrowser(context: BrowserContext): Promise<string[]> {
  const asked: string[] = []
  await context.route('https://api.klipy.com/**', (route) => {
    const url = new URL(route.request().url())
    asked.push(url.pathname + url.search)
    const kind = url.pathname.split('/').pop()
    const body = kind === 'categories'
      ? { result: true, data: { categories: [{ category: 'Dogs', query: 'dog' }] } }
      : { result: true, data: { data: ['dog-1', 'dog-2'].map(item), has_next: false } }
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) })
  })
  await context.route('https://static*.klipy.com/**', (route) => {
    asked.push(route.request().url())
    return route.fulfill({ status: 200, contentType: 'image/png', body: PNG })
  })
  return asked
}

test('GIFs: off until an admin adds a key, direct from KLIPY by default, or through the server', async ({ browser }) => {
  const hostContext = await browser.newContext()
  const hostAsked = await fakeKlipyInBrowser(hostContext)
  const host = await hostContext.newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const friendContext = await browser.newContext()
  const friendAsked = await fakeKlipyInBrowser(friendContext)
  const friend = await friendContext.newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')

  // Off: the GIF tab says how to turn it on.
  await friend.getByRole('button', { name: 'GIFs', exact: true }).click()
  await expect(friend.getByText("GIFs aren't on for this server yet")).toBeVisible()
  await expect(friend.getByRole('link', { name: 'How to set up GIFs' })).toHaveAttribute('href', /hosting\.md#gifs/)
  await friend.keyboard.press('Escape')

  // The host pastes a key in Settings → Overview.
  await openServerSettings(host, 'Overview')
  await host.getByLabel('KLIPY API key').fill(KEY)
  await host.getByRole('button', { name: 'Turn on' }).click()
  await expect(host.locator('.gif-settings').getByRole('status')).toHaveText('GIFs are on.')
  await expect(host.getByRole('radio', { name: /Direct/ })).toBeChecked()
  await host.screenshot({ path: join(SHOTS, 'gifs-settings.png') })
  await host.keyboard.press('Escape')

  // Direct (the default): the friend's app asks KLIPY itself, and says so.
  await friend.getByRole('button', { name: 'GIFs', exact: true }).click()
  const directPicker = friend.getByRole('dialog', { name: 'Emoji picker' })
  await expect(directPicker.getByRole('button', { name: /^Send GIF:/ })).toHaveCount(2)
  await expect(directPicker.locator('.gif-attribution')).toContainText('KLIPY sees your address and searches')
  expect(friendAsked.some((a) => a.startsWith(`/api/v1/${KEY}/gifs/trending?`) && a.includes('customer_id='))).toBe(true)
  await expect(directPicker.locator('iframe.klipy-frame').first()).toHaveAttribute('sandbox', '')
  await directPicker.getByRole('button', { name: 'Send GIF: A dog-1 GIF' }).click()
  // The host's app doesn't touch KLIPY until the host asks for it.
  const load = host.getByRole('button', { name: /Load GIF from KLIPY/ })
  await expect(load).toBeVisible()
  expect(hostAsked.filter((a) => a.includes('klipy.com'))).toHaveLength(0)
  await host.screenshot({ path: join(SHOTS, 'gifs-click-to-load.png') })
  await load.click()
  await expect(host.locator('.chat-gif.direct iframe.klipy-frame')).toBeVisible()
  await expect.poll(() => hostAsked.some((a) => a.startsWith('https://static.klipy.com/ii/dog-1/'))).toBe(true)
  // With auto-load on, the next one shows right away.
  await openSettings(friend, 'Appearance')
  await friend.getByLabel(/Load GIFs from KLIPY without asking/).check()
  await friend.keyboard.press('Escape')
  await expect(friend.locator('.chat-gif.direct iframe.klipy-frame')).toBeVisible()
  expect(seen.filter((s) => s.startsWith('/api/'))).toHaveLength(0) // the server never called KLIPY

  // Through this server (only with KLIPY's approval): the server searches and proxies the files.
  await openServerSettings(host, 'Overview')
  await host.getByRole('radio', { name: /Through this server/ }).click()
  await expect(host.locator('.gif-settings').getByRole('status')).toHaveText('GIFs now go through this server.')
  await host.keyboard.press('Escape')
  // The direct GIF from before shows through the server too (once messages are fetched again).
  await host.reload()
  await expect(host.locator('.chat-gif img').first()).toHaveAttribute('src', new RegExp(`^${server.url}/gifs/media\\?u=`))

  // Trending, a category, search, a favourite.
  await friend.getByRole('button', { name: 'GIFs', exact: true }).click()
  const picker = friend.getByRole('dialog', { name: 'Emoji picker' })
  await expect(picker.getByRole('tab', { name: 'GIFs' })).toHaveAttribute('aria-selected', 'true')
  await expect(picker.getByRole('button', { name: /^Send GIF:/ })).toHaveCount(3)
  const preview = picker.locator('.gif-send img').first()
  await expect(preview).toHaveAttribute('src', new RegExp(`^${server.url}/gifs/media\\?u=`))
  await expect.poll(() => preview.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(3)
  await picker.getByRole('listitem').filter({ hasText: 'Cats' }).click()
  await expect(picker.getByRole('heading', { name: 'Results for “cat”' })).toBeVisible()
  await expect(picker.getByRole('button', { name: /^Send GIF:/ })).toHaveCount(2)
  await picker.getByRole('button', { name: 'Add A cat-2 GIF to favourites' }).click()
  await picker.getByRole('button', { name: /^Favourite GIFs/ }).click()
  await expect(picker.getByRole('button', { name: /^Send GIF:/ })).toHaveCount(1)
  await friend.screenshot({ path: join(SHOTS, 'gifs-picker.png') })
  await picker.getByRole('button', { name: 'Send GIF: A cat-2 GIF' }).click()

  // Everyone sees it, through the server.
  const sent = host.locator('.chat-gif img').last()
  await expect(sent).toHaveAttribute('src', new RegExp(`^${server.url}/gifs/media\\?u=`))
  await expect.poll(() => sent.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(3)

  // KLIPY only ever heard from the server: the key in the path, one customer id for everyone.
  const api = seen.filter((s) => s.startsWith('/api/'))
  expect(api.some((s) => s.includes('/gifs/search?') && s.includes('q=cat'))).toBe(true)
  expect(new Set(api.filter((s) => s.includes('customer_id=')).map((s) => new URL(s, 'http://x').searchParams.get('customer_id'))).size).toBe(1)
  expect(seen.some((s) => s.startsWith('/media/static.klipy.com/ii/cat-2/'))).toBe(true)

  // Favourites stay on the device; on a phone the picker is a sheet with the same tabs.
  await friend.setViewportSize({ width: 390, height: 844 })
  await friend.getByRole('button', { name: 'Emoji', exact: true }).click()
  await friend.getByRole('tab', { name: 'GIFs' }).click()
  await expect(friend.locator('.emoji-picker-layer.sheet')).toBeVisible()
  await expect(friend.getByRole('button', { name: 'Favourite GIFs (1)' })).toBeVisible()
  await friend.waitForTimeout(300)
  await friend.screenshot({ path: join(SHOTS, 'gifs-mobile.png') })
})
