import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { main, markdown, output, summarize, testsOf } from './e2e-flaky.mjs'

// The shape of Playwright's JSON reporter: file suites, nested describe suites, specs with one test per repeat.
const spec = (title, line, ...statuses) => ({ title, file: 'a.spec.ts', line, tests: statuses.map((status) => ({ projectName: 'chromium', status })) })
const report = (...specs) => ({
  suites: [{ title: 'a.spec.ts', file: 'a.spec.ts', specs: specs.slice(0, 1), suites: [{ title: 'group', file: 'a.spec.ts', specs: specs.slice(1) }] }],
})

test('names each test by file, line and titles; one entry per repeat', () => {
  const r = report(spec('one', 3, 'expected'), spec('two', 9, 'flaky', 'expected'))
  assert.deepEqual(testsOf(r), [
    { name: 'a.spec.ts:3 › one', status: 'expected' },
    { name: 'a.spec.ts:9 › group › two', status: 'flaky' },
    { name: 'a.spec.ts:9 › group › two', status: 'expected' },
  ])
})

test('flaky = passed on retry, failed = every attempt; across shards, with counts; skipped not counted', () => {
  const s = summarize([
    report(spec('one', 3, 'expected', 'flaky', 'flaky'), spec('two', 9, 'unexpected', 'expected', 'skipped')),
    { suites: [{ title: 'b.spec.ts', file: 'b.spec.ts', specs: [{ title: 'three', file: 'b.spec.ts', line: 1, tests: [{ status: 'flaky' }] }] }] },
  ])
  assert.deepEqual(s.flaky, [{ name: 'a.spec.ts:3 › one', times: 2, runs: 3 }, { name: 'b.spec.ts:1 › three', times: 1, runs: 1 }])
  assert.deepEqual(s.failed, [{ name: 'a.spec.ts:9 › group › two', times: 1, runs: 2 }])
  assert.equal(s.runs, 6)
  const md = markdown(s)
  assert.match(md, /1 failed, 2 flaky/)
  assert.match(md, /- a\.spec\.ts:3 › one \(2 of 3\)/)
  assert.match(md, /- b\.spec\.ts:1 › three\n/)
  assert.match(markdown(summarize([report(spec('one', 3, 'expected'))])), /Every test passed on its first attempt/)
})

test('step outputs: one test per line; a shard without a report is named, never a crash', () => {
  assert.match(output('flaky', ['a', 'b']), /^flaky<<(EOF_FLAKY_\w+)\na\nb\n\1\n$/)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-flaky-'))
  fs.writeFileSync(path.join(dir, 'report-1.json'), JSON.stringify(report(spec('one', 3, 'flaky'))))
  fs.writeFileSync(path.join(dir, 'report-2.json'), 'not json')
  const summary = path.join(dir, 'summary.md')
  const out = path.join(dir, 'out.txt')
  let printed = ''
  assert.equal(main([dir, path.join(dir, 'missing.json')], { GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: out }, (s) => (printed += s)), 0)
  assert.match(printed, /No report from: missing\.json, report-2\.json \(not JSON\)/)
  assert.equal(fs.readFileSync(summary, 'utf8'), printed)
  const outputs = fs.readFileSync(out, 'utf8')
  assert.match(outputs, /^flaky<<(EOF_FLAKY_\w+)\na\.spec\.ts:3 › one\n\1\n/)
  assert.match(outputs, /flaky_count=1\nfailed_count=0\n$/)
  fs.rmSync(dir, { recursive: true, force: true })
})
