import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkWebhook, main, payload, verdict, worthPosting } from './ci-notify.mjs'

const HOOK = 'https://chat.example.test/hooks/abc123/s3cr3t-value'
const ENV = {
  ISKRA_CI_WEBHOOK: HOOK, GITHUB_REF_NAME: 'main', GITHUB_SHA: '0123456789abcdef0123456789abcdef01234567',
  GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'quikmn/iskra-voice', GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1',
}
const green = { server: { result: 'success' }, client: { result: 'success' }, 'end-to-end': { result: 'success' } }
const red = { ...green, server: { result: 'failure' } }
const FLAKY = 'hosting.spec.ts:240 › no router\nafk.spec.ts:12 › afk moves you (1 of 3)\n'

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

test("posts only what GitHub's own run message doesn't say: failures, and flaky tests on a pass", () => {
  // GitHub's workflow_run event already says "passed": a plain pass, a cancelled or a skipped run post nothing.
  assert.equal(worthPosting({ kind: 'ci', needs: green, env: ENV }), false)
  assert.equal(worthPosting({ kind: 'ci', needs: green, env: { ...ENV, E2E_FLAKY: '\n' } }), false)
  assert.equal(worthPosting({ kind: 'ci', needs: { ...green, client: { result: 'cancelled' } }, env: { ...ENV, E2E_FLAKY: FLAKY } }), false)
  assert.equal(worthPosting({ kind: 'ci', needs: { a: { result: 'skipped' } }, env: ENV }), false)
  assert.equal(worthPosting({ kind: 'ci', needs: green, env: { ...ENV, E2E_FLAKY: FLAKY } }), true)
  assert.equal(worthPosting({ kind: 'ci', needs: red, env: ENV }), true, 'which jobs failed')
  // The nightly stress run: only when it found failed or flaky tests.
  assert.equal(worthPosting({ kind: 'stress', needs: { shard: { result: 'success' } }, env: ENV }), false)
  assert.equal(worthPosting({ kind: 'stress', needs: { shard: { result: 'failure' } }, env: ENV }), false, 'a broken setup step: GitHub says it')
  assert.equal(worthPosting({ kind: 'stress', needs: { shard: { result: 'success' } }, env: { ...ENV, E2E_FLAKY: FLAKY } }), true)
  assert.equal(worthPosting({ kind: 'stress', needs: { shard: { result: 'failure' } }, env: { ...ENV, E2E_FAILED: 'a.spec.ts:1 › a' } }), true)
})

test('the message: branch, short commit, failed jobs and tests, flaky tests, the run link, nothing else', () => {
  const pass = payload({ kind: 'ci', needs: green, env: { ...ENV, E2E_FLAKY: FLAKY } })
  assert.deepEqual(pass, {
    username: 'Iskra CI',
    embeds: [{
      title: 'CI passed on main, 2 flaky', url: 'https://github.com/quikmn/iskra-voice/actions/runs/42', color: 0x3ba55d,
      description: 'Commit 0123456789\nFlaky (passed on retry): hosting.spec.ts:240 › no router; afk.spec.ts:12 › afk moves you (1 of 3)',
    }],
  })
  const fail = payload({ kind: 'ci', needs: { ...red, 'end-to-end': { result: 'failure' } }, env: { ...ENV, GITHUB_RUN_ATTEMPT: '2', E2E_FAILED: 'calls.spec.ts:9 › a call', E2E_FLAKY: FLAKY } })
  assert.equal(fail.embeds[0].title, 'CI failed on main')
  assert.match(fail.embeds[0].description, /^Commit 0123456789\nFailed: server, end-to-end\nFailed tests: calls\.spec\.ts:9 › a call\nFlaky \(passed on retry\): /)
  assert.equal(fail.embeds[0].url, 'https://github.com/quikmn/iskra-voice/actions/runs/42/attempts/2')
  assert.ok(!JSON.stringify(fail).includes('s3cr3t'), 'never the webhook secret')

  const many = Array.from({ length: 8 }, (_, i) => `t${i}.spec.ts:1 › t`).join('\n')
  assert.match(payload({ kind: 'ci', needs: green, env: { ...ENV, E2E_FLAKY: many } }).embeds[0].description, /t4\.spec\.ts:1 › t; and 3 more$/)
  assert.ok(payload({ kind: 'ci', needs: green, env: { ...ENV, E2E_FLAKY: 'x'.repeat(5000) } }).embeds[0].description.length <= 1000)

  const shard = (result) => ({ shard: { result } })
  assert.equal(payload({ kind: 'stress', needs: shard('success'), env: { ...ENV, E2E_FLAKY: 'a.spec.ts:1 › a (1 of 3)' } }).embeds[0].title, 'Nightly end-to-end stress passed on main, 1 flaky')
  assert.equal(payload({ kind: 'stress', needs: shard('failure'), env: ENV }).embeds[0].title, 'Nightly end-to-end stress failed on main')
})

test('posts once to the webhook; no secret, nothing to say, a bad URL or a failing server never fail the run or print the URL', async () => {
  const posts = []
  const ok = async (url, init) => { posts.push({ url, init }); return new Response(null, { status: 204 }) }
  const out = []
  assert.equal(await main(['ci'], { env: { ...ENV, NEEDS: JSON.stringify(red) }, fetchImpl: ok, print: (l) => out.push(l) }), 0)
  assert.equal(posts.length, 1)
  assert.equal(posts[0].url, HOOK)
  assert.equal(posts[0].init.method, 'POST')
  assert.equal(posts[0].init.headers['content-type'], 'application/json')
  assert.equal(JSON.parse(posts[0].init.body).embeds[0].title, 'CI failed on main')
  assert.deepEqual(out, ['Posted to Iskra: CI failed on main'])

  const failing = { ...ENV, NEEDS: JSON.stringify(red) }
  const cases = [
    [{ ...ENV, NEEDS: JSON.stringify(green) }, ok, /not posting/],
    [{ ...failing, ISKRA_CI_WEBHOOK: '' }, ok, /No ISKRA_CI_WEBHOOK secret/],
    [{ ...failing, ISKRA_CI_WEBHOOK: 'http://x.test/hooks/a/b' }, ok, /isn't an Iskra webhook URL/],
    [{ ...ENV, NEEDS: '{' }, ok, /NEEDS isn't JSON/],
    [failing, async () => new Response('', { status: 404 }), /answered 404/],
    [failing, async () => { throw new TypeError('fetch failed: getaddrinfo ENOTFOUND chat.example.test/hooks/abc123/s3cr3t-value') }, /network error/],
  ]
  for (const [env, fetchImpl, message] of cases) {
    const lines = []
    const before = posts.length
    assert.equal(await main(['ci'], { env, fetchImpl, print: (l) => lines.push(l) }), 0)
    assert.match(lines.join('\n'), message)
    assert.ok(!lines.join('\n').includes('s3cr3t'), 'the URL is never printed')
    if (fetchImpl === ok) assert.equal(posts.length, before, 'nothing posted')
  }
  assert.equal(await main(['release'], { env: ENV, fetchImpl: ok, print: () => {} }), 1, 'releases: GitHub says it all')
  assert.equal(await main(['nope'], { env: ENV, fetchImpl: ok, print: () => {} }), 1)
})
