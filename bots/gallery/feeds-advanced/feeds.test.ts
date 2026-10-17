// Feeds-advanced's rules: reading feeds, keyword filters, which addresses it fetches, what it remembers, Twitch.
// Run: npm test (in bots/, or in a copy of this folder). Nothing here goes to the internet.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { checkAddress, fetchFeed, isPrivateAddress, keywords, parseFeed, passes, plainText, Store, twitchLogin, type Feed } from './feeds.ts'
import { Twitch, wentLive } from './twitch.ts'

const dir = mkdtempSync(join(tmpdir(), 'feeds-test-'))
after(() => rmSync(dir, { recursive: true, force: true }))

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Blog</title>
  <item><title>Rust 2.0 &amp; more</title><link>https://blog.example/rust</link><guid>a1</guid>
    <description><![CDATA[<p>All about <b>Rust</b> and Go</p>]]></description></item>
  <item><title>Good news</title><link>https://blog.example/good</link><guid>a2</guid><description>Nothing &lt;b&gt;technical&lt;/b&gt;</description></item>
  <item><title>No link</title><link>javascript:alert(1)</link></item>
</channel></rss>`

const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Channel</title>
  <entry><id>yt:video:XYZ</id><title>New video</title><link rel="alternate" href="https://www.youtube.com/watch?v=XYZ"/>
    <media:group><media:description>A video about cats</media:description></media:group></entry>
</feed>`

describe('reading feeds', () => {
  it('reads RSS items: entities, CDATA and HTML become plain text; only http(s) links', () => {
    const items = parseFeed(RSS)
    assert.equal(items.length, 3)
    assert.deepEqual(items[0], { id: 'a1', title: 'Rust 2.0 & more', link: 'https://blog.example/rust', summary: 'All about Rust and Go' })
    assert.equal(items[1].summary, 'Nothing technical')
    assert.equal(items[2].link, null)
    assert.equal(items[2].id, 'No link')
  })

  it('reads Atom entries (YouTube channel feeds)', () => {
    assert.deepEqual(parseFeed(ATOM), [{ id: 'yt:video:XYZ', title: 'New video', link: 'https://www.youtube.com/watch?v=XYZ', summary: 'A video about cats' }])
  })

  it('decodes numeric entities and ignores nonsense', () => {
    assert.equal(plainText('caf&#233; &#x1F600; &bogus; &#0;'), 'café 😀 &bogus;')
    assert.deepEqual(parseFeed('not xml at all'), [])
  })
})

describe('filters', () => {
  const [rust, good] = parseFeed(RSS)
  it('splits keywords', () => assert.deepEqual(keywords(' Rust, go ,, ZIG '), ['rust', 'go', 'zig']))
  it('include: at least one word; exclude: none; whole words only', () => {
    assert.ok(passes(rust, [], []))
    assert.ok(passes(rust, ['go'], []))
    assert.ok(!passes(good, ['go'], [])) // "good" isn't "go"
    assert.ok(!passes(rust, [], ['rust']))
    assert.ok(passes(good, [], ['rust']))
    assert.ok(passes(rust, ['c++', 'rust'], []))
  })
})

describe('addresses', () => {
  const resolveTo = (ip: string) => async () => [ip]
  it('knows private and local addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.20.0.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:192.168.0.1'])
      assert.ok(isPrivateAddress(ip), ip)
    for (const ip of ['1.1.1.1', '93.184.216.34', '2606:4700::1111', '172.32.0.1']) assert.ok(!isPrivateAddress(ip), ip)
  })

  it('only fetches public http(s) addresses', async () => {
    assert.equal(await checkAddress('https://blog.example/feed', false, resolveTo('93.184.216.34')), null)
    assert.match((await checkAddress('ftp://blog.example/feed'))!, /http/)
    assert.match((await checkAddress('https://user:pw@blog.example/'))!, /password/)
    assert.match((await checkAddress('https://router.home/', false, resolveTo('192.168.1.1')))!, /private/)
    assert.match((await checkAddress('http://127.0.0.1:47070/'))!, /private/)
    assert.equal(await checkAddress('http://127.0.0.1:47070/', true), null)
    assert.match((await checkAddress('not a url'))!, /web address/)
  })

  it('checks every redirect and stops at 2 MB', async () => {
    const calls: string[] = []
    const fake = (async (url: string) => {
      calls.push(url)
      if (url === 'http://93.184.216.34/start') return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } })
      if (url === 'http://93.184.216.34/big') return new Response('x'.repeat(2 * 1024 * 1024 + 1))
      return new Response(RSS)
    }) as typeof fetch
    await assert.rejects(fetchFeed('http://93.184.216.34/start', false, fake), /private/)
    assert.deepEqual(calls, ['http://93.184.216.34/start']) // never asked the private address
    await assert.rejects(fetchFeed('http://93.184.216.34/big', false, fake), /2 MB/)
    assert.equal(parseFeed(await fetchFeed('http://93.184.216.34/ok', false, fake)).length, 3)
  })
})

describe('what it remembers', () => {
  it('posts only new items, oldest first, and keeps state across restarts', () => {
    const file = join(dir, 'feeds.json')
    const store = new Store(file)
    const feed: Feed = { id: 1, url: 'https://blog.example/feed', channelId: 3, include: [], exclude: [], seen: [] }
    const [a, b] = parseFeed(RSS)
    assert.deepEqual(store.newItems(feed, [b]).map((i) => i.id), ['a2'])
    assert.deepEqual(store.newItems(feed, [a, b]).map((i) => i.id), ['a1'])
    assert.deepEqual(store.newItems(feed, [a, b]), [])
    store.state.feeds.push(feed)
    store.save()
    assert.deepEqual(new Store(file).state.feeds[0].seen, ['a1', 'a2'])
  })

  it('people follow streamers themselves, up to 20 each', () => {
    const store = new Store(null)
    assert.equal(store.follow('shroud', 'A'), 'added')
    assert.equal(store.follow('shroud', 'A'), 'already')
    for (let i = 0; i < 19; i++) store.follow(`s${i}xx`, 'A')
    assert.equal(store.follow('onemore', 'A'), 'full')
    store.state.alerts.push({ login: 'gamer', channelId: 1 })
    assert.ok(store.watched().includes('gamer') && store.watched().includes('shroud'))
    assert.ok(store.unfollow('shroud', 'A'))
    assert.ok(!store.unfollow('shroud', 'A'))
    assert.equal(store.state.follows.shroud, undefined)
  })

  it('reads Twitch names and links', () => {
    assert.equal(twitchLogin('https://www.twitch.tv/Shroud/videos'), 'shroud')
    assert.equal(twitchLogin('a b'), null)
  })
})

describe('Twitch', () => {
  it('asks with the app token and announces a stream once', async () => {
    const asked: string[] = []
    const fake = (async (url: string, init?: RequestInit) => {
      asked.push(url)
      if (url.startsWith('https://id.twitch.tv/')) return Response.json({ access_token: 'T', expires_in: 3600 })
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer T')
      return Response.json({ data: [{ id: 's1', user_login: 'Shroud', user_name: 'shroud', title: 'Ranked', game_name: 'Valorant', type: 'live' }] })
    }) as typeof fetch
    const twitch = new Twitch('id', 'secret', fake)
    const streams = await twitch.live(['shroud', 'other'])
    assert.equal(streams[0].login, 'shroud')
    assert.match(asked[1], /user_login=shroud&user_login=other$/)
    await twitch.live(['shroud'])
    assert.equal(asked.filter((u) => u.includes('oauth2')).length, 1) // the token is reused

    const first = wentLive({}, streams)
    assert.equal(first.started.length, 1)
    assert.equal(wentLive(first.live, streams).started.length, 0) // still the same stream
    assert.equal(wentLive(first.live, [{ ...streams[0], id: 's2' }]).started.length, 1) // live again later
  })
})
