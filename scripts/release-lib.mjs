// Library of the steps of scripts/release.ps1 (the one release command); not run by hand.
// Pure helpers for the release scripts (release-version.mjs, release-assets.mjs, release-notes.mjs). Tested in release-lib.test.mjs.
import { readFileSync } from 'node:fs'

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-alpha\.(0|[1-9]\d*))?$/

/** Parses x.y.z or x.y.z-alpha.n; null when the version isn't one of those. */
export function parseVersion(text) {
  const m = VERSION.exec(String(text ?? ''))
  if (!m) return null
  return { major: +m[1], minor: +m[2], patch: +m[3], alpha: m[4] === undefined ? null : +m[4] }
}

export const isValidVersion = (text) => parseVersion(text) !== null

/** Semver order: negative when a < b. A final release sorts after its alphas. */
export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b)
  if (!x || !y) throw new Error(`Not a release version: ${!x ? a : b}`)
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] - y[k]
  if (x.alpha === y.alpha) return 0
  if (x.alpha === null) return 1
  if (y.alpha === null) return -1
  return x.alpha - y.alpha
}

/** "Iskra alpha 10" for 2.0.0-alpha.10, "Iskra 2.1.0" for a final release. */
export function releaseTitle(version) {
  const v = parseVersion(version)
  if (!v) throw new Error(`Not a release version: ${version}`)
  return v.alpha === null ? `Iskra ${version}` : `Iskra alpha ${v.alpha}`
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Replaces every standalone occurrence of `from` with `to`. "Standalone" means not part of a longer
 * version: 2.0.0-alpha.1 doesn't match inside 2.0.0-alpha.10 or 12.0.0-alpha.1.
 */
export function replaceVersion(text, from, to) {
  const re = new RegExp(`(?<![\\d.])${escape(from)}(?!\\d)`, 'g')
  let count = 0
  const out = text.replace(re, () => { count++; return to })
  return { text: out, count }
}

/** Asset names every release must have, from scripts/release-assets.json. */
export function expectedAssets(version, spec = JSON.parse(readFileSync(new URL('./release-assets.json', import.meta.url), 'utf8'))) {
  if (!isValidVersion(version)) throw new Error(`Not a release version: ${version}`)
  return Object.entries(spec).filter(([k]) => !k.startsWith('$')).flatMap(([group, names]) => names.map((n) => ({ group, name: n.replaceAll('{v}', version) })))
}

/** Which expected assets are missing from `names`, and which names nobody expects (besides SHA256SUMS.txt). */
export function checkAssets(version, names, spec) {
  const expected = expectedAssets(version, spec)
  const have = new Set(names)
  const want = new Set(expected.map((e) => e.name))
  return {
    missing: expected.filter((e) => !have.has(e.name)),
    extra: names.filter((n) => !want.has(n) && n !== 'SHA256SUMS.txt'),
  }
}

/** Reads electron-builder's latest*.yml: version plus each file's url, sha512 (base64) and size. */
export function parseUpdateYml(text) {
  const version = /^version:\s*['"]?([^'"\s]+)/m.exec(text)?.[1] ?? null
  const files = []
  for (const m of text.matchAll(/^\s*-\s*url:\s*['"]?([^'"\n]+?)['"]?\s*\n\s*sha512:\s*['"]?([A-Za-z0-9+/=]+)['"]?\s*\n\s*size:\s*(\d+)/gm)) {
    files.push({ url: m[1], sha512: m[2], size: +m[3] })
  }
  return { version, files }
}

/**
 * The files each latest*.yml must list for electron-updater to find an update: the Windows installer, the AppImage, and
 * a zip per Mac architecture (Squirrel.Mac installs from the zip; the updater picks the one matching the Mac's CPU).
 */
export const UPDATER_FILES = {
  'latest.yml': ['Iskra-Setup-{v}.exe'],
  'latest-linux.yml': ['Iskra-{v}-x86_64.AppImage'],
  'latest-mac.yml': ['Iskra-{v}-mac-arm64.zip', 'Iskra-{v}-mac-x64.zip'],
}

/** The updater files `yml` should list but doesn't (urls from parseUpdateYml). */
export function missingUpdaterFiles(yml, version, urls) {
  return (UPDATER_FILES[yml] ?? []).map((n) => n.replaceAll('{v}', version)).filter((n) => !urls.includes(n))
}

/** SHA256SUMS.txt in the `sha256sum` format: "hash  name", LF line endings, sorted by name. */
export function formatSums(entries) {
  return [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((e) => `${e.sha256}  ${e.name}\n`).join('')
}

/**
 * Splits an electron-builder latest*.yml into its top-level lines and its file entries (each "  - url: ..." block with
 * its indented lines, kept verbatim so fields like blockMapSize survive).
 */
function splitUpdateYml(text) {
  const top = [], files = []
  let inFiles = false
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (line === '') continue
    if (/^\S/.test(line)) {
      inFiles = /^files:\s*$/.test(line)
      top.push(inFiles ? 'files:' : line)
    } else if (inFiles && /^\s*-\s/.test(line)) {
      const url = /^\s*-\s*url:\s*['"]?([^'"\n]+?)['"]?\s*$/.exec(line)?.[1]
      if (!url) throw new Error(`unexpected file entry: ${line}`)
      files.push({ url, lines: [line] })
    } else if (inFiles && files.length) {
      files.at(-1).lines.push(line)
    } else {
      throw new Error(`unexpected line: ${line}`)
    }
  }
  return { top, files }
}

const topKey = (line) => /^([A-Za-z0-9_]+):/.exec(line)?.[1]

/**
 * Merges the latest-mac.yml of single-architecture builds into the one electron-builder writes when it builds them
 * together: every file of every part (grouped by extension in the first part's order: zips, then dmgs; parts in the
 * given order inside each group), `path`/`sha512` from the first part, the latest `releaseDate`. Throws when the parts
 * disagree on the version (or any other field) or list the same file twice.
 */
export function mergeUpdateYml(parts) {
  if (parts.length < 2) throw new Error('give at least two parts to merge')
  const split = parts.map(splitUpdateYml)
  const versions = new Set(parts.map((p) => parseUpdateYml(p).version))
  if (versions.size !== 1 || versions.has(null)) throw new Error(`the parts are for different versions: ${[...versions].join(', ')}`)
  const ext = (url) => /\.([^.]+)$/.exec(url)?.[1] ?? ''
  const order = [...new Set(split[0].files.map((f) => ext(f.url)))]
  for (const s of split.slice(1)) for (const f of s.files) if (!order.includes(ext(f.url))) order.push(ext(f.url))
  const files = order.flatMap((e) => split.flatMap((s) => s.files.filter((f) => ext(f.url) === e)))
  const urls = files.map((f) => f.url)
  const dup = urls.find((u, i) => urls.indexOf(u) !== i)
  if (dup) throw new Error(`${dup} is in more than one part`)
  if (!files.length) throw new Error('the parts list no files')
  // Fields other than files/path/sha512/releaseDate must be the same in every part.
  const own = new Set(['files', 'path', 'sha512', 'releaseDate'])
  for (const s of split.slice(1)) {
    const a = split[0].top.filter((l) => !own.has(topKey(l))), b = s.top.filter((l) => !own.has(topKey(l)))
    if (a.join('\n') !== b.join('\n')) throw new Error(`the parts differ: ${a.join(' | ')} vs ${b.join(' | ')}`)
  }
  const dates = split.map((s) => s.top.find((l) => topKey(l) === 'releaseDate')).filter(Boolean)
  const latestDate = dates.sort((x, y) => (x.replace(/[^0-9TZ:.-]/g, '') < y.replace(/[^0-9TZ:.-]/g, '') ? -1 : 1)).at(-1)
  const out = []
  for (const line of split[0].top) {
    if (line === 'files:') out.push(line, ...files.flatMap((f) => f.lines))
    else if (topKey(line) === 'releaseDate') out.push(latestDate)
    else out.push(line)
  }
  return out.join('\n') + '\n'
}

/** "**Iskra: alpha 14.**" for 2.0.0-alpha.14, "**Iskra 2.1.0.**" for a final release (headline of the notes). */
export function notesHeadline(version) {
  const v = parseVersion(version)
  if (!v) throw new Error(`Not a release version: ${version}`)
  return v.alpha === null ? `**Iskra ${version}.**` : `**Iskra: alpha ${v.alpha}.**`
}

/** The "### <title>" sections of a notes file, in order: [{ title, body }] (body without the heading line). */
export function notesSections(text) {
  const sections = []
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const h = /^###\s+(.+?)\s*$/.exec(line)
    if (h) sections.push({ title: h[1], lines: [] })
    else if (sections.length) sections.at(-1).lines.push(line)
  }
  return sections.map((s) => ({ title: s.title, body: s.lines.join('\n').trim() }))
}

/** Words that must never appear in public text (CLAUDE.md: the product is just "Iskra"). */
export function publicWordingProblems(text) {
  const problems = []
  if (/Iskra\s*2\b(?![.\d])/i.test(text)) problems.push('says "Iskra 2"')
  if (/\brebuilt\b/i.test(text)) problems.push('says "rebuilt"')
  if (/\bv1\b(?!\.\d)/i.test(text)) problems.push('mentions v1')
  return problems
}

/**
 * The release notes for `version` from docs/releases/NEXT.md (bullets under ### headings), the way the release step
 * writes them: the headline, NEXT's non-empty sections in order, and "### Get started" from the previous release's
 * notes with its version replaced (placed before "### Good to know", or last). Throws when NEXT has no bullets.
 */
export function notesFromNext(next, version, previousNotes, previousVersion) {
  const sections = notesSections(next).filter((s) => /^\s*-\s+\S/m.test(s.body))
  if (!sections.length) throw new Error('docs/releases/NEXT.md has no notes (no "- " lines under a ### heading)')
  const start = notesSections(previousNotes).find((s) => s.title === 'Get started')
  if (!start || !start.body) throw new Error(`the previous notes (${previousVersion}) have no "### Get started" section to copy`)
  const { text: startBody, count } = replaceVersion(start.body, previousVersion, version)
  if (/Iskra-Setup-/.test(start.body) && count === 0) throw new Error(`"### Get started" in the previous notes doesn't mention ${previousVersion}`)
  const out = sections.filter((s) => s.title !== 'Get started')
  const at = out.findIndex((s) => s.title === 'Good to know')
  out.splice(at === -1 ? out.length : at, 0, { title: 'Get started', body: startBody })
  return [notesHeadline(version), '', ...out.flatMap((s) => [`### ${s.title}`, s.body, ''])].join('\n')
}

/** What NEXT.md goes back to after a release: the comment line and empty sections. */
export const EMPTY_NEXT = "<!-- Release notes for the next version. Each change is its own line; the release step merges them. -->\n\n### What's new\n\n### Fixes\n\n### Good to know\n"

/**
 * Whether CI passed on a commit, from its CI workflow runs (GitHub's workflow_runs: status, conclusion, event, html_url).
 * Only push runs count. pass: one concluded success. wait: none yet, or one still running. fail: all finished, none green.
 */
export function ciVerdict(runs) {
  const push = runs.filter((r) => r.event === 'push')
  const green = push.find((r) => r.status === 'completed' && r.conclusion === 'success')
  if (green) return { state: 'pass', run: green, message: `CI passed: ${green.html_url}` }
  const running = push.find((r) => r.status !== 'completed')
  if (running) return { state: 'wait', run: running, message: `CI is still running (${running.status}): ${running.html_url}` }
  if (!push.length) return { state: 'wait', run: null, message: 'no CI run for this commit yet' }
  const last = push[0]
  // ci.yml cancels a branch's run when a newer push supersedes it (never a "Version X" commit's): rerun it to gate on it.
  const hint = last.conclusion === 'cancelled' ? ' (cancelled, probably by a newer push: rerun it with gh run rerun)' : ''
  return { state: 'fail', run: last, message: `CI concluded ${last.conclusion} on this commit${hint}: ${last.html_url}` }
}

/** The "- " lines of `next` that are already in the previous release's notes (NEXT.md not emptied after a release). */
export function repeatedNotes(next, previousNotes) {
  const shipped = new Set(previousNotes.replace(/\r\n/g, '\n').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- ')))
  return next.replace(/\r\n/g, '\n').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- ') && shipped.has(l))
}
