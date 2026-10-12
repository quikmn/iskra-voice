#!/usr/bin/env node
// Release asset checks shared by release-windows.ps1 and .github/workflows/release-finalize.yml.
//
//   node scripts/release-assets.mjs list <version> [group...]   expected file names, one per line
//   node scripts/release-assets.mjs check <version> <dir>       all expected files present, latest*.yml match the files
//   node scripts/release-assets.mjs names <version> <file>      expected files present in a list of names (one per line)
//   node scripts/release-assets.mjs sums <dir>                  writes <dir>/SHA256SUMS.txt for every other file in <dir>
import { createHash } from 'node:crypto'
import { createReadStream, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkAssets, expectedAssets, formatSums, isValidVersion, missingUpdaterFiles, parseUpdateYml } from './release-lib.mjs'

const [cmd, ...args] = process.argv.slice(2)
const fail = (msg) => { console.error(`error: ${msg}`); process.exit(1) }
const needVersion = (v) => { if (!isValidVersion(v)) fail(`"${v ?? ''}" isn't a release version (x.y.z or x.y.z-alpha.n)`) }

const hash = (file, algo, encoding) => new Promise((resolve, reject) => {
  const h = createHash(algo)
  createReadStream(file).on('error', reject).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest(encoding)))
})
const filesIn = (dir) => readdirSync(dir).filter((n) => statSync(join(dir, n)).isFile())

function report(version, names) {
  const { missing, extra } = checkAssets(version, names)
  for (const e of extra) console.log(`note: unexpected file ${e}`)
  if (missing.length) {
    for (const m of missing) console.error(`missing (${m.group}): ${m.name}`)
    return false
  }
  return true
}

if (cmd === 'list') {
  const [version, ...groups] = args
  needVersion(version)
  for (const e of expectedAssets(version)) if (!groups.length || groups.includes(e.group)) console.log(e.name)
} else if (cmd === 'names') {
  const [version, file] = args
  needVersion(version)
  const names = readFileSync(file, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  if (!report(version, names)) process.exit(1)
  console.log(`All ${expectedAssets(version).length} expected files are there.`)
} else if (cmd === 'check') {
  const [version, dir] = args
  needVersion(version)
  const names = filesIn(dir)
  let ok = report(version, names)
  // electron-updater refuses an update whose sha512 doesn't match latest*.yml, so check them here.
  for (const yml of ['latest.yml', 'latest-mac.yml', 'latest-linux.yml'].filter((n) => names.includes(n))) {
    const { version: v, files } = parseUpdateYml(readFileSync(join(dir, yml), 'utf8'))
    if (v !== version) { console.error(`${yml} says version ${v}, expected ${version}`); ok = false }
    if (!files.length) { console.error(`${yml} lists no files`); ok = false }
    for (const m of missingUpdaterFiles(yml, version, files.map((f) => f.url))) { console.error(`${yml} doesn't list ${m}, so the app won't update from it`); ok = false }
    for (const f of files) {
      if (!names.includes(f.url)) { console.error(`${yml} points at ${f.url}, which isn't in the release`); ok = false; continue }
      const size = statSync(join(dir, f.url)).size
      const sha512 = await hash(join(dir, f.url), 'sha512', 'base64')
      if (size !== f.size || sha512 !== f.sha512) { console.error(`${yml}: ${f.url} doesn't match (re-upload ${yml} together with the file it describes)`); ok = false }
    }
  }
  if (!ok) process.exit(1)
  console.log(`All ${expectedAssets(version).length} expected files are there and the update files match.`)
} else if (cmd === 'sums') {
  const [dir] = args
  if (!dir) fail('usage: sums <dir>')
  const entries = []
  for (const name of filesIn(dir).filter((n) => n !== 'SHA256SUMS.txt')) entries.push({ name, sha256: await hash(join(dir, name), 'sha256', 'hex') })
  writeFileSync(join(dir, 'SHA256SUMS.txt'), formatSums(entries))
  process.stdout.write(formatSums(entries))
} else {
  fail('usage: release-assets.mjs list|names|check|sums ... (see the top of the file)')
}
