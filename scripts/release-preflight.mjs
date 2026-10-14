#!/usr/bin/env node
// Step of scripts/release.ps1 (the one release command); not run by hand. Checks for its check phase.
//
//   node scripts/release-preflight.mjs next-version [--repo owner/name]   the next alpha after the latest release
//   node scripts/release-preflight.mjs store                               mobile/store.json is valid
//   node scripts/release-preflight.mjs github [--skip-phones] [--repo owner/name]
//                                     the secrets and variables the release workflows need (names only, via gh),
//                                     and whether an environment still waits for a reviewer
//
// Prints one line per finding: "red: ..." (the release can't go), "warn: ..." or "ok: ...". Exit 1 on any red.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareVersions, parseVersion } from './release-lib.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The next alpha after the newest of the latest release and desktop/package.json; null after a final release. */
export function nextVersion(latestTag, packageVersion) {
  const candidates = [String(latestTag ?? '').replace(/^v/, ''), packageVersion].filter((v) => parseVersion(v))
  if (!candidates.length) return null
  const newest = candidates.sort(compareVersions).at(-1)
  const v = parseVersion(newest)
  if (v.alpha === null) return null
  return `${v.major}.${v.minor}.${v.patch}-alpha.${v.alpha + 1}`
}

const IOS_MODES = ['testflight', 'appstore', 'upload']
const ANDROID_TRACK = /^[A-Za-z0-9][A-Za-z0-9 _.:-]{0,49}$/

/** What's wrong with mobile/store.json (an empty list when it's fine). `exists` checks a repo-relative path. */
export function storeProblems(store, exists = (p) => existsSync(join(root, p))) {
  const p = []
  if (!store || typeof store !== 'object') return ['mobile/store.json is not a JSON object']
  const ios = store.ios, android = store.android
  if (!ios || typeof ios !== 'object') p.push('mobile/store.json has no "ios" section')
  else {
    if (!IOS_MODES.includes(ios.mode)) p.push(`mobile/store.json ios.mode is "${ios.mode}"; use ${IOS_MODES.join(', ')}`)
    if (ios.bundleId !== 'foo.iskra.app') p.push(`mobile/store.json ios.bundleId is "${ios.bundleId}", not foo.iskra.app`)
    if (ios.externalGroups !== undefined) {
      if (!Array.isArray(ios.externalGroups)) p.push('mobile/store.json ios.externalGroups must be a list')
      else for (const g of ios.externalGroups) if (!g || (typeof g.publicLinkId !== 'string' && typeof g.name !== 'string')) p.push('mobile/store.json ios.externalGroups: each entry needs "publicLinkId" or "name"')
    }
    if (ios.internalGroups !== undefined && ios.internalGroups !== 'all' && !Array.isArray(ios.internalGroups)) p.push('mobile/store.json ios.internalGroups must be "all" or a list of names')
    if (ios.mode === 'appstore' && !ios.contact?.email) p.push('mobile/store.json ios.contact.email is needed for App Review')
  }
  if (!android || typeof android !== 'object') p.push('mobile/store.json has no "android" section')
  else {
    if (typeof android.track !== 'string' || !ANDROID_TRACK.test(android.track)) p.push(`mobile/store.json android.track "${android.track}" isn't a track name`)
    const r = android.rollout ?? 1
    if (typeof r !== 'number' || !(r > 0 && r <= 1)) p.push(`mobile/store.json android.rollout is ${r}; use a number above 0 and at most 1`)
    else if (r < 1 && android.track !== 'production') p.push('mobile/store.json android.rollout below 1 only works on the production track')
    for (const k of ['listing', 'dataSafety']) if (android[k] !== undefined && typeof android[k] !== 'boolean') p.push(`mobile/store.json android.${k} must be true or false`)
    if (android.dataSafety && !exists('docs/store/play/data-safety.csv')) p.push('mobile/store.json android.dataSafety is on but docs/store/play/data-safety.csv is missing')
  }
  return p
}

/**
 * The GitHub secret and variable names the release needs. `either` names may be repo secrets or secrets of the
 * `release` environment (deploy.yml reads them there).
 */
export function requiredNames(store, { skipPhones = false } = {}) {
  const secrets = ['MAC_CERT_P12_BASE64', 'MAC_CERT_PASSWORD', 'APPSTORE_API_KEY_BASE64', 'APPSTORE_KEY_ID', 'APPSTORE_ISSUER_ID']
  const variables = ['CLOUDFLARE_ACCOUNT_ID', 'DROPLET_HOST', 'DROPLET_KNOWN_HOSTS', 'MAC_IDENTITY']
  if (!skipPhones && store?.ios?.mode === 'appstore') variables.push('REVIEW_INVITE_URL')
  return { secrets, either: ['CLOUDFLARE_API_TOKEN', 'DROPLET_SSH_KEY'], variables }
}

/** red/warn/ok findings for the names GitHub has (`have`: { secrets, envSecrets, variables } arrays of names). */
export function nameFindings(required, have, store, { skipPhones = false } = {}) {
  const out = []
  const has = (list, n) => (list ?? []).includes(n)
  const settings = 'GitHub → quikmn/iskra-voice → Settings → Secrets and variables → Actions'
  for (const n of required.secrets) if (!has(have.secrets, n)) out.push({ level: 'red', text: `secret ${n} is missing (${settings}; docs/ci-cd.md section 4)` })
  for (const n of required.either) if (!has(have.secrets, n) && !has(have.envSecrets, n)) out.push({ level: 'red', text: `secret ${n} is missing (repo or environment "release"; docs/ci-cd.md section 4)` })
  for (const n of required.variables) {
    if (has(have.variables, n)) continue
    const why = n === 'REVIEW_INVITE_URL' ? ': phase B (ios.mode appstore) needs the review invite (docs/store/README.md, "Review invite")' : ''
    out.push({ level: 'red', text: `variable ${n} is missing (${settings} → Variables)${why}` })
  }
  if (!skipPhones && store?.ios?.mode === 'testflight' && !has(have.variables, 'REVIEW_INVITE_URL')) out.push({ level: 'warn', text: 'variable REVIEW_INVITE_URL is not set: Beta App Review notes say to write to spark@iskra.foo (docs/store/README.md)' })
  if (!skipPhones && !has(have.secrets, 'APPSTORE_REVIEW_PHONE')) out.push({ level: 'warn', text: 'secret APPSTORE_REVIEW_PHONE is not set: App Review gets no contact phone (docs/store/README.md)' })
  if (!out.some((f) => f.level === 'red')) out.push({ level: 'ok', text: 'the GitHub secrets and variables the release needs are there' })
  return out
}

/** A warning per environment that still has required reviewers (a run would wait for a click in GitHub). */
export function reviewerFindings(environments) {
  return (environments ?? [])
    .filter((e) => (e.protection_rules ?? []).some((r) => r.type === 'required_reviewers'))
    .map((e) => ({ level: 'warn', text: `environment "${e.name}" has required reviewers, so its runs wait for an approval: GitHub → quikmn/iskra-voice → Settings → Environments → ${e.name} → untick "Required reviewers" → Save protection rules` }))
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GH_PROMPT_DISABLED: '1' } })
}
const names = (args) => gh([...args, '--json', 'name', '--jq', '.[].name']).split(/\r?\n/).filter(Boolean)
const readStore = () => JSON.parse(readFileSync(join(root, 'mobile/store.json'), 'utf8'))
const print = (findings) => { for (const f of findings) console.log(`${f.level}: ${f.text}`); return findings.some((f) => f.level === 'red') ? 1 : 0 }

function main(argv) {
  const [cmd, ...rest] = argv
  const opt = (name, fallback) => { const i = rest.indexOf(name); return i === -1 ? fallback : rest[i + 1] }
  const repo = opt('--repo', 'quikmn/iskra-voice')
  const skipPhones = rest.includes('--skip-phones')
  if (cmd === 'next-version') {
    let latest = ''
    try { latest = gh(['release', 'view', '-R', repo, '--json', 'tagName', '--jq', '.tagName']).trim() } catch { /* no release yet */ }
    const pkg = JSON.parse(readFileSync(join(root, 'desktop/package.json'), 'utf8')).version
    const v = nextVersion(latest, pkg)
    if (!v) { console.error(`red: can't pick the next version after ${latest || pkg}: give it (release.ps1 <version>)`); return 1 }
    console.log(v)
    return 0
  }
  if (cmd === 'store') {
    let store
    try { store = readStore() } catch (e) { return print([{ level: 'red', text: `mobile/store.json can't be read: ${e.message}` }]) }
    const p = storeProblems(store)
    return print(p.length ? p.map((text) => ({ level: 'red', text })) : [{ level: 'ok', text: `mobile/store.json is valid (iOS ${store.ios.mode}, Google Play track '${store.android.track}')` }])
  }
  if (cmd === 'github') {
    let store = null
    try { store = readStore() } catch { /* reported by "store" */ }
    let have, environments
    try {
      have = { secrets: names(['secret', 'list', '-R', repo]), envSecrets: names(['secret', 'list', '-R', repo, '--env', 'release']), variables: names(['variable', 'list', '-R', repo]) }
      environments = JSON.parse(gh(['api', `repos/${repo}/environments`])).environments
    } catch (e) {
      return print([{ level: 'red', text: `couldn't list the GitHub secrets and variables (${String(e.stderr || e.message).trim().split('\n')[0]})` }])
    }
    return print([...nameFindings(requiredNames(store, { skipPhones }), have, store, { skipPhones }), ...reviewerFindings(environments)])
  }
  console.error('usage: node scripts/release-preflight.mjs next-version | store | github [--skip-phones]')
  return 2
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)))
