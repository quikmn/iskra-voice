// The iskra.foo worker (Cloudflare Pages, advanced mode). It serves the static files and keeps visitor statistics:
// daily totals in D1 (binding DB), shown at /stats behind a password (secret STATS_PASSWORD).
//
// What is counted: one row per day and value, with a number. Page views by path, the host of the site that linked
// here, the utm_source or ref parameter, country, device class, browser and operating system, and clicks on
// download links. Nothing else is stored: no IP address, no cookie, no visitor id, no user agent, no row per visit.
// Keep site/privacy.html section 9 in step with this file.
//
// Counting runs after the response is on its way (ctx.waitUntil) and every failure is swallowed, so a page is never
// slower or broken because of it. Without the DB binding the worker only serves files.
// _routes.json keeps fonts, images, stylesheets and text files away from the worker.

const SCHEMA =
  'CREATE TABLE IF NOT EXISTS counts (day TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, kind, name)) WITHOUT ROWID'
const UPSERT = 'INSERT INTO counts (day, kind, name, n) VALUES (?, ?, ?, 1) ON CONFLICT (day, kind, name) DO UPDATE SET n = n + 1'

const REPO = 'quikmn/iskra-voice'
const MIN_PASSWORD = 16

// ── Who is asking ──

// A browser's user agent starts with "Mozilla/" and has none of these words (nor a URL, which crawlers add).
const BOT = /(?<!cu)bot|crawl|spider|slurp|preview|fetch|monitor|scan|curl|wget|python|java\/|okhttp|headless|lighthouse|pingdom|uptime|facebookexternalhit|embed|feed|axios|node|libwww|phantom|scrapy|http|ruby|perl|php|postman|insomnia|gpt|claude|perplexity|anthropic|ahrefs|semrush|duckduck|archive/i

/** True for crawlers, link previewers, scripts and monitors: anything that is not a person's browser. */
function isBot(request) {
  const ua = request.headers.get('User-Agent') || ''
  if (!ua.startsWith('Mozilla/') || BOT.test(ua)) return true
  const cf = request.cf || {}
  if (cf.verifiedBotCategory) return true
  const bm = cf.botManagement
  return !!bm && (bm.verifiedBot === true || (typeof bm.score === 'number' && bm.score > 0 && bm.score < 30))
}

function device(ua) {
  if (/iPad|Tablet|PlayBook|Silk/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))) return 'Tablet'
  if (/Mobi|iPhone|iPod|Android/.test(ua)) return 'Phone'
  return 'Desktop'
}

function browser(ua) {
  if (/Edg(e|A|iOS)?\//.test(ua)) return 'Edge'
  if (/OPR\/|Opera/.test(ua)) return 'Opera'
  if (/SamsungBrowser\//.test(ua)) return 'Samsung Internet'
  if (/Vivaldi\//.test(ua)) return 'Vivaldi'
  if (/YaBrowser\//.test(ua)) return 'Yandex Browser'
  if (/Firefox\/|FxiOS\//.test(ua)) return 'Firefox'
  if (/Chrome\/|CriOS\/|Chromium\//.test(ua)) return 'Chrome'
  if (/Safari\//.test(ua) && /Version\//.test(ua)) return 'Safari'
  return 'Other'
}

function os(ua) {
  if (/Windows NT/.test(ua)) return 'Windows'
  if (/Android/.test(ua)) return 'Android'
  if (/iPhone|iPad|iPod/.test(ua)) return 'iOS'
  if (/Mac OS X|Macintosh/.test(ua)) return 'macOS'
  if (/CrOS/.test(ua)) return 'ChromeOS'
  if (/Linux|X11/.test(ua)) return 'Linux'
  return 'Other'
}

/** The host of the page that linked here ("news.ycombinator.com"), never its path. '' for none or this site itself. */
function referrerHost(request, url) {
  const raw = request.headers.get('Referer')
  if (!raw) return ''
  let ref
  try { ref = new URL(raw) } catch { return '' }
  if (!['http:', 'https:', 'android-app:'].includes(ref.protocol)) return ''
  const host = ref.hostname.toLowerCase().replace(/^www\./, '')
  if (!host || host === url.hostname || !/^[a-z0-9._-]{1,80}$/.test(host)) return ''
  return host
}

/** ?utm_source= or ?ref= as a short lower-case word; '' when absent or not a plain word. */
function campaign(url) {
  const raw = (url.searchParams.get('utm_source') || url.searchParams.get('ref') || '').toLowerCase()
  return /^[a-z0-9][a-z0-9._-]{0,39}$/.test(raw) ? raw : ''
}

// ── Download files ──

/** The dashboard's name for a release file or a download link; '' for files nobody picks by hand (update feeds, checksums). */
function downloadName(file) {
  const f = String(file)
  if (f === 'web-app') return 'Web app'
  if (f === 'google-play') return 'Google Play test'
  if (f === 'testflight') return 'TestFlight'
  if (/\.blockmap$|\.yml$|\.json$|SUMS/.test(f)) return ''
  if (/^Iskra-Setup-.*\.exe$/.test(f)) return 'Windows installer'
  if (/^Iskra-Portable-.*\.exe$/.test(f)) return 'Windows portable'
  if (/-mac-arm64\.dmg$/.test(f)) return 'Mac (Apple silicon)'
  if (/-mac-x64\.dmg$/.test(f)) return 'Mac (Intel)'
  if (/-mac-(arm64|x64)\.zip$/.test(f)) return 'Mac app updates'
  if (/\.AppImage$/.test(f)) return 'Linux AppImage'
  if (/\.deb$/.test(f)) return 'Linux .deb'
  if (/\.rpm$/.test(f)) return 'Linux .rpm'
  if (/\.apk$/.test(f)) return 'Android APK'
  if (/^iskra-server-.*-win-x64\.zip$/.test(f)) return 'Server: Windows'
  if (/^iskra-server-.*-linux-x64\.tar\.gz$/.test(f)) return 'Server: Linux x64'
  if (/^iskra-server-.*-linux-arm64\.tar\.gz$/.test(f)) return 'Server: Linux ARM64'
  if (/^iskra-server-.*-osx-arm64\.tar\.gz$/.test(f)) return 'Server: Mac (Apple silicon)'
  if (/^iskra-server-.*-osx-x64\.tar\.gz$/.test(f)) return 'Server: Mac (Intel)'
  return ''
}

// ── Counting ──

const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10)

/** Adds one to each [kind, name] for today. Makes the table on first use. Never throws. */
async function count(env, pairs, day = today()) {
  if (!env.DB || !pairs.length) return
  const run = () => env.DB.batch(pairs.map(([kind, name]) => env.DB.prepare(UPSERT).bind(day, kind, name)))
  try {
    await run()
  } catch (e) {
    try {
      if (!/no such table/i.test(String(e && e.message))) return
      await env.DB.prepare(SCHEMA).run()
      await run()
    } catch { /* statistics are best effort */ }
  }
}

/** What one page view adds, or [] when it isn't counted. */
function pageView(request, url, response) {
  if (request.method !== 'GET' || url.searchParams.has('deploy')) return []
  if (/prefetch|prerender/i.test(request.headers.get('Sec-Purpose') || request.headers.get('Purpose') || '')) return []
  const html = (response.headers.get('Content-Type') || '').startsWith('text/html')
  // 304: a returning visitor's browser checked its copy. Only paths without a file extension are pages.
  const page = response.status === 200 ? html : response.status === 304 && !/\.[a-z0-9]+$/i.test(url.pathname)
  if (!page || isBot(request)) return []
  const ua = request.headers.get('User-Agent') || ''
  const pairs = [['page', url.pathname.slice(0, 100)], ['device', device(ua)], ['browser', browser(ua)], ['os', os(ua)]]
  const country = request.cf && request.cf.country
  if (typeof country === 'string' && /^[A-Z0-9]{2}$/.test(country)) pairs.push(['country', country])
  const ref = referrerHost(request, url)
  if (ref) pairs.push(['ref', ref])
  const src = campaign(url)
  if (src) pairs.push(['src', src])
  return pairs
}

/** POST /count/download: the page says a download link was clicked (navigator.sendBeacon, body = the file name). */
async function downloadClick(request, url, env, ctx) {
  const done = new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } })
  const origin = request.headers.get('Origin')
  const site = request.headers.get('Sec-Fetch-Site')
  if ((origin && origin !== url.origin) || (site && site !== 'same-origin') || isBot(request)) return done
  let body = ''
  try { body = (await request.text()).slice(0, 120) } catch { return done }
  const name = downloadName(body)
  if (name) ctx.waitUntil(count(env, [['download', name]]))
  return done
}

// ── /stats ──

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
}

/** Compares two strings in a time that doesn't depend on where they differ, nor on their lengths (both are hashed first). */
async function sameSecret(a, b) {
  const [x, y] = await Promise.all([sha256(a), sha256(b)])
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i]
  return diff === 0
}

/** The password of an HTTP Basic Authorization header (any user name), or null. */
function basicPassword(request) {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(request.headers.get('Authorization') || '')
  if (!m) return null
  try {
    const text = new TextDecoder().decode(Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0)))
    const colon = text.indexOf(':')
    return colon < 0 ? null : text.slice(colon + 1)
  } catch { return null }
}

const PRIVATE = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' }
const plain = (body, status, extra = {}) => new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...PRIVATE, ...extra } })

async function stats(request, url, env) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return plain('Method not allowed', 405, { Allow: 'GET, HEAD' })
  const secret = typeof env.STATS_PASSWORD === 'string' ? env.STATS_PASSWORD : ''
  if (secret.length < MIN_PASSWORD) return plain(`Statistics are off: set the secret STATS_PASSWORD (${MIN_PASSWORD} characters or more) on the Pages project.`, 503)
  const given = basicPassword(request)
  if (given === null || !(await sameSecret(given, secret))) {
    return plain('Password needed.', 401, { 'WWW-Authenticate': 'Basic realm="Iskra statistics", charset="UTF-8"' })
  }
  if (!env.DB) return plain('Statistics are off: bind a D1 database as DB on the Pages project.', 503)
  const days = url.searchParams.get('days') === '90' ? 90 : 30
  let data
  try {
    data = await readCounts(env, days)
  } catch (e) {
    return plain(`Could not read the statistics: ${String(e && e.message).slice(0, 200)}`, 500)
  }
  const releases = await githubReleases()
  return new Response(request.method === 'HEAD' ? null : dashboard(days, data, releases), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      ...PRIVATE,
    },
  })
}

const KINDS = ['page', 'ref', 'src', 'country', 'device', 'browser', 'os', 'download']

async function readCounts(env, days, now = Date.now()) {
  const since = today(now - (days - 1) * 86400000)
  const top = 'SELECT name, SUM(n) AS n FROM counts WHERE kind = ? AND day >= ? GROUP BY name ORDER BY n DESC, name LIMIT 25'
  const query = () => env.DB.batch([
    env.DB.prepare("SELECT day, SUM(n) AS n FROM counts WHERE kind = 'page' AND day >= ? GROUP BY day").bind(since),
    ...KINDS.map((kind) => env.DB.prepare(top).bind(kind, since)),
  ])
  let results
  try {
    results = await query()
  } catch (e) {
    if (!/no such table/i.test(String(e && e.message))) throw e
    await env.DB.prepare(SCHEMA).run()
    results = await query()
  }
  const perDay = new Map(results[0].results.map((r) => [r.day, Number(r.n)]))
  const series = []
  for (let i = days - 1; i >= 0; i--) {
    const day = today(now - i * 86400000)
    series.push({ day, n: perDay.get(day) || 0 })
  }
  const tops = Object.fromEntries(KINDS.map((kind, i) => [kind, results[i + 1].results.map((r) => ({ name: String(r.name), n: Number(r.n) }))]))
  return { series, tops }
}

/** Download counts per release and file kind from GitHub, kept for 30 minutes. { releases, fetched } or { releases: [], error }. */
async function githubReleases() {
  const api = `https://api.github.com/repos/${REPO}/releases?per_page=30`
  const cache = typeof caches !== 'undefined' && caches.default
  const key = new Request('https://iskra.foo/__cache/github-releases')
  try {
    if (cache) {
      const hit = await cache.match(key)
      if (hit) return await hit.json()
    }
    const res = await fetch(api, { headers: { 'User-Agent': 'iskra.foo-stats', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(5000) })
    if (!res.ok) return { releases: [], error: `GitHub answered ${res.status}` }
    const releases = (await res.json()).map((r) => {
      const files = {}
      for (const a of r.assets || []) {
        const name = downloadName(a.name)
        if (name) files[name] = (files[name] || 0) + (a.download_count || 0)
      }
      return { tag: String(r.tag_name), day: String(r.published_at || '').slice(0, 10), files }
    })
    const out = { releases, fetched: new Date().toISOString() }
    if (cache) await cache.put(key, new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=1800' } }))
    return out
  } catch (e) {
    return { releases: [], error: String(e && e.message).slice(0, 120) }
  }
}

// ── The dashboard page ──

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const num = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
const sum = (rows) => rows.reduce((t, r) => t + r.n, 0)

let regionNames
function countryName(code) {
  try {
    regionNames ||= new Intl.DisplayNames(['en'], { type: 'region' })
    return regionNames.of(code) || code
  } catch { return code }
}

/** A round number at or above n for the top of the chart's scale. */
function niceMax(n) {
  if (n <= 4) return 4
  const p = 10 ** Math.floor(Math.log10(n))
  for (const m of [1, 2, 4, 5, 10]) if (m * p >= n) return m * p
  return 10 * p
}

/** Page views per day as bars. One series, so no legend: the heading names it. Each bar shows its value on hover. */
function chart(series) {
  const W = 960, H = 240, left = 44, right = 8, top = 12, bottom = 26
  const max = niceMax(Math.max(...series.map((d) => d.n), 1))
  const plotW = W - left - right, plotH = H - top - bottom
  const step = plotW / series.length
  const barW = Math.max(2, Math.min(24, step - 2))
  const y = (n) => top + plotH - (n / max) * plotH
  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const gy = y(max * f)
    return `<line x1="${left}" x2="${W - right}" y1="${gy}" y2="${gy}" class="grid${f === 0 ? ' base' : ''}"/><text x="${left - 8}" y="${gy + 4}" text-anchor="end">${num(max * f)}</text>`
  }).join('')
  const every = series.length > 45 ? 14 : 7
  const bars = series.map((d, i) => {
    const x = left + i * step + (step - barW) / 2
    const h = d.n ? Math.max(2, (d.n / max) * plotH) : 0
    const r = Math.min(4, barW / 2, h)
    const by = top + plotH - h
    const bar = h ? `<path d="M${x.toFixed(1)},${by + h}V${(by + r).toFixed(1)}q0,${-r} ${r},${-r}h${(barW - 2 * r).toFixed(1)}q${r},0 ${r},${r}V${by + h}z" class="bar"/>` : ''
    const label = (series.length - 1 - i) % every === 0 ? `<text x="${(x + barW / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle">${d.day.slice(5)}</text>` : ''
    return `<g><title>${d.day}: ${num(d.n)} page views</title><rect x="${(left + i * step).toFixed(1)}" y="${top}" width="${step.toFixed(1)}" height="${plotH}" class="hit"/>${bar}</g>${label}`
  }).join('')
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Page views per day, last ${series.length} days">${grid}${bars}</svg>`
}

function table(title, rows, { label = (s) => s, note = '', empty = 'Nothing yet.' } = {}) {
  const max = Math.max(...rows.map((r) => r.n), 1)
  const body = rows.length
    ? rows.map((r) => `<tr><td><span class="meter" style="width:${((r.n / max) * 100).toFixed(1)}%"></span><span class="name">${esc(label(r.name))}</span></td><td class="n">${num(r.n)}</td></tr>`).join('')
    : `<tr><td class="empty" colspan="2">${esc(empty)}</td></tr>`
  return `<section class="card"><h2>${esc(title)}</h2>${note ? `<p class="note">${esc(note)}</p>` : ''}<table>${body}</table></section>`
}

function releaseTable(gh) {
  if (!gh.releases.length) return `<section class="card wide"><h2>GitHub downloads per release</h2><p class="note">${esc(gh.error ? `Could not ask GitHub: ${gh.error}.` : 'No releases.')}</p></section>`
  const shown = gh.releases.slice(0, 12)
  const totals = new Map()
  for (const r of gh.releases) for (const [k, n] of Object.entries(r.files)) totals.set(k, (totals.get(k) || 0) + n)
  const cols = [...totals.keys()].sort((a, b) => totals.get(b) - totals.get(a))
  const head = `<tr><th>Version</th><th>Released</th><th class="n">All</th>${cols.map((c) => `<th class="n">${esc(c)}</th>`).join('')}</tr>`
  const row = (name, day, files) => `<tr><td>${esc(name)}</td><td>${esc(day)}</td><td class="n"><strong>${num(Object.values(files).reduce((a, b) => a + b, 0))}</strong></td>${cols.map((c) => `<td class="n">${files[c] ? num(files[c]) : '<span class="zero">0</span>'}</td>`).join('')}</tr>`
  const all = row(`Last ${gh.releases.length} releases`, '', Object.fromEntries(totals))
  return `<section class="card wide"><h2>GitHub downloads per release</h2>
<p class="note">From GitHub, which counts every download of a file: people, app updates and scripts alike. Update feeds and checksum files are left out.${gh.fetched ? ` Fetched ${esc(gh.fetched.slice(0, 16).replace('T', ' '))} UTC, kept for 30 minutes.` : ''}</p>
<div class="scroll"><table class="releases">${head}${shown.map((r) => row(r.tag, r.day, r.files)).join('')}${all}</table></div></section>`
}

function dashboard(days, { series, tops }, gh) {
  const views = sum(series)
  const todayN = series[series.length - 1].n
  const yesterday = series.length > 1 ? series[series.length - 2].n : 0
  const tile = (label, value) => `<div class="tile"><div class="tile-label">${esc(label)}</div><div class="tile-value">${esc(value)}</div></div>`
  const range = (d) => `<a href="/stats?days=${d}"${d === days ? ' aria-current="page"' : ''}>${d} days</a>`
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Statistics - Iskra</title>
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#0b0b14">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="stylesheet" href="/fonts.css">
<link rel="stylesheet" href="/site.css">
<style>
main.stats { flex: 1; width: 100%; max-width: 1180px; margin: 0 auto; padding: 48px 24px 80px; color: var(--soft); }
.stats h1 { font-size: 2rem; font-weight: 900; letter-spacing: -0.03em; color: var(--text); }
.stats .sub { color: var(--muted); font-size: 0.9rem; margin: 6px 0 24px; }
.range { display: inline-flex; gap: 4px; padding: 4px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); margin-bottom: 20px; }
.range a { padding: 6px 14px; border-radius: 7px; font-size: 0.85rem; font-weight: 600; color: var(--muted); text-decoration: none; }
.range a[aria-current] { background: var(--surface2); color: var(--text); }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 16px; }
.tile, .card { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 18px 20px; min-width: 0; }
.tile-label { font-size: 0.78rem; color: var(--muted); }
.tile-value { font-size: 1.9rem; font-weight: 800; letter-spacing: -0.02em; color: var(--text); font-variant-numeric: tabular-nums; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
.card.wide { grid-column: 1 / -1; }
.card h2 { font-size: 1rem; font-weight: 700; color: var(--text); margin-bottom: 10px; }
.card .note { font-size: 0.8rem; color: var(--muted); margin-bottom: 10px; line-height: 1.5; }
.card table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
.card td, .card th { padding: 6px 8px; text-align: left; position: relative; white-space: nowrap; }
.card th { font-size: 0.74rem; font-weight: 600; color: var(--muted); border-bottom: 1px solid var(--border); }
.card td.n, .card th.n { text-align: right; font-variant-numeric: tabular-nums; color: var(--text); width: 1%; }
.card td .name { position: relative; overflow-wrap: anywhere; white-space: normal; }
.meter { position: absolute; left: 0; top: 4px; bottom: 4px; border-radius: 4px; background: rgba(124,111,255,0.2); }
.card .empty, .zero { color: var(--muted); }
.releases td, .releases th { border-bottom: 1px solid var(--border); }
.releases tr:last-child td { border-bottom: none; color: var(--text); font-weight: 600; }
.scroll { overflow-x: auto; }
svg { display: block; width: 100%; height: auto; }
svg text { font: 11px 'Inter', sans-serif; fill: var(--muted); font-variant-numeric: tabular-nums; }
svg .grid { stroke: rgba(120,100,255,0.12); stroke-width: 1; }
svg .grid.base { stroke: rgba(120,100,255,0.35); }
svg .bar { fill: var(--accent); }
svg .hit { fill: transparent; }
svg g:hover .hit { fill: rgba(124,111,255,0.1); }
svg g:hover .bar { fill: #a89fff; }
</style>
</head>
<body>
<nav>
  <a class="nav-logo" href="/">Iskra</a>
  <div class="nav-links"><a class="btn btn-ghost" href="/">Back to the site</a></div>
</nav>
<main class="stats">
  <h1>Statistics</h1>
  <p class="sub">iskra.foo, last ${days} days, days in UTC. Daily totals only: no visitor is identified, and crawlers are left out.</p>
  <div class="range" role="group" aria-label="Time range">${range(30)}${range(90)}</div>
  <div class="tiles">
    ${tile(`Page views, ${days} days`, num(views))}
    ${tile('Today', num(todayN))}
    ${tile('Yesterday', num(yesterday))}
    ${tile(`Download clicks, ${days} days`, num(sum(tops.download)))}
  </div>
  <div class="cards">
    <section class="card wide"><h2>Page views per day</h2>${chart(series)}</section>
    ${table('Pages', tops.page)}
    ${table('Sites that sent visitors', tops.ref, { note: 'The host of the linking page. Most visits arrive without one.' })}
    ${table('Campaigns', tops.src, { note: 'The utm_source or ref parameter of the link.' })}
    ${table('Countries', tops.country, { label: countryName })}
    ${table('Devices', tops.device)}
    ${table('Browsers', tops.browser)}
    ${table('Operating systems', tops.os)}
    ${table('Download clicks on iskra.foo', tops.download, { note: 'Clicks on the download links of the home page.' })}
    ${releaseTable(gh)}
  </div>
</main>
</body>
</html>
`
}

// ── Entry ──

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    if (url.pathname === '/stats' || url.pathname === '/stats/') return stats(request, url, env)
    if (url.pathname === '/count/download') return downloadClick(request, url, env, ctx)
    const response = await env.ASSETS.fetch(request)
    try {
      const pairs = env.DB ? pageView(request, url, response) : []
      if (pairs.length) ctx.waitUntil(count(env, pairs))
    } catch { /* statistics are best effort */ }
    return response
  },
  // For scripts/site-worker.test.mjs.
  internals: { isBot, device, browser, os, referrerHost, campaign, downloadName, pageView, sameSecret, readCounts, niceMax, SCHEMA },
}
