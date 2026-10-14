#!/usr/bin/env node
// Uploads the Android app bundle to Google Play with the Android Publisher API (scripts/release-all.ps1 runs it after a
// release is published; docs/ci-cd.md "Google Play uploads"). One edit: upload the bundle (unless Play already has that
// version code), put it on a track with release notes in English and Swedish, commit. Running it again for a version
// that is already on the track changes nothing, so a resumed release can call it again.
//
//   node scripts/play-upload.mjs <version> [--aab mobile/release/Iskra-<version>.aab] [--track alpha]
//        [--status completed] [--rebuild 0] [--key <service-account.json>] [--dry-run | --check]
//
// --check only looks for the key (exit 0 found, 2 missing); --dry-run also checks the bundle and prints the notes.
//
// Auth: a Google Cloud service account's JSON key (default: devkeys\iskra-play-publisher.json in the folder above the
// repo that has devkeys\, else D:\Development_Projects; ISKRA_PLAY_KEY overrides). The key file is only read by
// google-auth-library (mobile/node_modules) and never printed. No key: prints why and exits 2 (a skip, not a failure).
// Exit 0: the version is on the track. Exit 1: it isn't (one "Play upload stopped: ..." line says why).
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
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
export function playNotes(markdown, { version, lang = 'en', max = NOTES_MAX }) {
  const s = sections(markdown)
  const pick = (...names) => names.flatMap((n) => s[n] ?? [])
  const items = [...pick("what's new", 'nytt', 'nyheter'), ...pick('fixes', 'fixar')].map(headline).filter(Boolean)
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
  async function call(method, path, { json, body, contentType, query, upload = false } = {}) {
    const url = new URL(`${upload ? '/upload' : ''}${app}${path}`, base)
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v))
    const headers = { authorization: `Bearer ${await token()}` }
    if (json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(json) }
    else if (contentType) headers['content-type'] = contentType
    const res = await fetchImpl(url.href, { method, headers, body })
    const text = await res.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = null }
    if (!res.ok) {
      const err = data?.error
      const reason = err?.errors?.[0]?.reason ?? err?.status ?? ''
      throw new PlayError(`${method} ${path || '/'}: ${res.status} ${err?.message ?? text.slice(0, 200)}`.trim(), { status: res.status, reason })
    }
    return data
  }
  return {
    insertEdit: () => call('POST', '/edits', { json: {} }),
    deleteEdit: (edit) => call('DELETE', `/edits/${edit}`),
    listBundles: (edit) => call('GET', `/edits/${edit}/bundles`),
    uploadBundle: (edit, bytes) => call('POST', `/edits/${edit}/bundles`, { upload: true, body: bytes, contentType: 'application/octet-stream', query: { uploadType: 'media' } }),
    getTrack: (edit, track) => call('GET', `/edits/${edit}/tracks/${encodeURIComponent(track)}`),
    updateTrack: (edit, track, releases) => call('PUT', `/edits/${edit}/tracks/${encodeURIComponent(track)}`, { json: { track, releases } }),
    commit: (edit, query) => call('POST', `/edits/${edit}:commit`, { query }),
  }
}

export function checkTrack(track) {
  if (typeof track !== 'string' || !/^[\p{L}\p{N} _.:-]{1,100}$/u.test(track)) throw new PlayError(`'${track}' isn't a track name (internal, alpha = closed testing, beta = open testing, production, or a custom closed track's name)`)
  return track
}

/**
 * Puts the bundle on the track in one edit. Steps are logged through `log`. Returns { versionCode, uploaded,
 * unchanged, status, committedForReview }.
 */
export async function publishToPlay({ api, bytes, versionCode, version, track = 'alpha', status = 'completed', notes, log = () => {} }) {
  checkTrack(track)
  if (!STATUSES.includes(status)) throw new PlayError(`'${status}' isn't a release status (${STATUSES.join(', ')})`)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
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
    try { current = (await api.getTrack(edit, track))?.releases ?? [] } catch (e) { if (e.status !== 404) throw e }
    const already = current.find((r) => (r.versionCodes ?? []).map(String).includes(code))
    if (already && (already.status === status || already.status === 'completed')) {
      log(`version code ${code} is already on the '${track}' track (${already.status}); nothing to change`)
      await api.deleteEdit(edit).catch(() => {})
      committed = true
      return { versionCode: code, uploaded, unchanged: true, status: already.status }
    }

    const release = (s) => ({ name: version, versionCodes: [code], status: s, releaseNotes: notes })
    let finalStatus = status
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

// ── Command line ──

/** devkeys\ lives in the nearest folder above the repo that has one (D:\Development_Projects on the owner's PC). */
export function defaultKeyPath(start = root, env = process.env) {
  if (env.ISKRA_PLAY_KEY) return env.ISKRA_PLAY_KEY
  let dir = start
  for (;;) {
    if (existsSync(join(dir, 'devkeys'))) return join(dir, 'devkeys', 'iskra-play-publisher.json')
    const up = dirname(dir)
    if (up === dir) return join('D:\\Development_Projects', 'devkeys', 'iskra-play-publisher.json')
    dir = up
  }
}

async function googleToken(keyFile) {
  const require = createRequire(join(root, 'mobile', 'package.json'))
  let lib
  try { lib = await import(pathToFileURL(require.resolve('google-auth-library')).href) } catch {
    throw new PlayError('google-auth-library is missing: run npm ci in mobile/')
  }
  const auth = new lib.GoogleAuth({ keyFile, scopes: [SCOPE] })
  return async () => {
    const t = await auth.getAccessToken()
    if (!t) throw new PlayError('Google gave no access token for the service account')
    return t
  }
}

function parseArgs(argv) {
  const args = { version: argv[0], track: 'alpha', status: 'completed', rebuild: 0, dryRun: false, check: false }
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    const next = () => { const v = argv[++i]; if (v === undefined) throw new PlayError(`${a} needs a value`); return v }
    if (a === '--aab') args.aab = next()
    else if (a === '--track') args.track = next()
    else if (a === '--status') args.status = next()
    else if (a === '--rebuild') args.rebuild = Number(next())
    else if (a === '--key') args.key = next()
    else if (a === '--dry-run') args.dryRun = true
    else if (a === '--check') args.check = true
    else throw new PlayError(`unknown option ${a}`)
  }
  return args
}

export async function main(argv, { env = process.env, fetchImpl = fetch, tokenFor = googleToken, print = console.log } = {}) {
  try {
    const args = parseArgs(argv)
    if (!/^\d+\.\d+\.\d+(-(alpha|beta|rc)\.\d+)?$/.test(args.version ?? '')) throw new PlayError(`'${args.version ?? ''}' isn't a version (x.y.z or x.y.z-alpha.n, no leading v)`)
    checkTrack(args.track)
    const versionCode = androidVersionCode(args.version, args.rebuild)
    const aab = resolve(args.aab ?? join(root, 'mobile', 'release', `Iskra-${args.version}.aab`))
    const key = args.key ?? defaultKeyPath(root, env)
    if (!existsSync(key)) {
      print(`Play upload skipped: no service-account key at ${key} (docs/ci-cd.md, "Google Play uploads", sets one up). Upload ${aab} in Play Console instead.`)
      return 2
    }
    if (args.check) {
      print(`Play upload: service-account key found (${key})`)
      return 0
    }
    const notes = releaseNotesFor(args.version)
    if (!existsSync(aab)) throw new PlayError(`${aab} is missing: build it with mobile/scripts/build-android.ps1 on the release tag`)
    if (args.dryRun) {
      print(`DRY RUN would upload ${aab} (version code ${versionCode}) to Google Play's '${args.track}' track as ${args.status}, notes:`)
      for (const n of notes) print(`  [${n.language}] ${n.text.replace(/\n/g, ' / ')}`)
      return 0
    }
    const api = playApi({ token: await tokenFor(key), fetchImpl, base: env.ISKRA_PLAY_API || API })
    const result = await publishToPlay({
      api, bytes: readFileSync(aab), versionCode, version: args.version, track: args.track, status: args.status, notes,
      log: (line) => print(`  ${line}`),
    })
    const review = result.committedForReview === false ? '; send it for review in Play Console' : ''
    print(`Play: Iskra ${args.version} (version code ${result.versionCode}) is on the '${args.track}' track (${result.status})${result.unchanged ? ', already' : ''}${review}`)
    return 0
  } catch (e) {
    print(`Play upload stopped: ${e instanceof PlayError ? e.message : (e?.message ?? String(e))}`)
    return 1
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2))
}
