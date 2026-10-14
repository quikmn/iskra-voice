#!/usr/bin/env node
// Step of scripts/release.ps1 (the one release command); don't run it by hand. Runs in mobile-ios.yml, which release.ps1 starts.
// After mobile-ios.yml uploads a build: everything App Store Connect needs so nobody clicks anything
// (docs/ci-cd.md, "Phone apps in the release"). Plain App Store Connect API calls with the APPSTORE_* key.
//
//   testflight (phase A): wait until Apple has processed the build, answer export compliance, set "What to test" from
//     the release notes (en-US, plus sv from docs/releases/<version>.sv.md or one Swedish line), keep the TestFlight
//     test information and review contact current, add the build to the internal groups and the external groups in
//     mobile/store.json (the public link r4tMgn3D's group), and submit it for Beta App Review.
//   appstore (phase B): the same, then the App Store version: create or reuse it, set the build, What's New, the
//     listing (docs/store/appstore: name, subtitle, promotional text, description, keywords, URLs), screenshots, the age
//     rating, the review details (with the review invite), submit it for review, released automatically once approved.
//   upload: nothing (the build is only uploaded).
//
//   node scripts/appstore.mjs <auto|testflight|appstore|upload> --version 2.0.0-alpha.17 --marketing 2.0.0
//        --build-number 200001170.123.1 --key AuthKey.p8 [--dry-run]
//
// auto = mobile/store.json's ios.mode. Env: APPSTORE_KEY_ID, APPSTORE_ISSUER_ID; optional REVIEW_INVITE_URL (a
// never-expiring invite to the review server, set once, for the review notes) and APPSTORE_REVIEW_PHONE (the review
// contact's phone). Every step checks what is there first, so a rerun picks up where the last one stopped and never
// submits twice. Never prints the key or tokens. Exit 0: done; 1: stopped (one "App Store Connect stopped: ..." line says why).
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { playNotes, REPO_URL } from './play-upload.mjs'

export const API = 'https://api.appstoreconnect.apple.com'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LENGTH = (s) => [...s].length

export class AscError extends Error {
  constructor(message, { status = 0, code = '' } = {}) {
    super(message)
    this.status = status
    this.code = code
  }
}

// ── The API ──

/** A small App Store Connect client over fetch (tests pass a fake). `token()` gives a fresh JWT. */
export function ascApi({ token, fetchImpl = fetch, base = API }) {
  async function call(method, path, { data, query } = {}) {
    const url = new URL(path, base)
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v))
    const headers = { authorization: `Bearer ${await token()}` }
    let body
    if (data !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify({ data }) }
    const res = await fetchImpl(url.href, { method, headers, body })
    const text = await res.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch { json = null }
    if (!res.ok) {
      const e = json?.errors?.[0]
      throw new AscError(`${method} ${path}: ${res.status} ${[e?.title, e?.detail].filter(Boolean).join(': ') || text.slice(0, 200)}`, { status: res.status, code: e?.code ?? '' })
    }
    return json
  }
  return {
    get: (path, query) => call('GET', path, { query }),
    post: (path, data) => call('POST', path, { data }),
    patch: (path, data) => call('PATCH', path, { data }),
    del: (path, data) => call('DELETE', path, { data }),
    /** One upload operation of an asset reservation (a presigned URL: no App Store Connect token). */
    async upload(op, bytes) {
      const headers = Object.fromEntries((op.requestHeaders ?? []).map((h) => [h.name, h.value]))
      const res = await fetchImpl(op.url, { method: op.method, headers, body: bytes.subarray(op.offset, op.offset + op.length) })
      if (!res.ok) throw new AscError(`upload: ${res.status}`, { status: res.status })
    },
  }
}

/** ES256 JWTs for the API key (jose, from mobile/node_modules), renewed every 15 minutes. */
export async function ascToken({ keyPath, keyId, issuerId, now = () => Date.now() }) {
  const require = createRequire(join(root, 'mobile', 'package.json'))
  let jose
  try { jose = await import(pathToFileURL(require.resolve('jose')).href) } catch { throw new AscError('jose is missing: run npm ci in mobile/') }
  const key = await jose.importPKCS8(readFileSync(keyPath, 'utf8'), 'ES256')
  let cached = null
  return async () => {
    const t = Math.floor(now() / 1000)
    if (!cached || t - cached.iat > 900) {
      const jwt = await new jose.SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: keyId, typ: 'JWT' })
        .setIssuer(issuerId).setIssuedAt(t).setExpirationTime(t + 1200).setAudience('appstoreconnect-v1').sign(key)
      cached = { jwt, iat: t }
    }
    return cached.jwt
  }
}

const rel = (type, id) => ({ data: { type, id } })
const one = (r) => r?.data ?? null
const many = (r) => r?.data ?? []
/** "Not found" for a to-one relationship that isn't there. */
async function maybe(promise) {
  try { return await promise } catch (e) { if (e.status === 404) return null; throw e }
}

// ── Texts ──

/** What to test / What's New: the release notes' lines in full, plain text, at most 4000 characters. */
export function whatsNew(version, dir = join(root, 'docs', 'releases')) {
  const en = join(dir, `${version}.md`)
  if (!existsSync(en)) throw new AscError(`docs/releases/${version}.md is missing`)
  const sv = join(dir, `${version}.sv.md`)
  return [
    { locale: 'en-US', text: playNotes(readFileSync(en, 'utf8'), { version, lang: 'en', max: 4000, full: true }) },
    {
      locale: 'sv',
      text: existsSync(sv)
        ? playNotes(readFileSync(sv, 'utf8'), { version, lang: 'sv', max: 4000, full: true })
        : `Nyheter och fixar i Iskra ${version}. Allt som är nytt (på engelska): ${REPO_URL}/releases/tag/v${version}`,
    },
  ]
}

export const META_LIMITS = { name: 30, subtitle: 30, promotional_text: 170, description: 4000, keywords: 100 }
export const META_FILES = ['name', 'subtitle', 'promotional_text', 'description', 'keywords', 'support_url', 'marketing_url', 'privacy_url']
export const LOCALES = ['en-US', 'sv']
/** Screenshot folders and App Store Connect's display types: iPhone 6.9" (1320×2868) and iPad 13" (2064×2752). */
export const DISPLAY_TYPES = { iphone: 'APP_IPHONE_67', ipad: 'APP_IPAD_PRO_3GEN_129' }

/** docs/store/appstore/<locale>/*.txt, checked against App Store Connect's limits, plus screenshots where they exist. */
export function loadMetadata(dir = join(root, 'docs', 'store', 'appstore')) {
  const out = {}
  for (const locale of LOCALES) {
    const m = {}
    for (const f of META_FILES) {
      const file = join(dir, locale, `${f}.txt`)
      if (!existsSync(file)) throw new AscError(`docs/store/appstore/${locale}/${f}.txt is missing`)
      m[f] = readFileSync(file, 'utf8').trim()
      if (META_LIMITS[f] && LENGTH(m[f]) > META_LIMITS[f]) throw new AscError(`docs/store/appstore/${locale}/${f}.txt is ${LENGTH(m[f])} characters (App Store Connect allows ${META_LIMITS[f]})`)
    }
    m.screenshots = {}
    for (const [folder, type] of Object.entries(DISPLAY_TYPES)) {
      const d = join(dir, 'screenshots', locale, folder)
      m.screenshots[type] = existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.png')).sort().map((f) => ({ name: f, bytes: readFileSync(join(d, f)) })) : []
    }
    out[locale] = m
  }
  const notes = join(dir, 'review-notes.txt')
  const age = join(dir, 'age-rating.json')
  return {
    locales: out,
    reviewNotes: existsSync(notes) ? readFileSync(notes, 'utf8').trim() : '',
    ageRating: existsSync(age) ? JSON.parse(readFileSync(age, 'utf8')).attributes : null,
  }
}

/** The review notes with the review server's invite in place of {{INVITE}}. */
export function reviewNotes(template, invite) {
  return template.replace(/\{\{INVITE\}\}/g, invite || '(write to spark@iskra.foo for a fresh invite link)').slice(0, 4000)
}

export function storeConfig(file = join(root, 'mobile', 'store.json')) {
  const c = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  return { mode: 'testflight', bundleId: 'foo.iskra.app', internalGroups: 'all', externalGroups: [], submitForBetaReview: true, releaseType: 'AFTER_APPROVAL', contact: {}, ...(c.ios ?? {}) }
}

// ── TestFlight ──

export async function findApp(api, bundleId) {
  const app = many(await api.get('/v1/apps', { 'filter[bundleId]': bundleId, limit: 2 }))[0]
  if (!app) throw new AscError(`App Store Connect has no app with the bundle id ${bundleId} (the app record is made once by hand: mobile/README.md)`)
  return app.id
}

/** Waits until Apple shows the build and has processed it. */
export async function waitForBuild({ api, log, sleep, now }, { appId, marketing, buildNumber, timeoutMs = 60 * 60_000, pollMs = 60_000 }) {
  const deadline = now() + timeoutMs
  let last = ''
  for (;;) {
    const build = many(await api.get('/v1/builds', { 'filter[app]': appId, 'filter[version]': buildNumber, 'filter[preReleaseVersion.version]': marketing, limit: 2 }))[0]
    const state = build?.attributes?.processingState ?? 'not there yet'
    if (state !== last) { log(`build ${marketing} (${buildNumber}): ${state}`); last = state }
    if (state === 'VALID') return build
    if (state === 'FAILED' || state === 'INVALID') throw new AscError(`Apple couldn't process build ${buildNumber} (${state}); App Store Connect → TestFlight shows why (and Apple emails the account holder)`)
    if (now() >= deadline) throw new AscError(`build ${buildNumber} still isn't processed after ${Math.round(timeoutMs / 60_000)} minutes (${state}); rerun the store step later`)
    await sleep(pollMs)
  }
}

/** Info.plist says ITSAppUsesNonExemptEncryption = false; set it on the build too if Apple didn't, so nothing waits on the question. */
export async function exportCompliance({ api, log }, build) {
  if (build.attributes?.usesNonExemptEncryption === false) return
  await api.patch(`/v1/builds/${build.id}`, { type: 'builds', id: build.id, attributes: { usesNonExemptEncryption: false } })
  log('export compliance: standard encryption only (exempt)')
}

/** "What to test" per language. A language App Store Connect refuses is a warning, English is required. */
export async function setWhatToTest({ api, log, warn }, buildId, notes) {
  const existing = many(await api.get(`/v1/builds/${buildId}/betaBuildLocalizations`, { limit: 50 }))
  for (const n of notes) {
    try {
      const have = existing.find((l) => l.attributes?.locale === n.locale)
      if (have) {
        if (have.attributes?.whatsNew !== n.text) await api.patch(`/v1/betaBuildLocalizations/${have.id}`, { type: 'betaBuildLocalizations', id: have.id, attributes: { whatsNew: n.text } })
      } else {
        await api.post('/v1/betaBuildLocalizations', { type: 'betaBuildLocalizations', attributes: { locale: n.locale, whatsNew: n.text }, relationships: { build: rel('builds', buildId) } })
      }
      log(`What to test (${n.locale})`)
    } catch (e) {
      if (n.locale === 'en-US') throw e
      warn(`What to test (${n.locale}) not set: ${e.message}`)
    }
  }
}

/** TestFlight's test information and the Beta App Review contact. Problems are warnings (they're usually set already). */
export async function testInformation({ api, log, warn }, appId, { cfg, metadata, invite, phone }) {
  try {
    const locs = many(await api.get(`/v1/apps/${appId}/betaAppLocalizations`, { limit: 50 }))
    for (const locale of LOCALES) {
      const m = metadata.locales[locale]
      const attributes = { feedbackEmail: cfg.feedbackEmail, marketingUrl: m.marketing_url, privacyPolicyUrl: m.privacy_url, description: m.description.slice(0, 4000) }
      const have = locs.find((l) => l.attributes?.locale === locale)
      if (have) await api.patch(`/v1/betaAppLocalizations/${have.id}`, { type: 'betaAppLocalizations', id: have.id, attributes })
      else await api.post('/v1/betaAppLocalizations', { type: 'betaAppLocalizations', attributes: { locale, ...attributes }, relationships: { app: rel('apps', appId) } })
    }
    log('TestFlight test information')
  } catch (e) { warn(`TestFlight test information not updated: ${e.message}`) }
  try {
    const detail = one(await maybe(api.get(`/v1/apps/${appId}/betaAppReviewDetail`)))
    if (detail) {
      await api.patch(`/v1/betaAppReviewDetails/${detail.id}`, { type: 'betaAppReviewDetails', id: detail.id, attributes: reviewContact(cfg, metadata, invite, phone) })
      log('Beta App Review contact and notes')
    }
  } catch (e) { warn(`Beta App Review details not updated: ${e.message}`) }
}

function reviewContact(cfg, metadata, invite, phone) {
  const c = cfg.contact ?? {}
  return {
    contactFirstName: c.firstName, contactLastName: c.lastName, contactEmail: c.email,
    ...(phone ? { contactPhone: phone } : {}),
    demoAccountRequired: false,
    notes: reviewNotes(metadata.reviewNotes, invite),
  }
}

/** The groups that get the build: internal ones ("all" or names) and external ones by name or public link id. */
export function pickGroups(groups, cfg) {
  const internal = groups.filter((g) => g.attributes.isInternalGroup && (cfg.internalGroups === 'all' || (cfg.internalGroups ?? []).includes(g.attributes.name)))
  const external = []
  for (const want of cfg.externalGroups ?? []) {
    const g = groups.find((x) => !x.attributes.isInternalGroup && ((want.publicLinkId && x.attributes.publicLinkId === want.publicLinkId) || (want.name && x.attributes.name === want.name)))
    if (!g) throw new AscError(`no external TestFlight group with ${want.publicLinkId ? `the public link ${want.publicLinkId}` : `the name "${want.name}"`} (mobile/store.json ios.externalGroups)`)
    external.push(g)
  }
  return { internal, external }
}

export async function distribute({ api, log }, appId, buildId, cfg) {
  const groups = many(await api.get(`/v1/apps/${appId}/betaGroups`, { limit: 200 }))
  const { internal, external } = pickGroups(groups, cfg)
  for (const g of [...internal, ...external]) {
    // Internal groups with access to all builds get every build by themselves.
    if (g.attributes.isInternalGroup && g.attributes.hasAccessToAllBuilds) { log(`TestFlight group "${g.attributes.name}" gets every build`); continue }
    await api.post(`/v1/betaGroups/${g.id}/relationships/builds`, [{ type: 'builds', id: buildId }])
    log(`TestFlight group "${g.attributes.name}"`)
  }
  return { internal, external }
}

/** Beta App Review, once per build (external testers get it when Apple approves; later builds are often approved at once). */
export async function submitBetaReview({ api, log }, buildId) {
  const existing = one(await maybe(api.get(`/v1/builds/${buildId}/betaAppReviewSubmission`)))
  if (existing) { log(`Beta App Review: ${existing.attributes?.betaReviewState ?? 'submitted'} already`); return existing.attributes?.betaReviewState ?? 'submitted' }
  try {
    const r = one(await api.post('/v1/betaAppReviewSubmissions', { type: 'betaAppReviewSubmissions', relationships: { build: rel('builds', buildId) } }))
    log(`Beta App Review: submitted (${r?.attributes?.betaReviewState ?? 'WAITING_FOR_REVIEW'})`)
    return r?.attributes?.betaReviewState ?? 'WAITING_FOR_REVIEW'
  } catch (e) {
    if (e.status === 409 && /already|submitted/i.test(e.message)) { log('Beta App Review: submitted already'); return 'submitted' }
    throw e
  }
}

// ── The App Store ──

const EDITABLE = ['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY']
const SUBMITTED = ['WAITING_FOR_REVIEW', 'IN_REVIEW', 'READY_FOR_REVIEW', 'PENDING_APPLE_RELEASE', 'PROCESSING_FOR_APP_STORE', 'PROCESSING_FOR_DISTRIBUTION']
const LIVE = ['READY_FOR_SALE', 'READY_FOR_DISTRIBUTION', 'PENDING_DEVELOPER_RELEASE', 'ACCEPTED']
const versionState = (v) => v.attributes?.appVersionState ?? v.attributes?.appStoreState

/** The App Store version to fill: this marketing version if it's open, the open one renamed, or a new one. */
export async function ensureVersion({ api, log }, appId, marketing, releaseType) {
  const versions = many(await api.get(`/v1/apps/${appId}/appStoreVersions`, { 'filter[platform]': 'IOS', limit: 50 }))
  const same = versions.find((v) => v.attributes?.versionString === marketing)
  if (same && LIVE.includes(versionState(same))) throw new AscError(`App Store version ${marketing} is already approved or on sale; the next release needs a higher version`)
  if (same && SUBMITTED.includes(versionState(same))) { log(`App Store version ${marketing}: ${versionState(same)}`); return { version: same, submitted: true } }
  let version = same && EDITABLE.includes(versionState(same)) ? same : versions.find((v) => EDITABLE.includes(versionState(v)))
  if (version) {
    await api.patch(`/v1/appStoreVersions/${version.id}`, { type: 'appStoreVersions', id: version.id, attributes: { versionString: marketing, releaseType } })
    log(`App Store version ${marketing} (${versionState(version)})`)
  } else {
    version = one(await api.post('/v1/appStoreVersions', { type: 'appStoreVersions', attributes: { platform: 'IOS', versionString: marketing, releaseType }, relationships: { app: rel('apps', appId) } }))
    log(`App Store version ${marketing}: created`)
  }
  return { version, submitted: false }
}

async function upsertLocalizations({ api }, list, create, update, locale, attributes) {
  const have = list.find((l) => l.attributes?.locale === locale)
  if (have) return update(have.id, attributes)
  return create(locale, attributes)
}

/** The version's texts per language; What's New is left out where Apple doesn't take it (an app's first version). */
export async function versionTexts(ctx, versionId, metadata, notes) {
  const { api, log } = ctx
  const list = many(await api.get(`/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations`, { limit: 50 }))
  for (const locale of LOCALES) {
    const m = metadata.locales[locale]
    const base = { description: m.description, keywords: m.keywords, promotionalText: m.promotional_text, marketingUrl: m.marketing_url, supportUrl: m.support_url }
    const withNotes = { ...base, whatsNew: notes.find((n) => n.locale === locale)?.text }
    const create = (l, a) => api.post('/v1/appStoreVersionLocalizations', { type: 'appStoreVersionLocalizations', attributes: { locale: l, ...a }, relationships: { appStoreVersion: rel('appStoreVersions', versionId) } })
    const update = (id, a) => api.patch(`/v1/appStoreVersionLocalizations/${id}`, { type: 'appStoreVersionLocalizations', id, attributes: a })
    try {
      await upsertLocalizations(ctx, list, create, update, locale, withNotes)
    } catch (e) {
      if (!/whatsNew/i.test(e.message)) throw e
      await upsertLocalizations(ctx, list, create, update, locale, base)
    }
    log(`App Store texts (${locale})`)
  }
  return many(await api.get(`/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations`, { limit: 50 }))
}

/** Name, subtitle and privacy policy (the app info that goes with the next version). */
export async function appInfoTexts(ctx, appId, metadata) {
  const { api, log } = ctx
  const infos = many(await api.get(`/v1/apps/${appId}/appInfos`, { limit: 10 }))
  const state = (i) => i.attributes?.state ?? i.attributes?.appStoreState
  const info = infos.find((i) => !LIVE.includes(state(i))) ?? infos[0]
  if (!info) throw new AscError('App Store Connect returned no app info')
  const list = many(await api.get(`/v1/appInfos/${info.id}/appInfoLocalizations`, { limit: 50 }))
  for (const locale of LOCALES) {
    const m = metadata.locales[locale]
    await upsertLocalizations(ctx, list,
      (l, a) => api.post('/v1/appInfoLocalizations', { type: 'appInfoLocalizations', attributes: { locale: l, ...a }, relationships: { appInfo: rel('appInfos', info.id) } }),
      (id, a) => api.patch(`/v1/appInfoLocalizations/${id}`, { type: 'appInfoLocalizations', id, attributes: a }),
      locale, { name: m.name, subtitle: m.subtitle, privacyPolicyUrl: m.privacy_url })
    log(`name and subtitle (${locale})`)
  }
  return info.id
}

/** The age rating answers (docs/store/appstore/age-rating.json). A refused answer is a warning: set it once by hand. */
export async function ageRating({ api, log, warn }, appInfoId, attributes) {
  if (!attributes) return
  try {
    const decl = one(await api.get(`/v1/appInfos/${appInfoId}/ageRatingDeclaration`))
    await api.patch(`/v1/ageRatingDeclarations/${decl.id}`, { type: 'ageRatingDeclarations', id: decl.id, attributes })
    log('age rating')
  } catch (e) { warn(`age rating not set through the API (${e.message}); answer it once in App Store Connect (docs/store/appstore/age-rating.md)`) }
}

export async function appReviewDetail({ api, log }, versionId, attributes) {
  const have = one(await maybe(api.get(`/v1/appStoreVersions/${versionId}/appStoreReviewDetail`)))
  if (have) await api.patch(`/v1/appStoreReviewDetails/${have.id}`, { type: 'appStoreReviewDetails', id: have.id, attributes })
  else await api.post('/v1/appStoreReviewDetails', { type: 'appStoreReviewDetails', attributes, relationships: { appStoreVersion: rel('appStoreVersions', versionId) } })
  log('App Review information')
}

const md5 = (bytes) => createHash('md5').update(bytes).digest('hex')

/** Screenshots per language and device; a set is replaced only when its files changed. No files: left as it is. */
export async function screenshots(ctx, localizations, metadata) {
  const { api, log } = ctx
  for (const loc of localizations) {
    const m = metadata.locales[loc.attributes?.locale]
    if (!m) continue
    const sets = many(await api.get(`/v1/appStoreVersionLocalizations/${loc.id}/appScreenshotSets`, { limit: 50 }))
    for (const [type, files] of Object.entries(m.screenshots)) {
      if (!files.length) continue
      let set = sets.find((s) => s.attributes?.screenshotDisplayType === type)
      if (!set) set = one(await api.post('/v1/appScreenshotSets', { type: 'appScreenshotSets', attributes: { screenshotDisplayType: type }, relationships: { appStoreVersionLocalization: rel('appStoreVersionLocalizations', loc.id) } }))
      const have = many(await api.get(`/v1/appScreenshotSets/${set.id}/appScreenshots`, { limit: 50 }))
      const want = files.map((f) => md5(f.bytes))
      if (have.length === want.length && have.every((s, i) => s.attributes?.sourceFileChecksum === want[i])) continue
      for (const s of have) await api.del(`/v1/appScreenshots/${s.id}`)
      for (const f of files) {
        const shot = one(await api.post('/v1/appScreenshots', { type: 'appScreenshots', attributes: { fileName: f.name, fileSize: f.bytes.length }, relationships: { appScreenshotSet: rel('appScreenshotSets', set.id) } }))
        for (const op of shot.attributes?.uploadOperations ?? []) await api.upload(op, f.bytes)
        await api.patch(`/v1/appScreenshots/${shot.id}`, { type: 'appScreenshots', id: shot.id, attributes: { uploaded: true, sourceFileChecksum: md5(f.bytes) } })
      }
      log(`screenshots ${type} (${loc.attributes.locale}): ${files.length}`)
    }
  }
}

/** Submits the version for App Review (one review submission with the version in it). */
export async function submitForReview({ api, log }, appId, versionId) {
  const open = many(await api.get(`/v1/apps/${appId}/reviewSubmissions`, { 'filter[platform]': 'IOS', 'filter[state]': 'READY_FOR_REVIEW,WAITING_FOR_REVIEW,IN_REVIEW,UNRESOLVED_ISSUES', limit: 10 }))
  const waiting = open.find((s) => ['WAITING_FOR_REVIEW', 'IN_REVIEW'].includes(s.attributes?.state))
  if (waiting) { log(`App Review: ${waiting.attributes.state} already`); return waiting.attributes.state }
  const draft = open.find((s) => ['READY_FOR_REVIEW', 'UNRESOLVED_ISSUES'].includes(s.attributes?.state))
    ?? one(await api.post('/v1/reviewSubmissions', { type: 'reviewSubmissions', attributes: { platform: 'IOS' }, relationships: { app: rel('apps', appId) } }))
  try {
    await api.post('/v1/reviewSubmissionItems', { type: 'reviewSubmissionItems', relationships: { reviewSubmission: rel('reviewSubmissions', draft.id), appStoreVersion: rel('appStoreVersions', versionId) } })
  } catch (e) { if (e.status !== 409) throw e }
  await api.patch(`/v1/reviewSubmissions/${draft.id}`, { type: 'reviewSubmissions', id: draft.id, attributes: { submitted: true } })
  log('App Review: submitted; it goes on sale by itself once approved')
  return 'WAITING_FOR_REVIEW'
}

/** Everything for one build, by mode. Returns a short summary. */
export async function run(ctx, { mode, cfg, version, marketing, buildNumber, notes, metadata, invite, phone, timeoutMs }) {
  const { api, log } = ctx
  if (mode === 'upload') { log('store mode "upload": nothing to do after the upload'); return { mode } }
  if (mode !== 'testflight' && mode !== 'appstore') throw new AscError(`unknown mode '${mode}' (testflight, appstore or upload)`)
  if (mode === 'appstore' && !invite) throw new AscError('no review invite: set the repository variable REVIEW_INVITE_URL to an invite to the review server (docs/store/appstore/README.md)')
  const appId = await findApp(api, cfg.bundleId)
  const build = await waitForBuild(ctx, { appId, marketing, buildNumber, timeoutMs })
  await exportCompliance(ctx, build)
  // Test information first: it adds the Swedish TestFlight language that Swedish "What to test" needs.
  await testInformation(ctx, appId, { cfg, metadata, invite, phone })
  await setWhatToTest(ctx, build.id, notes)
  const groups = await distribute(ctx, appId, build.id, cfg)
  let beta = 'not submitted'
  if (cfg.submitForBetaReview && groups.external.length) beta = await submitBetaReview(ctx, build.id)
  const summary = { mode, build: build.id, groups: [...groups.internal, ...groups.external].map((g) => g.attributes.name), betaReview: beta }
  if (mode === 'testflight') return summary

  const { version: v, submitted } = await ensureVersion(ctx, appId, marketing, cfg.releaseType)
  if (submitted) return { ...summary, appStore: versionState(v) }
  await api.patch(`/v1/appStoreVersions/${v.id}/relationships/build`, { type: 'builds', id: build.id })
  log(`App Store version ${marketing}: build ${buildNumber}`)
  const localizations = await versionTexts(ctx, v.id, metadata, notes)
  const infoId = await appInfoTexts(ctx, appId, metadata)
  await ageRating(ctx, infoId, metadata.ageRating)
  await appReviewDetail(ctx, v.id, reviewContact(cfg, metadata, invite, phone))
  await screenshots(ctx, localizations, metadata)
  const review = await submitForReview(ctx, appId, v.id)
  return { ...summary, appStore: review }
}

// ── Command line ──

function parseArgs(argv) {
  const args = { mode: argv[0], dryRun: false }
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    const next = () => { const v = argv[++i]; if (v === undefined) throw new AscError(`${a} needs a value`); return v }
    if (a === '--version') args.version = next()
    else if (a === '--marketing') args.marketing = next()
    else if (a === '--build-number') args.buildNumber = next()
    else if (a === '--key') args.key = next()
    else if (a === '--dry-run') args.dryRun = true
    else throw new AscError(`unknown option ${a}`)
  }
  return args
}

export async function main(argv, { env = process.env, fetchImpl = fetch, tokenFor = ascToken, print = console.log, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(), config = storeConfig(), metadataDir, timeoutMs } = {}) {
  const warnings = []
  try {
    const args = parseArgs(argv)
    const mode = args.mode === 'auto' || !args.mode ? config.mode : args.mode
    if (mode === 'upload') { print('App Store Connect: mode "upload", nothing more to do.'); return 0 }
    if (!/^\d+\.\d+\.\d+(-(alpha|beta|rc)\.\d+)?$/.test(args.version ?? '')) throw new AscError(`'${args.version ?? ''}' isn't a version`)
    if (!/^\d+\.\d+\.\d+$/.test(args.marketing ?? '')) throw new AscError(`'${args.marketing ?? ''}' isn't a marketing version (x.y.z)`)
    if (!/^\d+(\.\d+)*$/.test(args.buildNumber ?? '')) throw new AscError(`'${args.buildNumber ?? ''}' isn't a build number`)
    const notes = whatsNew(args.version)
    const metadata = loadMetadata(metadataDir)
    const invite = env.REVIEW_INVITE_URL || ''
    if (args.dryRun) {
      print(`DRY RUN ${mode}: build ${args.marketing} (${args.buildNumber}); What to test:`)
      for (const n of notes) print(`  [${n.locale}] ${n.text.replace(/\n/g, ' / ').slice(0, 200)}`)
      return 0
    }
    if (!env.APPSTORE_KEY_ID || !env.APPSTORE_ISSUER_ID || !args.key || !existsSync(args.key)) throw new AscError('the App Store Connect API key is missing (APPSTORE_KEY_ID, APPSTORE_ISSUER_ID and --key)')
    const api = ascApi({ token: await tokenFor({ keyPath: args.key, keyId: env.APPSTORE_KEY_ID, issuerId: env.APPSTORE_ISSUER_ID }), fetchImpl, base: env.ISKRA_ASC_API || API })
    const ctx = { api, sleep, now, log: (l) => print(`  ${l}`), warn: (l) => { warnings.push(l); print(`::warning::${l}`) } }
    const r = await run(ctx, { mode, cfg: config, version: args.version, marketing: args.marketing, buildNumber: args.buildNumber, notes, metadata, invite, phone: env.APPSTORE_REVIEW_PHONE || '', timeoutMs })
    print(`App Store Connect: ${mode === 'appstore' ? `App Store ${r.appStore}; ` : ''}TestFlight groups ${r.groups.map((g) => `"${g}"`).join(', ') || '(none)'}; Beta App Review ${r.betaReview}`)
    return 0
  } catch (e) {
    print(`App Store Connect stopped: ${e instanceof AscError ? e.message : (e?.message ?? String(e))}`)
    return 1
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2))
}
