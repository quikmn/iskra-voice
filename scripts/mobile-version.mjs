// Version numbers for the phone app, from desktop/package.json (the one app version).
//   node scripts/mobile-version.mjs [run_number] [run_attempt]
// prints MARKETING_VERSION=2.0.0 and BUILD_NUMBER=20000109.<run>.<attempt> lines (for $GITHUB_ENV).
//   node scripts/mobile-version.mjs --android
// prints APP_VERSION and VERSION_CODE (mobile/scripts/build-android.ps1).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?$/
const STAGE = { alpha: 100, beta: 200, rc: 300 }

/**
 * Android's version code (mobile/scripts/build-android.ps1; the same scheme the earlier Android app used, so
 * installed copies update in place): (major*10000 + minor*100 + patch)*1000, plus 100+n for alpha.n,
 * 200+n for beta.n, 300+n for rc.n and 900 for a final release, so every release orders after the last.
 */
export function versionCode(version) {
  const m = VERSION.exec(version ?? '')
  if (!m) throw new Error(`Can't make a version code from '${version}'`)
  const [, major, minor, patch, stage, n] = m
  if (Number(minor) > 99 || Number(patch) > 99) throw new Error(`Minor and patch must be below 100: ${version}`)
  if (stage && Number(n) >= 100) throw new Error(`Prerelease number too large for the version code: ${version}`)
  const pre = stage ? STAGE[stage] + Number(n) : 900
  return (Number(major) * 10000 + Number(minor) * 100 + Number(patch)) * 1000 + pre
}

/** CFBundleShortVersionString: Apple takes only up to three integers, so 2.0.0-alpha.9 ships as 2.0.0. */
export function marketingVersion(version) {
  const m = VERSION.exec(version ?? '')
  if (!m) throw new Error(`Not an app version: '${version}'`)
  return `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}`
}

/**
 * CFBundleVersion: the version code, then the CI run and attempt, so a rebuild of the same version still gets a
 * new, higher number (App Store Connect rejects a build number it has seen for that version).
 */
export function buildNumber(version, run = 0, attempt = 1) {
  for (const n of [run, attempt]) if (!Number.isSafeInteger(Number(n)) || Number(n) < 0) throw new Error(`Bad run number: ${n}`)
  return `${versionCode(version)}.${Number(run)}.${Number(attempt)}`
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const pkg = JSON.parse(readFileSync(new URL('../desktop/package.json', import.meta.url), 'utf8'))
  const args = process.argv.slice(2)
  console.log(`APP_VERSION=${pkg.version}`)
  if (args[0] === '--android') {
    console.log(`VERSION_CODE=${versionCode(pkg.version)}`)
    process.exit(0)
  }
  const [run = '0', attempt = '1'] = args
  console.log(`MARKETING_VERSION=${marketingVersion(pkg.version)}`)
  console.log(`BUILD_NUMBER=${buildNumber(pkg.version, run, attempt)}`)
}
