// Feeds: an admin turns the Feeds bot on, adds an RSS feed (served by this test on 127.0.0.1; a LocalOnly server
// only fetches loopback), and only what's new afterwards is posted, with its link. The settings fit a phone.
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { joinVia, SHOTS, startServer, type TestServer } from './helpers'

let server: TestServer
let feed: Server
let feedUrl = ''
const items: { id: string; title: string }[] = [{ id: 'old-1', title: 'An old post' }]
const requests: string[] = []

function rss(): string {
  const entries = items.map((i) => `<item><title>${i.title}</title><link>https://blog.example/${i.id}</link><guid>${i.id}</guid></item>`).join('')
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Pizza Blog</title><link>https://blog.example/</link>${entries}</channel></rss>`
}

test.beforeAll(async () => {
  feed = createServer((req, res) => {
    requests.push(req.url ?? '')
    res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8' })
    res.end(rss())
  })
  await new Promise<void>((done) => feed.listen(0, '127.0.0.1', done))
  const address = feed.address()
  feedUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/feed.xml`
  server = await startServer('Pizza Club')
})
test.afterAll(async () => {
  await server?.stop()
  await new Promise<void>((done) => (feed ? feed.close(() => done()) : done()))
})

async function openBots(page: Page) {
  await page.getByRole('button', { name: /server options/ }).click()
  await page.getByRole('menuitem', { name: 'More settings' }).click()
  await page.getByRole('menuitem', { name: 'Bots & webhooks' }).click()
  await page.getByRole('tab', { name: 'Bots' }).click()
}

test('Feeds: an admin adds an RSS feed and new posts show up in the channel', async ({ browser }) => {
  test.setTimeout(120_000)
  const host = await (await browser.newContext()).newPage()
  await joinVia(host, server.ownerLink(), 'Host')

  // Off until turned on; then its settings say what the server will fetch.
  await openBots(host)
  const toggle = host.getByRole('switch', { name: 'Turn Feeds on' })
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  expect(requests).toEqual([]) // nothing is fetched just by turning it on
  await host.getByRole('button', { name: 'Feeds settings' }).click()
  const settings = host.getByTestId('feeds-settings')
  await expect(settings).toContainText("they see the server's address, never your members'")
  await expect(settings).toContainText('No feeds yet')

  // Add the feed: checked once, what's there is marked as seen.
  const add = settings.getByTestId('feed-add')
  await expect(add.getByRole('radio', { name: 'RSS or Atom' })).toHaveAttribute('aria-checked', 'true')
  await add.getByTestId('feed-source').fill('not an address')
  await add.getByTestId('feed-add-submit').click()
  await expect(add).toContainText("That doesn't look like a web address.")
  await add.getByTestId('feed-source').fill(feedUrl)
  await add.getByLabel('Post in').selectOption({ label: '#general' })
  await add.getByTestId('feed-add-submit').click()
  await expect(add.getByTestId('feed-add-status')).toHaveText('Added. Only new posts will show up.')
  const row = settings.getByTestId('feed-item')
  await expect(row).toContainText('Pizza Blog')
  await expect(row).toContainText('in #general · every 15 min')
  expect(requests.length).toBe(1)
  await host.screenshot({ path: join(SHOTS, 'feeds-settings.png') })

  // A new post on the blog; "Check now" picks it up and the bot posts it (the old one never).
  items.unshift({ id: 'new-1', title: 'Margherita *done right*' })
  await row.getByTestId('feed-check').click()
  await expect(row.getByRole('status').last()).toHaveText('Checked.')
  await host.keyboard.press('Escape')
  const post = host.getByTestId('feed-post')
  await expect(post).toHaveCount(1)
  await expect(post).toContainText('📰 Pizza Blog:')
  await expect(post.locator('.feed-post-title')).toHaveText('Margherita *done right*') // the feed's text, never markdown
  await expect(post.getByRole('link', { name: 'https://blog.example/new-1' })).toHaveAttribute('href', 'https://blog.example/new-1')
  await expect(host.locator('.message', { hasText: 'An old post' })).toHaveCount(0)
  await host.screenshot({ path: join(SHOTS, 'feeds-post.png') })

  // At phone width the settings fit the screen.
  await openBots(host)
  await host.getByRole('button', { name: 'Feeds settings' }).click()
  await host.setViewportSize({ width: 390, height: 844 })
  const narrow = host.getByTestId('feeds-settings')
  await expect(narrow).toBeVisible()
  const box = await narrow.boundingBox()
  expect(box!.x + box!.width).toBeLessThanOrEqual(390)
  expect(await host.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await host.screenshot({ path: join(SHOTS, 'feeds-mobile.png') })
})
