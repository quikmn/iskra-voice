#!/usr/bin/env node
// Step of scripts/release.ps1 (the one release command); don't run it by hand.
// The release notes for a version (docs/releases/<version>.md), as the release step writes them.
//
//   node scripts/release-notes.mjs 2.0.0-alpha.14            # writes the notes from NEXT.md and empties NEXT.md
//   node scripts/release-notes.mjs 2.0.0-alpha.14 --dry-run  # shows what it would do; writes nothing
//
// If docs/releases/<version>.md already exists it's kept as written (only checked). Otherwise it's made from
// docs/releases/NEXT.md: the headline, NEXT's sections, and "### Get started" from the previous release's notes with
// the new version. NEXT.md then goes back to empty sections; both files go into the version commit (release-version.mjs).
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareVersions, EMPTY_NEXT, isValidVersion, notesFromNext, notesHeadline, publicWordingProblems, repeatedNotes } from './release-lib.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const version = args.find((a) => !a.startsWith('--'))
const dryRun = args.includes('--dry-run')
const fail = (msg) => { console.error(`\nRelease stopped: ${msg}`); process.exit(1) }
const unknown = args.filter((a) => a.startsWith('--') && a !== '--dry-run')
if (unknown.length) fail(`unknown option ${unknown.join(', ')}`)
if (!isValidVersion(version)) fail(`"${version ?? ''}" isn't a release version: use x.y.z or x.y.z-alpha.n (no leading v)`)

const previous = JSON.parse(readFileSync(join(root, 'desktop/package.json'), 'utf8')).version
if (compareVersions(version, previous) <= 0) fail(`${version} must be newer than the current version ${previous}`)
const notesFile = `docs/releases/${version}.md`
const notesPath = join(root, notesFile)
const nextPath = join(root, 'docs/releases/NEXT.md')

function check(text, where) {
  const problems = publicWordingProblems(text)
  if (problems.length) fail(`${where} ${problems.join(', ')}: the product is just "Iskra" (fix the wording, then run this again)`)
  if (!text.startsWith(notesHeadline(version).slice(0, -2))) fail(`${where} doesn't start with the headline ${notesHeadline(version)}`)
  if (text.includes(`Iskra-Setup-${previous}.exe`)) fail(`${where} still names the previous version's files (${previous})`)
}

if (existsSync(notesPath) && statSync(notesPath).size > 0) {
  check(readFileSync(notesPath, 'utf8'), notesFile)
  console.log(`Notes: ${notesFile} (already written; NEXT.md left as it is)`)
  process.exit(0)
}

const previousNotesPath = join(root, `docs/releases/${previous}.md`)
if (!existsSync(previousNotesPath)) fail(`docs/releases/${previous}.md (the previous notes, for "Get started") is missing`)
const next = readFileSync(nextPath, 'utf8')
const previousNotes = readFileSync(previousNotesPath, 'utf8')
const repeated = repeatedNotes(next, previousNotes)
if (repeated.length) fail(`docs/releases/NEXT.md repeats ${repeated.length} line(s) that already shipped in ${previous} (first: "${repeated[0].slice(0, 60)}..."). Take out what shipped, then run this again`)
let notes
try {
  notes = notesFromNext(next, version, previousNotes, previous)
} catch (e) {
  fail(`write the release notes first: ${e.message} (or write ${notesFile} by hand; format in docs/releases/README.md)`)
}
check(notes, `the notes from NEXT.md`)
const bullets = notes.split('\n').filter((l) => /^\s*-\s/.test(l)).length
if (dryRun) {
  console.log(`Notes: would write ${notesFile} from NEXT.md (${bullets} lines, headline ${notesHeadline(version)}) and empty NEXT.md`)
  process.exit(0)
}
writeFileSync(notesPath, notes)
writeFileSync(nextPath, EMPTY_NEXT)
console.log(`Notes: wrote ${notesFile} from NEXT.md (${bullets} lines) and emptied NEXT.md`)
