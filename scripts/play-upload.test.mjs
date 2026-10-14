import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  checkTrack, defaultKeyPath, defaultSwedishNotes, headline, listTracks, loadListing, main, NOTES_MAX, playApi, playNotes, publishToPlay,
  releaseNotesFor, rolloutStatus, storeConfig,
} from './play-upload.mjs'

const NOTES = `**Iskra: alpha 16.**

### What's new
- **Report a bug from inside the app.** Press Ctrl+Shift+B (or My settings → Report a bug), say what happened.
- **AFK channel.** People who sit idle in voice are moved to the AFK channel.
- **Richer GitHub cards in webhook channels:** the full commit subject.
- **Thinner scrollbars** that follow your theme.

### Fixes
- Clicking a message no longer leaves its action bar and frame showing; they show while you hover.
- Connecting to [DigitalOcean](https://x) now always uses the same \`local\` port. More text.

### Get started
- **Windows:** \`Iskra-Setup-2.0.0-alpha.16.exe\`.

### Good to know
- Bug reports go to Iskra's own server.
`

/**
 * A fake Android Publisher API: the requests it saw, Play's state (bundles, tracks), and switches for the errors Play
 * gives in real life. Answers like Google's REST API, including its error shape.
 */
function fakePlay({ bundles = [], tracks = {}, draftApp = false, managed = false } = {}) {
  const state = { bundles: [...bundles], tracks: structuredClone(tracks), listings: {}, uploads: [], edits: new Set(), committed: [], deleted: [], requests: [], next: 1 }
  const pending = new Map()
  const reply = (status, body) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const error = (status, message, reason = 'badRequest') => reply(status, { error: { code: status, message, status: 'INVALID_ARGUMENT', errors: [{ reason, message }] } })
  async function fetchImpl(href, init) {
    const url = new URL(href)
    const method = init.method
    state.requests.push({ method, path: url.pathname + url.search, auth: init.headers.authorization, type: init.headers['content-type'] })
    assert.equal(url.origin, 'https://play.test')
    assert.equal(init.headers.authorization, 'Bearer test-token')
    if (url.pathname === '/androidpublisher/v3/applications/foo.iskra.app/dataSafety') { state.dataSafety = JSON.parse(init.body).safetyLabels; return reply(200, {}) }
    const lm = /^(\/upload)?\/androidpublisher\/v3\/applications\/foo\.iskra\.app\/edits\/([^/]+)\/listings\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname)
    if (lm) {
      const [, up, edit, lang, type] = lm
      if (!state.edits.has(edit)) return error(404, 'This Edit has been deleted.', 'editDeleted')
      const p = pending.get(edit)
      p.listings ??= structuredClone(state.listings)
      const l = (p.listings[lang] ??= { images: {} })
      if (!type && method === 'PUT') { Object.assign(l, JSON.parse(init.body)); return reply(200, JSON.parse(init.body)) }
      if (type && method === 'GET') return reply(200, { images: l.images[type] ?? [] })
      if (type && method === 'DELETE') { l.images[type] = []; return reply(200, { deleted: [] }) }
      if (type && method === 'POST') {
        assert.ok(up, 'images go to the /upload endpoint')
        assert.equal(init.headers['content-type'], 'image/png')
        const image = { id: String(state.next++), sha256: createHash('sha256').update(Buffer.from(init.body)).digest('hex') }
        ;(l.images[type] ??= []).push(image)
        state.uploads.push(type)
        return reply(200, { image })
      }
      return error(400, 'unexpected listing call')
    }
    const m = /^(\/upload)?\/androidpublisher\/v3\/applications\/foo\.iskra\.app\/edits(?:\/([^/:]+))?(?::commit|\/(bundles|tracks)(?:\/([^/]+))?)?$/.exec(url.pathname)
    if (!m) return error(404, `no route ${url.pathname}`, 'notFound')
    const [, upload, edit, kind, track] = m
    if (!edit && method === 'POST') { const id = `edit-${state.next++}`; state.edits.add(id); pending.set(id, {}); return reply(200, { id }) }
    if (!state.edits.has(edit)) return error(404, 'This Edit has been deleted.', 'editDeleted')
    const p = pending.get(edit)
    if (url.pathname.endsWith(':commit')) {
      if (managed && url.searchParams.get('changesNotSentForReview') !== 'true') return error(400, 'Changes cannot be sent for review automatically. Please set the query parameter changesNotSentForReview to true.')
      if (p.bundle) state.bundles.push(p.bundle)
      Object.assign(state.tracks, p.tracks ?? {})
      if (p.listings) state.listings = p.listings
      state.edits.delete(edit)
      state.committed.push({ edit, query: url.search })
      return reply(200, { id: edit })
    }
    if (!kind && method === 'DELETE') { state.edits.delete(edit); state.deleted.push(edit); return reply(204) }
    if (kind === 'bundles' && method === 'GET') return reply(200, { kind: 'androidpublisher#bundlesListResponse', bundles: [...state.bundles, ...(p.bundle ? [p.bundle] : [])] })
    if (kind === 'bundles' && method === 'POST') {
      assert.ok(upload, 'bundles go to the /upload endpoint')
      assert.equal(url.searchParams.get('uploadType'), 'media')
      assert.equal(init.headers['content-type'], 'application/octet-stream')
      const bytes = Buffer.from(init.body)
      const versionCode = Number(bytes.toString('utf8').split(':')[1])
      p.bundle = { versionCode, sha256: createHash('sha256').update(bytes).digest('hex'), sha1: 'x' }
      return reply(200, p.bundle)
    }
    if (kind === 'tracks' && method === 'GET' && !track) return reply(200, { tracks: Object.keys(state.tracks).map((t) => ({ track: t })) })
    if (kind === 'tracks' && method === 'GET') {
      const t = state.tracks[decodeURIComponent(track)]
      return t ? reply(200, { track: decodeURIComponent(track), releases: t }) : error(404, 'Track not found.', 'notFound')
    }
    if (kind === 'tracks' && method === 'PUT') {
      const body = JSON.parse(init.body)
      assert.equal(body.track, decodeURIComponent(track))
      if (draftApp && body.releases.some((r) => r.status !== 'draft')) return error(400, 'Only releases with status draft may be created on draft app.')
      p.tracks = { ...(p.tracks ?? {}), [body.track]: body.releases }
      return reply(200, body)
    }
    return error(400, 'unexpected')
  }
  return { state, api: playApi({ token: async () => 'test-token', fetchImpl, base: 'https://play.test' }), fetchImpl }
}

const aab = (code) => Buffer.from(`fake-aab:${code}`)
const notes = [{ language: 'en-US', text: 'Hello' }, { language: 'sv-SE', text: 'Hej' }]

test('release notes: headlines of what is new and fixes, plain text, the link last, within 500 characters', () => {
  const text = playNotes(NOTES, { version: '2.0.0-alpha.16' })
  assert.equal(text, [
    '• Report a bug from inside the app',
    '• AFK channel',
    '• Richer GitHub cards in webhook channels',
    '• Thinner scrollbars',
    '• Clicking a message no longer leaves its action bar and frame showing; they show while you hover',
    '• Connecting to DigitalOcean now always uses the same local port',
    'Everything new: https://github.com/quikmn/iskra-voice/releases/tag/v2.0.0-alpha.16',
  ].join('\n'))
  assert.equal(headline('Plain **bold** line. Second.'), 'Plain bold line')
  // Long notes: whole lines are left out, never cut mid-line, and the link always stays.
  const long = `### What's new\n${Array.from({ length: 40 }, (_, i) => `- **Feature number ${i} with a fairly long name.** Text.`).join('\n')}`
  const cut = playNotes(long, { version: '2.0.0' })
  assert.ok([...cut].length <= NOTES_MAX, `${[...cut].length}`)
  assert.match(cut, /^• Feature number 0 with a fairly long name\n/)
  assert.match(cut, /\nEverything new: https:\/\/github\.com\/quikmn\/iskra-voice\/releases\/tag\/v2\.0\.0$/)
  assert.equal(playNotes('### Nytt\n- **Ny sak.** Text', { version: '2.0.0', lang: 'sv' }), '• Ny sak\nAllt som är nytt: https://github.com/quikmn/iskra-voice/releases/tag/v2.0.0')
})

test('release notes for both languages; Swedish falls back to one line with the link', () => {
  const dir = mkdtempSync(join(tmpdir(), 'iskra-notes-'))
  try {
    writeFileSync(join(dir, '2.0.0-alpha.16.md'), NOTES)
    const [en, sv] = releaseNotesFor('2.0.0-alpha.16', dir)
    assert.equal(en.language, 'en-US')
    assert.equal(sv.language, 'sv-SE')
    assert.equal(sv.text, defaultSwedishNotes('2.0.0-alpha.16'))
    assert.ok([...sv.text].length <= NOTES_MAX)
    writeFileSync(join(dir, '2.0.0-alpha.16.sv.md'), '### Nytt\n- **AFK-kanal.** Text\n### Fixar\n- Klick fungerar.')
    assert.equal(releaseNotesFor('2.0.0-alpha.16', dir)[1].text, '• AFK-kanal\n• Klick fungerar\nAllt som är nytt: https://github.com/quikmn/iskra-voice/releases/tag/v2.0.0-alpha.16')
    assert.throws(() => releaseNotesFor('2.0.0-alpha.99', dir), /docs\/releases\/2\.0\.0-alpha\.99\.md is missing/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('track names', () => {
  for (const t of ['alpha', 'internal', 'beta', 'production', 'Friends and family']) assert.equal(checkTrack(t), t)
  for (const t of ['', 'a/b', '../x', 'x?y']) assert.throws(() => checkTrack(t), /isn't a track name/)
})

test('a new version: one edit uploads the bundle, sets the closed track with notes, and commits', async () => {
  const play = fakePlay({ bundles: [{ versionCode: 200001150, sha256: 'old' }] })
  const log = []
  const result = await publishToPlay({ api: play.api, bytes: aab(200001160), versionCode: 200001160, version: '2.0.0-alpha.16', notes, log: (l) => log.push(l) })
  assert.deepEqual(result, { versionCode: '200001160', uploaded: true, unchanged: false, status: 'completed', committedForReview: true })
  assert.deepEqual(play.state.tracks.alpha, [{ name: '2.0.0-alpha.16', versionCodes: ['200001160'], status: 'completed', releaseNotes: notes }])
  assert.equal(play.state.committed.length, 1)
  assert.deepEqual(play.state.requests.map((r) => `${r.method} ${r.path.replace(/edit-\d+/, 'E')}`), [
    'POST /androidpublisher/v3/applications/foo.iskra.app/edits',
    'GET /androidpublisher/v3/applications/foo.iskra.app/edits/E/bundles',
    'POST /upload/androidpublisher/v3/applications/foo.iskra.app/edits/E/bundles?uploadType=media',
    'GET /androidpublisher/v3/applications/foo.iskra.app/edits/E/tracks/alpha',
    'GET /androidpublisher/v3/applications/foo.iskra.app/edits/E/tracks',
    'PUT /androidpublisher/v3/applications/foo.iskra.app/edits/E/tracks/alpha',
    'POST /androidpublisher/v3/applications/foo.iskra.app/edits/E:commit',
  ])
  assert.ok(log.some((l) => l.startsWith('uploading the bundle')))
})

test('running it again changes nothing (a resumed release)', async () => {
  const play = fakePlay()
  await publishToPlay({ api: play.api, bytes: aab(200001160), versionCode: 200001160, version: '2.0.0-alpha.16', notes })
  const again = await publishToPlay({ api: play.api, bytes: aab(200001160), versionCode: 200001160, version: '2.0.0-alpha.16', notes })
  assert.deepEqual(again, { versionCode: '200001160', uploaded: false, unchanged: true, status: 'completed' })
  assert.equal(play.state.committed.length, 1)
  assert.equal(play.state.deleted.length, 1, 'the read-only edit is thrown away')
  assert.equal(play.state.edits.size, 0)
})

test('uploaded before but not on the track (stopped halfway): no second upload, the track is set', async () => {
  const bytes = aab(200001160)
  const play = fakePlay({ bundles: [{ versionCode: 200001160, sha256: createHash('sha256').update(bytes).digest('hex') }], tracks: { internal: [] } })
  const result = await publishToPlay({ api: play.api, bytes, versionCode: 200001160, version: '2.0.0-alpha.16', track: 'internal', notes })
  assert.equal(result.uploaded, false)
  assert.equal(play.state.tracks.internal[0].versionCodes[0], '200001160')
  assert.ok(!play.state.requests.some((r) => r.path.startsWith('/upload/')))
})

test('Play already has that version code from another file: stops, nothing committed', async () => {
  const play = fakePlay({ bundles: [{ versionCode: 200001160, sha256: 'someone-else' }] })
  await assert.rejects(publishToPlay({ api: play.api, bytes: aab(200001160), versionCode: 200001160, version: '2.0.0-alpha.16', notes }), /different file.*-Rebuild/)
  assert.equal(play.state.committed.length, 0)
  assert.equal(play.state.edits.size, 0, 'the edit is deleted')
})

test('the bundle has a different version code than expected: stops before the track', async () => {
  const play = fakePlay()
  await assert.rejects(publishToPlay({ api: play.api, bytes: aab(200001150), versionCode: 200001160, version: '2.0.0-alpha.16', notes }), /version code 200001150, expected 200001160/)
  assert.equal(play.state.committed.length, 0)
  assert.ok(!play.state.requests.some((r) => r.method === 'PUT'))
})

test('an app never published yet takes a draft release instead', async () => {
  const play = fakePlay({ draftApp: true })
  const log = []
  const result = await publishToPlay({ api: play.api, bytes: aab(200001160), versionCode: 200001160, version: '2.0.0-alpha.16', notes, log: (l) => log.push(l) })
  assert.equal(result.status, 'draft')
  assert.equal(play.state.tracks.alpha[0].status, 'draft')
  assert.ok(log.some((l) => /only draft releases/.test(l)))
})

test('managed publishing: commits without sending for review and says so', async () => {
  const play = fakePlay({ managed: true })
  const result = await publishToPlay({ api: play.api, bytes: aab(200001160), versionCode: 200001160, version: '2.0.0-alpha.16', notes })
  assert.equal(result.committedForReview, false)
  assert.equal(play.state.committed[0].query, '?changesNotSentForReview=true')
})

test('command line: no key is a skip (exit 2), never a failure; the key path is never opened', async () => {
  const out = []
  const code = await main(['2.0.0-alpha.16', '--key', join(tmpdir(), 'no-such-dir', 'key.json')], {
    print: (l) => out.push(l), tokenFor: () => assert.fail('no token without a key'), fetchImpl: () => assert.fail('no network'),
  })
  assert.equal(code, 2)
  assert.match(out.join('\n'), /^Play upload skipped: no service-account key at .*key\.json/)
  assert.equal(defaultKeyPath({ ISKRA_PLAY_KEY: 'X:\\k.json' }), 'X:\\k.json')
  assert.equal(defaultKeyPath({}), 'D:\\Development_Projects\\devkeys\\google-play-service-account.json')
})

test('command line: a full run against the fake API, and bad input stops with one line', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iskra-play-'))
  try {
    const key = join(dir, 'key.json')
    writeFileSync(key, '{}') // never read: tokenFor is the fake
    const file = join(dir, 'Iskra.aab')
    writeFileSync(file, aab(200001160))
    const play = fakePlay()
    const out = []
    const code = await main(['2.0.0-alpha.16', '--aab', file, '--key', key], {
      print: (l) => out.push(l), env: { ISKRA_PLAY_API: 'https://play.test' }, fetchImpl: play.fetchImpl, tokenFor: async (k) => { assert.equal(k, key); return async () => 'test-token' },
    })
    assert.equal(code, 0, out.join('\n'))
    assert.equal(out.at(-1), "Play: Iskra 2.0.0-alpha.16 (version code 200001160) is on the 'alpha' track (completed)")
    assert.equal(play.state.tracks.alpha[0].releaseNotes[0].language, 'en-US')
    assert.match(play.state.tracks.alpha[0].releaseNotes[0].text, /^• Report a bug from inside the app/)

    const check = []
    assert.equal(await main(['2.0.0-alpha.16', '--check', '--key', key], { print: (l) => check.push(l), fetchImpl: () => assert.fail('no network') }), 0)
    assert.match(check[0], /^Play upload: service-account key found/)
    assert.equal(await main(['2.0.0-alpha.16', '--check', '--key', join(dir, 'none.json')], { print: () => {} }), 2)

    const dry = []
    assert.equal(await main(['2.0.0-alpha.16', '--aab', file, '--key', key, '--dry-run', '--track', 'internal'], { print: (l) => dry.push(l), fetchImpl: () => assert.fail('no network in a dry run') }), 0)
    assert.match(dry[0], /^DRY RUN would upload .* \(version code 200001160\) to Google Play's 'internal' track as completed/)

    for (const [args, message] of [
      [['v2.0.0'], /isn't a version/],
      [['2.0.0-alpha.16', '--track', 'a/b', '--key', key], /isn't a track name/],
      [['2.0.0-alpha.16', '--aab', join(dir, 'missing.aab'), '--key', key], /missing\.aab is missing/],
      [['2.0.0-alpha.16', '--bogus'], /unknown option --bogus/],
    ]) {
      const lines = []
      assert.equal(await main(args, { print: (l) => lines.push(l), fetchImpl: () => assert.fail('no network') }), 1)
      assert.match(lines.at(-1), /^Play upload stopped: /)
      assert.match(lines.at(-1), message)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('rollout: everyone at once is completed, a share is a staged rollout', () => {
  assert.deepEqual(rolloutStatus(1), { status: 'completed' })
  assert.deepEqual(rolloutStatus(0.2), { status: 'inProgress', userFraction: 0.2 })
  for (const bad of [0, 1.5, 'x', -1]) assert.throws(() => rolloutStatus(bad), /rollout must be/)
})

test('production with a staged rollout: inProgress with the share of users', async () => {
  const play = fakePlay({ tracks: { production: [] } })
  await publishToPlay({ api: play.api, bytes: aab(200009000), versionCode: 200009000, version: '2.0.0', track: 'production', status: 'inProgress', userFraction: 0.2, notes })
  assert.deepEqual(play.state.tracks.production, [{ name: '2.0.0', versionCodes: ['200009000'], status: 'inProgress', releaseNotes: notes, userFraction: 0.2 }])
})

test('a custom closed track that does not exist: stops and names the tracks Play has', async () => {
  const play = fakePlay({ tracks: { alpha: [], 'Friends and family': [] } })
  await assert.rejects(
    publishToPlay({ api: play.api, bytes: aab(200001160), versionCode: 200001160, version: '2.0.0-alpha.16', track: 'Friends', notes }),
    /no track 'Friends'.*Its tracks: alpha, Friends and family/,
  )
  assert.equal(play.state.committed.length, 0)
  assert.deepEqual(await listTracks(play.api), ['alpha', 'Friends and family'])
  assert.equal(play.state.edits.size, 0, 'listing tracks leaves no edit behind')
})

test('the store listing: text every time, graphics only when they changed, all in the release edit', async () => {
  const play = fakePlay({ tracks: { production: [] } })
  const listing = [
    { language: 'en-US', title: 'Iskra', shortDescription: 'Short', fullDescription: 'Full', images: { icon: [Buffer.from('icon')], featureGraphic: [], phoneScreenshots: [Buffer.from('s1'), Buffer.from('s2')] } },
    { language: 'sv-SE', title: 'Iskra', shortDescription: 'Kort', fullDescription: 'Lång', images: { icon: [Buffer.from('icon')], featureGraphic: [Buffer.from('fg')], phoneScreenshots: [] } },
  ]
  const run = () => publishToPlay({ api: play.api, bytes: aab(200009000), versionCode: 200009000, version: '2.0.0', track: 'production', notes, listing })
  await run()
  assert.equal(play.state.listings['en-US'].title, 'Iskra')
  assert.equal(play.state.listings['sv-SE'].shortDescription, 'Kort')
  assert.deepEqual(play.state.uploads, ['icon', 'phoneScreenshots', 'phoneScreenshots', 'icon', 'featureGraphic'])
  assert.equal(play.state.committed.length, 1)
  // Again (a resumed release): the version is on the track already, the text is set again, no graphic is uploaded.
  await run()
  assert.equal(play.state.uploads.length, 5)
  assert.equal(play.state.committed.length, 2)
  // A changed screenshot replaces that set only.
  listing[0].images.phoneScreenshots[1] = Buffer.from('s2 new')
  await run()
  assert.deepEqual(play.state.uploads.slice(5), ['phoneScreenshots', 'phoneScreenshots'])
})

test("the repo's listing text fits Play's limits; the config defaults to phase A (closed testing)", () => {
  const listing = loadListing()
  assert.deepEqual(listing.map((l) => l.language), ['en-US', 'sv-SE'])
  for (const l of listing) assert.ok(l.title && l.shortDescription && l.fullDescription)
  const config = storeConfig()
  assert.equal(config.track, 'alpha')
  assert.equal(config.listing, false)
})

test('command line: config defaults, --list-tracks and data safety', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iskra-play-'))
  try {
    const key = join(dir, 'key.json')
    writeFileSync(key, '{}')
    const file = join(dir, 'Iskra.aab')
    writeFileSync(file, aab(200001160))
    const listingDir = join(dir, 'play')
    for (const lang of ['en-US', 'sv-SE']) {
      mkdirSync(join(listingDir, lang), { recursive: true })
      for (const f of ['title.txt', 'short_description.txt', 'full_description.txt']) writeFileSync(join(listingDir, lang, f), `${lang} ${f}`)
    }
    writeFileSync(join(listingDir, 'data-safety.csv'), 'Question ID,Response ID\nPSL_DATA_COLLECTION,true\n')
    const play = fakePlay({ tracks: { production: [] } })
    const opts = (out) => ({
      print: (l) => out.push(l), env: { ISKRA_PLAY_API: 'https://play.test' }, fetchImpl: play.fetchImpl, tokenFor: async () => async () => 'test-token',
      config: { track: 'production', rollout: 0.5, listing: true, dataSafety: true }, listingDir,
    })
    const out = []
    assert.equal(await main(['2.0.0-alpha.16', '--aab', file, '--key', key], opts(out)), 0, out.join('\n'))
    assert.equal(play.state.tracks.production[0].status, 'inProgress')
    assert.equal(play.state.tracks.production[0].userFraction, 0.5)
    assert.equal(play.state.listings['sv-SE'].title, 'sv-SE title.txt')
    assert.match(play.state.dataSafety, /^Question ID/)
    assert.ok(out.includes('  data safety sent'))
    const tracks = []
    assert.equal(await main(['--list-tracks', '--key', key], opts(tracks)), 0)
    assert.equal(tracks[0], 'Play tracks for foo.iskra.app: production')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
