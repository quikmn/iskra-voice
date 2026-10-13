#!/usr/bin/env node
// Splits the Playwright specs (client/e2e) over CI's end-to-end shards by measured duration, so the shards finish
// about together. Durations (seconds per spec file, measured in CI) are in client/e2e/durations.json; a spec that isn't
// there yet counts as the median, so a new spec always lands in some shard. Greedy: longest spec first, into the
// shard with the least time so far.
//
//   node scripts/e2e-shards.mjs list <shard> <total> <out file>   # Playwright --test-list for one shard
//   node scripts/e2e-shards.mjs show [total]                      # the split and each shard's seconds
//   node scripts/e2e-shards.mjs check <playwright --list json>    # the specs Playwright sees are exactly the split's
//   node scripts/e2e-shards.mjs measure <CI log>...               # rewrite durations.json from `gh run view <id> --log`
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const E2E_DIR = path.join(root, 'client', 'e2e')
export const DURATIONS_FILE = path.join(E2E_DIR, 'durations.json')

// Playwright's default testMatch, relative to testDir (client/playwright.config.ts: testDir 'e2e').
const SPEC = /\.(spec|test)\.[cm]?[jt]sx?$/

/** Every spec file under dir, as Playwright names them (relative, forward slashes), sorted. */
export function specFiles(dir = E2E_DIR) {
  const out = []
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p) }
      else if (SPEC.test(e.name)) out.push(p)
    }
  }
  walk('')
  return out.sort()
}

export function readDurations(file = DURATIONS_FILE) {
  return JSON.parse(fs.readFileSync(file, 'utf8')).seconds
}

/** Splits specs into `total` buckets: [{ specs, seconds }]. Every spec lands in exactly one bucket. */
export function assignShards(specs, seconds, total) {
  if (!Number.isInteger(total) || total < 1) throw new Error('total must be a positive integer')
  const known = specs.map((s) => seconds[s]).filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  const fallback = known.length ? known[Math.floor(known.length / 2)] : 1
  const cost = (s) => (Number.isFinite(seconds[s]) ? seconds[s] : fallback)
  const order = [...new Set(specs)].sort((a, b) => cost(b) - cost(a) || (a < b ? -1 : 1))
  const buckets = Array.from({ length: total }, () => ({ specs: [], seconds: 0 }))
  for (const s of order) {
    const b = buckets.reduce((min, x) => (x.seconds < min.seconds ? x : min))
    b.specs.push(s)
    b.seconds += cost(s)
  }
  for (const b of buckets) b.specs.sort()
  return buckets
}

/** Per spec file, the summed test durations of Playwright list-reporter lines (`✓ 3 [chromium] › e2e/x.spec.ts:1:1 › t (12.7s)`). */
export function durationsFromLog(text) {
  const sums = {}
  for (const line of text.split('\n')) {
    const m = line.match(/[✓✘]\s+\d+ \[[^\]]+\] › (?:e2e\/)?(\S+?):\d+:\d+ › .*\((\d+(?:\.\d+)?)(ms|s|m)\)\s*$/)
    if (!m) continue
    sums[m[1]] = (sums[m[1]] ?? 0) + Number(m[2]) * (m[3] === 'ms' ? 0.001 : m[3] === 'm' ? 60 : 1)
  }
  return sums
}

/** The spec files in Playwright's `--list --reporter=json` output. */
export function filesFromPlaywrightList(json) {
  return [...new Set(json.suites.map((s) => s.file))].sort()
}

function main(argv) {
  const [cmd, ...args] = argv
  const fail = (msg) => { console.error(`error: ${msg}`); process.exit(1) }
  if (cmd === 'list' || cmd === 'show') {
    const total = Number(cmd === 'list' ? args[1] : args[0] ?? 4)
    const buckets = assignShards(specFiles(), readDurations(), total)
    if (cmd === 'show') {
      buckets.forEach((b, i) => console.log(`shard ${i + 1}/${total}: ${Math.round(b.seconds)} s, ${b.specs.length} specs: ${b.specs.join(' ')}`))
      return
    }
    const shard = Number(args[0])
    if (!Number.isInteger(shard) || shard < 1 || shard > total || !args[2]) fail('usage: list <shard> <total> <out file>')
    const b = buckets[shard - 1]
    fs.writeFileSync(args[2], b.specs.join('\n') + '\n')
    console.log(`shard ${shard}/${total}: ${b.specs.length} specs, about ${Math.round(b.seconds)} s of tests: ${b.specs.join(' ')}`)
  } else if (cmd === 'check') {
    if (!args[0]) fail('usage: check <playwright --list --reporter=json output>')
    const seen = filesFromPlaywrightList(JSON.parse(fs.readFileSync(args[0], 'utf8')))
    const split = assignShards(specFiles(), readDurations(), Number(args[1] ?? 4)).flatMap((b) => b.specs).sort()
    const missing = seen.filter((f) => !split.includes(f))
    const extra = split.filter((f) => !seen.includes(f))
    if (missing.length || extra.length) fail(`the shard split doesn't match Playwright's specs. Not in any shard: ${missing.join(', ') || 'none'}; not a Playwright spec: ${extra.join(', ') || 'none'}`)
    console.log(`all ${seen.length} spec files are in exactly one shard`)
  } else if (cmd === 'measure') {
    if (!args.length) fail('usage: measure <log from gh run view <id> --log>...')
    const runs = args.map((f) => durationsFromLog(fs.readFileSync(f, 'utf8')))
    const seconds = {}
    for (const spec of specFiles()) {
      const vals = runs.map((r) => r[spec]).filter((v) => v !== undefined)
      // Specs that only skip in CI (desktop, screenshot tours) take about a second.
      seconds[spec] = vals.length ? Math.max(1, Math.round(vals.reduce((a, b) => a + b, 0) / vals.length)) : 1
    }
    fs.writeFileSync(DURATIONS_FILE, JSON.stringify({ about: 'Seconds of tests per spec in CI; scripts/e2e-shards.mjs splits the shards by them. Refresh: node scripts/e2e-shards.mjs measure <gh run view <id> --log>', seconds }, null, 2) + '\n')
    console.log(`wrote ${path.relative(root, DURATIONS_FILE)} (${Object.keys(seconds).length} specs)`)
  } else {
    fail('usage: e2e-shards.mjs list|show|check|measure (see the top of the file)')
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2))
