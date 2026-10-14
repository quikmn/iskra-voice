import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { nameFindings, nextVersion, requiredNames, reviewerFindings, storeProblems } from './release-preflight.mjs'

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
