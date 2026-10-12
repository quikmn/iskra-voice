import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { MAX_WRITE, SaveStreams, suggestedName } from './saveStreams'

const folder = () => mkdtempSync(path.join(tmpdir(), 'iskra-save-'))

test('a finished save gets its real name; nothing is there before', async () => {
  const dir = folder()
  try {
    const saves = new SaveStreams()
    const target = path.join(dir, 'movie.mkv')
    const id = await saves.begin(target, 1)
    assert.equal(await saves.write(id, new Uint8Array([1, 2, 3]), 1), true)
    assert.equal(await saves.write(id, new Uint8Array([4]), 1), true)
    assert.equal(existsSync(target), false)
    assert.equal(await saves.finish(id, 1), true)
    assert.deepEqual([...readFileSync(target)], [1, 2, 3, 4])
    assert.equal(existsSync(`${target}.iskra-part`), false)
    assert.equal(await saves.write(id, new Uint8Array([5]), 1), false) // done
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an aborted save leaves nothing behind, and an existing file the user chose to replace is kept until the end', async () => {
  const dir = folder()
  try {
    const saves = new SaveStreams()
    const target = path.join(dir, 'a.bin')
    writeFileSync(target, 'old')
    const id = await saves.begin(target, 1)
    await saves.write(id, new Uint8Array([9]), 1)
    await saves.abort(id, 1)
    assert.equal(readFileSync(target, 'utf8'), 'old')
    assert.equal(existsSync(`${target}.iskra-part`), false)

    const second = await saves.begin(target, 1)
    await saves.write(second, new Uint8Array([7]), 1)
    assert.equal(await saves.finish(second, 1), true)
    assert.deepEqual([...readFileSync(target)], [7])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('only the page that started a save can touch it, with real bytes of a sane size', async () => {
  const dir = folder()
  try {
    const saves = new SaveStreams()
    const id = await saves.begin(path.join(dir, 'b.bin'), 1)
    assert.equal(await saves.write(id, new Uint8Array([1]), 2), false)
    assert.equal(await saves.finish(id, 2), false)
    assert.equal(await saves.write(id, 'text', 1), false)
    assert.equal(await saves.write(id, new Uint8Array(MAX_WRITE + 1), 1), false)
    assert.equal(await saves.write('made-up', new Uint8Array([1]), 1), false)
    await saves.abortAll(1)
    assert.equal(saves.open, 0)
    assert.equal(existsSync(path.join(dir, 'b.bin.iskra-part')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('suggested names carry no folders or forbidden characters', () => {
  assert.equal(suggestedName('..\\..\\Windows\\evil.exe'), 'evil.exe')
  assert.equal(suggestedName('a/b/c:d?.txt'), 'cd.txt')
  assert.equal(suggestedName('...'), 'file')
  assert.equal(suggestedName(42), 'file')
  assert.equal(suggestedName('photo.jpg'), 'photo.jpg')
})

test('writes the page sends without waiting land in order, and finish waits for them (security review)', async () => {
  const dir = folder()
  try {
    const saves = new SaveStreams()
    const target = path.join(dir, 'big.bin')
    const id = await saves.begin(target, 1)
    const a = new Uint8Array(3 * 1024 * 1024).fill(1)
    const b = new Uint8Array(1024).fill(2)
    const c = new Uint8Array(2 * 1024 * 1024).fill(3)
    const writes = [saves.write(id, a, 1), saves.write(id, b, 1), saves.write(id, c, 1)]
    const finished = saves.finish(id, 1)
    assert.equal(await saves.write(id, new Uint8Array([9]), 1), false) // nothing after finish
    assert.deepEqual(await Promise.all(writes), [true, true, true])
    assert.equal(await finished, true)
    const got = readFileSync(target)
    assert.equal(got.length, a.length + b.length + c.length)
    assert.equal(got[a.length - 1], 1)
    assert.equal(got[a.length], 2)
    assert.equal(got[a.length + b.length], 3)
    assert.equal(got[got.length - 1], 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a part file already there is never truncated or reused (security review)', async () => {
  const dir = folder()
  try {
    const saves = new SaveStreams()
    const target = path.join(dir, 'x.bin')
    writeFileSync(`${target}.iskra-part`, 'someone else')
    const id = await saves.begin(target, 1)
    assert.equal(await saves.write(id, new Uint8Array([7]), 1), true)
    assert.equal(await saves.finish(id, 1), true)
    assert.equal(readFileSync(`${target}.iskra-part`, 'utf8'), 'someone else')
    assert.deepEqual([...readFileSync(target)], [7])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
