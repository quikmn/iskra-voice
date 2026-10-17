import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { gunzipSync, gzipSync } from 'node:zlib'
import { DeskLog, errorFields, fileName, formatLine, LogMessage, makeEntry, pageEntry, runRetention, type LogLevel, type LogSource, type LogValue } from './log'

const REPO = path.join(__dirname, '..', '..')
const DAY = 86_400_000
const NOW = Date.parse('2026-10-17T03:00:00Z')

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'iskra-desklog-'))
}

test('renders the golden lines exactly as the app and the server do', () => {
  const golden = JSON.parse(readFileSync(path.join(REPO, 'protocol', 'log-format.json'), 'utf8')) as {
    cases: { at: string; level: LogLevel; src: LogSource; area: string; event: string; code: string | null; fields: [string, LogValue][]; line: string }[]
  }
  for (const c of golden.cases) {
    const fields = c.fields.map(([k, v]): [string, LogValue] => [k, k === 'msg' && typeof v === 'string' ? new LogMessage(v) : v])
    const entry = makeEntry(Date.parse(c.at), c.level, c.src, c.area, c.event, c.code, fields)
    assert.equal(entry && formatLine(entry), c.line)
  }
  assert.equal(makeEntry(NOW, 'WARN', 'desk', 'life', 'failed', null)?.code, 'DSK-900')
})

test('every code the desktop app uses is in protocol/log-codes.json, and every desktop code listed there is used', () => {
  const codes = (JSON.parse(readFileSync(path.join(REPO, 'protocol', 'log-codes.json'), 'utf8')) as { codes: { code: string; sources: string[]; retired?: boolean }[] }).codes
  const src = path.join(REPO, 'desktop', 'src')
  const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    return statSync(full).isDirectory() ? files(full) : name.endsWith('.ts') && !name.endsWith('.test.ts') ? [full] : []
  })
  const used = new Set<string>()
  for (const file of files(src)) for (const m of readFileSync(file, 'utf8').matchAll(/'([A-Z][A-Z0-9]{1,2}-\d{3})'/g)) used.add(m[1])
  const listed = new Set(codes.map((c) => c.code))
  assert.deepEqual([...used].filter((c) => !listed.has(c)), [])
  const ours = codes.filter((c) => !c.retired && c.sources.some((s) => s === 'desk' || s === 'upd')).map((c) => c.code)
  assert.deepEqual(ours.filter((c) => !used.has(c)), [])
})

// Things that must never reach the log.
const SENSITIVE = {
  serverName: 'Secret Club',
  folder: 'C:\\Users\\alice\\AppData\\Roaming\\Iskra\\servers\\secret-club',
  home: '/home/alice/.config/Iskra',
  ipv4: '203.0.113.42',
  ipv6: '2001:db8:85a3::8a2e:370:7334',
  email: 'alice@example.org',
  url: 'https://objects.githubusercontent.com/x/y.exe?X-Amz-Signature=abc&token=s3cret',
  key: 'Qk7-'.repeat(10) + 'abc',
  secret: 'Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2',
  message: 'meet me at the usual place tonight',
}

test('privacy: a whole run fed hostile values leaves nothing personal in the file or the tail', () => {
  const dir = tempDir()
  try {
    let now = NOW
    const log = new DeskLog({ now: () => now })
    log.open(dir)
    const values = Object.values(SENSITIVE)
    for (const value of values) {
      log.info('life', 'host-start', [['port', value], ['why', value], ['what', value], ['ver', value], ['os', value]])
      log.warn('DSK-120', 'life', 'host-stopped', [['exit', value], [value, value], ['name', value], ['frame', value]])
      log.error('DSK-900', 'life', 'failed', Object.assign(new Error(`${value} at ${SENSITIVE.folder} for ${SENSITIVE.email} via ${SENSITIVE.url} ${SENSITIVE.key} ${SENSITIVE.ipv4}`), { code: value }))
      log.write('WARN', 'upd', value, value, value, [['msg', value]])
      // The page's entries are checked again: a message is scrubbed, other text has to fit its key's shape.
      log.fromPage({ at: now, level: 'INFO', src: 'evil', area: 'voice', event: 'left', code: null, fields: [['reason', value], ['chan', value], ['srv', value], ['msg', `"${SENSITIVE.ipv4} ${SENSITIVE.key}"`], [value, 'x']] })
      log.fromPage({ at: now, level: 'ERROR', area: value, event: value, code: value, fields: value })
      log.fromPage(value)
      now += 1000
    }
    const text = readdirSync(dir).map((name) => readFileSync(path.join(dir, name), 'utf8')).join('\n') + log.tail().join('\n')
    for (const value of [...values, 'alice', 's3cret', 'X-Amz-Signature']) assert.ok(!text.includes(value), `found ${value}`)
    assert.ok(text.includes('INFO  app   voice  left        -       msg="<ip> <token>"'))
    assert.ok(text.includes('ERROR desk  life   failed      DSK-900 name=Error'))
    // The updater's errors keep their first line (a library's wording), scrubbed.
    log.write('WARN', 'upd', 'update', 'failed', 'UPD-110', errorFields(new Error(`fetch ${SENSITIVE.url} into ${SENSITIVE.folder} and ${SENSITIVE.home} from ${SENSITIVE.ipv4} ${SENSITIVE.ipv6} ${SENSITIVE.key} ${SENSITIVE.email}`), true))
    const updater = log.tail().at(-1)!
    assert.match(updater, /msg="fetch https:\/\/objects\.githubusercontent\.com\/… into <path> and <path> from <ip> <ip> <token> <email>"$/)
    for (const value of ['alice', 's3cret', SENSITIVE.ipv4, SENSITIVE.key]) assert.ok(!updater.includes(value), `found ${value}`)
    for (const line of text.split('\n').filter(Boolean)) assert.match(line, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z (INFO |WARN |ERROR) (desk|upd|app) /)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('errors say their class, code and first line, scrubbed', () => {
  const error = Object.assign(new Error('Cannot find latest.yml\nXML: <feed>…'), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' })
  const entry = makeEntry(NOW, 'WARN', 'upd', 'update', 'failed', 'UPD-110', errorFields(error, true))!
  assert.match(formatLine(entry), /UPD-110 name=Error why=err-updater-channel-file-not-found frame=log\.test\.js:\d+:\d+ msg="Cannot find latest\.yml"$/)
  assert.deepEqual(errorFields('plain'), [['name', 'Error']])
  // Other errors never keep their message (it may name a server or a file).
  assert.ok(!errorFields(new Error('Secret Club failed')).some(([k]) => k === 'msg'))
})

test('the page entries keep their own time only when it is close to now', () => {
  assert.equal(pageEntry({ at: NOW - 5000, level: 'INFO', area: 'life', event: 'start', fields: [] }, NOW)?.at, NOW - 5000)
  assert.equal(pageEntry({ at: 0, level: 'INFO', area: 'life', event: 'start', fields: [] }, NOW)?.at, NOW)
  assert.equal(pageEntry({ at: NOW, level: 'DEBUG', area: 'life', event: 'start', fields: [] }, NOW), null)
})

test('the tail is the last 30 minutes, across midnight, and lines before the folder is known are kept', () => {
  const dir = tempDir()
  try {
    let now = Date.parse('2026-10-17T23:50:00Z')
    const log = new DeskLog({ now: () => now })
    log.info('life', 'start') // before open: kept and written once it opens
    log.open(dir)
    now += 15 * 60_000 // 00:05 the next day
    log.info('life', 'sleep')
    now += 10 * 60_000
    log.info('life', 'resumed')
    assert.deepEqual(readdirSync(dir).sort(), ['2026-10-17.log', '2026-10-18.log'])
    assert.deepEqual(log.tail().map((l) => l.slice(0, 24)), ['2026-10-17T23:50:00.000Z', '2026-10-18T00:05:00.000Z', '2026-10-18T00:15:00.000Z'])
    now += 20 * 60_000
    assert.deepEqual(log.tail().map((l) => l.split(/\s+/)[4]), ['sleep', 'resumed'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── Retention (the server's stairs, LoggingTests) ──────────────────────────

function day(dir: string, daysAgo: number, text = 'line\n', gz = false): string {
  const file = path.join(dir, fileName(NOW - daysAgo * DAY) + (gz ? '.gz' : ''))
  writeFileSync(file, gz ? gzipSync(text) : text)
  return file
}

test('files stay plain, then gzipped, then go', () => {
  const dir = tempDir()
  try {
    day(dir, 0)
    day(dir, 59, 'fifty-nine\n')
    const sixtyOne = day(dir, 61, 'sixty-one\n')
    day(dir, 179, 'kept\n', true)
    day(dir, 181, 'gone\n', true)
    day(dir, 181, 'gone too\n')
    writeFileSync(path.join(dir, 'notes.txt'), 'not ours')
    const result = runRetention(dir, NOW)
    assert.deepEqual(readdirSync(dir).sort(), [fileName(NOW - 179 * DAY) + '.gz', fileName(NOW - 61 * DAY) + '.gz', fileName(NOW - 59 * DAY), fileName(NOW), 'notes.txt'].sort())
    assert.equal(gunzipSync(readFileSync(sixtyOne + '.gz')).toString(), 'sixty-one\n')
    assert.equal(result.compressed, 1)
    assert.equal(result.deleted, 2)
    // Again: nothing more to do.
    assert.deepEqual(runRetention(dir, NOW), { compressed: 0, deleted: 0, skipped: 0, bytes: result.bytes })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('over the size cap the oldest go first, gzipped before plain, never today', () => {
  const dir = tempDir()
  try {
    const mb = 'x'.repeat(1024 * 1024)
    day(dir, 0, mb)
    day(dir, 1, mb)
    day(dir, 2, mb)
    day(dir, 2, mb, true)
    day(dir, 3, mb)
    runRetention(dir, NOW, { plainDays: 60, keepDays: 180, maxMb: 2 })
    assert.deepEqual(readdirSync(dir).sort(), [fileName(NOW - DAY), fileName(NOW)].sort())
    // Today's file alone over the cap: still kept.
    const only = tempDir()
    try {
      writeFileSync(path.join(only, fileName(NOW)), mb + mb + mb)
      runRetention(only, NOW, { plainDays: 60, keepDays: 180, maxMb: 1 })
      assert.ok(existsSync(path.join(only, fileName(NOW))))
    } finally {
      rmSync(only, { recursive: true, force: true })
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an interrupted compression is finished or cleaned up on the next run', () => {
  const dir = tempDir()
  try {
    // Stopped mid-write: a temp file and the plain one.
    const plain = day(dir, 70, 'seventy\n')
    writeFileSync(`${plain}.gz.tmp`, 'half')
    // Stopped right after the rename: both the plain file and its gzip.
    const both = day(dir, 80, 'eighty\n')
    writeFileSync(`${both}.gz`, gzipSync('eighty\n'))
    runRetention(dir, NOW)
    assert.deepEqual(readdirSync(dir).sort(), [fileName(NOW - 80 * DAY) + '.gz', fileName(NOW - 70 * DAY) + '.gz'].sort())
    assert.equal(gunzipSync(readFileSync(`${plain}.gz`)).toString(), 'seventy\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a file that cannot be read is skipped, not fatal', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const dir = tempDir()
  try {
    const locked = day(dir, 70, 'locked\n')
    chmodSync(locked, 0o000)
    day(dir, 75, 'fine\n')
    const result = runRetention(dir, NOW)
    assert.equal(result.skipped, 1)
    assert.equal(result.compressed, 1)
    chmodSync(locked, 0o644)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('no folder: nothing happens', () => {
  assert.deepEqual(runRetention(path.join(tmpdir(), 'iskra-no-such-folder-xyz'), NOW), { compressed: 0, deleted: 0, skipped: 0, bytes: 0 })
})
