import sodium from 'libsodium-wrappers-sumo'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import golden from '../../../protocol/log-format.json'
import codes from '../../../protocol/log-codes.json'
import { addLogSink, BrowserMessage, duration, errorFields, formatLine, log, logError, makeEntry, parseLine, scrub, serverLogId, setLogClock, type LogEntry, type LogLevel, type LogSource, type LogValue } from './log'

describe('the line format', () => {
  it('renders the golden lines exactly as the server does', () => {
    for (const c of golden.cases) {
      const fields = (c.fields as [string, LogValue][]).map(([k, v]): [string, LogValue] => [k, k === 'msg' && typeof v === 'string' ? new BrowserMessage(v) : v])
      const entry = makeEntry(Date.parse(c.at), c.level as LogLevel, c.src as LogSource, c.area, c.event, c.code, fields)
      expect(entry && formatLine(entry)).toBe(c.line)
    }
  })

  it('reads its own lines back', () => {
    for (const c of golden.cases) {
      const parsed = parseLine(c.line)!
      expect(parsed.time).toBe(c.at)
      expect(parsed.level).toBe(c.level)
      expect(parsed.src).toBe(c.src)
    }
    expect(parseLine('2026-10-17T13:00:00.000Z INFO  app   conn   online      -       srv=7c2e took=230ms')?.fields).toEqual({ srv: '7c2e', took: '230ms' })
    expect(parseLine('not a log line')).toBeNull()
    // The server's lines read the same way (a built-in bot's source is longer than the column).
    expect(parseLine('2026-10-17T13:41:30.112Z DEBUG bot:dice sched  failed      BOT-110')?.src).toBe('bot:dice')
  })

  it('puts a code on every warning and error, and keeps values short and plain', () => {
    const at = Date.UTC(2026, 9, 17)
    expect(makeEntry(at, 'WARN', 'app', 'conn', 'offline', null)?.code).toBe('ERR-900')
    expect(makeEntry(at, 'INFO', 'app', 'conn', 'online', null)?.code).toBeNull()
    expect(makeEntry(at, 'INFO', 'app', 'conn', 'online', null, { n: 1.5, ok: true, why: 'x'.repeat(41), retry: true })?.fields).toEqual([['n', '1.5']])
    expect(makeEntry(at, 'INFO', 'nope' as LogSource, 'conn', 'online', null)).toBeNull()
    expect(makeEntry(Number.NaN, 'INFO', 'app', 'conn', 'online', null)).toBeNull()
    expect(makeEntry(at, 'INFO', 'app', 'ui', 'error', null, { msg: 'a message someone wrote' })?.fields).toEqual([])
    const long = makeEntry(at, 'INFO', 'app', 'ui', 'error', null, { msg: new BrowserMessage('word '.repeat(60)) })!
    expect(long.fields[0][1].length).toBeLessThanOrEqual(122)
    expect(long.fields[0][1].endsWith('…"')).toBe(true)
  })

  it('writes durations the way the server does', () => {
    expect(duration(497)).toBe('497ms')
    expect(duration(6700)).toBe('6.7s')
    expect(duration(312_400)).toBe('312s')
    expect(duration(-1)).toBe('0ms')
  })
})

describe('scrubbing text', () => {
  it('takes out addresses, paths, emails and long tokens', () => {
    const out = scrub('to 203.0.113.42:443 and [2001:db8::1]:80 from /home/alice/x via \\\\nas\\share token AbCdEfGhIjKlMnOpQrStUvWxYz0123456789')
    expect(out).not.toMatch(/203\.0|2001:db8|alice|nas|AbCdEf/)
    expect(scrub('see https://chat.example.com/#/join/secret?x=1 now')).toBe('see https://chat.example.com/… now')
  })
})

describe('errors', () => {
  it('keep their class and frame; only browser errors keep their message', () => {
    const own = Object.assign(new Error('Alice said meet at 5'), { name: 'TypeError', stack: 'TypeError: x\n    at f (app://iskra/assets/index-3f2a.js:12:3456)' })
    expect(errorFields(own)).toEqual([['name', 'TypeError'], ['frame', 'index-3f2a.js:12:3456']])
    const dom = new DOMException('Cannot close a closed AudioContext', 'InvalidStateError')
    expect(errorFields(dom)).toContainEqual(['msg', new BrowserMessage('Cannot close a closed AudioContext')])
    expect(errorFields('a string with a secret')).toEqual([['name', 'Error'], ['frame', undefined]])
    expect(errorFields({ name: 'Not a class name!' })[0]).toEqual(['name', 'Error'])
  })
})

describe('sinks', () => {
  afterEach(() => setLogClock(null))

  it('get every allowed entry, and a failing sink breaks nothing', () => {
    setLogClock(() => Date.UTC(2026, 9, 17, 13))
    const seen: LogEntry[] = []
    const stopBad = addLogSink(() => { throw new Error('boom') })
    const stop = addLogSink((e) => seen.push(e))
    log('INFO', 'life', 'start', null, { ver: '2.0.0' })
    logError('voice', 'audio-close', new DOMException('Cannot close a closed AudioContext', 'InvalidStateError'))
    stop()
    stopBad()
    log('INFO', 'life', 'stop')
    expect(seen.map((e) => formatLine(e).replace(/ frame=\S+/, ''))).toEqual([
      '2026-10-17T13:00:00.000Z INFO  app   life   start       -       ver=2.0.0',
      '2026-10-17T13:00:00.000Z ERROR app   voice  failed      ERR-910 op=audio-close name=InvalidStateError msg="Cannot close a closed AudioContext"',
    ])
  })
})

describe('the server id', () => {
  beforeAll(async () => {
    await sodium.ready
  })

  it('is 4 hex of BLAKE2b-256("iskra-log-v1" ‖ 0 ‖ key), the same as the server prints', () => {
    const key = new Uint8Array(32).map((_, i) => i)
    const b64 = sodium.to_base64(key, sodium.base64_variants.URLSAFE_NO_PADDING)
    const payload = new Uint8Array([...new TextEncoder().encode('iskra-log-v1'), 0, ...key])
    expect(serverLogId(b64)).toBe(sodium.to_hex(sodium.crypto_generichash(32, payload, null)).slice(0, 4))
    expect(serverLogId(b64)).toMatch(/^[0-9a-f]{4}$/)
    expect(serverLogId('not base64!')).toBeNull()
  })
})

// ── Codes: every code the app uses is in protocol/log-codes.json, and every app code listed there is used ──────

/** Listed for the app but logged only once the voice quality sampler (ICE) and the handshake timeout exist. */
const NOT_YET: string[] = ['VOI-130', 'CON-120']
/** Strings that look like codes but aren't. */
const NOT_CODES = ['SHA-256']

/** The app's own source files (not tests, not vendored code). */
const SOURCES = Object.entries(import.meta.glob(['../**/*.ts', '../**/*.tsx', '!../**/*.test.ts', '!../**/*.test.tsx', '!../vendor/**'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>)

describe('log codes', () => {
  it('match protocol/log-codes.json both ways', () => {
    const list = codes.codes as { code: string; sources: string[]; retired?: boolean }[]
    const used = new Set<string>()
    expect(SOURCES.length).toBeGreaterThan(100)
    for (const [, text] of SOURCES) {
      for (const m of text.matchAll(/'([A-Z][A-Z0-9]{1,2}-\d{3})'/g)) if (!NOT_CODES.includes(m[1])) used.add(m[1])
    }
    const listed = new Set(list.map((c) => c.code))
    expect([...used].filter((c) => !listed.has(c))).toEqual([])
    const forApp = list.filter((c) => !c.retired && c.sources.includes('app')).map((c) => c.code)
    expect(forApp.filter((c) => !used.has(c) && !NOT_YET.includes(c))).toEqual([])
  })
})
