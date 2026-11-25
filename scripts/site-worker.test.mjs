// The iskra.foo worker (site/_worker.js): what it counts, what it leaves out, and who may read /stats.
// D1 is replaced by node:sqlite behind the same prepare/bind/batch calls, so the worker's real SQL runs.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import worker from '../site/_worker.js'

const { isBot, device, browser, os, downloadName, sameSecret, niceMax, SCHEMA } = worker.internals

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'
const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0'
const ANDROID_TABLET = 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const PASSWORD = 'correct horse battery staple'

function fakeD1({ table = true } = {}) {
  const db = new DatabaseSync(':memory:')
  if (table) db.exec(SCHEMA)
  const statement = (sql, args = []) => ({
    bind: (...a) => statement(sql, a),
    run: async () => { db.prepare(sql).run(...args); return { success: true } },
    all: async () => ({ results: db.prepare(sql).all(...args) }),
  })
  return {
    prepare: (sql) => statement(sql),
    batch: async (statements) => {
      const out = []
      for (const s of statements) out.push(await s.all())
      return out
    },
    rows: () => db.prepare('SELECT kind, name, n FROM counts ORDER BY kind, name').all().map((r) => `${r.kind}=${r.name}:${r.n}`),
    sql: db,
  }
}

/** A worker environment: static pages from a map, a D1 fake, and ctx.waitUntil promises to wait for. */
function setup({ db = fakeD1(), password = PASSWORD, pages = { '/': 'home', '/terms': 'terms', '/discord-alternative': 'compare' } } = {}) {
  const pending = []
  const env = {
    DB: db,
    STATS_PASSWORD: password,
    ASSETS: {
      fetch: async (request) => {
        const { pathname } = new URL(request.url)
        if (request.headers.get('If-None-Match')) return new Response(null, { status: 304 })
        if (pathname.endsWith('.css')) return new Response('body{}', { headers: { 'Content-Type': 'text/css' } })
        if (pathname in pages) return new Response(pages[pathname], { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
        return new Response('not found', { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
      },
    },
  }
  const ctx = { waitUntil: (p) => pending.push(p) }
  const get = async (path, { ua = CHROME, headers = {}, cf = { country: 'SE' }, method = 'GET', body } = {}) => {
    const request = new Request(`https://iskra.foo${path}`, { method, body, headers: { 'User-Agent': ua, ...headers } })
    Object.defineProperty(request, 'cf', { value: cf })
    const response = await worker.fetch(request, env, ctx)
    await Promise.all(pending.splice(0))
    return response
  }
  return { env, db, get }
}

const basic = (password, user = 'owner') => ({ Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` })

test('a page view adds one to each daily total and nothing else', async () => {
  const { db, get } = setup()
  const res = await get('/terms?utm_source=Reddit', { headers: { Referer: 'https://www.reddit.com/r/selfhosted/comments/abc/secret-thread/' } })
  assert.equal(await res.text(), 'terms')
  assert.deepEqual(db.rows(), ['browser=Chrome:1', 'country=SE:1', 'device=Desktop:1', 'os=Windows:1', 'page=/terms:1', 'ref=reddit.com:1', 'src=reddit:1'])
  await get('/terms', { ua: IPHONE, cf: { country: 'DE' } })
  assert.deepEqual(db.rows(), ['browser=Chrome:1', 'browser=Safari:1', 'country=DE:1', 'country=SE:1', 'device=Desktop:1', 'device=Phone:1', 'os=Windows:1', 'os=iOS:1', 'page=/terms:2', 'ref=reddit.com:1', 'src=reddit:1'])
  // The table has a day, a kind, a name and a number: no column could hold an address or a visitor.
  assert.deepEqual(db.sql.prepare('PRAGMA table_info(counts)').all().map((c) => c.name), ['day', 'kind', 'name', 'n'])
  assert.match(db.sql.prepare('SELECT DISTINCT day FROM counts').all().map((r) => r.day).join(), /^\d{4}-\d\d-\d\d$/)
})

test('a returning visitor whose browser checks its copy (304) is counted; a stylesheet is not', async () => {
  const { db, get } = setup()
  await get('/terms', { headers: { 'If-None-Match': '"abc"' } })
  await get('/site.css')
  await get('/site.css', { headers: { 'If-None-Match': '"abc"' } })
  assert.deepEqual(db.rows().filter((r) => r.startsWith('page=')), ['page=/terms:1'])
})

test('crawlers, scripts, link previews, deploy checks, prefetches and missing pages are not counted', async () => {
  const { db, get } = setup()
  for (const ua of [
    'curl/8.5.0', '', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)', 'python-requests/2.32', 'facebookexternalhit/1.1',
  ]) await get('/', { ua })
  await get('/?deploy=123-1', { headers: { 'Cache-Control': 'no-cache' } })
  await get('/', { headers: { 'Sec-Purpose': 'prefetch;prerender' } })
  await get('/', { cf: { country: 'US', botManagement: { verifiedBot: true, score: 99 } } })
  await get('/', { cf: { country: 'US', botManagement: { score: 3 } } })
  await get('/', { cf: { country: 'US', verifiedBotCategory: 'Search Engine Crawler' } })
  await get('/wp-login.php')
  await get('/', { method: 'HEAD' })
  assert.deepEqual(db.rows(), [])
  assert.equal(isBot(new Request('https://iskra.foo/', { headers: { 'User-Agent': CHROME } })), false)
  const cubot = 'Mozilla/5.0 (Linux; Android 13; CUBOT P80) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
  assert.equal(isBot(new Request('https://iskra.foo/', { headers: { 'User-Agent': cubot } })), false)
})

test('only the host of the linking site is kept, and odd campaign values are dropped', async () => {
  const { db, get } = setup()
  await get('/', { headers: { Referer: 'https://iskra.foo/terms' } })
  await get('/', { headers: { Referer: 'not a url' } })
  await get('/?ref=%3Cscript%3Ealert(1)%3C/script%3E', { headers: { Referer: 'https://news.ycombinator.com/item?id=1' } })
  await get(`/?utm_source=${'x'.repeat(60)}`)
  await get('/?ref=hn')
  const rows = db.rows()
  assert.deepEqual(rows.filter((r) => r.startsWith('ref=')), ['ref=news.ycombinator.com:1'])
  assert.deepEqual(rows.filter((r) => r.startsWith('src=')), ['src=hn:1'])
  assert.ok(!rows.join().includes('item'))
})

test('device, browser and operating system families', () => {
  assert.deepEqual([device(CHROME), browser(CHROME), os(CHROME)], ['Desktop', 'Chrome', 'Windows'])
  assert.deepEqual([device(IPHONE), browser(IPHONE), os(IPHONE)], ['Phone', 'Safari', 'iOS'])
  assert.deepEqual([device(FIREFOX_LINUX), browser(FIREFOX_LINUX), os(FIREFOX_LINUX)], ['Desktop', 'Firefox', 'Linux'])
  assert.deepEqual([device(ANDROID_TABLET), browser(ANDROID_TABLET), os(ANDROID_TABLET)], ['Tablet', 'Chrome', 'Android'])
  assert.equal(browser(`${CHROME} Edg/131.0.0.0`), 'Edge')
  assert.equal(os('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15'), 'macOS')
})

test('the table is made on the first page view, and a failing database never breaks a page', async () => {
  const fresh = setup({ db: fakeD1({ table: false }) })
  assert.equal(await (await fresh.get('/')).text(), 'home')
  assert.ok(fresh.db.rows().includes('page=/:1'))

  const broken = { prepare: () => ({ bind: () => ({}) }), batch: async () => { throw new Error('D1_ERROR: database is down') } }
  assert.equal(await (await setup({ db: broken }).get('/')).text(), 'home')
  assert.equal(await (await setup({ db: null }).get('/')).text(), 'home')
})

test('download clicks are counted by kind of file, from this site only', async () => {
  const { db, get } = setup()
  const click = (body, extra = {}) => get('/count/download', { method: 'POST', body, headers: { Origin: 'https://iskra.foo', 'Sec-Fetch-Site': 'same-origin', ...extra } })
  assert.equal((await click('Iskra-Setup-2.0.0-alpha.51.exe')).status, 204)
  await click('Iskra-Setup-2.0.0-alpha.52.exe')
  await click('iskra-server-2.0.0-alpha.51-linux-arm64.tar.gz')
  await click('web-app')
  await click('made-up-file.exe')
  await click('Iskra-Setup-2.0.0-alpha.51.exe', { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' })
  await get('/count/download', { method: 'POST', body: 'Iskra-Setup-2.0.0-alpha.51.exe', ua: 'curl/8.5.0' })
  assert.equal((await get('/count/download')).status, 405)
  assert.deepEqual(db.rows(), ['download=Server: Linux ARM64:1', 'download=Web app:1', 'download=Windows installer:2'])
})

test('release files map to the dashboard names; update feeds and checksums are left out', () => {
  const v = '2.0.0-alpha.51'
  const assets = JSON.parse(readFileSync(new URL('./release-assets.json', import.meta.url), 'utf8'))
  const files = Object.entries(assets).filter(([k]) => k !== '$comment').flatMap(([, list]) => list).map((f) => f.replaceAll('{v}', v))
  const named = files.filter((f) => downloadName(f))
  assert.deepEqual(files.filter((f) => !downloadName(f)).sort(), [
    `Iskra-${v}-mac-arm64.dmg.blockmap`, `Iskra-${v}-mac-arm64.zip.blockmap`, `Iskra-${v}-mac-x64.dmg.blockmap`, `Iskra-${v}-mac-x64.zip.blockmap`,
    `Iskra-Setup-${v}.exe.blockmap`, `iskra-sbom-desktop-${v}.cdx.json`, `iskra-sbom-server-${v}.cdx.json`, `iskra-sbom-web-${v}.cdx.json`,
    'latest-linux.yml', 'latest-mac.yml', 'latest.yml',
  ].sort())
  assert.equal(new Set(named.map(downloadName)).size, named.length - 1) // the two Mac update zips share a name
  // Every download link on the home page has a name, so a click on it is counted.
  const home = readFileSync(new URL('../site/index.html', import.meta.url), 'utf8')
  const linked = [...home.matchAll(/releases\/download\/v[^/]+\/([^"]+)"/g)].map((m) => m[1])
  assert.ok(linked.length >= 14)
  for (const f of linked) assert.ok(downloadName(f), f)
})

test('/stats needs the password', async () => {
  const { get } = setup()
  const none = await get('/stats')
  assert.equal(none.status, 401)
  assert.match(none.headers.get('WWW-Authenticate'), /^Basic realm=/)
  assert.equal(none.headers.get('X-Robots-Tag'), 'noindex, nofollow')
  assert.equal(none.headers.get('Cache-Control'), 'no-store')
  for (const wrong of ['', 'wrong', PASSWORD.slice(0, -1), `${PASSWORD}x`, PASSWORD.toUpperCase()]) {
    assert.equal((await get('/stats', { headers: basic(wrong) })).status, 401, wrong)
  }
  assert.equal((await get('/stats', { headers: { Authorization: `Bearer ${PASSWORD}` } })).status, 401)
  assert.equal((await get('/stats', { headers: { Authorization: 'Basic !!!' } })).status, 401)
  assert.equal((await get('/stats', { method: 'POST', headers: basic(PASSWORD) })).status, 405)
  assert.equal(await sameSecret(PASSWORD, PASSWORD), true)
  assert.equal(await sameSecret(PASSWORD, 'x'), false)
})

test('/stats stays shut without a password of 16 characters or more, whatever is sent', async () => {
  for (const password of [null, '', 'short']) {
    const { get } = setup({ password })
    assert.equal((await get('/stats')).status, 503)
    assert.equal((await get('/stats', { headers: basic(password ?? '') })).status, 503)
    assert.equal((await get('/stats', { headers: basic('undefined') })).status, 503)
  }
})

test('/stats shows the totals, escapes what it shows, and is not itself counted', async (t) => {
  const { db, get } = setup()
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(String(url), 'https://api.github.com/repos/quikmn/iskra-voice/releases?per_page=30')
    return Response.json([{ tag_name: 'v2.0.0-alpha.51', published_at: '2026-11-25T11:24:53Z', assets: [
      { name: 'Iskra-Setup-2.0.0-alpha.51.exe', download_count: 1234 }, { name: 'latest.yml', download_count: 9999 },
      { name: 'Iskra-2.0.0-alpha.51-mac-arm64.zip', download_count: 5 }, { name: 'Iskra-2.0.0-alpha.51-mac-x64.zip', download_count: 6 },
    ] }])
  })
  await get('/discord-alternative', { headers: { Referer: 'https://duckduckgo.com/' } })
  await get('/discord-alternative', { ua: IPHONE })
  await get('/')
  const day = new Date().toISOString().slice(0, 10)
  db.sql.prepare('INSERT INTO counts VALUES (?, ?, ?, ?)').run(day, 'ref', '<img src=x onerror=alert(1)>', 7)
  const before = db.rows()

  const res = await get('/stats?days=90', { headers: basic(PASSWORD) })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('X-Robots-Tag'), 'noindex, nofollow')
  assert.equal(res.headers.get('Cache-Control'), 'no-store')
  assert.match(res.headers.get('Content-Security-Policy'), /default-src 'none'/)
  const html = await res.text()
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/)
  assert.match(html, /Page views, 90 days<\/div><div class="tile-value">3</)
  assert.match(html, /<span class="name">\/discord-alternative<\/span><\/td><td class="n">2</)
  assert.match(html, /<span class="name">duckduckgo\.com<\/span>/)
  assert.match(html, /<span class="name">Sweden<\/span><\/td><td class="n">3</)
  assert.match(html, new RegExp(`<title>${day}: 3 page views</title>`))
  assert.equal(html.match(/<g><title>/g).length, 90)
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;') && !html.includes('<img src=x'))
  assert.match(html, /v2\.0\.0-alpha\.51<\/td><td>2026-11-25<\/td><td class="n"><strong>1 245<\/strong><\/td><td class="n">1 234<\/td><td class="n">11</)
  assert.ok(!html.includes('9 999'))
  assert.deepEqual(db.rows(), before)

  const thirty = await (await get('/stats', { headers: basic(PASSWORD, '') })).text()
  assert.equal(thirty.match(/<g><title>/g).length, 30)
})

test('/stats still answers when GitHub does not', async (t) => {
  const { get } = setup()
  t.mock.method(globalThis, 'fetch', async () => new Response('rate limited', { status: 403 }))
  const html = await (await get('/stats', { headers: basic(PASSWORD) })).text()
  assert.match(html, /Could not ask GitHub: GitHub answered 403\./)
  assert.match(html, /Nothing yet\./)
})

test('the migration file and the worker make the same table', () => {
  const file = readFileSync(new URL('../site/migrations/0001_counts.sql', import.meta.url), 'utf8')
  assert.ok(file.includes(`${SCHEMA};`))
})

test('chart scale tops', () => {
  assert.deepEqual([0, 3, 7, 10, 11, 37, 450, 1001].map(niceMax), [4, 4, 10, 10, 20, 40, 500, 2000])
})
