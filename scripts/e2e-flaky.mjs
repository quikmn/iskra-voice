#!/usr/bin/env node
// Lists the end-to-end tests that were flaky (failed, then passed on Playwright's retry) or failed (every attempt), from
// Playwright JSON reports (`--reporter=json`, one per shard). For CI: a table in the job summary, and the lists as step
// outputs that scripts/ci-notify.mjs puts in the #ci message ("green, 2 flaky: ...").
//
//   node scripts/e2e-flaky.mjs <report.json | folder of them>...
//
// Prints Markdown; also appends it to $GITHUB_STEP_SUMMARY and writes `flaky`, `failed` (one test per line) and
// `flaky_count`, `failed_count` to $GITHUB_OUTPUT when those are set. Never fails the step: the tests' own exit code does.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Every test run in a Playwright JSON report: { name, status } per test (each --repeat-each copy is one). */
export function testsOf(report) {
  const out = []
  const walk = (suite, titles) => {
    for (const spec of suite.specs ?? []) {
      const name = `${spec.file}:${spec.line} › ${[...titles, spec.title].join(' › ')}`
      for (const t of spec.tests ?? []) out.push({ name, status: t.status })
    }
    for (const child of suite.suites ?? []) walk(child, [...titles, child.title])
  }
  // The top suites are the spec files; their titles are the file names, already in `name`.
  for (const file of report.suites ?? []) walk(file, [])
  return out
}

/**
 * Flaky and failed tests across reports, each once with how often: { flaky: [{ name, times, runs }], failed: [...],
 * runs }. Playwright's statuses: 'expected' (passed), 'flaky' (passed on a retry), 'unexpected' (failed every attempt),
 * 'skipped'.
 */
export function summarize(reports) {
  const byName = new Map()
  let runs = 0
  for (const r of reports) {
    for (const t of testsOf(r)) {
      if (t.status === 'skipped') continue
      runs++
      const e = byName.get(t.name) ?? { name: t.name, runs: 0, flaky: 0, failed: 0 }
      e.runs++
      if (t.status === 'flaky') e.flaky++
      if (t.status === 'unexpected') e.failed++
      byName.set(t.name, e)
    }
  }
  const list = (key) => [...byName.values()].filter((e) => e[key] > 0).map((e) => ({ name: e.name, times: e[key], runs: e.runs })).sort((a, b) => (a.name < b.name ? -1 : 1))
  return { flaky: list('flaky'), failed: list('failed'), runs }
}

const line = (e) => (e.runs > 1 ? `${e.name} (${e.times} of ${e.runs})` : e.name)

/** The job summary's Markdown. */
export function markdown({ flaky, failed, runs }, missing = []) {
  const out = [`### End-to-end: ${failed.length} failed, ${flaky.length} flaky (passed on retry), ${runs} test runs`]
  if (missing.length) out.push('', `No report from: ${missing.join(', ')} (the run stopped before it was written).`)
  if (failed.length) out.push('', '**Failed (every attempt):**', '', ...failed.map((e) => `- ${line(e)}`))
  if (flaky.length) out.push('', '**Flaky (failed, then passed on retry):**', '', ...flaky.map((e) => `- ${line(e)}`))
  if (!failed.length && !flaky.length && !missing.length) out.push('', 'Every test passed on its first attempt.')
  return out.join('\n') + '\n'
}

/** A multi-line step output in GitHub's `name<<delimiter` form. */
export function output(name, lines) {
  const delimiter = `EOF_${name.toUpperCase()}_${Math.random().toString(36).slice(2)}`
  return `${name}<<${delimiter}\n${lines.join('\n')}\n${delimiter}\n`
}

function reportFiles(args) {
  const files = []
  const missing = []
  for (const a of args) {
    if (!fs.existsSync(a)) { missing.push(path.basename(a)); continue }
    if (fs.statSync(a).isDirectory()) {
      for (const f of fs.readdirSync(a).sort()) if (f.endsWith('.json')) files.push(path.join(a, f))
    } else files.push(a)
  }
  return { files, missing }
}

export function main(argv, env = process.env, print = (s) => process.stdout.write(s)) {
  const { files, missing } = reportFiles(argv)
  const reports = []
  for (const f of files) {
    try {
      reports.push(JSON.parse(fs.readFileSync(f, 'utf8')))
    } catch {
      missing.push(`${path.basename(f)} (not JSON)`)
    }
  }
  if (!files.length && !missing.length) missing.push('any shard')
  const result = summarize(reports)
  const md = markdown(result, missing)
  print(md)
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, md)
  if (env.GITHUB_OUTPUT) {
    fs.appendFileSync(env.GITHUB_OUTPUT,
      output('flaky', result.flaky.map(line)) + output('failed', result.failed.map(line)) +
      `flaky_count=${result.flaky.length}\nfailed_count=${result.failed.length}\n`)
  }
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2))
