#!/usr/bin/env node
// Renewal warnings (docs/ci-cd.md, "Renewal warnings"): reads docs/renewals.json, the one list of everything that
// expires, works out the days left (live for the TLS certificates, the domain and security.txt), prints a report and,
// with --post, sends warnings to the #renewals channel through the Iskra webhook ISKRA_RENEWALS_WEBHOOK.
//
//   node scripts/renewals.mjs                     # report only
//   node scripts/renewals.mjs --post              # report, then post if something is due (renewals.yml, daily)
//   node scripts/renewals.mjs --post --digest     # post the full list whatever the date
//   node scripts/renewals.mjs --today 2027-04-12  # pretend it's another day (UTC)
//
// Posts when an item is exactly at one of its warnDays, within 7 days (daily), overdue (daily) or can't be read
// (daily); on the 1st of the month (UTC) a digest lists everything, including entries whose date is still unknown.
// Exit code 1 (a red run) when anything is overdue or a live check can't be read. Without the secret it says so and
// posts nothing. Never prints the webhook URL. No dependencies: Node's fetch and tls.
import { readFileSync, appendFileSync } from 'node:fs'
import { connect } from 'node:tls'
import { fileURLToPath } from 'node:url'
import { resolve, dirname, join } from 'node:path'
import { checkWebhook } from './ci-notify.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG = join(ROOT, 'docs', 'renewals.json')
const DAY = 86_400_000
const DAILY_WITHIN = 7
const RED = 0xed4245
const ORANGE = 0xf0a020
const GREEN = 0x3ba55d

// ── dates (UTC days) ──

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

/** A YYYY-MM-DD string as UTC midnight in ms; throws on anything else (including 2027-02-30). */
export function parseDay(s) {
  if (typeof s !== 'string' || !ISO_DAY.test(s)) throw new Error(`not a YYYY-MM-DD date: ${s}`)
  const ms = Date.parse(`${s}T00:00:00Z`)
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== s) throw new Error(`not a real date: ${s}`)
  return ms
}

/** The UTC day of a Date (or anything Date takes) as YYYY-MM-DD. */
export const toDay = (d) => new Date(d).toISOString().slice(0, 10)

/** Whole days from today until the expiry day: 0 = expires today, negative = overdue. */
export const daysLeft = (expires, today) => Math.round((parseDay(expires) - parseDay(today)) / DAY)

/** Why an item with `days` left should be posted today, or null: overdue, soon (daily within 7 days), threshold. */
export function postReason(days, warnDays) {
  if (days < 0) return 'overdue'
  if (days <= DAILY_WITHIN) return 'soon'
  if (warnDays.includes(days)) return 'threshold'
  return null
}

/** The monthly digest goes out on the 1st (UTC), or when forced. */
export const isDigestDay = (today, force = false) => force || today.endsWith('-01')

// ── live checks ──

/** The expiration event of an RDAP domain answer, as YYYY-MM-DD. */
export function parseRdap(json) {
  const ev = (json?.events ?? []).find((e) => e?.eventAction === 'expiration')
  if (!ev?.eventDate || Number.isNaN(Date.parse(ev.eventDate))) throw new Error('no expiration event in the RDAP answer')
  return toDay(ev.eventDate)
}

/** The Expires field of a security.txt (RFC 9116), as YYYY-MM-DD. */
export function parseSecurityTxt(text) {
  const m = /^Expires:\s*(\S+)\s*$/im.exec(String(text))
  if (!m || Number.isNaN(Date.parse(m[1]))) throw new Error('no Expires field')
  return toDay(m[1])
}

async function getJson(fetchImpl, url) {
  const res = await fetchImpl(url, { headers: { accept: 'application/rdap+json, application/json' }, redirect: 'follow', signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

/** The domain's expiry from the .foo registry's RDAP server, with rdap.org (the bootstrap redirector) as a fallback. */
export async function rdapExpiry(domain, { fetchImpl = fetch } = {}) {
  let last
  for (const url of [`https://pubapi.registry.google/rdap/domain/${domain}`, `https://rdap.org/domain/${domain}`]) {
    try { return parseRdap(await getJson(fetchImpl, url)) } catch (e) { last = e }
  }
  throw last
}

export async function securityTxtExpiry(url, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${url}?renewals=${Date.now()}`, { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return parseSecurityTxt(await res.text())
}

/** The notAfter day of the certificate host:443 serves (read even when it has expired: that's what we report). */
export function tlsExpiry(host, { connectImpl = connect } = {}) {
  return new Promise((resolveP, reject) => {
    const socket = connectImpl({ host, port: 443, servername: host, rejectUnauthorized: false, timeout: 20_000 })
    const fail = (e) => { socket.destroy(); reject(e) }
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate()
      socket.end()
      if (!cert?.valid_to || Number.isNaN(Date.parse(cert.valid_to))) return reject(new Error('no certificate'))
      resolveP(toDay(Date.parse(cert.valid_to)))
    })
    socket.once('timeout', () => fail(new Error('timed out')))
    socket.once('error', fail)
  })
}

const CHECKS = {
  tls: (c, io) => tlsExpiry(c.host, io),
  rdap: (c, io) => rdapExpiry(c.domain, io),
  securitytxt: (c, io) => securityTxtExpiry(c.url, io),
}

async function withRetries(fn, tries, pauseMs) {
  for (let i = 1; ; i++) {
    try { return await fn() } catch (e) {
      if (i >= tries) throw e
      await new Promise((r) => setTimeout(r, pauseMs))
    }
  }
}

// ── evaluation ──

/** Checks the config's shape; returns a list of problems (empty when fine). */
export function validate(config) {
  const problems = []
  const ids = new Set()
  for (const it of config?.items ?? []) {
    const at = it?.id ?? '(no id)'
    if (!it?.id || ids.has(it.id)) problems.push(`${at}: missing or duplicate id`)
    ids.add(it?.id)
    for (const k of ['name', 'renew', 'doc']) if (!it?.[k]) problems.push(`${at}: no ${k}`)
    if (it?.check) {
      if (!CHECKS[it.check.type]) problems.push(`${at}: unknown check ${it.check.type}`)
    } else if (it?.expires === null) {
      if (!it.note) problems.push(`${at}: expires null needs a note`)
    } else {
      try { parseDay(it?.expires) } catch (e) { problems.push(`${at}: ${e.message}`) }
    }
    if (it?.warnDays && !(Array.isArray(it.warnDays) && it.warnDays.every((d) => Number.isInteger(d) && d > 0))) problems.push(`${at}: warnDays must be positive whole days`)
  }
  if (!ids.size) problems.push('no items')
  return problems
}

/**
 * One result per item: { item, expires, days, status, reason, error }. status: ok, due (posted today), overdue,
 * missing (no date yet), error (a live check failed).
 */
export async function evaluate(config, { today, io = {}, tries = 3, pauseMs = 5000 } = {}) {
  const defaults = config.warnDays ?? [30, 14, 7, 1]
  return Promise.all(config.items.map(async (item) => {
    const warnDays = item.warnDays ?? defaults
    let expires = item.expires ?? null
    if (item.check) {
      try {
        expires = await withRetries(() => CHECKS[item.check.type](item.check, io), tries, pauseMs)
      } catch (e) {
        return { item, expires: null, days: null, status: 'error', reason: 'error', error: e?.message || String(e) }
      }
    }
    if (!expires) return { item, expires: null, days: null, status: 'missing', reason: null }
    const days = daysLeft(expires, today)
    const reason = postReason(days, warnDays)
    return { item, expires, days, status: reason === 'overdue' ? 'overdue' : reason ? 'due' : 'ok', reason }
  }))
}

const ORDER = { error: 0, overdue: 1, due: 2, ok: 3, missing: 4 }
const sorted = (results) => [...results].sort((a, b) => ORDER[a.status] - ORDER[b.status] || (a.days ?? 1e9) - (b.days ?? 1e9))

export function docUrl(doc, env = {}) {
  if (/^https?:\/\//.test(doc)) return doc
  return `${env.GITHUB_SERVER_URL || 'https://github.com'}/${env.GITHUB_REPOSITORY || 'quikmn/iskra-voice'}/blob/main/${doc}`
}

function when(r) {
  if (r.status === 'error') return `couldn't be read (${r.error})`
  if (r.status === 'missing') return r.item.note || 'date unknown'
  if (r.days < 0) return `${r.expires}, OVERDUE by ${-r.days} day${r.days === -1 ? '' : 's'}`
  if (r.days === 0) return `${r.expires}, expires TODAY`
  return `${r.expires}, ${r.days} day${r.days === 1 ? '' : 's'} left`
}

/** One line per item: name, date, days left, how to renew, the doc link. */
export const line = (r, env) => `${r.item.name}: ${when(r)}. Renew: ${r.item.renew}. ${docUrl(r.item.doc, env)}`

/** What to post today, or null for a quiet day. Daily: only what's due, overdue or unreadable; the digest: everything. */
export function message(results, { today, digest, env = {} }) {
  const pressing = sorted(results.filter((r) => r.reason))
  if (!digest && !pressing.length) return null
  const shown = digest ? sorted(results) : pressing
  const count = (s) => results.filter((r) => r.status === s).length
  const parts = [[count('overdue'), 'overdue'], [count('error'), "can't be read"], [count('due'), 'due soon'], ...(digest ? [[count('missing'), 'missing date']] : [])]
    .filter(([n]) => n).map(([n, w]) => `${n} ${w}`)
  const title = `${digest ? `Renewals digest ${today}` : 'Renewals'}${parts.length ? `: ${parts.join(', ')}` : ': nothing due'}`
  let description = ''
  for (const [i, r] of shown.entries()) {
    const next = `- ${line(r, env)}\n`
    if (description.length + next.length > 3900) { description += `… and ${shown.length - i} more (see the run)`; break }
    description += next
  }
  const color = count('overdue') || count('error') ? RED : pressing.length ? ORANGE : GREEN
  return { username: 'Iskra renewals', embeds: [{ title: title.slice(0, 256), description: description.trimEnd(), color }] }
}

export function report(results, today) {
  const rows = sorted(results).map((r) => `${r.status.padEnd(8)} ${line(r)}`)
  return [`Renewals on ${today} (UTC):`, ...rows].join('\n')
}

// ── main ──

export async function main(argv, { env = process.env, io = {}, now = new Date(), print = console.log, config, tries, pauseMs } = {}) {
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
  const today = arg('--today') ?? toDay(now)
  try { parseDay(today) } catch (e) { print(e.message); return 2 }
  config ??= JSON.parse(readFileSync(CONFIG, 'utf8'))
  const problems = validate(config)
  if (problems.length) { print(`::error::docs/renewals.json: ${problems.join('; ')}`); return 1 }

  const results = await evaluate(config, { today, io, tries, pauseMs })
  const text = report(results, today)
  print(text)
  if (env.GITHUB_STEP_SUMMARY) { try { appendFileSync(env.GITHUB_STEP_SUMMARY, `\`\`\`\n${text}\n\`\`\`\n`) } catch { /* the summary is a courtesy */ } }

  const bad = sorted(results).filter((r) => r.status === 'overdue' || r.status === 'error')
  for (const r of bad) print(`::error::${r.item.name}: ${when(r)}`)

  if (argv.includes('--post')) {
    const digest = isDigestDay(today, argv.includes('--digest') || env.RENEWALS_DIGEST === 'true')
    const body = message(results, { today, digest, env })
    const url = env.ISKRA_RENEWALS_WEBHOOK
    if (!body) print('Nothing due today: not posting.')
    else if (!url) print('ISKRA_RENEWALS_WEBHOOK not set, not posting.')
    else if (!checkWebhook(url)) print("::warning::ISKRA_RENEWALS_WEBHOOK isn't an Iskra webhook URL (https://<server>/hooks/<id>/<secret>); not posting.")
    else {
      try {
        const res = await (io.fetchImpl ?? fetch)(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) })
        if (res.ok) print(`Posted to #renewals: ${body.embeds[0].title}`)
        else print(`::warning::The Iskra webhook answered ${res.status}; nothing was posted.`)
      } catch (e) {
        print(`::warning::Couldn't reach the Iskra webhook (${e?.name === 'TimeoutError' ? 'timed out' : 'network error'}); nothing was posted.`)
      }
    }
  }
  return bad.length ? 1 : 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2))
}
