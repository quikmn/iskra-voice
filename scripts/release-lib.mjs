// Pure helpers for the release scripts (release.mjs, release-assets.mjs). Tested in release-lib.test.mjs.
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
