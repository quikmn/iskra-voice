#!/usr/bin/env node
// Turns the user-facing guides in docs/ (and LICENSE) into pages on iskra.foo: site/docs/<name>.html (served at
// https://iskra.foo/docs/<name>), site/docs/index.html (/docs/) and site/license.html (/license). The pages are
// committed, so deploying the site needs no build step.
//
//   node scripts/build-site-docs.mjs           write the pages
//   node scripts/build-site-docs.mjs --check   exit 1 when a page is missing or differs from its markdown
//
// No network. Markdown via markdown-it (pinned in the root package.json, raw HTML off), heading ids as GitHub makes
// them so the same #anchors work on both. Developer docs (development, ci-cd, compliance, releases) stay on GitHub:
// links to them become explicit GitHub links. scripts/build-site-docs.test.mjs checks the pages are current.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, posix, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import MarkdownIt from 'markdown-it'

export const root = join(dirname(fileURLToPath(import.meta.url)), '..')
export const REPO = 'https://github.com/quikmn/iskra-voice'
export const SITE = 'https://iskra.foo'

/** The published guides, in the order of the docs menu. `title` is the menu name; the page heading is the H1. */
export const GROUPS = [
  { name: 'Run a server', pages: [
    { slug: 'hosting', title: 'Hosting reference', blurb: 'Every way to run a server, reaching it from the internet, backups, moving and every setting.' },
    { slug: 'home-server', title: 'An Iskra box at home', blurb: 'An old PC, a mini PC or a Raspberry Pi that keeps your group’s server on.' },
    { slug: 'templates', title: 'Server templates', blurb: 'Start a server with channels, roles and rules in one go, or write your own template.' },
  ] },
  { name: 'Privacy and security', pages: [
    { slug: 'security', title: 'How Iskra keeps you safe', blurb: 'Accounts without passwords, end-to-end encryption, and what a server can and can’t see.' },
    { slug: 'privacy-connections', title: 'Who Iskra talks to', blurb: 'Every connection the apps and servers make, and why.' },
  ] },
  { name: 'Using Iskra', pages: [
    { slug: 'voice-processing', title: 'Voice processing', blurb: 'Noise removal, camera effects and live captions, all on your own device.' },
    { slug: 'activities', title: 'Activities', blurb: 'Small apps to use together in a voice channel, and how to make one.' },
    { slug: 'assistant', title: 'The assistant (bring your own AI)', blurb: 'Help, bots and organizing your server with an AI provider you choose; nothing goes through Iskra.' },
    { slug: 'testers', title: 'A guide for testers', blurb: 'Getting the test apps, what to try and how to report a bug.' },
  ] },
  { name: 'Build', pages: [
    { slug: 'bots', title: 'Bots and webhooks', blurb: 'Built-in bots, webhooks and writing your own bot with the SDK.' },
  ] },
]
export const PAGES = GROUPS.flatMap((g) => g.pages)
/** Repo files with a page on iskra.foo, and that page. */
export const PUBLISHED = new Map([
  ...PAGES.map((p) => [`docs/${p.slug}.md`, `/docs/${p.slug}`]),
  ['LICENSE', '/license'],
])

// ── GitHub-compatible heading ids (as github-slugger: lower case, punctuation and symbols dropped, spaces to "-") ──

export function slugify(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '').replace(/ /g, '-')
}

export function slugger() {
  const seen = Object.create(null)
  return (text) => {
    const base = slugify(text)
    let slug = base
    while (slug in seen) slug = `${base}-${++seen[base]}`
    seen[slug] = 0
    return slug
  }
}

// ── helpers ──

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const plain = (tokens) => tokens.map((t) => (t.type === 'text' || t.type === 'code_inline' ? t.content : t.children ? plain(t.children) : '')).join('')

/** The day a file last changed: its last commit, or today when it has changes not yet committed. */
export function lastUpdated(file) {
  const git = (...args) => { try { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim() } catch { return '' } }
  const dirty = git('status', '--porcelain', '--', file)
  const date = dirty ? '' : git('log', '-1', '--format=%as', '--', file)
  return date || new Date().toISOString().slice(0, 10)
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const longDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `${d} ${MONTHS[m - 1]} ${y}` }

/**
 * Where a link in docs/<file>.md goes on the site: published docs become their page, other repo files explicit
 * GitHub links (blob for files, tree for folders), web links stay. Returns { href, external }.
 */
export function rewriteHref(href, fromFile) {
  if (!href || href.startsWith('#') || /^mailto:/i.test(href)) return { href, external: false }
  const gh = href.match(/^https:\/\/github\.com\/quikmn\/iskra-voice\/(?:blob|tree)\/main\/([^#?]+)(#.*)?$/)
  if (gh && PUBLISHED.has(gh[1])) return { href: PUBLISHED.get(gh[1]) + (gh[2] ?? ''), external: false }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) {
    const site = href.startsWith(SITE + '/') || href === SITE
    return { href: site ? href.slice(SITE.length) || '/' : href, external: !site }
  }
  const [path, hash = ''] = href.split(/(?=#)/)
  const target = posix.normalize(posix.join(posix.dirname(fromFile), decodeURIComponent(path)))
  if (PUBLISHED.has(target)) return { href: PUBLISHED.get(target) + hash, external: false }
  if (target.startsWith('..')) throw new Error(`${fromFile}: link outside the repo: ${href}`)
  const abs = join(root, target)
  if (!existsSync(abs)) throw new Error(`${fromFile}: link to a file that doesn't exist: ${href}`)
  const kind = statSync(abs).isDirectory() ? 'tree' : 'blob'
  return { href: `${REPO}/${kind}/main/${target.split('/').map(encodeURIComponent).join('/')}${hash}`, external: true }
}

// ── markdown ──

function markdown(fromFile) {
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false })
  const titles = new Map(PAGES.map((p) => [p.slug, p.title]))

  md.core.ruler.push('iskra_site', (state) => {
    const slug = slugger()
    state.env.headings = []
    const tokens = state.tokens
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]
      if (t.type === 'heading_open') {
        const text = plain(tokens[i + 1].children ?? [])
        const id = slug(text)
        t.attrSet('id', id)
        state.env.headings.push({ level: Number(t.tag.slice(1)), id, text })
      }
      if (t.type !== 'inline' || !t.children) continue
      const kids = t.children
      for (let k = 0; k < kids.length; k++) {
        const c = kids[k]
        if (c.type !== 'link_open') continue
        const { href, external } = rewriteHref(c.attrGet('href'), fromFile)
        c.attrSet('href', href)
        if (external) { c.attrSet('target', '_blank'); c.attrSet('rel', 'noopener') }
        // "templates.md" as a link's text reads as the page's name on the site.
        const page = href.match(/^\/docs\/([a-z-]+)/)?.[1]
        if (page && titles.has(page)) {
          for (let j = k + 1; j < kids.length && kids[j].type !== 'link_close'; j++) {
            if (kids[j].type === 'text' || kids[j].type === 'code_inline') {
              const re = new RegExp(`(?:docs/)?\\b${page}\\.md\\b`)
              if (re.test(kids[j].content)) { kids[j].type = 'text'; kids[j].content = kids[j].content.replace(re, titles.get(page)) }
            }
          }
        }
      }
    }
  })

  const r = md.renderer.rules
  r.heading_close = (tokens, idx) => {
    const open = tokens[idx - 2]
    const id = open.attrGet('id')
    return `<a class="anchor" href="#${esc(id)}" aria-hidden="true" tabindex="-1">#</a></${tokens[idx].tag}>\n`
  }
  r.table_open = () => '<div class="table-wrap"><table>\n'
  r.table_close = () => '</table></div>\n'
  r.fence = (tokens, idx) => {
    const t = tokens[idx]
    const lang = t.info.trim().split(/\s+/)[0]
    const label = { sh: 'shell', bash: 'shell', powershell: 'PowerShell', ps1: 'PowerShell', jsonc: 'JSON', json: 'JSON', ts: 'TypeScript', js: 'JavaScript', html: 'HTML', text: '', ini: 'ini', yaml: 'YAML', yml: 'YAML', toml: 'TOML', py: 'Python', python: 'Python' }[lang] ?? lang
    return `<div class="code">${label ? `<div class="code-lang">${esc(label)}</div>` : ''}<pre><code${lang ? ` class="language-${esc(lang)}"` : ''}>${esc(t.content)}</code></pre></div>\n`
  }
  return md
}

/** Renders docs/<slug>.md: { title, html, headings }. The H1 becomes the page title. */
export function renderDoc(file, source) {
  const env = {}
  const md = markdown(file)
  const tokens = md.parse(source.replace(/\r\n/g, '\n'), env)
  let title = ''
  const h1 = tokens.findIndex((t) => t.type === 'heading_open' && t.tag === 'h1')
  if (h1 >= 0) {
    title = plain(tokens[h1 + 1].children)
    tokens.splice(h1, 3)
  }
  return { title, html: md.renderer.render(tokens, md.options, env), headings: env.headings.filter((h) => h.level > 1) }
}

// ── page chrome (as site/privacy.html) ──

const BOLT = `<svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M16 2L4 16h10l-2 10 14-16H16L18 2z" fill="url(#bolt)" stroke="none"/>
      <defs>
        <linearGradient id="bolt" x1="4" y1="2" x2="22" y2="26" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stop-color="#7c6fff"/>
          <stop offset="100%" stop-color="#00cfff"/>
        </linearGradient>
      </defs>
    </svg>`

export const FOOTER_LINKS = [
  ['/github', 'GitHub'], ['/hosting', 'Hosting guide'], ['/docs/', 'Docs'], ['/docs/security', 'Security'], ['/terms', 'Terms'],
  ['/privacy', 'Privacy'], ['/privacy#third', 'Who Iskra talks to'], ['/support', 'Support'], ['/delete-account', 'Delete account'],
]

function page({ path, title, description, kicker, body, current }) {
  const footer = FOOTER_LINKS.map(([href, label]) => `    <a href="${href}"${href === current ? ' aria-current="page"' : ''}>${label}</a>`).join('\n')
  return `<!DOCTYPE html>
<!-- Generated by scripts/build-site-docs.mjs. Don't edit: change the source and run node scripts/build-site-docs.mjs. -->
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)} - Iskra</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${SITE}${path}">
<meta name="theme-color" content="#0b0b14">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="stylesheet" href="/fonts.css">
<link rel="stylesheet" href="/site.css">
<link rel="stylesheet" href="/guide.css">
</head>
<body>

<!-- NAV -->
<nav>
  <a class="nav-logo" href="/">
    ${BOLT}
    Iskra
  </a>
  <div class="nav-links">
    <a class="btn btn-ghost nav-hide-sm" href="/docs/"${kicker === 'Docs' ? ' aria-current="page"' : ''}>Docs</a>
    <a class="btn btn-ghost nav-hide-sm" href="/support">Help</a>
    <a class="btn btn-ghost nav-hide-sm" href="${REPO}" target="_blank" rel="noopener">GitHub</a>
    <a class="btn btn-primary" href="/#download">Download</a>
  </div>
</nav>

${body}

<!-- FOOTER -->
<footer>
  <span>© 2026 Viktor Lundgren · <a href="/license">PolyForm Noncommercial 1.0.0</a></span>
  <div class="footer-links">
${footer}
    <a href="https://ko-fi.com/vlundgren" target="_blank" rel="noopener">Ko-fi</a>
    <a href="https://paypal.me/iskrafoo" target="_blank" rel="noopener">PayPal</a>
  </div>
</footer>

</body>
</html>
`
}

function sideMenu(currentSlug, headings) {
  const groups = GROUPS.map((g) => {
    const items = g.pages.map((p) => {
      if (p.slug !== currentSlug) return `        <li><a href="/docs/${p.slug}">${esc(p.title)}</a></li>`
      return `        <li class="here"><a href="/docs/${p.slug}" aria-current="page">${esc(p.title)}</a>\n${tocList(headings, 'side-toc')}\n        </li>`
    }).join('\n')
    return `      <div class="side-group">${esc(g.name)}</div>\n      <ul>\n${items}\n      </ul>`
  }).join('\n')
  return `  <aside class="docs-side">
    <div class="side-nav" role="navigation" aria-label="Docs">
      <a class="side-home" href="/hosting">&larr; Hosting guide</a>
${groups}
    </div>
  </aside>`
}

function tocList(headings, cls) {
  const items = headings.filter((h) => h.level <= 3)
    .map((h) => `<li class="l${h.level}"><a href="#${esc(h.id)}">${esc(h.text)}</a></li>`).join('')
  return items ? `<ul class="${cls}">${items}</ul>` : ''
}

export function docPage(p, file, source, updated) {
  const { title, html, headings } = renderDoc(file, source)
  const toc = headings.some((h) => h.level === 2)
    ? `  <details class="mobile-toc">\n    <summary>On this page</summary>\n    ${tocList(headings.filter((h) => h.level === 2), 'toc-list')}\n  </details>\n`
    : ''
  const body = `<div class="docs-layout">
${sideMenu(p.slug, headings)}

<main class="doc docs-main" id="top">
  <div class="doc-kicker">Docs</div>
  <h1>${esc(title || p.title)}</h1>
  <p class="updated">Last updated <time datetime="${updated}">${longDate(updated)}</time></p>
${toc}
<div class="md">
${html}</div>

  <div class="doc-foot">
    <a href="#top">Back to top &uarr;</a>
    <a href="${REPO}/edit/main/${file}" target="_blank" rel="noopener">Edit this page on GitHub</a>
  </div>
</main>
</div>`
  return page({ path: `/docs/${p.slug}`, title: title || p.title, description: p.blurb, kicker: 'Docs', body, current: p.slug === 'security' ? '/docs/security' : '' })
}

export function indexPage() {
  const groups = GROUPS.map((g) => `  <h2 id="${slugify(g.name)}">${esc(g.name)}</h2>
  <div class="doc-cards">
${g.pages.map((p) => `    <a class="doc-card" href="/docs/${p.slug}"><strong>${esc(p.title)}</strong><span>${esc(p.blurb)}</span></a>`).join('\n')}
  </div>`).join('\n')
  const body = `<main class="doc docs-index">
  <div class="doc-kicker">Docs</div>
  <h1>The Iskra <span class="grad">docs</span></h1>
  <p class="lead">Everything in detail, for when you want to know exactly how it works. New to hosting? Start with the <a href="/hosting">hosting guide</a>.</p>
${groups}
  <h2 id="more">More</h2>
  <div class="doc-cards">
    <a class="doc-card" href="/github"><strong>What’s on GitHub</strong><span>Downloads, the bot SDK, themes, the source code and how to report a bug.</span></a>
    <a class="doc-card" href="/license"><strong>License</strong><span>PolyForm Noncommercial 1.0.0: free for personal and noncommercial use.</span></a>
  </div>
</main>`
  return page({ path: '/docs/', title: 'Docs', description: 'Guides to hosting an Iskra server, security and privacy, voice processing, activities, bots and webhooks.', kicker: 'Docs', body, current: '/docs/' })
}

/** LICENSE is plain text: single-line paragraphs without a full stop are its section titles. */
export function licensePage(source, updated) {
  const paras = source.replace(/\r\n/g, '\n').trim().split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
  const [name, url, copyright, notice, ...rest] = paras
  const link = (s) => esc(s).replace(/https:\/\/[^\s)]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`)
  const slug = slugger()
  const headings = []
  const body = rest.map((p) => {
    if (!p.includes('\n') && !/[.:;,]$/.test(p) && p.length < 50) {
      const id = slug(p)
      headings.push({ level: 2, id, text: p })
      return `<h2 id="${id}">${esc(p)}<a class="anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a></h2>`
    }
    return `<p>${link(p)}</p>`
  }).join('\n')
  const html = `<main class="doc" id="top">
  <div class="doc-kicker">License</div>
  <h1>${esc(name.replace(/ 1\.0\.0$/, ''))} <span class="grad">1.0.0</span></h1>
  <p class="updated">Last updated <time datetime="${updated}">${longDate(updated)}</time></p>

  <div class="box ok">
    <div class="box-title">In plain words</div>
    <ul>
      <li><strong>You may use, run, change and share Iskra for any noncommercial purpose:</strong> personal use, friend groups, hobby projects, and noncommercial organisations such as schools and charities.</li>
      <li><strong>Commercial use needs separate permission:</strong> ask us at <a href="mailto:spark@iskra.foo">spark@iskra.foo</a>.</li>
      <li>Copies you share carry this license and its <em>Required Notice</em>.</li>
    </ul>
    <p>This is just a summary: the license text below decides.</p>
  </div>

  <div class="license-meta">
    <p>${link(url)}</p>
    <p>${esc(copyright)}</p>
    <p>${link(notice)}</p>
  </div>

  <ul class="toc" aria-label="Contents">${headings.map((h) => `<li><a href="#${h.id}">${esc(h.text)}</a></li>`).join('')}</ul>

<div class="md">
${body}
</div>

  <div class="doc-foot">
    <a href="#top">Back to top &uarr;</a>
    <a href="${REPO}" target="_blank" rel="noopener">Source code on GitHub</a>
  </div>
</main>`
  return page({ path: '/license', title: 'License', description: 'Iskra is source-available under the PolyForm Noncommercial License 1.0.0: free for personal and noncommercial use.', kicker: 'License', body: html, current: '' })
}

/** Every generated page: Map<repo-relative output path, html>. */
export function buildAll() {
  const out = new Map()
  for (const p of PAGES) {
    const file = `docs/${p.slug}.md`
    out.set(`site/docs/${p.slug}.html`, docPage(p, file, readFileSync(join(root, file), 'utf8'), lastUpdated(file)))
  }
  out.set('site/docs/index.html', indexPage())
  out.set('site/license.html', licensePage(readFileSync(join(root, 'LICENSE'), 'utf8'), lastUpdated('LICENSE')))
  return out
}

/** Same page apart from its "last updated" date and line endings (a shallow clone can't tell the date). */
export const comparable = (html) => html.replace(/\r\n/g, '\n').replace(/<time datetime="[^"]*">[^<]*<\/time>/g, '<time>')

/** Generated pages that are missing, differ from their source, or are left over from a removed guide. */
export function stalePages(pages = buildAll()) {
  const stale = []
  for (const [path, html] of pages) {
    const abs = join(root, path)
    if (!existsSync(abs) || comparable(readFileSync(abs, 'utf8')) !== comparable(html)) stale.push(path)
  }
  const dir = join(root, 'site', 'docs')
  if (existsSync(dir)) for (const f of readdirSync(dir)) if (!pages.has(`site/docs/${f}`)) stale.push(`site/docs/${f} (no source)`)
  return stale
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const pages = buildAll()
  if (process.argv.includes('--check')) {
    const stale = stalePages(pages)
    if (stale.length) {
      console.error(`Site docs are out of date: ${stale.join(', ')}. Run: node scripts/build-site-docs.mjs`)
      process.exit(1)
    }
    console.log(`Site docs are current (${pages.size} pages).`)
  } else {
    mkdirSync(join(root, 'site', 'docs'), { recursive: true })
    for (const [path, html] of pages) writeFileSync(join(root, path), html)
    console.log(`Wrote ${[...pages.keys()].map((p) => relative(root, join(root, p))).join(', ')}`)
  }
}
