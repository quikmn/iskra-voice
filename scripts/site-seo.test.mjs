// Every page of iskra.foo (site/*.html, site/docs/*.html) carries what search engines and link previews read,
// and the files for crawlers (robots.txt, sitemap.xml, llms.txt) agree with the pages that exist.
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { root, sitePaths, sitemap } from './build-site-docs.mjs'

const site = join(root, 'site')
const read = (file) => readFileSync(join(site, file), 'utf8')
const files = [
  ...readdirSync(site).filter((f) => f.endsWith('.html') && f !== '404.html'),
  ...readdirSync(join(site, 'docs')).filter((f) => f.endsWith('.html')).map((f) => `docs/${f}`),
]
const address = (file) => `https://iskra.foo/${file.replace(/\.html$/, '').replace(/^index$/, '').replace(/^docs\/index$/, 'docs/')}`
const meta = (html, pattern) => (pattern.exec(html) || [])[1]

test('every page has its own title and description, a canonical address and link preview tags', () => {
  const titles = new Map()
  const descriptions = new Map()
  for (const file of files) {
    const html = read(file)
    const title = meta(html, /<title>([^<]+)<\/title>/)
    const description = meta(html, /<meta name="description" content="([^"]+)">/)
    assert.ok(title && title.length <= 70, `${file}: title missing or over 70 characters`)
    assert.ok(description && description.length >= 50 && description.length <= 200, `${file}: description missing, short or over 200 characters`)
    assert.ok(!titles.has(title), `${file} and ${titles.get(title)} share a title`)
    assert.ok(!descriptions.has(description), `${file} and ${descriptions.get(description)} share a description`)
    titles.set(title, file)
    descriptions.set(description, file)
    assert.equal(meta(html, /<link rel="canonical" href="([^"]+)">/), address(file), `${file}: canonical`)
    assert.equal(meta(html, /<meta property="og:url" content="([^"]+)">/), address(file), `${file}: og:url`)
    assert.equal(meta(html, /<meta property="og:title" content="([^"]+)">/), title, `${file}: og:title`)
    assert.equal(meta(html, /<meta property="og:description" content="([^"]+)">/), description, `${file}: og:description`)
    assert.equal(meta(html, /<meta property="og:image" content="([^"]+)">/), 'https://iskra.foo/og.png', `${file}: og:image`)
    assert.ok(meta(html, /<meta property="og:image:alt" content="([^"]+)">/), `${file}: og:image:alt`)
    assert.equal(meta(html, /<meta name="twitter:card" content="([^"]+)">/), 'summary_large_image', `${file}: twitter:card`)
    assert.equal((html.match(/<h1[\s>]/g) || []).length >= 1, true, `${file}: no h1`)
    assert.match(html, /<html lang="en">/, `${file}: lang`)
    for (const img of html.match(/<img [^>]*>/g) || []) assert.match(img, / alt="[^"]+"/, `${file}: an image without alt text`)
  }
})

test('the pages load nothing from other sites', () => {
  for (const file of [...files, '404.html']) {
    const html = read(file)
    const loaded = [...html.matchAll(/<(?:script|link|img|iframe|source|video|audio)\b[^>]*?\b(?:src|href)="([^"]+)"/g)]
      .filter((m) => !/rel="canonical"/.test(m[0])).map((m) => m[1])
    for (const url of loaded) assert.ok(!/^(https?:)?\/\//.test(url), `${file} loads ${url}`)
  }
})

test('the link preview picture is a 1200×630 PNG', () => {
  const png = readFileSync(join(site, 'og.png'))
  assert.equal(png.subarray(1, 4).toString(), 'PNG')
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1200, 630])
})

test('structured data parses: the app on the home page, questions on the comparison page', () => {
  const blocks = (file) => [...read(file).matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].flatMap((m) => JSON.parse(m[1])['@graph'])
  const home = blocks('index.html')
  const app = home.find((n) => n['@type'] === 'SoftwareApplication')
  assert.equal(app.offers.price, '0')
  assert.ok(app.operatingSystem.includes('Windows'))
  assert.equal(app.softwareVersion, JSON.parse(readFileSync(join(root, 'desktop/package.json'), 'utf8')).version)
  assert.ok(home.some((n) => n['@type'] === 'Organization'))

  // Each question in the structured data is on the page, word for word (search engines require that).
  const page = read('discord-alternative.html')
  const text = (html) => html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/→ /g, '').replace(/\s+/g, ' ').trim()
  const shown = new Map([...page.matchAll(/<summary>([^<]+)<\/summary>\s*<p>([\s\S]*?)<\/p>/g)].map((m) => [m[1], text(m[2])]))
  const faq = blocks('discord-alternative.html').find((n) => n['@type'] === 'FAQPage')
  assert.ok(faq.mainEntity.length >= 6)
  assert.equal(faq.mainEntity.length, shown.size)
  for (const q of faq.mainEntity) {
    assert.ok(shown.has(q.name), `not on the page: ${q.name}`)
    const answer = q.acceptedAnswer.text
    assert.equal(answer.replace(/[^a-z0-9]/gi, ''), shown.get(q.name).replace(/[^a-z0-9]/gi, ''), q.name)
  }
})

test('robots.txt, the sitemap and llms.txt agree with the pages', () => {
  const robots = read('robots.txt')
  assert.match(robots, /^Sitemap: https:\/\/iskra\.foo\/sitemap\.xml$/m)
  assert.match(robots, /^User-agent: \*\nAllow: \/$/m)
  for (const bot of ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended']) assert.match(robots, new RegExp(`^User-agent: ${bot}$`, 'm'))
  assert.ok(!/^Disallow: \/$/m.test(robots))

  assert.equal(read('sitemap.xml'), sitemap())
  assert.deepEqual([...sitePaths()].sort(), files.map((f) => address(f).slice('https://iskra.foo'.length)).sort())

  for (const file of ['llms.txt', 'llms-full.txt']) {
    for (const [, path] of read(file).matchAll(/\]\(https:\/\/iskra\.foo(\/[^)#]*)\)/g)) {
      const name = path === '/' ? 'index' : path.endsWith('/') ? `${path.slice(1)}index` : path.slice(1)
      assert.ok(existsSync(join(site, `${name}.html`)), `${file} links to ${path}, which is not a page`)
    }
  }
})

test('every page links to the comparison page, and the home page puts it in the hero', () => {
  for (const file of files) assert.ok(read(file).includes('href="/discord-alternative"'), file)
  assert.match(read('index.html'), /<p class="hero-own">[\s\S]*?href="\/discord-alternative"/)
})

test('the privacy policy says what the site counts, and the worker stores only that', () => {
  const policy = read('privacy.html')
  assert.match(policy, /iskra\.foo counts page views/)
  assert.ok(!/no analytics, no tracking/i.test(policy) && !/We don't add analytics/.test(policy))
  const worker = read('_worker.js')
  assert.deepEqual([...worker.matchAll(/\[\['?(\w+)'?, |pairs\.push\(\['(\w+)'/g)].map((m) => m[1] || m[2]).sort(), ['country', 'download', 'page', 'ref', 'src'])
  assert.ok(!/CF-Connecting-IP|X-Forwarded-For|Set-Cookie|document\.cookie/i.test(worker + read('index.html')))
})
