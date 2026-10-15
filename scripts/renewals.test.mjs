import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  parseDay, toDay, daysLeft, postReason, isDigestDay, parseRdap, parseSecurityTxt, tlsExpiry, validate, evaluate, message, main,
} from './renewals.mjs'

const WARN = [30, 14, 7, 1]
const HOOK = 'https://chat.example/hooks/abc/def'
const item = (over) => ({ id: 'x', name: 'Thing', renew: 'Renew it', doc: 'docs/ci-cd.md#x', ...over })

test('dates: UTC days, real dates only, whole days left', () => {
  assert.equal(toDay(parseDay('2027-05-12')), '2027-05-12')
  assert.throws(() => parseDay('2027-02-30'))
  assert.throws(() => parseDay('2027-5-12'))
  assert.throws(() => parseDay(null))
  assert.equal(daysLeft('2027-05-12', '2027-05-12'), 0)
  assert.equal(daysLeft('2027-05-12', '2027-04-12'), 30)
  assert.equal(daysLeft('2027-05-12', '2027-05-13'), -1)
  assert.equal(daysLeft('2027-01-13', '2026-10-15'), 90)
  assert.equal(daysLeft('2028-03-01', '2028-02-28'), 2) // leap year
  assert.equal(daysLeft('2027-03-29', '2027-03-27'), 2) // DST doesn't matter in UTC
  assert.equal(toDay(new Date('2026-10-15T23:59:59Z')), '2026-10-15')
})

test('post rules: exactly at a threshold, daily within 7 days and when overdue, quiet otherwise', () => {
  assert.equal(postReason(30, WARN), 'threshold')
  assert.equal(postReason(14, WARN), 'threshold')
  assert.equal(postReason(29, WARN), null)
  assert.equal(postReason(15, WARN), null)
  assert.equal(postReason(8, WARN), null)
  for (const d of [7, 6, 3, 1, 0]) assert.equal(postReason(d, WARN), 'soon', `${d}`)
  assert.equal(postReason(-1, WARN), 'overdue')
  assert.equal(postReason(-400, WARN), 'overdue')
  assert.equal(postReason(45, [45, 30]), 'threshold')
  assert.equal(postReason(200, WARN), null)
})

test('the digest goes out on the 1st, or when forced', () => {
  assert.equal(isDigestDay('2026-11-01'), true)
  assert.equal(isDigestDay('2026-11-02'), false)
  assert.equal(isDigestDay('2026-11-10'), false)
  assert.equal(isDigestDay('2026-11-02', true), true)
})

test('RDAP and security.txt parsing', () => {
  assert.equal(parseRdap({ events: [{ eventAction: 'registration', eventDate: '2026-05-02T21:41:06Z' }, { eventAction: 'expiration', eventDate: '2027-05-02T21:41:06.334Z' }] }), '2027-05-02')
  assert.throws(() => parseRdap({ events: [{ eventAction: 'registration', eventDate: '2026-05-02T21:41:06Z' }] }))
  assert.throws(() => parseRdap(null))
  assert.equal(parseSecurityTxt('Contact: mailto:a@b\r\nExpires: 2027-10-01T00:00:00.000Z\r\n'), '2027-10-01')
  assert.throws(() => parseSecurityTxt('Contact: mailto:a@b\n'))
  assert.throws(() => parseSecurityTxt('Expires: soon\n'))
})

test('TLS: reads the certificate end date without trusting or sending anything', async () => {
  let opts
  const connectImpl = (o) => {
    opts = o
    const s = new EventEmitter()
    s.getPeerCertificate = () => ({ valid_to: 'Dec  1 12:00:00 2026 GMT' })
    s.end = () => {}
    s.destroy = () => {}
    setImmediate(() => s.emit('secureConnect'))
    return s
  }
  assert.equal(await tlsExpiry('app.iskra.foo', { connectImpl }), '2026-12-01')
  assert.equal(opts.servername, 'app.iskra.foo')
  const broken = () => { const s = new EventEmitter(); s.destroy = () => {}; setImmediate(() => s.emit('error', new Error('ECONNREFUSED'))); return s }
  await assert.rejects(tlsExpiry('x', { connectImpl: broken }), /ECONNREFUSED/)
})

test('the checked-in list is valid, and every date in it comes from the docs', () => {
  const config = JSON.parse(readFileSync(new URL('../docs/renewals.json', import.meta.url), 'utf8'))
  assert.deepEqual(validate(config), [])
  const docs = readFileSync(new URL('../docs/ci-cd.md', import.meta.url), 'utf8')
  for (const it of config.items) {
    if (it.expires) assert.ok(docs.includes(it.expires), `${it.id}: ${it.expires} is in docs/ci-cd.md`)
    assert.match(it.doc, /^docs\/ci-cd\.md#[a-z0-9-]+$/, it.id)
  }
  assert.deepEqual(validate({ items: [item({ expires: '2027-02-30' }), item({ expires: null }), item({ id: 'y', check: { type: 'nope' } })] }).length, 4)
})

test('evaluate: static dates, live checks, missing dates and failed checks', async () => {
  const config = {
    warnDays: WARN,
    items: [
      item({ id: 'a', name: 'A', expires: '2027-05-12' }),
      item({ id: 'b', name: 'B', expires: '2027-04-13' }),
      item({ id: 'c', name: 'C', expires: '2027-04-01' }),
      item({ id: 'd', name: 'D', expires: null, note: 'date unknown: owner to fill' }),
      item({ id: 'e', name: 'E', check: { type: 'securitytxt', url: 'https://x/.well-known/security.txt' } }),
      item({ id: 'f', name: 'F', check: { type: 'tls', host: 'nowhere.invalid' } }),
    ],
  }
  const fetchImpl = async () => new Response('Expires: 2027-04-15T00:00:00Z\n')
  const connectImpl = () => { const s = new EventEmitter(); s.destroy = () => {}; setImmediate(() => s.emit('error', new Error('ENOTFOUND'))); return s }
  const r = Object.fromEntries((await evaluate(config, { today: '2027-04-12', io: { fetchImpl, connectImpl }, tries: 2, pauseMs: 0 })).map((x) => [x.item.id, x]))
  assert.deepEqual([r.a.days, r.a.status, r.a.reason], [30, 'due', 'threshold'])
  assert.deepEqual([r.b.days, r.b.status], [1, 'due'])
  assert.deepEqual([r.c.days, r.c.status], [-11, 'overdue'])
  assert.equal(r.d.status, 'missing')
  assert.equal(r.d.reason, null)
  assert.deepEqual([r.e.expires, r.e.days, r.e.reason], ['2027-04-15', 3, 'soon'])
  assert.equal(r.f.status, 'error')
  assert.match(r.f.error, /ENOTFOUND/)
})

test('message: quiet days post nothing, the digest lists everything with the missing dates', () => {
  const res = (over) => ({ item: item(over.item ?? {}), expires: null, days: null, status: 'ok', reason: null, ...over })
  const ok = res({ expires: '2027-05-12', days: 200 })
  const missing = res({ item: { name: 'Membership', expires: null, note: 'date unknown: owner to fill' }, status: 'missing' })
  assert.equal(message([ok, missing], { today: '2026-10-15', digest: false }), null)

  const digest = message([ok, missing], { today: '2026-11-01', digest: true })
  assert.match(digest.embeds[0].title, /^Renewals digest 2026-11-01: 1 missing date$/)
  assert.match(digest.embeds[0].description, /Thing: 2027-05-12, 200 days left\. Renew: Renew it\. https:\/\/github\.com\/quikmn\/iskra-voice\/blob\/main\/docs\/ci-cd\.md#x/)
  assert.match(digest.embeds[0].description, /Membership: date unknown: owner to fill/)

  const due = res({ item: { name: 'Cert' }, expires: '2027-05-12', days: 30, status: 'due', reason: 'threshold' })
  const late = res({ item: { name: 'Token' }, expires: '2027-01-13', days: -2, status: 'overdue', reason: 'overdue' })
  const daily = message([ok, missing, due, late], { today: '2027-01-15', digest: false })
  assert.equal(daily.username, 'Iskra renewals')
  assert.equal(daily.embeds[0].title, 'Renewals: 1 overdue, 1 due soon')
  const lines = daily.embeds[0].description.split('\n')
  assert.equal(lines.length, 2) // only what's pressing
  assert.match(lines[0], /^- Token: 2027-01-13, OVERDUE by 2 days\./)
  assert.match(lines[1], /^- Cert: 2027-05-12, 30 days left\./)
  assert.equal(daily.embeds[0].color, 0xed4245)
})

test('main: no webhook says so and passes; overdue or unreadable fails; a post goes to the webhook', async () => {
  const out = []
  const print = (s) => out.push(s)
  const fine = { items: [item({ expires: '2027-04-19' })] } // 7 days from 2027-04-12: due
  assert.equal(await main(['--post', '--today', '2027-04-12'], { env: {}, print, config: fine }), 0)
  assert.ok(out.includes('ISKRA_RENEWALS_WEBHOOK not set, not posting.'))

  const posts = []
  const fetchImpl = async (url, init) => { posts.push({ url, body: JSON.parse(init.body) }); return new Response(null, { status: 204 }) }
  out.length = 0
  assert.equal(await main(['--post', '--today', '2027-04-12'], { env: { ISKRA_RENEWALS_WEBHOOK: HOOK }, io: { fetchImpl }, print, config: fine }), 0)
  assert.equal(posts.length, 1)
  assert.equal(posts[0].url, HOOK)
  assert.match(posts[0].body.embeds[0].description, /7 days left/)
  assert.ok(!out.join('\n').includes(HOOK), 'the webhook URL is never printed')

  posts.length = 0
  const quiet = { items: [item({ expires: '2027-04-20' })] }
  assert.equal(await main(['--post', '--today', '2027-04-12'], { env: { ISKRA_RENEWALS_WEBHOOK: HOOK }, io: { fetchImpl }, print, config: quiet }), 0)
  assert.equal(posts.length, 0)
  assert.equal(await main(['--post', '--digest', '--today', '2027-04-12'], { env: { ISKRA_RENEWALS_WEBHOOK: HOOK }, io: { fetchImpl }, print, config: quiet }), 0)
  assert.equal(posts.length, 1)

  const overdue = { items: [item({ expires: '2027-04-11' })] }
  assert.equal(await main(['--today', '2027-04-12'], { env: {}, print, config: overdue }), 1)
  const unreadable = { items: [item({ check: { type: 'securitytxt', url: 'https://x' } })] }
  const down = async () => new Response('nope', { status: 503 })
  assert.equal(await main(['--today', '2027-04-12'], { env: {}, io: { fetchImpl: down }, print, config: unreadable, tries: 1, pauseMs: 0 }), 1)

  // A failing webhook is a warning, not a red run.
  const failing = async () => { throw new TypeError('fetch failed') }
  out.length = 0
  assert.equal(await main(['--post', '--today', '2027-04-12'], { env: { ISKRA_RENEWALS_WEBHOOK: HOOK }, io: { fetchImpl: failing }, print, config: fine }), 0)
  assert.match(out.join('\n'), /::warning::Couldn't reach the Iskra webhook/)
})
