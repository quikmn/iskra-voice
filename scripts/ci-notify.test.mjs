import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkWebhook, main, payload, verdict } from './ci-notify.mjs'

const HOOK = 'https://chat.example.test/hooks/abc123/s3cr3t-value'
const ENV = {
  ISKRA_CI_WEBHOOK: HOOK, GITHUB_REF_NAME: 'main', GITHUB_SHA: '0123456789abcdef0123456789abcdef01234567',
  GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'quikmn/iskra-voice', GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1',
}
const green = { server: { result: 'success' }, client: { result: 'success' }, 'end-to-end': { result: 'success' } }

test('only Iskra webhook URLs over HTTPS', () => {
  assert.ok(checkWebhook(HOOK))
  assert.ok(checkWebhook('https://chat.iskra.foo:8443/hooks/a/b'))
  for (const bad of ['http://chat.example.test/hooks/a/b', 'https://x.test/api/webhooks/a/b', 'https://u:p@x.test/hooks/a/b', 'https://x.test/hooks/a', 'nope', ''])
    assert.equal(checkWebhook(bad), false, bad)
})

test('the verdict: a failure wins, then cancelled; skipped jobs do not count', () => {
  assert.deepEqual(verdict(green), { result: 'success', failed: [] })
  assert.deepEqual(verdict({ ...green, client: { result: 'failure' }, android: { result: 'skipped' } }), { result: 'failure', failed: ['client'] })
  assert.deepEqual(verdict({ ...green, desktop: { result: 'cancelled' } }), { result: 'cancelled', failed: ['desktop'] })
  assert.deepEqual(verdict({ a: { result: 'skipped' } }), { result: 'skipped', failed: [] })
})

test('the message: branch, short commit, pass or fail, the run link, nothing else', () => {
  const pass = payload({ kind: 'ci', needs: green, env: ENV })
  assert.deepEqual(pass, {
    username: 'Iskra CI',
    embeds: [{ title: 'CI passed on main', url: 'https://github.com/quikmn/iskra-voice/actions/runs/42', description: 'Commit 0123456789', color: 0x3ba55d }],
  })
  const fail = payload({ kind: 'ci', needs: { ...green, server: { result: 'failure' } }, env: { ...ENV, GITHUB_RUN_ATTEMPT: '2' } })
  assert.equal(fail.embeds[0].title, 'CI failed on main')
  assert.equal(fail.embeds[0].description, 'Commit 0123456789\nFailed: server')
  assert.equal(fail.embeds[0].url, 'https://github.com/quikmn/iskra-voice/actions/runs/42/attempts/2')
  assert.ok(!JSON.stringify(fail).includes('s3cr3t'), 'never the webhook secret')

  const rel = payload({ kind: 'release', needs: { publish: { result: 'success' }, deploy: { result: 'success' } }, env: { ...ENV, TAG: 'v2.0.0-alpha.17', COMMIT: 'fedcba9876543210' } })
  assert.equal(rel.username, 'Iskra releases')
  assert.equal(rel.embeds[0].description, 'Commit fedcba9876', "the tag's commit, not main's")
  assert.equal(rel.embeds[0].title, 'Release v2.0.0-alpha.17 published and deployed')
  assert.equal(payload({ kind: 'release', needs: { publish: { result: 'success' }, deploy: { result: 'skipped' } }, env: { ...ENV, TAG: 'v2' } }).embeds[0].title, 'Release v2 published')
  const relFail = payload({ kind: 'release', needs: { publish: { result: 'failure' }, deploy: { result: 'skipped' } }, env: { ...ENV, TAG: 'v2' } })
  assert.equal(relFail.embeds[0].title, 'Release v2: failed')
  assert.equal(relFail.embeds[0].description, 'Failed: publish')
})

test('posts once to the webhook; no secret, a bad URL or a failing server never fail the run or print the URL', async () => {
  const posts = []
  const ok = async (url, init) => { posts.push({ url, init }); return new Response(null, { status: 204 }) }
  const out = []
  assert.equal(await main(['ci'], { env: { ...ENV, NEEDS: JSON.stringify(green) }, fetchImpl: ok, print: (l) => out.push(l) }), 0)
  assert.equal(posts.length, 1)
  assert.equal(posts[0].url, HOOK)
  assert.equal(posts[0].init.method, 'POST')
  assert.equal(posts[0].init.headers['content-type'], 'application/json')
  assert.equal(JSON.parse(posts[0].init.body).embeds[0].title, 'CI passed on main')
  assert.deepEqual(out, ['Posted to Iskra: CI passed on main'])

  const cases = [
    [{ ...ENV, ISKRA_CI_WEBHOOK: '' }, ok, /No ISKRA_CI_WEBHOOK secret/],
    [{ ...ENV, ISKRA_CI_WEBHOOK: 'http://x.test/hooks/a/b' }, ok, /isn't an Iskra webhook URL/],
    [{ ...ENV, NEEDS: '{' }, ok, /NEEDS isn't JSON/],
    [ENV, async () => new Response('', { status: 404 }), /answered 404/],
    [ENV, async () => { throw new TypeError('fetch failed: getaddrinfo ENOTFOUND chat.example.test/hooks/abc123/s3cr3t-value') }, /network error/],
  ]
  for (const [env, fetchImpl, message] of cases) {
    const lines = []
    const before = posts.length
    assert.equal(await main(['ci'], { env, fetchImpl, print: (l) => lines.push(l) }), 0)
    assert.match(lines.join('\n'), message)
    assert.ok(!lines.join('\n').includes('s3cr3t'), 'the URL is never printed')
    if (fetchImpl === ok) assert.equal(posts.length, before, 'nothing posted')
  }
  assert.equal(await main(['nope'], { env: ENV, fetchImpl: ok, print: () => {} }), 1)
})
