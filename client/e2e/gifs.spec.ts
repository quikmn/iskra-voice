import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { expect, test, type BrowserContext } from '@playwright/test'
import { composerAction, createInviteLink, freePort, joinVia, openServerSettings, openSettings, SHOTS, startServer, type TestServer } from './helpers'

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

test('GIFs: off until an admin adds a key, through the server by default, or direct from KLIPY as a choice', async ({ browser }) => {
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

  // The host pastes a key in Server settings → GIFs. Through this server is the default.
  await openServerSettings(host, 'GIFs')
  await host.getByLabel('KLIPY API key').fill(KEY)
  await host.getByRole('button', { name: 'Turn on' }).click()
  await expect(host.locator('.gif-settings').getByRole('status')).toHaveText('GIFs are on.')
  await expect(host.getByRole('radio', { name: /Through this server/ })).toBeChecked()
  await expect(host.getByRole('radio', { name: /Straight from KLIPY/ })).not.toBeChecked()
  await host.screenshot({ path: join(SHOTS, 'gifs-settings.png') })
  await host.keyboard.press('Escape')

  // Trending, a category, search, a favourite: all through the server.
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

  // KLIPY only ever heard from the server: the key in the path, one customer id for everyone. No member's app called it.
  const api = seen.filter((s) => s.startsWith('/api/'))
  expect(api.some((s) => s.includes('/gifs/search?') && s.includes('q=cat'))).toBe(true)
  expect(new Set(api.filter((s) => s.includes('customer_id=')).map((s) => new URL(s, 'http://x').searchParams.get('customer_id'))).size).toBe(1)
  expect(seen.some((s) => s.startsWith('/media/static.klipy.com/ii/cat-2/'))).toBe(true)
  expect(friendAsked).toHaveLength(0)
  expect(hostAsked).toHaveLength(0)

  // Favourites stay on the device; on a phone the picker is a sheet with the same tabs.
  await friend.setViewportSize({ width: 390, height: 844 })
  await composerAction(friend, 'Emoji') // behind the "+" on phones
  await friend.getByRole('tab', { name: 'GIFs' }).click()
  await expect(friend.locator('.emoji-picker-layer.sheet')).toBeVisible()
  await expect(friend.getByRole('button', { name: 'Favourite GIFs (1)' })).toBeVisible()
  await friend.waitForTimeout(300)
  await friend.screenshot({ path: join(SHOTS, 'gifs-mobile.png') })
  await friend.keyboard.press('Escape')
  await friend.setViewportSize({ width: 1280, height: 800 })

  // Straight from KLIPY, as the owner's explicit choice: the friend's app asks KLIPY itself, and says so.
  await openServerSettings(host, 'GIFs')
  await host.getByRole('radio', { name: /Straight from KLIPY/ }).click()
  await expect(host.locator('.gif-settings').getByRole('status')).toHaveText("Members' apps now load GIFs from KLIPY directly.")
  await host.keyboard.press('Escape')
  const apiBefore = seen.filter((s) => s.startsWith('/api/')).length
  await friend.getByRole('button', { name: 'GIFs', exact: true }).click()
  const directPicker = friend.getByRole('dialog', { name: 'Emoji picker' })
  await expect(directPicker.locator('.gif-attribution')).toContainText('KLIPY sees your address and searches')
  await expect.poll(() => friendAsked.some((a) => a.startsWith(`/api/v1/${KEY}/gifs/trending?`) && a.includes('customer_id='))).toBe(true)
  await expect(directPicker.getByRole('button', { name: 'Send GIF: A dog-1 GIF' })).toBeVisible()
  await expect(directPicker.locator('iframe.klipy-frame').first()).toHaveAttribute('sandbox', '')
  await directPicker.getByRole('button', { name: 'Send GIF: A dog-1 GIF' }).click()
  // The host's app doesn't touch KLIPY until the host asks for it.
  const load = host.getByRole('button', { name: /Load GIF from KLIPY/ }).last()
  await expect(load).toBeVisible()
  expect(hostAsked.filter((a) => a.includes('klipy.com'))).toHaveLength(0)
  await host.screenshot({ path: join(SHOTS, 'gifs-click-to-load.png') })
  await load.click()
  await expect(host.locator('.chat-gif.direct iframe.klipy-frame').last()).toBeVisible()
  await expect.poll(() => hostAsked.some((a) => a.startsWith('https://static.klipy.com/ii/dog-1/'))).toBe(true)
  // With auto-load on, the next one shows right away.
  await openSettings(friend, 'Privacy & data')
  await friend.getByLabel(/Load GIFs from KLIPY without asking/).check()
  await friend.keyboard.press('Escape')
  await expect(friend.locator('.chat-gif.direct iframe.klipy-frame').last()).toBeVisible()
  expect(seen.filter((s) => s.startsWith('/api/'))).toHaveLength(apiBefore) // the server didn't call KLIPY for this
})
