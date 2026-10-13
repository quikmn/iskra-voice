import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assignShards, durationsFromLog, filesFromPlaywrightList, readDurations, specFiles } from './e2e-shards.mjs'

test('every e2e spec runs in exactly one of the 4 shards', () => {
  const specs = specFiles()
  assert.ok(specs.length > 50, `found only ${specs.length} specs`)
  const placed = assignShards(specs, readDurations(), 4).flatMap((b) => b.specs)
  assert.equal(placed.length, specs.length, 'a spec is in two shards')
  assert.deepEqual([...placed].sort(), specs)
})

test('the measured shards are within 10% of an even split', () => {
  const buckets = assignShards(specFiles(), readDurations(), 4)
  const even = buckets.reduce((a, b) => a + b.seconds, 0) / 4
  for (const b of buckets) assert.ok(b.seconds <= even * 1.1, `a shard has ${b.seconds} s, even is ${even} s`)
})

test('a spec without a measurement still lands in a shard, at the median duration', () => {
  const buckets = assignShards(['a.spec.ts', 'b.spec.ts', 'c.spec.ts', 'new.spec.ts'], { 'a.spec.ts': 10, 'b.spec.ts': 20, 'c.spec.ts': 30 }, 2)
  assert.deepEqual(buckets.map((b) => b.specs), [['a.spec.ts', 'c.spec.ts'], ['b.spec.ts', 'new.spec.ts']])
  assert.deepEqual(buckets.map((b) => b.seconds), [40, 40])
})

test('greedy: longest first into the emptiest shard, deterministic', () => {
  const seconds = { 'a.spec.ts': 8, 'b.spec.ts': 7, 'c.spec.ts': 6, 'd.spec.ts': 5, 'e.spec.ts': 4, 'f.spec.ts': 3 }
  const run = () => assignShards(Object.keys(seconds), seconds, 3).map((b) => b.seconds)
  assert.deepEqual(run(), [11, 11, 11])
  assert.deepEqual(run(), run())
  assert.equal(assignShards(['x.spec.ts'], {}, 4).filter((b) => b.specs.length).length, 1)
  assert.throws(() => assignShards([], {}, 0))
})

test('reads spec durations from a CI log', () => {
  const log = [
    'end-to-end shard 3/4\tUNKNOWN STEP\t2026-10-13T22:32:56Z   ✓   1 [chromium] › e2e/names.spec.ts:34:1 › a new name shows (12.7s)',
    'end-to-end shard 3/4\tUNKNOWN STEP\t2026-10-13T22:33:08Z   ✓   3 [chromium] › e2e/names.spec.ts:121:1 › reconnect (rename) (10.3s)',
    'end-to-end shard 1/4\tUNKNOWN STEP\t2026-10-13T22:33:08Z   ✘   4 [chromium] › e2e/a11y.spec.ts:5:1 › axe (1.5m)',
    'end-to-end shard 1/4\tUNKNOWN STEP\t2026-10-13T22:33:08Z   ✓   5 [chromium] › e2e/sub/x.spec.ts:5:1 › quick (250ms)',
    'end-to-end shard 1/4\tUNKNOWN STEP\t2026-10-13T22:33:34Z   -   2 [chromium] › e2e/audit-tour.spec.ts:797:1 › UX audit tour (desktop app)',
  ].join('\n')
  const d = durationsFromLog(log)
  assert.deepEqual(Object.keys(d).sort(), ['a11y.spec.ts', 'names.spec.ts', 'sub/x.spec.ts'])
  assert.ok(Math.abs(d['names.spec.ts'] - 23) < 1e-9)
  assert.equal(d['a11y.spec.ts'], 90)
  assert.equal(d['sub/x.spec.ts'], 0.25)
})

test("reads the spec files of Playwright's --list json", () => {
  assert.deepEqual(filesFromPlaywrightList({ suites: [{ file: 'b.spec.ts' }, { file: 'a.spec.ts' }, { file: 'b.spec.ts' }] }), ['a.spec.ts', 'b.spec.ts'])
})
