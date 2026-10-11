import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { createInviteLink, freePort, joinVia, openSettings, SHOTS, startServer, type TestServer } from './helpers'

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

test('GIFs through the server: off until an admin adds a key, then search, favourites and sending', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')
  const friend = await (await browser.newContext()).newPage()
  await joinVia(friend, await createInviteLink(host), 'Friend')

  // Off: the GIF tab says how to turn it on.
  await friend.getByRole('button', { name: 'GIFs', exact: true }).click()
  await expect(friend.getByText("GIFs aren't on for this server yet")).toBeVisible()
  await expect(friend.getByRole('link', { name: 'How to set up GIFs' })).toHaveAttribute('href', /hosting\.md#gifs/)
  await friend.keyboard.press('Escape')

  // The host pastes a key in Settings → Overview.
  await openSettings(host, 'Overview')
  await host.getByLabel('KLIPY API key').fill(KEY)
  await host.getByRole('button', { name: 'Turn on' }).click()
  await expect(host.locator('.gif-settings').getByRole('status')).toHaveText('GIFs are on.')
  await host.screenshot({ path: join(SHOTS, 'gifs-settings.png') })
  await host.keyboard.press('Escape')

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
