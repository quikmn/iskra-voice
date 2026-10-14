import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ascApi, loadMetadata, main, pickGroups, reviewNotes, run, storeConfig, whatsNew } from './appstore.mjs'

/**
 * A fake App Store Connect: resources by type and id, relationships kept as ids, and JSON:API answers like Apple's
 * (including its error shape). `opts` switch on the behaviour seen in real life.
 */
function fakeAsc({ processingAfter = 2, firstVersion = false, buildState = 'VALID', ageRatingFails = false } = {}) {
  let next = 1
  const id = () => String(next++)
  const db = {
    apps: [{ id: 'app1', attributes: { bundleId: 'foo.iskra.app' } }],
    builds: [],
    betaGroups: [
      { id: 'g-int', attributes: { name: 'Friends & family', isInternalGroup: true, hasAccessToAllBuilds: false } },
      { id: 'g-all', attributes: { name: 'Team', isInternalGroup: true, hasAccessToAllBuilds: true } },
      { id: 'g-ext', attributes: { name: 'Public testers', isInternalGroup: false, publicLinkId: 'r4tMgn3D' } },
    ],
    groupBuilds: {},
    betaBuildLocalizations: [],
    betaAppLocalizations: [{ id: 'bal-en', attributes: { locale: 'en-US' } }],
    betaAppReviewDetail: { id: 'bard', attributes: {} },
    betaReviews: [],
    versions: [],
    versionLocs: [],
    appInfos: [{ id: 'info1', attributes: { state: 'PREPARE_FOR_SUBMISSION' } }],
    appInfoLocs: [{ id: 'ail-en', attributes: { locale: 'en-US', name: 'Iskra' }, appInfo: 'info1' }],
    ageRating: { id: 'age1', attributes: {} },
    reviewDetails: [],
    sets: [],
    shots: [],
    uploads: [],
    submissions: [],
    items: [],
  }
  const calls = []
  let polls = 0
  const reply = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const err = (status, title, detail = '') => reply(status, { errors: [{ status: String(status), code: title.toUpperCase().replace(/\W+/g, '_'), title, detail }] })
  const data = (d) => reply(200, { data: d })
  async function fetchImpl(href, init) {
    const url = new URL(href)
    if (url.origin === 'https://upload.test') { db.uploads.push(url.pathname); assert.equal(init.method, 'PUT'); assert.ok(!init.headers.authorization, 'no token to the upload URL'); return reply(200) }
    assert.equal(url.origin, 'https://asc.test')
    assert.equal(init.headers.authorization, 'Bearer jwt')
    const m = init.method
    const p = url.pathname
    const body = init.body ? JSON.parse(init.body).data : undefined
    calls.push(`${m} ${p}`)
    const q = (k) => url.searchParams.get(k)
    let r
    if (m === 'GET' && p === '/v1/apps') return data(db.apps.filter((a) => a.attributes.bundleId === q('filter[bundleId]')))
    if (m === 'GET' && p === '/v1/builds') {
      polls++
      if (polls === 1) return data([])
      if (!db.builds.length) db.builds.push({ id: 'b1', attributes: { version: q('filter[version]'), processingState: 'PROCESSING', usesNonExemptEncryption: null } })
      if (polls >= processingAfter + 1) db.builds[0].attributes.processingState = buildState
      return data(db.builds)
    }
    if (m === 'PATCH' && p === '/v1/builds/b1') { Object.assign(db.builds[0].attributes, body.attributes); return data(db.builds[0]) }
    if (m === 'GET' && p === '/v1/builds/b1/betaBuildLocalizations') return data(db.betaBuildLocalizations)
    if (m === 'POST' && p === '/v1/betaBuildLocalizations') {
      if (body.attributes.locale === 'sv' && !db.betaAppLocalizations.some((l) => l.attributes.locale === 'sv')) return err(409, 'The provided entity includes an attribute with a value that has already been used', 'locale sv isn\'t set up for this app')
      r = { id: id(), attributes: body.attributes }; db.betaBuildLocalizations.push(r); return reply(201, { data: r })
    }
    if (m === 'PATCH' && (r = /^\/v1\/betaBuildLocalizations\/(.+)$/.exec(p))) { Object.assign(db.betaBuildLocalizations.find((l) => l.id === r[1]).attributes, body.attributes); return data({}) }
    if (m === 'GET' && p === '/v1/apps/app1/betaAppLocalizations') return data(db.betaAppLocalizations)
    if (m === 'PATCH' && (r = /^\/v1\/betaAppLocalizations\/(.+)$/.exec(p))) { Object.assign(db.betaAppLocalizations.find((l) => l.id === r[1]).attributes, body.attributes); return data({}) }
    if (m === 'POST' && p === '/v1/betaAppLocalizations') { db.betaAppLocalizations.push({ id: id(), attributes: body.attributes }); return reply(201, { data: {} }) }
    if (m === 'GET' && p === '/v1/apps/app1/betaAppReviewDetail') return data(db.betaAppReviewDetail)
    if (m === 'PATCH' && p === '/v1/betaAppReviewDetails/bard') { Object.assign(db.betaAppReviewDetail.attributes, body.attributes); return data({}) }
    if (m === 'GET' && p === '/v1/apps/app1/betaGroups') return data(db.betaGroups)
    if (m === 'POST' && (r = /^\/v1\/betaGroups\/(.+)\/relationships\/builds$/.exec(p))) {
      if (r[1] === 'g-all') return err(409, 'Cannot add builds to a group with access to all builds')
      ;(db.groupBuilds[r[1]] ??= new Set()).add(body[0].id); return reply(204)
    }
    if (m === 'GET' && p === '/v1/builds/b1/betaAppReviewSubmission') return db.betaReviews.length ? data(db.betaReviews[0]) : err(404, 'NOT_FOUND')
    if (m === 'POST' && p === '/v1/betaAppReviewSubmissions') { r = { id: id(), attributes: { betaReviewState: 'WAITING_FOR_REVIEW' } }; db.betaReviews.push(r); return reply(201, { data: r }) }
    // The App Store
    if (m === 'GET' && p === '/v1/apps/app1/appStoreVersions') return data(db.versions)
    if (m === 'POST' && p === '/v1/appStoreVersions') { r = { id: id(), attributes: { ...body.attributes, appVersionState: 'PREPARE_FOR_SUBMISSION' } }; db.versions.push(r); return reply(201, { data: r }) }
    if (m === 'PATCH' && (r = /^\/v1\/appStoreVersions\/([^/]+)$/.exec(p))) { Object.assign(db.versions.find((v) => v.id === r[1]).attributes, body.attributes); return data({}) }
    if (m === 'PATCH' && (r = /^\/v1\/appStoreVersions\/([^/]+)\/relationships\/build$/.exec(p))) { db.versions.find((v) => v.id === r[1]).build = body.id; return reply(204) }
    if (m === 'GET' && (r = /^\/v1\/appStoreVersions\/([^/]+)\/appStoreVersionLocalizations$/.exec(p))) return data(db.versionLocs.filter((l) => l.version === r[1]))
    if (m === 'POST' && p === '/v1/appStoreVersionLocalizations') {
      if (firstVersion && body.attributes.whatsNew) return err(409, 'An attribute value is not acceptable for the current resource state.', 'The attribute \'whatsNew\' can not be edited at this time')
      r = { id: id(), attributes: body.attributes, version: body.relationships.appStoreVersion.data.id }; db.versionLocs.push(r); return reply(201, { data: r })
    }
    if (m === 'PATCH' && (r = /^\/v1\/appStoreVersionLocalizations\/(.+)$/.exec(p))) { Object.assign(db.versionLocs.find((l) => l.id === r[1]).attributes, body.attributes); return data({}) }
    if (m === 'GET' && p === '/v1/apps/app1/appInfos') return data(db.appInfos)
    if (m === 'GET' && p === '/v1/appInfos/info1/appInfoLocalizations') return data(db.appInfoLocs)
    if (m === 'PATCH' && (r = /^\/v1\/appInfoLocalizations\/(.+)$/.exec(p))) { Object.assign(db.appInfoLocs.find((l) => l.id === r[1]).attributes, body.attributes); return data({}) }
    if (m === 'POST' && p === '/v1/appInfoLocalizations') { db.appInfoLocs.push({ id: id(), attributes: body.attributes }); return reply(201, { data: {} }) }
    if (m === 'GET' && p === '/v1/appInfos/info1/ageRatingDeclaration') return data(db.ageRating)
    if (m === 'PATCH' && p === '/v1/ageRatingDeclarations/age1') { if (ageRatingFails) return err(409, 'ENTITY_ERROR.ATTRIBUTE.UNKNOWN', "'gunsOrOtherWeapons' is not a valid attribute"); Object.assign(db.ageRating.attributes, body.attributes); return data({}) }
    if (m === 'GET' && (r = /^\/v1\/appStoreVersions\/([^/]+)\/appStoreReviewDetail$/.exec(p))) { const d = db.reviewDetails.find((x) => x.version === r[1]); return d ? data(d) : err(404, 'NOT_FOUND') }
    if (m === 'POST' && p === '/v1/appStoreReviewDetails') { db.reviewDetails.push({ id: id(), attributes: body.attributes, version: body.relationships.appStoreVersion.data.id }); return reply(201, { data: {} }) }
    if (m === 'PATCH' && (r = /^\/v1\/appStoreReviewDetails\/(.+)$/.exec(p))) { Object.assign(db.reviewDetails.find((x) => x.id === r[1]).attributes, body.attributes); return data({}) }
    if (m === 'GET' && (r = /^\/v1\/appStoreVersionLocalizations\/([^/]+)\/appScreenshotSets$/.exec(p))) return data(db.sets.filter((s) => s.loc === r[1]))
    if (m === 'POST' && p === '/v1/appScreenshotSets') { r = { id: id(), attributes: body.attributes, loc: body.relationships.appStoreVersionLocalization.data.id }; db.sets.push(r); return reply(201, { data: r }) }
    if (m === 'GET' && (r = /^\/v1\/appScreenshotSets\/([^/]+)\/appScreenshots$/.exec(p))) return data(db.shots.filter((s) => s.set === r[1]))
    if (m === 'DELETE' && (r = /^\/v1\/appScreenshots\/(.+)$/.exec(p))) { db.shots = db.shots.filter((s) => s.id !== r[1]); return reply(204) }
    if (m === 'POST' && p === '/v1/appScreenshots') {
      const size = body.attributes.fileSize
      r = { id: id(), set: body.relationships.appScreenshotSet.data.id, attributes: { fileName: body.attributes.fileName, uploadOperations: [{ method: 'PUT', url: `https://upload.test/${next}`, offset: 0, length: size, requestHeaders: [{ name: 'Content-Type', value: 'image/png' }] }] } }
      db.shots.push(r); return reply(201, { data: r })
    }
    if (m === 'PATCH' && (r = /^\/v1\/appScreenshots\/(.+)$/.exec(p))) { Object.assign(db.shots.find((s) => s.id === r[1]).attributes, body.attributes); return data({}) }
    if (m === 'GET' && p === '/v1/apps/app1/reviewSubmissions') return data(db.submissions.filter((s) => q('filter[state]').split(',').includes(s.attributes.state)))
    if (m === 'POST' && p === '/v1/reviewSubmissions') { r = { id: id(), attributes: { state: 'READY_FOR_REVIEW' } }; db.submissions.push(r); return reply(201, { data: r }) }
    if (m === 'POST' && p === '/v1/reviewSubmissionItems') { db.items.push(body.relationships); return reply(201, { data: {} }) }
    if (m === 'PATCH' && (r = /^\/v1\/reviewSubmissions\/(.+)$/.exec(p))) {
      const s = db.submissions.find((x) => x.id === r[1]); s.attributes.state = 'WAITING_FOR_REVIEW'
      for (const v of db.versions) v.attributes.appVersionState = 'WAITING_FOR_REVIEW'
      return data(s)
    }
    return err(404, 'NOT_FOUND', `${m} ${p}`)
  }
  const api = ascApi({ token: async () => 'jwt', fetchImpl, base: 'https://asc.test' })
  return { db, calls, api, fetchImpl }
}

const shotFiles = (n, tag = '') => Array.from({ length: n }, (_, i) => ({ name: `${i + 1}.png`, bytes: Buffer.from(`png${i}${tag}`) }))
const META = {
  locales: Object.fromEntries(['en-US', 'sv'].map((l) => [l, {
    name: `Iskra ${l}`, subtitle: 'Sub', promotional_text: 'Promo', description: 'Desc', keywords: 'a,b', support_url: 'https://iskra.foo/support',
    marketing_url: 'https://iskra.foo', privacy_url: 'https://iskra.foo/privacy', screenshots: { APP_IPHONE_67: shotFiles(2), APP_IPAD_PRO_3GEN_129: [] },
  }])),
  reviewNotes: 'Paste: {{INVITE}}',
  ageRating: { violenceRealistic: 'NONE', messagingAndChat: true },
}
const NOTES = [{ locale: 'en-US', text: '• New things' }, { locale: 'sv', text: '• Nya saker' }]
const CFG = { ...storeConfig(), contact: { firstName: 'Viktor', lastName: 'Lundgren', email: 'spark@iskra.foo' }, feedbackEmail: 'spark@iskra.foo' }

function ctxFor(fake) {
  const log = []
  const warnings = []
  let t = 0
  return { log, warnings, ctx: { api: fake.api, log: (l) => log.push(l), warn: (l) => warnings.push(l), sleep: async (ms) => { t += ms }, now: () => t } }
}

const RUN = { cfg: CFG, version: '2.0.0-alpha.17', marketing: '2.0.0', buildNumber: '200001170.5.1', notes: NOTES, metadata: META, invite: 'https://chat.iskra.foo:8443/#/join/abc', phone: '+46 70 000 00 00' }

test('TestFlight: waits for processing, answers export compliance, sets What to test, groups, Beta App Review', async () => {
  const fake = fakeAsc()
  const { ctx, log, warnings } = ctxFor(fake)
  const r = await run(ctx, { ...RUN, mode: 'testflight' })
  assert.deepEqual(r, { mode: 'testflight', build: 'b1', groups: ['Friends & family', 'Team', 'Public testers'], betaReview: 'WAITING_FOR_REVIEW' })
  assert.equal(fake.db.builds[0].attributes.usesNonExemptEncryption, false)
  assert.deepEqual(fake.db.betaBuildLocalizations.map((l) => [l.attributes.locale, l.attributes.whatsNew]), [['en-US', '• New things'], ['sv', '• Nya saker']])
  assert.deepEqual(warnings, [])
  assert.deepEqual([...fake.db.groupBuilds['g-int']], ['b1'])
  assert.deepEqual([...fake.db.groupBuilds['g-ext']], ['b1'])
  assert.equal(fake.db.groupBuilds['g-all'], undefined, 'a group with every build is left alone')
  assert.equal(fake.db.betaReviews.length, 1)
  assert.equal(fake.db.betaAppReviewDetail.attributes.notes, 'Paste: https://chat.iskra.foo:8443/#/join/abc')
  assert.equal(fake.db.betaAppReviewDetail.attributes.contactPhone, '+46 70 000 00 00')
  assert.equal(fake.db.betaAppReviewDetail.attributes.demoAccountRequired, false)
  assert.equal(fake.db.betaAppLocalizations.find((l) => l.id === 'bal-en').attributes.feedbackEmail, 'spark@iskra.foo')
  assert.ok(log.some((l) => /build 2\.0\.0 \(200001170\.5\.1\): PROCESSING/.test(l)))
  assert.ok(!fake.calls.some((c) => c.includes('appStoreVersions')), 'phase A never touches the App Store version')
})

test('TestFlight again (a rerun): no second Beta App Review, What to test kept', async () => {
  const fake = fakeAsc()
  await run(ctxFor(fake).ctx, { ...RUN, mode: 'testflight' })
  const before = fake.calls.filter((c) => c === 'POST /v1/betaAppReviewSubmissions').length
  const { ctx, log } = ctxFor(fake)
  await run(ctx, { ...RUN, mode: 'testflight' })
  assert.equal(fake.calls.filter((c) => c === 'POST /v1/betaAppReviewSubmissions').length, before)
  assert.ok(log.includes('Beta App Review: WAITING_FOR_REVIEW already'))
  assert.equal(fake.db.betaBuildLocalizations.length, 2)
})

test('a Swedish What to test that App Store Connect refuses is only a warning', async () => {
  const fake = fakeAsc()
  const { ctx, warnings } = ctxFor(fake)
  // Test information can't add the Swedish TestFlight language here, so Swedish What to test is refused.
  const api = { ...fake.api, post: (path, d) => (path === '/v1/betaAppLocalizations' ? Promise.reject(new Error('no sv')) : fake.api.post(path, d)) }
  await run({ ...ctx, api }, { ...RUN, mode: 'testflight' })
  assert.match(warnings.join('\n'), /TestFlight test information not updated/)
  assert.match(warnings.join('\n'), /What to test \(sv\) not set/)
  assert.deepEqual(fake.db.betaBuildLocalizations.map((l) => l.attributes.locale), ['en-US'])
  assert.equal(fake.db.betaReviews.length, 1)
})

test('a build Apple refuses stops with a clear message; a missing external group is a configuration error', async () => {
  const bad = fakeAsc({ buildState: 'INVALID' })
  await assert.rejects(run(ctxFor(bad).ctx, { ...RUN, mode: 'testflight' }), /couldn't process build 200001170\.5\.1 \(INVALID\)/)
  assert.throws(() => pickGroups([], { externalGroups: [{ publicLinkId: 'nope' }] }), /no external TestFlight group with the public link nope/)
  const slow = fakeAsc({ processingAfter: 1000 })
  await assert.rejects(run(ctxFor(slow).ctx, { ...RUN, mode: 'testflight', timeoutMs: 5 * 60_000 }), /still isn't processed after 5 minutes/)
})

test('App Store: version, build, texts, age rating, review details, screenshots, submitted for review with automatic release', async () => {
  const fake = fakeAsc({ firstVersion: true })
  const { ctx } = ctxFor(fake)
  const r = await run(ctx, { ...RUN, mode: 'appstore' })
  assert.equal(r.appStore, 'WAITING_FOR_REVIEW')
  const v = fake.db.versions[0]
  assert.deepEqual([v.attributes.versionString, v.attributes.releaseType, v.build], ['2.0.0', 'AFTER_APPROVAL', 'b1'])
  assert.deepEqual(fake.db.versionLocs.map((l) => l.attributes.locale), ['en-US', 'sv'])
  assert.equal(fake.db.versionLocs[0].attributes.whatsNew, undefined, "an app's first version takes no What's New")
  assert.equal(fake.db.versionLocs[0].attributes.keywords, 'a,b')
  assert.equal(fake.db.appInfoLocs.find((l) => l.id === 'ail-en').attributes.name, 'Iskra en-US')
  assert.equal(fake.db.appInfoLocs.find((l) => l.attributes.locale === 'sv').attributes.subtitle, 'Sub')
  assert.equal(fake.db.ageRating.attributes.messagingAndChat, true)
  assert.equal(fake.db.reviewDetails[0].attributes.notes, 'Paste: https://chat.iskra.foo:8443/#/join/abc')
  // Screenshots: two iPhone shots per language, uploaded to the presigned URL and committed with their MD5.
  assert.equal(fake.db.shots.length, 4)
  assert.equal(fake.db.uploads.length, 4)
  assert.equal(fake.db.shots[0].attributes.sourceFileChecksum, createHash('md5').update(Buffer.from('png0')).digest('hex'))
  assert.equal(fake.db.shots[0].attributes.uploaded, true)
  assert.equal(fake.db.items.length, 1)
  assert.equal(fake.db.submissions[0].attributes.state, 'WAITING_FOR_REVIEW')
})

test('App Store again while in review: nothing is submitted twice; unchanged screenshots stay', async () => {
  const fake = fakeAsc()
  await run(ctxFor(fake).ctx, { ...RUN, mode: 'appstore' })
  const { ctx, log } = ctxFor(fake)
  const r = await run(ctx, { ...RUN, mode: 'appstore' })
  assert.equal(r.appStore, 'WAITING_FOR_REVIEW')
  assert.ok(log.includes('App Store version 2.0.0: WAITING_FOR_REVIEW'))
  assert.equal(fake.db.submissions.length, 1)
  assert.equal(fake.db.uploads.length, 4)
})

test('App Store: a rejected version is reused; changed screenshots replace that set; age rating refusal is a warning', async () => {
  const fake = fakeAsc({ ageRatingFails: true })
  await run(ctxFor(fake).ctx, { ...RUN, mode: 'appstore' })
  fake.db.versions[0].attributes.appVersionState = 'REJECTED'
  fake.db.submissions[0].attributes.state = 'COMPLETE'
  const changed = structuredClone(META)
  for (const l of Object.values(changed.locales)) l.screenshots.APP_IPHONE_67 = shotFiles(2, 'new').map((f) => ({ ...f, bytes: Buffer.from(f.bytes) }))
  const { ctx, warnings } = ctxFor(fake)
  const r = await run(ctx, { ...RUN, mode: 'appstore', metadata: changed })
  assert.equal(r.appStore, 'WAITING_FOR_REVIEW')
  assert.equal(fake.db.versions.length, 1)
  assert.equal(fake.db.uploads.length, 8)
  assert.equal(fake.db.shots.length, 4)
  assert.equal(fake.db.submissions.length, 2)
  assert.match(warnings.join('\n'), /age rating not set through the API/)
})

test('App Store: an approved version stops (the next release needs a higher version); no invite stops before anything', async () => {
  const fake = fakeAsc()
  fake.db.versions.push({ id: 'v-old', attributes: { versionString: '2.0.0', appVersionState: 'READY_FOR_DISTRIBUTION' } })
  await assert.rejects(run(ctxFor(fake).ctx, { ...RUN, mode: 'appstore' }), /already approved or on sale/)
  const fresh = fakeAsc()
  await assert.rejects(run(ctxFor(fresh).ctx, { ...RUN, mode: 'appstore', invite: '' }), /REVIEW_INVITE_URL/)
  assert.equal(fresh.calls.length, 0)
})

test("texts: What to test from the release notes; the repo's App Store kit fits Apple's limits", () => {
  const dir = mkdtempSync(join(tmpdir(), 'iskra-asc-'))
  try {
    writeFileSync(join(dir, '2.0.0-alpha.17.md'), "**Iskra.**\n\n### What's new\n- **AFK channel.** People who sit idle move.\n### Fixes\n- A [fix](https://x).")
    const [en, sv] = whatsNew('2.0.0-alpha.17', dir)
    assert.equal(en.text, '• AFK channel. People who sit idle move.\n• A fix.\nEverything new: https://github.com/quikmn/iskra-voice/releases/tag/v2.0.0-alpha.17')
    assert.equal(sv.locale, 'sv')
    assert.match(sv.text, /^Nyheter och fixar i Iskra 2\.0\.0-alpha\.17/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
  const meta = loadMetadata()
  for (const l of ['en-US', 'sv']) {
    assert.ok(meta.locales[l].description.length > 500)
    assert.match(meta.locales[l].privacy_url, /^https:\/\/iskra\.foo\/privacy$/)
  }
  assert.match(meta.reviewNotes, /\{\{INVITE\}\}/)
  assert.equal(meta.ageRating.userGeneratedContent, true)
  assert.equal(reviewNotes('a {{INVITE}} b', 'X'), 'a X b')
  assert.equal(storeConfig().mode, 'testflight')
  assert.deepEqual(storeConfig().externalGroups, [{ publicLinkId: 'r4tMgn3D' }])
})

test('command line: dry run without network; missing key stops; upload mode does nothing', async () => {
  const out = []
  const no = () => assert.fail('no network')
  assert.equal(await main(['auto', '--version', '2.0.0-alpha.16', '--marketing', '2.0.0', '--build-number', '200001160.1.1', '--dry-run'], { print: (l) => out.push(l), fetchImpl: no }), 0)
  assert.match(out[0], /^DRY RUN testflight: build 2\.0\.0 \(200001160\.1\.1\)/)
  const stop = []
  assert.equal(await main(['testflight', '--version', '2.0.0-alpha.16', '--marketing', '2.0.0', '--build-number', '1.1.1'], { env: {}, print: (l) => stop.push(l), fetchImpl: no }), 1)
  assert.match(stop.at(-1), /^App Store Connect stopped: the App Store Connect API key is missing/)
  const up = []
  assert.equal(await main(['upload'], { print: (l) => up.push(l), fetchImpl: no }), 0)
  assert.equal(await main(['testflight', '--version', 'v2', '--marketing', '2.0.0', '--build-number', '1'], { print: () => {}, fetchImpl: no }), 1)
})

test('API tokens: ES256 JWTs for App Store Connect from a .p8 key (a throwaway key here), renewed after 15 minutes', async () => {
  const { generateKeyPairSync, verify } = await import('node:crypto')
  const { ascToken } = await import('./appstore.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'iskra-p8-'))
  try {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const keyPath = join(dir, 'AuthKey_TEST.p8')
    writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }))
    let t = 1_700_000_000_000
    const token = await ascToken({ keyPath, keyId: 'KEY123', issuerId: 'issuer-uuid', now: () => t })
    const jwt = await token()
    const [h, p, sig] = jwt.split('.')
    const json = (s) => JSON.parse(Buffer.from(s, 'base64url').toString())
    assert.deepEqual(json(h), { alg: 'ES256', kid: 'KEY123', typ: 'JWT' })
    assert.deepEqual(json(p), { iss: 'issuer-uuid', iat: 1_700_000_000, exp: 1_700_001_200, aud: 'appstoreconnect-v1' })
    assert.ok(verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')))
    assert.equal(await token(), jwt, 'cached')
    t += 16 * 60_000
    assert.notEqual(await token(), jwt, 'renewed')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
