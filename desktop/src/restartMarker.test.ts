import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { farewellLine, RESTART_MARKER, restartMarkerJson, writeRestartMarker } from './restartMarker'

test('the marker is the JSON the server reads (RestartMarker.cs)', () => {
  // ShutdownTests.The_desktop_apps_update_marker_says_restarting_for_an_update reads this exact shape.
  assert.equal(restartMarkerJson('update', 60, 1_760_000_000_123), '{"v":1,"reason":"update","etaSeconds":60,"at":1760000000123}\n')
  assert.equal(restartMarkerJson('restart', null, 5), '{"v":1,"reason":"restart","at":5}\n')
  // The server refuses an ETA outside 0-600 s: keep it inside.
  assert.equal(JSON.parse(restartMarkerJson('update', 5000, 1)).etaSeconds, 600)
  assert.equal(JSON.parse(restartMarkerJson('update', -3, 1)).etaSeconds, 0)
})

test('the marker is written into the world folder, with no temp file left', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'iskra-marker-'))
  try {
    assert.equal(writeRestartMarker(dir, 'update', 60, 42), true)
    assert.equal(readFileSync(path.join(dir, RESTART_MARKER), 'utf8'), '{"v":1,"reason":"update","etaSeconds":60,"at":42}\n')
    assert.equal(existsSync(path.join(dir, `${RESTART_MARKER}.tmp`)), false)
    // A second update replaces it.
    assert.equal(writeRestartMarker(dir, 'update', 30, 43), true)
    assert.equal(JSON.parse(readFileSync(path.join(dir, RESTART_MARKER), 'utf8')).at, 43)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a folder that is gone is reported, not thrown', () => {
  const original = console.error
  console.error = () => undefined
  try {
    assert.equal(writeRestartMarker(path.join(tmpdir(), 'iskra-no-such-world-folder', 'x'), 'update', 60), false)
  } finally {
    console.error = original
  }
})

test('the server is told "restart" only when no marker says why', () => {
  assert.equal(farewellLine('stop', false), '')
  assert.equal(farewellLine('restart', false), 'restart\n')
  // An update with its marker closes plainly, so the marker's reason (update) wins.
  assert.equal(farewellLine('update', true), '')
  // No marker: still "restarting", just without "for an update".
  assert.equal(farewellLine('update', false), 'restart\n')
})
