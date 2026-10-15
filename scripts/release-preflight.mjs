#!/usr/bin/env node
// Step of scripts/release.ps1 (the one release command) and of the Release workflow (release-all.yml); not run by
// hand. Checks for their check phase.
//
//   node scripts/release-preflight.mjs next-version [--repo owner/name]   the next alpha after the latest release
//   node scripts/release-preflight.mjs store                               mobile/store.json is valid
//   node scripts/release-preflight.mjs github [--skip-phones] [--repo owner/name]
//                                     the secrets and variables the release workflows need (names only, via gh),
//                                     and whether an environment still waits for a reviewer
//   node scripts/release-preflight.mjs release [<version>] [--skip-phones] [--android-ci] [--repo owner/name] [--ci-wait 30]
//                                     the Release workflow's checks on GitHub: what release.ps1's check phase checks
//                                     that doesn't need the home PC (that's release-pc-checks.ps1). Secret names come
//                                     from HAS_<NAME>=true|false and variables from VARS_JSON (the workflow passes
//                                     them; a job can't list secrets). Writes version= and tag= to $GITHUB_OUTPUT.
//
// Prints one line per finding: "red: ..." (the release can't go), "warn: ..." or "ok: ...". Exit 1 on any red.
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { waitForCi } from './ci-gate.mjs'
import { compareVersions, isValidVersion, parseVersion } from './release-lib.mjs'

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

/** The workflows a release runs (they must be active). */
export const RELEASE_WORKFLOWS = ['ci.yml', 'release.yml', 'release-finalize.yml', 'deploy.yml', 'mobile-ios.yml']

/**
 * The commit CI must have passed on: HEAD, or the newest commit before it that CI ran on or would run on (CI skips
 * pushes that only change *.md and site/). `hasRun(c)`: CI has a push run there; `files(c)`: the files c changes.
 */
export function ciCommit(commits, hasRun, files) {
  let sha = commits[0]
  for (const c of commits) {
    sha = c
    if (hasRun(c)) break
    if (files(c).some((f) => !/\.md$/.test(f) && !f.startsWith('site/'))) break
  }
  return sha
}

/**
 * The Release workflow's findings from what was looked up (`f`), with the same cases as release.ps1's check phase:
 * "[case] what to do".
 */
export function releaseFindings(f) {
  const out = []
  const red = (c, t) => out.push({ level: 'red', text: `[${c}] ${t}` })
  const ok = (t) => out.push({ level: 'ok', text: t })
  const off = Object.entries(f.workflows ?? {}).filter(([, state]) => state !== 'active')
  if (off.length) red('workflow off', `not active on GitHub: ${off.map(([n, s]) => `${n} (${s})`).join(', ')}. Enable it under Actions.`)
  else ok(`workflows active: ${Object.keys(f.workflows ?? {}).join(', ')}`)
  if (f.versionError) { red('which version?', f.versionError); return out }
  if (f.tagExists) red(`tag v${f.version} already exists`, 'pick the next version. Never move tags.')
  if (f.releaseExists) red(`a release v${f.version} already exists`, 'report it (a draft without a tag?).')
  if (compareVersions(f.version, f.current) <= 0) red('must be newer than the current version', `${f.version} isn't newer than ${f.current}.`)
  else ok(`${f.current} -> ${f.version}`)
  if (f.notes.code !== 0) red('write the release notes first', `${String(f.notes.message || 'release-notes.mjs stopped').replace(/\.$/, '')}. Add the changes to docs/releases/NEXT.md (or write docs/releases/${f.version}.md).`)
  else ok('release notes are ready')
  if (f.bump.code !== 0) red("doesn't mention the current version", `${String(f.bump.message || 'release-version.mjs stopped').replace(/\.$/, '')}. links.ts or site/index.html is out of sync with desktop/package.json.`)
  else if ((f.bump.siteCount ?? 0) < 20) red('site download section', `site/index.html has ${f.bump.siteCount ?? 0} links to ${f.current} (20 or more expected). Fix its download section.`)
  else if (!f.bump.links) red('links.ts', `client/src/links.ts doesn't carry ${f.current}.`)
  else ok(`desktop/package.json, client/src/links.ts and site/index.html all say ${f.current}`)
  if (f.assets.listed !== f.assets.want || f.assets.listed < 20) red('release file list', `scripts/release-assets.mjs lists ${f.assets.listed} files, scripts/release-assets.json has ${f.assets.want}. Report it.`)
  else ok(`the release will carry ${f.assets.listed} files`)
  for (const p of f.store ?? []) red('store setup', p)
  for (const n of f.names ?? []) {
    if (n.level === 'red') red('GitHub setup', n.text)
    else out.push(n)
  }
  if (!f.ci.ok) {
    if (f.ci.timedOut) red('CI not done', `${f.ci.message}. Press Release again when CI on main is green.`)
    else red('CI failed on main', `${f.ci.message}. Fix main first (a flake: re-run CI's failed jobs), then press Release again.`)
  } else ok(f.ci.message)
  return out
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GH_PROMPT_DISABLED: '1' } })
}
const names = (args) => gh([...args, '--json', 'name', '--jq', '.[].name']).split(/\r?\n/).filter(Boolean)
const readStore = () => JSON.parse(readFileSync(join(root, 'mobile/store.json'), 'utf8'))
const print = (findings) => { for (const f of findings) console.log(`${f.level}: ${f.text}`); return findings.some((f) => f.level === 'red') ? 1 : 0 }

const lines = (text) => String(text ?? '').split(/\r?\n/)
function runNode(args) {
  const r = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' })
  const all = lines(`${r.stdout}\n${r.stderr}`)
  const stop = all.find((l) => l.startsWith('Release stopped:'))
  return { code: r.status, lines: all, message: stop ? stop.replace(/^Release stopped:\s*/, '') : '' }
}
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim()

async function releaseCommand(rest, { repo, skipPhones }) {
  const valued = ['--repo', '--ci-wait']
  const positional = rest.filter((a, i) => !a.startsWith('--') && !valued.includes(rest[i - 1]))
  const ciWait = Number((rest.includes('--ci-wait') ? rest[rest.indexOf('--ci-wait') + 1] : '') || 30)
  const current = JSON.parse(readFileSync(join(root, 'desktop/package.json'), 'utf8')).version
  const f = { current, workflows: {} }
  for (const wf of RELEASE_WORKFLOWS) {
    try { f.workflows[wf] = gh(['api', `repos/${repo}/actions/workflows/${wf}`, '--jq', '.state']).trim() } catch { f.workflows[wf] = 'unknown' }
  }
  let latest = ''
  try { latest = gh(['release', 'view', '-R', repo, '--json', 'tagName', '--jq', '.tagName']).trim() } catch { /* none yet */ }
  f.version = positional[0] || nextVersion(latest, current)
  if (!f.version) f.versionError = `can't pick the next version after ${latest || current}: give it (the version input)`
  else if (!isValidVersion(f.version)) f.versionError = `'${f.version}' isn't a release version (x.y.z or x.y.z-alpha.n, no leading v)`
  if (!f.versionError) {
    const tag = `v${f.version}`
    f.tagExists = git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`) !== ''
    try { gh(['release', 'view', tag, '-R', repo, '--json', 'tagName']); f.releaseExists = true } catch { f.releaseExists = false }
    f.notes = runNode(['scripts/release-notes.mjs', f.version, '--dry-run'])
    const bump = runNode(['scripts/release-version.mjs', f.version, '--dry-run'])
    const site = bump.lines.find((l) => /site\/index\.html: \d+ occurrence/.test(l))
    f.bump = { code: bump.code, message: bump.message, siteCount: site ? Number(/(\d+) occurrence/.exec(site)[1]) : 0, links: bump.lines.some((l) => /client\/src\/links\.ts: \d+ occurrence/.test(l)) }
    const listed = runNode(['scripts/release-assets.mjs', 'list', f.version])
    const spec = JSON.parse(readFileSync(join(root, 'scripts/release-assets.json'), 'utf8'))
    f.assets = { listed: listed.code === 0 ? listed.lines.filter(Boolean).length : 0, want: Object.entries(spec).filter(([k]) => k !== '$comment').flatMap(([, v]) => [v].flat()).length }
  }
  let store = null
  try { store = readStore() } catch (e) { f.store = [`mobile/store.json can't be read: ${e.message}`] }
  if (store && !skipPhones) f.store = storeProblems(store)
  // Names only: the workflow says which secrets are set (HAS_<NAME>) and passes the variables (not secret).
  const required = requiredNames(store, { skipPhones })
  const present = [...required.secrets, ...required.either, 'APPSTORE_REVIEW_PHONE'].filter((n) => process.env[`HAS_${n}`] === 'true')
  let vars = {}
  try { vars = JSON.parse(process.env.VARS_JSON || '{}') } catch { /* none */ }
  f.names = nameFindings(required, { secrets: present, envSecrets: present, variables: Object.keys(vars) }, store, { skipPhones })
  const wif = Boolean(vars.GCP_WIF_PROVIDER && vars.GCP_PLAY_SERVICE_ACCOUNT)
  if (rest.includes('--android-ci') && !wif) f.names.push({ level: 'red', text: 'variable ANDROID_BUILD is "ci" (the Android app built on GitHub), which needs Google workload identity federation: set GCP_WIF_PROVIDER and GCP_PLAY_SERVICE_ACCOUNT (docs/ci-cd.md, "Google Play without a key file"), or delete ANDROID_BUILD' })
  else if (!wif && !skipPhones) f.names.push({ level: 'warn', text: "Google Play uploads use the home PC's key file (no workload identity federation yet: docs/ci-cd.md, \"Google Play without a key file\")" })
  // CI on main's head (or the newest commit CI runs on), waiting while it runs.
  const commits = git('rev-list', '--first-parent', '-n', '30', 'HEAD').split('\n').filter(Boolean)
  const sha = ciCommit(commits, (c) => {
    try { return Number(gh(['api', `repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${c}&event=push&per_page=1`, '--jq', '.total_count']).trim()) > 0 } catch { return false }
  }, (c) => git('diff-tree', '--no-commit-id', '--name-only', '-r', c).split('\n').filter(Boolean))
  if (f.versionError) f.ci = { ok: true, message: 'CI not checked' }
  else {
    console.log(`CI on ${sha.slice(0, 12)}${sha === commits[0] ? ' (HEAD)' : ' (newer commits only change docs or site/, which CI skips)'}; waiting up to ${ciWait} min while it runs:`)
    f.ci = await waitForCi({ sha, repo, waitMinutes: ciWait })
  }
  const findings = releaseFindings(f)
  const code = print(findings)
  for (const x of findings) if (x.level === 'red') console.log(`::error::${x.text}`)
  if (process.env.GITHUB_OUTPUT && !f.versionError) appendFileSync(process.env.GITHUB_OUTPUT, `version=${f.version}\ntag=v${f.version}\n`)
  if (process.env.GITHUB_STEP_SUMMARY) {
    const reds = findings.filter((x) => x.level === 'red')
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, reds.length
      ? `### ${reds.length} thing(s) to fix before release v${f.version ?? '?'} (nothing was changed)\n${reds.map((x) => `- ${x.text}`).join('\n')}\n`
      : `### Checks green for release v${f.version}\n`)
  }
  return code
}

async function main(argv) {
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
  if (cmd === 'release') return releaseCommand(rest, { repo, skipPhones })
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
  console.error('usage: node scripts/release-preflight.mjs next-version | store | github [--skip-phones] | release [<version>] [--skip-phones]')
  return 2
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = await main(process.argv.slice(2))
