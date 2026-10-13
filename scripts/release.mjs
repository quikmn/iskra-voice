#!/usr/bin/env node
// Starts a release: bumps the version everywhere, commits "Version X" and tags vX. See docs/ci-cd.md.
//
//   npm run release -- 2.0.0-alpha.10            # then run the git push command it prints
//   npm run release -- 2.0.0-alpha.10 --push     # pushes main and the tag too
//   npm run release -- 2.0.0-alpha.10 --dry-run  # shows what would change; writes nothing, skips the git checks
//
// Needs docs/releases/<version>.md (the release notes; scripts/release-notes.mjs writes it from NEXT.md). It and
// docs/releases/NEXT.md may be uncommitted: they go into the version commit. scripts/release-all.ps1 runs the whole release.
import { execFileSync, execSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareVersions, isValidVersion, replaceVersion } from './release-lib.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--')))
const version = args.find((a) => !a.startsWith('--'))
const dryRun = flags.has('--dry-run')
const push = flags.has('--push')
const unknown = [...flags].filter((f) => !['--dry-run', '--push'].includes(f))
const TRAILER = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'

const fail = (msg) => { console.error(`\nRelease stopped: ${msg}`); process.exit(1) }
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim()
const rel = (p) => p.replaceAll('\\', '/')

if (unknown.length) fail(`unknown option ${unknown.join(', ')}`)
if (!version) fail('give the version, e.g. npm run release -- 2.0.0-alpha.10')
if (!isValidVersion(version)) fail(`"${version}" isn't a release version: use x.y.z or x.y.z-alpha.n (no leading v)`)

const tag = `v${version}`
const notes = `docs/releases/${version}.md`
const next = 'docs/releases/NEXT.md'
const pkgPath = join(root, 'desktop/package.json')
const previous = JSON.parse(readFileSync(pkgPath, 'utf8')).version
if (compareVersions(version, previous) <= 0) fail(`${version} must be newer than the current version ${previous}`)

// Git state: on main, clean (apart from the notes files), not behind origin, tag unused.
const problems = []
const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
if (branch !== 'main') problems.push(`you're on ${branch}; releases are made from main`)
// The path follows the status letters; git() trims, so the first line may have lost its leading space (" M x" -> "M x").
const statusPath = (line) => rel(line.replace(/^\s*\S{1,2}\s+/, ''))
const dirty = git('status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean).filter((l) => ![notes, next].includes(statusPath(l)))
if (dirty.length) problems.push(`the working tree has changes; commit or discard them first:\n  ${dirty.join('\n  ')}`)
try {
  git('fetch', '--quiet', 'origin', 'main', '--tags')
  const behind = git('rev-list', '--count', 'HEAD..origin/main')
  if (behind !== '0') problems.push(`main is ${behind} commit(s) behind origin/main; pull first`)
} catch { problems.push("couldn't fetch origin (offline?)") }
if (git('tag', '--list', tag)) problems.push(`tag ${tag} already exists; pick the next version instead of moving a tag`)
if (problems.length) {
  if (!dryRun) fail(problems.join('\n'))
  for (const p of problems) console.log(`(dry run, ignored) ${p}`)
}

const notesPath = join(root, notes)
if (!existsSync(notesPath) || statSync(notesPath).size === 0) {
  const msg = `write the release notes first: ${notes} (see docs/releases/README.md)`
  if (!dryRun) fail(msg)
  console.log(`(dry run, ignored) ${msg}`)
}

// Files that carry the version shown to users. Every occurrence of the previous version is replaced.
const edits = []
for (const file of ['client/src/links.ts', 'site/index.html']) {
  const before = readFileSync(join(root, file), 'utf8')
  const { text, count } = replaceVersion(before, previous, version)
  if (count === 0) fail(`${file} doesn't mention the current version ${previous}; fix it by hand so it matches desktop/package.json`)
  edits.push({ file, text, count })
}
const links = edits[0].text
if (!links.includes(`RELEASE_VERSION = '${version}'`)) fail('client/src/links.ts: RELEASE_VERSION was not updated')

console.log(`Iskra ${previous} -> ${version}`)
for (const e of edits) console.log(`  ${e.file}: ${e.count} occurrence(s)`)
console.log('  desktop/package.json, desktop/package-lock.json (npm version)')
console.log(`  notes: ${notes}`)
if (git('status', '--porcelain', '--', next)) console.log(`  ${next} (emptied for the next release)`)
if (dryRun) { console.log('\nDry run: nothing written.'); process.exit(0) }

for (const e of edits) writeFileSync(join(root, e.file), e.text)
// npm keeps package.json and the lock file in step (execSync: a shell finds npm.cmd on Windows).
execSync(`npm version ${version} --no-git-tag-version`, { cwd: join(root, 'desktop'), stdio: 'inherit' }) // version is validated above
const lock = JSON.parse(readFileSync(join(root, 'desktop/package-lock.json'), 'utf8'))
if (JSON.parse(readFileSync(pkgPath, 'utf8')).version !== version || lock.version !== version) fail('npm version did not update desktop/package.json and its lock file')

const nextChanged = git('status', '--porcelain', '--', next) !== ''
git('add', '--', 'desktop/package.json', 'desktop/package-lock.json', ...edits.map((e) => e.file), notes, ...(nextChanged ? [next] : []))
git('commit', '--quiet', '-m', `Version ${version}`, '-m', TRAILER)
git('tag', '-a', tag, '-m', `Iskra ${version}`)
console.log(`\nCommitted "Version ${version}" and tagged ${tag}.`)

const pushCmd = ['push', '--atomic', 'origin', 'main', tag]
if (push) {
  execFileSync('git', pushCmd, { cwd: root, stdio: 'inherit' })
  console.log(`\nPushed. The Release workflow now builds Linux and macOS: gh run list --workflow release.yml -L 1`)
} else {
  console.log(`\nNext: git ${pushCmd.join(' ')}`)
}
console.log(`Then, on Windows with SimplySign logged in: .\\scripts\\release-windows.ps1 ${version}`)
