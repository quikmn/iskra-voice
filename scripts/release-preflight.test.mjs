import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { ciCommit, nameFindings, nextVersion, releaseFindings, requiredNames, reviewerFindings, storeProblems } from './release-preflight.mjs'

const store = () => JSON.parse(readFileSync(new URL('../mobile/store.json', import.meta.url), 'utf8'))

test('the next version is the next alpha after the newest of the latest release and package.json', () => {
  assert.equal(nextVersion('v2.0.0-alpha.16', '2.0.0-alpha.16'), '2.0.0-alpha.17')
  assert.equal(nextVersion('v2.0.0-alpha.9', '2.0.0-alpha.10'), '2.0.0-alpha.11')
  assert.equal(nextVersion('', '2.0.0-alpha.3'), '2.0.0-alpha.4')
  assert.equal(nextVersion('v2.0.0', '2.0.0'), null, 'after a final release the human picks the version')
  assert.equal(nextVersion('nonsense', 'also'), null)
})

test("the repo's mobile/store.json is valid", () => {
  assert.deepEqual(storeProblems(store()), [])
})

test('store.json mistakes are reported', () => {
  const s = store()
  s.ios.mode = 'testfligth'
  s.android.track = ''
  s.android.rollout = 0
  s.android.listing = 'yes'
  s.android.dataSafety = true
  const p = storeProblems(s, () => false)
  assert.ok(p.some((x) => x.includes('ios.mode')))
  assert.ok(p.some((x) => x.includes('android.track')))
  assert.ok(p.some((x) => x.includes('android.rollout')))
  assert.ok(p.some((x) => x.includes('android.listing')))
  assert.ok(p.some((x) => x.includes('data-safety.csv')))
  assert.deepEqual(storeProblems(null), ['mobile/store.json is not a JSON object'])
  const staged = store()
  staged.android.rollout = 0.2
  assert.ok(storeProblems(staged).some((x) => x.includes('production track')))
  staged.android.track = 'production'
  assert.deepEqual(storeProblems(staged), [])
})

const allHave = { secrets: ['MAC_CERT_P12_BASE64', 'MAC_CERT_PASSWORD', 'APPSTORE_API_KEY_BASE64', 'APPSTORE_KEY_ID', 'APPSTORE_ISSUER_ID', 'APPSTORE_REVIEW_PHONE'], envSecrets: ['CLOUDFLARE_API_TOKEN', 'DROPLET_SSH_KEY'], variables: ['CLOUDFLARE_ACCOUNT_ID', 'DROPLET_HOST', 'DROPLET_KNOWN_HOSTS', 'MAC_IDENTITY', 'REVIEW_INVITE_URL'] }

test('every needed secret and variable there: green', () => {
  const s = store()
  const f = nameFindings(requiredNames(s), allHave, s)
  assert.deepEqual(f.map((x) => x.level), ['ok'])
})

test('a missing secret or variable is red; deploy secrets may be repo or environment secrets', () => {
  const s = store()
  const have = { ...allHave, secrets: allHave.secrets.filter((n) => n !== 'APPSTORE_KEY_ID'), variables: allHave.variables.filter((n) => n !== 'DROPLET_HOST') }
  const reds = nameFindings(requiredNames(s), have, s).filter((x) => x.level === 'red').map((x) => x.text)
  assert.equal(reds.length, 2)
  assert.ok(reds[0].includes('APPSTORE_KEY_ID'))
  assert.ok(reds[1].includes('DROPLET_HOST'))
  const repoLevel = { ...allHave, secrets: [...allHave.secrets, 'CLOUDFLARE_API_TOKEN', 'DROPLET_SSH_KEY'], envSecrets: [] }
  assert.ok(nameFindings(requiredNames(s), repoLevel, s).every((x) => x.level !== 'red'))
  const none = { ...allHave, envSecrets: [] }
  assert.equal(nameFindings(requiredNames(s), none, s).filter((x) => x.level === 'red').length, 2)
})

test('REVIEW_INVITE_URL: required for the App Store (phase B), a warning for TestFlight, ignored with -SkipPhones', () => {
  const have = { ...allHave, variables: allHave.variables.filter((n) => n !== 'REVIEW_INVITE_URL') }
  const b = store(); b.ios.mode = 'appstore'
  assert.ok(nameFindings(requiredNames(b), have, b).some((x) => x.level === 'red' && x.text.includes('REVIEW_INVITE_URL')))
  const a = store(); a.ios.mode = 'testflight'
  const fa = nameFindings(requiredNames(a), have, a)
  assert.ok(fa.some((x) => x.level === 'warn' && x.text.includes('REVIEW_INVITE_URL')))
  assert.ok(!fa.some((x) => x.level === 'red'))
  const skip = nameFindings(requiredNames(b, { skipPhones: true }), have, b, { skipPhones: true })
  assert.ok(!skip.some((x) => x.text.includes('REVIEW_INVITE_URL')))
})

test('environments with required reviewers get a warning with the setting to change', () => {
  const envs = [
    { name: 'release', protection_rules: [{ type: 'branch_policy' }] },
    { name: 'npm', protection_rules: [{ type: 'required_reviewers', reviewers: [] }] },
    { name: 'marketplace' },
  ]
  const w = reviewerFindings(envs)
  assert.equal(w.length, 1)
  assert.equal(w[0].level, 'warn')
  assert.match(w[0].text, /environment "npm".*Settings → Environments → npm/)
  assert.deepEqual(reviewerFindings(undefined), [])
})

// ── The Release workflow's checks (release-preflight.mjs release) ──

const facts = (change = {}) => ({
  current: '2.0.0-alpha.17', version: '2.0.0-alpha.18',
  workflows: { 'ci.yml': 'active', 'release.yml': 'active' },
  tagExists: false, releaseExists: false,
  notes: { code: 0 }, bump: { code: 0, siteCount: 24, links: true }, assets: { listed: 23, want: 23 },
  store: [], names: [{ level: 'ok', text: 'names ok' }], ci: { ok: true, message: 'CI passed: https://x' },
  ...change,
})
const reds = (f) => releaseFindings(f).filter((x) => x.level === 'red').map((x) => x.text)

test('Release workflow checks: all green', () => {
  assert.deepEqual(reds(facts()), [])
  assert.ok(releaseFindings(facts()).some((x) => x.text === 'CI passed: https://x'))
})

test('Release workflow checks: every red is listed, each with its case', () => {
  const r = reds(facts({
    workflows: { 'ci.yml': 'active', 'deploy.yml': 'disabled_manually' }, tagExists: true, releaseExists: true, version: '2.0.0-alpha.17',
    notes: { code: 1, message: 'docs/releases/NEXT.md has no changes.' }, bump: { code: 0, siteCount: 3, links: true }, assets: { listed: 22, want: 23 },
    store: ['mobile/store.json ios.mode is "x"'], names: [{ level: 'red', text: 'secret MAC_CERT_PASSWORD is missing' }, { level: 'warn', text: 'w' }],
    ci: { ok: false, message: 'CI concluded failure on this commit: https://y' },
  }))
  for (const want of [/^\[workflow off\] .*deploy\.yml \(disabled_manually\)/, /^\[tag v2\.0\.0-alpha\.17 already exists\]/, /^\[a release v2\.0\.0-alpha\.17 already exists\]/,
    /^\[must be newer than the current version\]/, /^\[write the release notes first\] docs\/releases\/NEXT\.md has no changes\. Add/, /^\[site download section\] .*3 links/,
    /^\[release file list\] .*22 files/, /^\[store setup\]/, /^\[GitHub setup\] secret MAC_CERT_PASSWORD/, /^\[CI failed on main\] CI concluded failure/]) {
    assert.ok(r.some((t) => want.test(t)), `${want} in ${r.join('\n')}`)
  }
  assert.match(reds(facts({ ci: { ok: false, timedOut: true, message: 'no green CI run' } }))[0], /^\[CI not done\]/)
  assert.match(reds(facts({ bump: { code: 1, message: "client/src/links.ts doesn't mention 2.0.0-alpha.17." } }))[0], /^\[doesn't mention the current version\]/)
  assert.equal(reds(facts({ versionError: "can't pick the next version" })).length, 1, 'no version: nothing else to check')
})

test('the commit CI must have passed on skips newer docs-only commits, like CI does', () => {
  const files = { a: ['docs/x.md'], b: ['site/index.html', 'README.md'], c: ['server/x.cs'], d: ['client/y.ts'] }
  assert.equal(ciCommit(['a', 'b', 'c', 'd'], () => false, (c) => files[c]), 'c')
  assert.equal(ciCommit(['a', 'b', 'c'], (c) => c === 'b', (c) => files[c]), 'b', 'a commit CI ran on counts')
  assert.equal(ciCommit(['d', 'c'], () => false, (c) => files[c]), 'd')
})
