import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { folderPart, MAX_WRITE, MIN_FREE_BYTES, Recordings, stampName, trackName } from './recordings'

const base = () => mkdtempSync(path.join(tmpdir(), 'iskra-rec-'))
const plenty = async () => 10 * 1024 * 1024 * 1024
const at = new Date(2026, 9, 18, 21, 5, 9)

test('a recording gets <server>/<channel>/<date time>/ with its files and info.txt', async () => {
  const dir = base()
  try {
    const recordings = new Recordings(plenty)
    const begun = await recordings.begin(dir, 'Friends: the server', '../lounge', 1, at)
    assert.ok('id' in begun)
    assert.equal(begun.folder, path.join(dir, 'Friends the server', '..lounge'.replace(/^\.+/, ''), '2026-10-18 21-05-09'))
    const alex = await recordings.open(begun.id, 'Alex.webm', 1)
    assert.ok(alex)
    assert.equal(await recordings.write(alex, new Uint8Array([1, 2]), 1), 'ok')
    assert.equal(await recordings.write(alex, new Uint8Array([3]), 1), 'ok')
    assert.equal(await recordings.info(begun.id, 'who\nwhen\n', 1), true)
    // Another page (or a made-up id) can't touch it.
    assert.equal(await recordings.write(alex, new Uint8Array([9]), 2), 'failed')
    assert.equal(await recordings.open(begun.id, 'Bea.webm', 2), null)
    await recordings.end(begun.id, 1)
    assert.equal(recordings.openFiles, 0)
    assert.deepEqual([...readFileSync(path.join(begun.folder, 'Alex.webm'))], [1, 2, 3])
    assert.match(readFileSync(path.join(begun.folder, 'info.txt'), 'utf8'), /^who\r?\nwhen\r?\n$/)
    assert.equal(recordings.folderOf(begun.id, 1), begun.folder)
    assert.equal(await recordings.open(begun.id, 'Late.webm', 1), null) // over

    // A second recording in the same second gets its own folder.
    const again = await recordings.begin(dir, 'Friends: the server', '../lounge', 1, at)
    assert.ok('id' in again)
    assert.equal(path.basename(again.folder), '2026-10-18 21-05-09 (2)')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('file names are plain .webm names in the folder; nothing is overwritten', async () => {
  for (const bad of ['../x.webm', 'a/b.webm', 'a\\b.webm', 'x.exe', '.webm', 'con.webm', 'a:b.webm', 42, null, `${'a'.repeat(80)}.webm`]) {
    assert.equal(trackName(bad), null, String(bad))
  }
  assert.equal(trackName('Alex (2).webm'), 'Alex (2).webm')
  assert.equal(folderPart('  ..  ', 'Voice'), 'Voice')
  assert.equal(folderPart('NUL', 'Voice'), 'Voice')
  // Device names count whatever follows the first dot, and with superscript digits.
  for (const name of ['CON.x', 'con .txt', 'COM¹', 'lpt³.backup', 'Aux.', 'CONOUT$']) assert.equal(folderPart(name, 'Voice'), 'Voice', name)
  assert.equal(trackName('CON.x.webm'), null)
  assert.equal(trackName('COM¹.webm'), null)
  assert.equal(folderPart('Console', 'Voice'), 'Console')
  assert.equal(trackName('Connor.webm'), 'Connor.webm')
  assert.equal(stampName(at), '2026-10-18 21-05-09')

  const dir = base()
  try {
    const recordings = new Recordings(plenty)
    const begun = await recordings.begin(dir, 's', 'c', 1, at)
    assert.ok('id' in begun)
    writeFileSync(path.join(begun.folder, 'Taken.webm'), 'mine')
    assert.equal(await recordings.open(begun.id, 'Taken.webm', 1), null)
    assert.equal(readFileSync(path.join(begun.folder, 'Taken.webm'), 'utf8'), 'mine')
    const file = await recordings.open(begun.id, 'Big.webm', 1)
    assert.equal(await recordings.write(file, new Uint8Array(MAX_WRITE + 1), 1), 'failed')
    assert.equal(await recordings.write(file, 'text', 1), 'failed')
    assert.equal(await recordings.info(begun.id, 'x'.repeat(70_000), 1), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a full disk stops it (keeping what was written), and it never starts on a nearly full one', async () => {
  const dir = base()
  try {
    let free = 10 * 1024 * 1024 * 1024
    const recordings = new Recordings(async () => free)
    const begun = await recordings.begin(dir, 's', 'c', 1, at)
    assert.ok('id' in begun)
    const file = await recordings.open(begun.id, 'Alex.webm', 1)
    assert.equal(await recordings.write(file, new Uint8Array([1]), 1), 'ok')
    free = MIN_FREE_BYTES - 1
    // Checked every so often, not on every write: write enough to reach the next check.
    let result = 'ok'
    for (let i = 0; i < 6 && result === 'ok'; i++) result = await recordings.write(file, new Uint8Array(MAX_WRITE), 1)
    assert.equal(result, 'disk')
    assert.equal(await recordings.write(file, new Uint8Array([2]), 1), 'failed')
    await recordings.endAll(1)
    assert.ok(existsSync(path.join(begun.folder, 'Alex.webm')))

    const none = await recordings.begin(dir, 's', 'c2', 1, at)
    assert.deepEqual(none, { error: 'disk' })
    assert.deepEqual(readdirSync(path.join(dir, 's', 'c2')), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
