#!/usr/bin/env node
// Step of scripts/release.ps1 (the one release command) and of the Release workflow (release-all.yml); don't run it by
// hand. Uploads the Android app bundle to Google Play with the Android Publisher API (after a release is published;
// docs/ci-cd.md "Google Play uploads"). One edit: upload the bundle (unless Play already has that version code), put it
// on a track with release notes in English and Swedish, commit. Running it again for a version that is already on the
// track changes nothing, so a resumed release can call it again.
//
//   node scripts/play-upload.mjs <version> [--aab mobile/release/Iskra-<version>.aab] [--track alpha] [--rollout 1]
//        [--listing | --no-listing] [--status completed] [--rebuild 0] [--key <service-account.json>]
//        [--universal-apk <out.apk>] [--dry-run | --check]
//   node scripts/play-upload.mjs --list-tracks      # the app's track names on Play (read only)
//
// Defaults come from mobile/store.json ("android": track, rollout, listing, dataSafety); options override them.
// --check only looks for the credentials (exit 0 found, 2 missing); --dry-run also checks the bundle and prints the notes.
// With listing on, the store listing text and graphics come from docs/store/play (graphics only where the screenshot
// spec made them) and go into the same edit; with dataSafety on, docs/store/play/data-safety.csv goes to Play after it.
// --universal-apk: after the upload, downloads the universal APK Play generated from the bundle and signed with the app
// signing key (for the GitHub release when the bundle is built on GitHub with the upload key; docs/ci-cd.md, "Android
// built on GitHub").
//
// Auth, the first that is there: ISKRA_PLAY_ACCESS_TOKEN (an OAuth access token for the service account, from Google
// workload identity federation in the Release workflow: no key file anywhere), else a Google Cloud service account's
// JSON key at D:\Development_Projects\devkeys\google-play-service-account.json (ISKRA_PLAY_KEY overrides). The key file
// is only read by google-auth-library (mobile/node_modules); neither is ever printed. Neither: prints why and exits 2
// (a skip, not a failure).
// Exit 0: the version is on the track. Exit 1: it isn't (one "Play upload stopped: ..." line says why).
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { androidVersionCode } from './mobile-version.mjs'

export const PACKAGE = 'foo.iskra.app'
export const API = 'https://androidpublisher.googleapis.com'
export const SCOPE = 'https://www.googleapis.com/auth/androidpublisher'
/** Play's built-in tracks: internal testing, closed testing ("alpha"), open testing ("beta"), production. */
export const BUILT_IN_TRACKS = ['internal', 'alpha', 'beta', 'production']
export const STATUSES = ['completed', 'draft', 'inProgress', 'halted']
/** Play's limit per language. */
export const NOTES_MAX = 500
export const REPO_URL = 'https://github.com/quikmn/iskra-voice'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export class PlayError extends Error {
  constructor(message, { status = 0, reason = '' } = {}) {
    super(message)
    this.status = status
    this.reason = reason
  }
}

// ── Release notes ──

/** Markdown inline formatting to plain text (Play shows notes as plain text). */
export function plain(text) {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/(^|\W)[*_]([^*_]+)[*_](?=\W|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A bullet's headline: its bold lead-in if it has one, else its first sentence. */
export function headline(bullet) {
  const bold = /^\*\*(.+?)\*\*/.exec(bullet)
  const text = plain(bold ? bold[1] : bullet)
  if (bold) return text.replace(/[.:]$/, '')
  const sentence = /^(.+?[.!?])(\s|$)/.exec(text)
  return (sentence ? sentence[1] : text).replace(/\.$/, '')
}

/** Bullets under each `### Section` of a release notes file. */
export function sections(markdown) {
  const out = {}
  let current = null
  for (const line of markdown.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/)) {
    const h = /^###\s+(.+?)\s*$/.exec(line)
    if (h) { current = h[1].toLowerCase(); out[current] = []; continue }
    const b = /^\s*[-*]\s+(.+)$/.exec(line)
    if (b && current) out[current].push(b[1].trim())
  }
  return out
}

const LENGTH = (s) => [...s].length

/**
 * Play release notes (plain text, at most `max` characters) from a docs/releases/<version>.md file: the headlines of
 * "What's new" (Swedish: "Nytt"), then of "Fixes" ("Fixar"), as many as fit, and a last line with the full notes' link.
 */
export function playNotes(markdown, { version, lang = 'en', max = NOTES_MAX, full = false }) {
  const s = sections(markdown)
  const pick = (...names) => names.flatMap((n) => s[n] ?? [])
  const items = [...pick("what's new", 'nytt', 'nyheter'), ...pick('fixes', 'fixar')].map(full ? plain : headline).filter(Boolean)
  const link = `${lang === 'sv' ? 'Allt som är nytt' : 'Everything new'}: ${REPO_URL}/releases/tag/v${version}`
  const lines = []
  for (const item of items) {
    const line = `• ${item}`
    if (LENGTH([...lines, line, link].join('\n')) > max) continue
    lines.push(line)
  }
  return [...lines, link].join('\n')
}

/** Swedish notes when there is no docs/releases/<version>.sv.md: one line and the (English) full notes' link. */
export function defaultSwedishNotes(version) {
  return `Nyheter och fixar i Iskra ${version}. Allt som är nytt (på engelska): ${REPO_URL}/releases/tag/v${version}`
}

/** en-US and sv-SE notes for Play, from docs/releases. */
export function releaseNotesFor(version, dir = join(root, 'docs', 'releases')) {
  const en = join(dir, `${version}.md`)
  if (!existsSync(en)) throw new PlayError(`docs/releases/${version}.md is missing`)
  const sv = join(dir, `${version}.sv.md`)
  return [
    { language: 'en-US', text: playNotes(readFileSync(en, 'utf8'), { version, lang: 'en' }) },
    { language: 'sv-SE', text: existsSync(sv) ? playNotes(readFileSync(sv, 'utf8'), { version, lang: 'sv' }) : defaultSwedishNotes(version) },
  ]
}

// ── The API ──

/**
 * A small Android Publisher client over fetch. `token()` returns an OAuth access token; `fetchImpl` is fetch (tests
 * pass a fake). Errors become PlayError with Google's message.
 */
export function playApi({ token, fetchImpl = fetch, base = API, packageName = PACKAGE }) {
  const app = `/androidpublisher/v3/applications/${encodeURIComponent(packageName)}`
  async function call(method, path, { json, body, contentType, query, upload = false, binary = false } = {}) {
    const url = new URL(`${upload ? '/upload' : ''}${app}${path}`, base)
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v))
    const headers = { authorization: `Bearer ${await token()}` }
    if (json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(json) }
    else if (contentType) headers['content-type'] = contentType
    const res = await fetchImpl(url.href, { method, headers, body })
    if (binary && res.ok) return Buffer.from(await res.arrayBuffer())
    const text = await res.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = null }
    if (!res.ok) {
      const err = data?.error
      const reason = err?.errors?.[0]?.reason ?? err?.status ?? ''
      throw new PlayError(`${method} ${path || '/'}: ${res.status} ${err?.message ?? text.slice(0, 200)}${reason ? ` (${reason})` : ''}`.trim(), { status: res.status, reason })
    }
    return data
  }
  const listing = (edit, lang) => `/edits/${edit}/listings/${encodeURIComponent(lang)}`
  return {
    insertEdit: () => call('POST', '/edits', { json: {} }),
    deleteEdit: (edit) => call('DELETE', `/edits/${edit}`),
    listBundles: (edit) => call('GET', `/edits/${edit}/bundles`),
    uploadBundle: (edit, bytes) => call('POST', `/edits/${edit}/bundles`, { upload: true, body: bytes, contentType: 'application/octet-stream', query: { uploadType: 'media' } }),
    // Outside edits: the APKs Play generated from a committed bundle, signed with the app signing key.
    generatedApks: (versionCode) => call('GET', `/generatedApks/${encodeURIComponent(versionCode)}`),
    downloadGeneratedApk: (versionCode, id) => call('GET', `/generatedApks/${encodeURIComponent(versionCode)}/downloads/${encodeURIComponent(id)}:download`, { query: { alt: 'media' }, binary: true }),
    listTracks: (edit) => call('GET', `/edits/${edit}/tracks`),
    getTrack: (edit, track) => call('GET', `/edits/${edit}/tracks/${encodeURIComponent(track)}`),
    updateTrack: (edit, track, releases) => call('PUT', `/edits/${edit}/tracks/${encodeURIComponent(track)}`, { json: { track, releases } }),
    updateListing: (edit, l) => call('PUT', listing(edit, l.language), { json: { language: l.language, title: l.title, shortDescription: l.shortDescription, fullDescription: l.fullDescription } }),
    listImages: (edit, lang, type) => call('GET', `${listing(edit, lang)}/${type}`),
    deleteImages: (edit, lang, type) => call('DELETE', `${listing(edit, lang)}/${type}`),
    uploadImage: (edit, lang, type, bytes) => call('POST', `${listing(edit, lang)}/${type}`, { upload: true, body: bytes, contentType: 'image/png', query: { uploadType: 'media' } }),
    commit: (edit, query) => call('POST', `/edits/${edit}:commit`, { query }),
    // Outside edits: the Data safety form, in Play Console's own CSV format.
    dataSafety: (csv) => call('POST', '/dataSafety', { json: { safetyLabels: csv } }),
  }
}

export function checkTrack(track) {
  if (typeof track !== 'string' || !/^[\p{L}\p{N} _.:-]{1,100}$/u.test(track)) throw new PlayError(`'${track}' isn't a track name (internal, alpha = closed testing, beta = open testing, production, or a custom closed track's name)`)
  return track
}

/** A release's status and share of users: below 1 is a staged rollout ("inProgress" with userFraction). */
export function rolloutStatus(rollout = 1) {
  const r = Number(rollout)
  if (!(r > 0 && r <= 1)) throw new PlayError(`rollout must be above 0 and at most 1, not ${rollout}`)
  return r < 1 ? { status: 'inProgress', userFraction: r } : { status: 'completed' }
}

const sha256Of = (bytes) => createHash('sha256').update(bytes).digest('hex')
export const IMAGE_TYPES = ['icon', 'featureGraphic', 'phoneScreenshots']

/** Listing text and graphics into the edit. Graphics are replaced only when they differ from what Play has. */
async function applyListing(api, edit, languages, log) {
  for (const l of languages) {
    await api.updateListing(edit, l)
    log(`listing text (${l.language})`)
    for (const type of IMAGE_TYPES) {
      const files = l.images?.[type]
      if (!files?.length) continue
      const have = ((await api.listImages(edit, l.language, type))?.images ?? []).map((i) => String(i.sha256 ?? '').toLowerCase())
      const want = files.map(sha256Of)
      if (have.length === want.length && have.every((h, i) => h === want[i])) continue
      await api.deleteImages(edit, l.language, type)
      for (const bytes of files) await api.uploadImage(edit, l.language, type, bytes)
      log(`${type} (${l.language}): ${files.length} image${files.length === 1 ? '' : 's'}`)
    }
  }
}

/**
 * Puts the bundle on the track in one edit (and, with `listing`, the store listing text and graphics). Steps are logged
 * through `log`. Returns { versionCode, uploaded, unchanged, status, committedForReview }.
 */
export async function publishToPlay({ api, bytes, versionCode, version, track = 'alpha', status = 'completed', userFraction, notes, listing, log = () => {} }) {
  checkTrack(track)
  if (!STATUSES.includes(status)) throw new PlayError(`'${status}' isn't a release status (${STATUSES.join(', ')})`)
  const sha256 = sha256Of(bytes)
  const code = String(versionCode)
  const edit = (await api.insertEdit()).id
  if (!edit) throw new PlayError('Play returned no edit id')
  let committed = false
  try {
    const existing = ((await api.listBundles(edit))?.bundles ?? []).find((b) => String(b.versionCode) === code)
    let uploaded = false
    if (existing) {
      if (existing.sha256 && existing.sha256.toLowerCase() !== sha256) {
        throw new PlayError(`Play already has version code ${code} from a different file. Play never takes a code twice: build again with the next rebuild number (build-android.ps1 -Rebuild n) and upload that`, { reason: 'versionCodeTaken' })
      }
      log(`Play already has version code ${code}; not uploading it again`)
    } else {
      log(`uploading the bundle (${(bytes.length / 1048576).toFixed(1)} MB, version code ${code})`)
      const result = await api.uploadBundle(edit, bytes)
      if (String(result?.versionCode) !== code) {
        throw new PlayError(`the uploaded bundle has version code ${result?.versionCode}, expected ${code} (wrong .aab?)`)
      }
      uploaded = true
    }

    let current = []
    try { current = (await api.getTrack(edit, track))?.releases ?? [] } catch (e) {
      if (e.status !== 404) throw e
      // A built-in track with nothing on it yet; any other name must be one of the app's tracks.
      const names = ((await api.listTracks(edit).catch(() => null))?.tracks ?? []).map((t) => t.track)
      if (!BUILT_IN_TRACKS.includes(track) && !names.includes(track)) throw new PlayError(`Play has no track '${track}' for this app. Its tracks: ${names.join(', ') || '(none listed)'}. Set android.track in mobile/store.json (or -PlayTrack) to one of them`, { status: 404, reason: 'trackNotFound' })
    }
    const already = current.find((r) => (r.versionCodes ?? []).map(String).includes(code))
    const done = already && (already.status === status || already.status === 'completed')
    let finalStatus = done ? already.status : status
    if (done && !listing) {
      log(`version code ${code} is already on the '${track}' track (${already.status}); nothing to change`)
      await api.deleteEdit(edit).catch(() => {})
      committed = true
      return { versionCode: code, uploaded, unchanged: true, status: already.status }
    }

    if (done) log(`version code ${code} is already on the '${track}' track (${already.status})`)
    else {
      const release = (s) => ({
        name: version, versionCodes: [code], status: s, releaseNotes: notes,
        ...((s === 'inProgress' || s === 'halted') && userFraction ? { userFraction } : {}),
      })
      try {
        await api.updateTrack(edit, track, [release(status)])
      } catch (e) {
        // An app that was never published (still a draft in Play Console) takes only draft releases.
        if (status !== 'draft' && /draft app|status draft/i.test(e.message)) {
          log(`Play takes only draft releases until the app's first release is published in Play Console: adding it as a draft`)
          finalStatus = 'draft'
          await api.updateTrack(edit, track, [release('draft')])
        } else throw e
      }
    }
    if (listing) await applyListing(api, edit, listing, log)

    let committedForReview = true
    try {
      await api.commit(edit)
    } catch (e) {
      // Managed publishing, or changes waiting for review: Play wants them committed without sending them for review.
      if (/changesNotSentForReview/i.test(e.message)) {
        log('Play asks to commit without sending the changes for review: committing; send them for review in Play Console (Publishing overview)')
        await api.commit(edit, { changesNotSentForReview: true })
        committedForReview = false
      } else throw e
    }
    committed = true
    return { versionCode: code, uploaded, unchanged: false, status: finalStatus, committedForReview }
  } finally {
    if (!committed) await api.deleteEdit(edit).catch(() => {})
  }
}

/**
 * The universal APK Play generated from the committed bundle with this version code, signed with Play's app signing
 * key (the same key as every earlier APK, so installed copies update). Throws when Play has none (yet).
 */
export async function downloadUniversalApk(api, versionCode) {
  const apks = (await api.generatedApks(String(versionCode)))?.generatedApks ?? []
  const universal = apks.map((a) => a?.generatedUniversalApk?.downloadId).find(Boolean)
  if (!universal) throw new PlayError(`Play has no universal APK for version code ${versionCode} (yet): it makes one from a committed bundle`)
  const bytes = await api.downloadGeneratedApk(String(versionCode), universal)
  if (!bytes?.length || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new PlayError(`the universal APK Play gave for version code ${versionCode} isn't an APK (zip) file`)
  return bytes
}

/** The tracks Play has for this app (a read-only edit, thrown away). */
export async function listTracks(api) {
  const edit = (await api.insertEdit()).id
  try { return ((await api.listTracks(edit))?.tracks ?? []).map((t) => t.track) } finally { await api.deleteEdit(edit).catch(() => {}) }
}

// ── Store listing from docs/store/play ──

export const LISTING_LIMITS = { title: 30, shortDescription: 80, fullDescription: 4000 }

/**
 * The listing per language from docs/store/play/<en-US|sv-SE>/*.txt, with the graphics the screenshot spec made
 * (screenshots/<lang>/*.png, graphics/feature-graphic-<en|sv>.png, graphics/icon-512.png) where they exist.
 */
export function loadListing(dir = join(root, 'docs', 'store', 'play')) {
  const read = (...p) => readFileSync(join(dir, ...p), 'utf8').trim()
  const png = (...p) => (existsSync(join(dir, ...p)) ? [readFileSync(join(dir, ...p))] : [])
  return ['en-US', 'sv-SE'].map((language) => {
    const l = { language, title: read(language, 'title.txt'), shortDescription: read(language, 'short_description.txt'), fullDescription: read(language, 'full_description.txt') }
    for (const [k, max] of Object.entries(LISTING_LIMITS)) if (LENGTH(l[k]) > max) throw new PlayError(`docs/store/play/${language}: ${k} is ${LENGTH(l[k])} characters (Play allows ${max})`)
    const shots = join(dir, 'screenshots', language)
    l.images = {
      icon: png('graphics', 'icon-512.png'),
      featureGraphic: png('graphics', `feature-graphic-${language.slice(0, 2)}.png`),
      phoneScreenshots: existsSync(shots) ? readdirSync(shots).filter((f) => f.endsWith('.png')).sort().map((f) => readFileSync(join(shots, f))) : [],
    }
    return l
  })
}

/** mobile/store.json's "android" part. */
export function storeConfig(file = join(root, 'mobile', 'store.json')) {
  const c = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  return { track: 'alpha', rollout: 1, listing: false, dataSafety: false, ...(c.android ?? {}) }
}

// ── Command line ──

/** The service-account key's fixed place on the owner's PC (outside the repo, never committed). */
export const KEY_PATH = 'D:\\Development_Projects\\devkeys\\google-play-service-account.json'

/** The key file: ISKRA_PLAY_KEY if set, else KEY_PATH. */
export function defaultKeyPath(env = process.env) {
  return env.ISKRA_PLAY_KEY || KEY_PATH
}

/**
 * How to log in: an access token from workload identity federation (ISKRA_PLAY_ACCESS_TOKEN) wins over a key file;
 * { kind: 'token' | 'key' | null, key, describe }.
 */
export function playCredentials(env, keyOption) {
  if (env.ISKRA_PLAY_ACCESS_TOKEN && !keyOption) return { kind: 'token', describe: 'an access token (workload identity federation)' }
  const key = keyOption ?? defaultKeyPath(env)
  return existsSync(key) ? { kind: 'key', key, describe: `service-account key found (${key})` } : { kind: null, key }
}

async function googleToken(keyFile) {
  const require = createRequire(join(root, 'mobile', 'package.json'))
  let lib
  try { lib = await import(pathToFileURL(require.resolve('google-auth-library')).href) } catch {
    throw new PlayError('google-auth-library is missing: run npm ci in mobile/')
  }
  const auth = new lib.GoogleAuth({ keyFile, scopes: [SCOPE] })
  // Which account this is (an e-mail, not a secret): the first thing to compare when Play says "permission denied".
  try { const c = await auth.getCredentials(); if (c?.client_email) console.log(`Google Play: signing in as ${c.client_email}`) } catch { /* reported by the token call */ }
  return async () => {
    const t = await auth.getAccessToken()
    if (!t) throw new PlayError('Google gave no access token for the service account')
    return t
  }
}

function parseArgs(argv, config) {
  const args = { version: argv[0], track: config.track, rollout: config.rollout, listing: Boolean(config.listing), dataSafety: Boolean(config.dataSafety), rebuild: 0, dryRun: false, check: false, listTracks: false }
  if (argv[0] === '--list-tracks') { args.listTracks = true; args.version = undefined }
  for (let i = args.listTracks ? 0 : 1; i < argv.length; i++) {
    const a = argv[i]
    const next = () => { const v = argv[++i]; if (v === undefined) throw new PlayError(`${a} needs a value`); return v }
    if (a === '--aab') args.aab = next()
    else if (a === '--track') args.track = next()
    else if (a === '--status') args.status = next()
    else if (a === '--rollout') args.rollout = Number(next())
    else if (a === '--listing') args.listing = true
    else if (a === '--no-listing') { args.listing = false; args.dataSafety = false }
    else if (a === '--rebuild') args.rebuild = Number(next())
    else if (a === '--key') args.key = next()
    else if (a === '--universal-apk') args.universalApk = next()
    else if (a === '--dry-run') args.dryRun = true
    else if (a === '--check') args.check = true
    else if (a === '--list-tracks') args.listTracks = true
    else throw new PlayError(`unknown option ${a}`)
  }
  return args
}

export async function main(argv, { env = process.env, fetchImpl = fetch, tokenFor = googleToken, print = console.log, config = storeConfig(), listingDir } = {}) {
  try {
    const args = parseArgs(argv, config)
    const cred = playCredentials(env, args.key)
    const token = async () => (cred.kind === 'token' ? async () => env.ISKRA_PLAY_ACCESS_TOKEN : tokenFor(cred.key))
    if (args.listTracks) {
      if (!cred.kind) { print(`Play: no service-account key at ${cred.key}`); return 2 }
      const api = playApi({ token: await token(), fetchImpl, base: env.ISKRA_PLAY_API || API })
      print(`Play tracks for ${PACKAGE}: ${(await listTracks(api)).join(', ')}`)
      return 0
    }
    if (!/^\d+\.\d+\.\d+(-(alpha|beta|rc)\.\d+)?$/.test(args.version ?? '')) throw new PlayError(`'${args.version ?? ''}' isn't a version (x.y.z or x.y.z-alpha.n, no leading v)`)
    checkTrack(args.track)
    const roll = rolloutStatus(args.rollout)
    const status = args.status ?? roll.status
    const versionCode = androidVersionCode(args.version, args.rebuild)
    const aab = resolve(args.aab ?? join(root, 'mobile', 'release', `Iskra-${args.version}.aab`))
    if (!cred.kind) {
      print(`Play upload skipped: no service-account key at ${cred.key} and no workload identity federation (docs/ci-cd.md, "Google Play uploads"). Upload ${aab} in Play Console instead.`)
      return 2
    }
    if (args.check) {
      print(`Play upload: ${cred.describe}`)
      return 0
    }
    const notes = releaseNotesFor(args.version)
    if (!existsSync(aab)) throw new PlayError(`${aab} is missing: build it with mobile/scripts/build-android.ps1 on the release tag`)
    const listing = args.listing ? loadListing(listingDir) : null
    const csvFile = join(listingDir ?? join(root, 'docs', 'store', 'play'), 'data-safety.csv')
    const what = `to Google Play's '${args.track}' track as ${status}${roll.userFraction && status === 'inProgress' ? ` (${Math.round(roll.userFraction * 100)} % of users)` : ''}`
    if (args.dryRun) {
      print(`DRY RUN would upload ${aab} (version code ${versionCode}) ${what}${listing ? ', with the store listing' : ''}, notes:`)
      for (const n of notes) print(`  [${n.language}] ${n.text.replace(/\n/g, ' / ')}`)
      if (listing) for (const l of listing) print(`  listing ${l.language}: "${l.title}", ${Object.entries(l.images).map(([k, v]) => `${k} ${v.length}`).join(', ')}`)
      if (args.dataSafety) print(`  data safety: ${existsSync(csvFile) ? csvFile : 'no data-safety.csv, left as it is'}`)
      return 0
    }
    const api = playApi({ token: await token(), fetchImpl, base: env.ISKRA_PLAY_API || API })
    const result = await publishToPlay({
      api, bytes: readFileSync(aab), versionCode, version: args.version, track: args.track, status, userFraction: roll.userFraction, notes, listing,
      log: (line) => print(`  ${line}`),
    })
    if (args.dataSafety) {
      if (existsSync(csvFile)) { await api.dataSafety(readFileSync(csvFile, 'utf8')); print('  data safety sent') }
      else print('  data safety: no docs/store/play/data-safety.csv; left as it is')
    }
    const review = result.committedForReview === false ? '; send it for review in Play Console' : ''
    print(`Play: Iskra ${args.version} (version code ${result.versionCode}) is on the '${args.track}' track (${result.status})${result.unchanged ? ', already' : ''}${review}`)
    if (args.universalApk) {
      const apk = await downloadUniversalApk(api, versionCode)
      writeFileSync(resolve(args.universalApk), apk)
      print(`Play: the universal APK (signed by Play with the app signing key) is ${resolve(args.universalApk)} (${(apk.length / 1048576).toFixed(1)} MB)`)
    }
    return 0
  } catch (e) {
    print(`Play upload stopped: ${e instanceof PlayError ? e.message : (e?.message ?? String(e))}`)
    return 1
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2))
}
