import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { readBuildCommit, windowTitle } from './title'

test('the window title always ends with the version and commit', () => {
  const v = '2.0.0-alpha.14'
  assert.equal(windowTitle('Iskra', v, 'a89a580'), 'Iskra 2.0.0-alpha.14 · a89a580')
  assert.equal(windowTitle('', v, 'a89a580'), 'Iskra 2.0.0-alpha.14 · a89a580')
  assert.equal(windowTitle('(3) Iskra', v, 'a89a580'), '(3) Iskra 2.0.0-alpha.14 · a89a580')
  assert.equal(windowTitle('My settings — Iskra', v, 'a89a580'), 'My settings — Iskra 2.0.0-alpha.14 · a89a580')
  assert.equal(windowTitle('Server settings', v, 'dev'), 'Server settings — Iskra 2.0.0-alpha.14 · dev')
  assert.equal(windowTitle('app://iskra/index.html', v, 'dev'), 'app://iskra/index.html — Iskra 2.0.0-alpha.14 · dev')
})

test('the commit comes from dist/build-info.json, or is "dev"', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'iskra-title-'))
  try {
    const file = path.join(dir, 'build-info.json')
    assert.equal(readBuildCommit(file), 'dev') // no file
    writeFileSync(file, JSON.stringify({ commit: 'a89a580' }))
    assert.equal(readBuildCommit(file), 'a89a580')
    writeFileSync(file, JSON.stringify({ commit: 'A89A580; rm -rf' }))
    assert.equal(readBuildCommit(file), 'dev')
    writeFileSync(file, 'not json')
    assert.equal(readBuildCommit(file), 'dev')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
