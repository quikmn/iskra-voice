// The docs pages on iskra.foo (scripts/build-site-docs.mjs): current with their markdown, GitHub's heading ids, and
// no link that sends people to a raw GitHub page for something that has a page on iskra.foo.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import test from 'node:test'
import { PUBLISHED, renderDoc, rewriteHref, root, slugger, slugify, stalePages } from './build-site-docs.mjs'

test('the generated pages match docs/*.md and LICENSE (run node scripts/build-site-docs.mjs)', () => {
  assert.deepEqual(stalePages(), [])
})

test('heading ids are the ones GitHub makes, so #anchors work on both', () => {
  assert.equal(slugify('`server.json` reference'), 'serverjson-reference')
  assert.equal(slugify('Backup buddies (a friend\'s server)'), 'backup-buddies-a-friends-server')
  assert.equal(slugify('4. Report a bug'), '4-report-a-bug')
  assert.equal(slugify('One switch: Let friends anywhere join'), 'one-switch-let-friends-anywhere-join')
  assert.equal(slugify('Rent a server on DigitalOcean (one click)'), 'rent-a-server-on-digitalocean-one-click')
  assert.equal(slugify('Ports  at a glance'), 'ports--at-a-glance')
  assert.equal(slugify('Åäö and ü'), 'åäö-and-ü')
  const slug = slugger()
  assert.deepEqual(['Updating', 'Updating', 'Updating', 'Updating-1'].map(slug), ['updating', 'updating-1', 'updating-2', 'updating-1-1'])
  const { html } = renderDoc('docs/x.md', '# Title\n\n## A *nice* `code` [link](#a)\n\n## A nice code link\n')
  assert.match(html, /<h2 id="a-nice-code-link">/)
  assert.match(html, /<h2 id="a-nice-code-link-1">/)
})

test('links: published docs become site pages, other repo files explicit GitHub links', () => {
  assert.deepEqual(rewriteHref('hosting.md#gifs', 'docs/bots.md'), { href: '/docs/hosting#gifs', external: false })
  assert.deepEqual(rewriteHref('../LICENSE', 'docs/bots.md'), { href: '/license', external: false })
  assert.deepEqual(rewriteHref('#webhooks', 'docs/bots.md'), { href: '#webhooks', external: false })
  assert.deepEqual(rewriteHref('../protocol/PROTOCOL.md#bots', 'docs/bots.md'),
    { href: 'https://github.com/quikmn/iskra-voice/blob/main/protocol/PROTOCOL.md#bots', external: true })
  assert.deepEqual(rewriteHref('../bots/examples', 'docs/bots.md'),
    { href: 'https://github.com/quikmn/iskra-voice/tree/main/bots/examples', external: true })
  assert.deepEqual(rewriteHref('https://github.com/quikmn/iskra-voice/blob/main/docs/security.md#x', 'docs/bots.md'), { href: '/docs/security#x', external: false })
  assert.deepEqual(rewriteHref('https://iskra.foo/privacy', 'docs/bots.md'), { href: '/privacy', external: false })
  assert.deepEqual(rewriteHref('https://tailscale.com', 'docs/bots.md'), { href: 'https://tailscale.com', external: true })
  assert.throws(() => rewriteHref('nope.md', 'docs/bots.md'), /doesn't exist/)
  // No raw HTML from markdown, ever.
  assert.doesNotMatch(renderDoc('docs/x.md', '# T\n\n<script>alert(1)</script>\n\n<b>x</b>').html, /<script|<b>/)
})

// ── Every link people click ──

const files = (dir, ext) => {
  const abs = join(root, dir)
  if (!existsSync(abs)) return []
  if (statSync(abs).isFile()) return [dir]
  return readdirSync(abs, { recursive: true }).map((f) => join(dir, String(f)).replace(/\\/g, '/'))
    .filter((f) => ext.test(f) && !/node_modules|\.test\./.test(f) && statSync(join(root, f)).isFile())
}
const SCANNED = [
  ...files('site', /\.html$/), ...files('client/src', /\.(ts|tsx)$/), ...files('desktop/src', /\.ts$/),
  ...files('mobile/src', /\.(ts|tsx)$/), ...files('marketplace/digitalocean', /(listing\.md|iskra-claim-screen)$/),
  ...files('server/templates', /\.json$/), 'bots/sdk/README.md', 'bots/sdk/package.json', 'docs/store/testers-kit.md',
]

/**
 * GitHub links to a file that has a page on iskra.foo that may stay, as "file: url". Links to the repository itself,
 * releases, issues, other repo files (code, workflows, developer docs) and "Edit on GitHub" (/edit/) are always fine.
 */
const ALLOWED = new Set([])

test('nothing links to GitHub for a doc that has a page on iskra.foo', () => {
  const bad = []
  for (const file of SCANNED) {
    const text = readFileSync(join(root, file), 'utf8')
    for (const m of text.matchAll(/https:\/\/github\.com\/quikmn\/iskra-voice\/(?:blob|tree)\/[^/\s"'`]+\/([^\s"'`#?)<>]+)[^\s"'`)<>]*/g)) {
      if (PUBLISHED.has(m[1]) && !ALLOWED.has(`${file}: ${m[0]}`)) bad.push(`${file}: ${m[0]} -> https://iskra.foo${PUBLISHED.get(m[1])}`)
    }
  }
  assert.deepEqual(bad, [])
})

/** site/ file for a path on iskra.foo, as Cloudflare Pages serves it (clean URLs). */
function siteFile(path) {
  const p = decodeURIComponent(path)
  for (const f of p.endsWith('/') ? [`${p}index.html`] : [p, `${p}.html`]) {
    const abs = join(root, 'site', f)
    if (existsSync(abs) && statSync(abs).isFile()) return abs
  }
  return null
}

test('links within iskra.foo (site pages and the apps) point at pages and #anchors that exist', () => {
  const ids = new Map()
  const idsOf = (abs) => ids.get(abs) ?? ids.set(abs, new Set([...readFileSync(abs, 'utf8').matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))).get(abs)
  const bad = []
  const check = (file, url, base) => {
    let [path, hash] = url.split('#')
    if (!path) path = base
    if (path === '') path = '/'
    const abs = siteFile(path)
    if (!abs) return bad.push(`${file}: ${url} (no such page)`)
    if (hash && abs.endsWith('.html') && !idsOf(abs).has(decodeURIComponent(hash))) bad.push(`${file}: ${url} (no #${hash} there)`)
  }
  for (const file of SCANNED) {
    const text = readFileSync(join(root, file), 'utf8')
    const page = file.startsWith('site/') && file.endsWith('.html') ? '/' + relative('site', file).replace(/\\/g, '/').replace(/(index)?\.html$/, '') : null
    for (const m of text.matchAll(/https:\/\/iskra\.foo(\/[^\s"'`)<>\\]*)?/g)) check(file, (m[1] ?? '/').replace(/[.,;:]+$/, ''), '/')
    if (page !== null) for (const m of text.matchAll(/\s(?:href|src)="(\/[^"]*|#[^"]*)"/g)) check(file, m[1], page)
  }
  assert.deepEqual(bad, [])
})
