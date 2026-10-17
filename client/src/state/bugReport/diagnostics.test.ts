import sodium from 'libsodium-wrappers-sumo'
import { afterEach, describe, expect, it } from 'vitest'
import { errorFields, formatLine, log, makeEntry, setLogClock, type LogEntry } from '../../core/log'
import { useLogIds } from '../logIds'
import { DiagnosticsBuffer, diagnostics, finalNet, MAX_AGE_MS } from './diagnostics'
import { buildPayload, emptyDraft, MAX_LOGS, previewPayload, renderLogs, type ReportEnv } from './payload'
import { closeWhy, connectionLine, voiceLeftCode, type ConnectSeries } from './recorders'

const at = Date.UTC(2026, 9, 14, 12, 0, 0)

// Things that must never leave the device in logs.
const SENSITIVE = {
  message: 'meet me at the usual place tonight',
  fileName: 'tax-return-2026.pdf',
  member: 'Alice Wonderland',
  accountKey: 'Qk7-'.repeat(10) + 'abc', // 43 base64url characters, like an account key
  serverName: 'Secret Club',
  invite: 'https://chat.example.com/#/join/AbCdEfGhIjKlMnOpQrStUvWx',
  inviteCode: 'Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2',
  token: ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ4In0', 'c2lnbmF0dXJl'].join('.'), // JWT-shaped, built here so secret scanners don't flag the test
  ipv4: '203.0.113.42',
  ipv6: '2001:db8:85a3::8a2e:370:7334',
  email: 'alice@example.org',
  url: 'https://files.example.net/secret?token=abc',
  path: 'C:\\Users\\alice\\Documents\\notes.txt',
}

const env: ReportEnv = { version: '2.0.0-alpha.15', commit: 'abc1234', os: 'Windows', browser: 'Chrome 140', device: 'web', language: 'en' }
const entry = (offset: number, level: LogEntry['level'], area: string, event: string, code: string | null, fields: Record<string, string | number> = {}) =>
  makeEntry(at + offset, level, 'app', area, event, code, fields)!

describe('the buffer', () => {
  it('keeps the newest entries within the limit and age, never debug lines', () => {
    const buffer = new DiagnosticsBuffer(3)
    for (let i = 0; i < 5; i++) buffer.add(entry(i, 'INFO', 'life', 'visible', null))
    buffer.add(entry(6, 'DEBUG', 'life', 'visible', null))
    expect(buffer.entries(at + 10).map((e) => e.at)).toEqual([at + 2, at + 3, at + 4])
    expect(buffer.entries(at + 4 + MAX_AGE_MS + 1)).toEqual([])
  })

  it('checks entries again on the way in', () => {
    const buffer = new DiagnosticsBuffer()
    buffer.add({ at, level: 'INFO', src: 'app', area: 'chat', event: 'sent', code: null, fields: [['text', SENSITIVE.message], ['why', SENSITIVE.message]] })
    buffer.add('a string' as unknown as LogEntry)
    expect(buffer.entries(at).map(formatLine)).toEqual(['2026-10-14T12:00:00.000Z INFO  app   misc   sent        -'])
  })

  it('is fed by the app log', () => {
    setLogClock(() => at)
    diagnostics.clear()
    log('INFO', 'life', 'online')
    setLogClock(null)
    expect(diagnostics.entries(at).map((e) => e.event)).toEqual(['online'])
  })
})

describe('the final net', () => {
  it('removes addresses, emails, links and key-shaped strings', () => {
    for (const value of [SENSITIVE.ipv4, SENSITIVE.ipv6, SENSITIVE.email, SENSITIVE.invite, SENSITIVE.url, SENSITIVE.accountKey, SENSITIVE.token, SENSITIVE.inviteCode]) {
      expect(finalNet(`before ${value} after`)).not.toContain(value)
    }
    expect(finalNet('loopback ::1 and fe80::1 too')).not.toMatch(/::1|fe80::1/)
  })

  it('leaves log lines alone', () => {
    const line = '2026-10-17T13:29:48.582Z WARN  app   conn   offline     CON-110 srv=1a90 conn=k3f path=direct close=1006 why=socket-error retry=497ms n=1'
    expect(finalNet(line)).toBe(line)
  })
})

describe('the report', () => {
  afterEach(() => setLogClock(null))

  const session = [
    entry(0, 'INFO', 'life', 'start', null, { ver: '2.0.0-alpha.15', kind: 'web' }),
    entry(100, 'INFO', 'conn', 'connecting', null, { srv: '7c2e', path: 'direct', n: 0 }),
    entry(330, 'INFO', 'conn', 'online', null, { srv: '7c2e', conn: 'k3f', path: 'direct', took: '230ms', n: 0 }),
    entry(60_000, 'INFO', 'voice', 'connecting', null, { srv: '7c2e', conn: 'k3f', chan: 12 }),
    entry(60_400, 'INFO', 'voice', 'joined', null, { srv: '7c2e', conn: 'k3f', chan: 12, took: '400ms' }),
    entry(67_100, 'INFO', 'voice', 'left', 'VOI-201', { srv: '7c2e', conn: 'k3f', chan: 12, reason: 'other-device', dur: '7.1s' }),
    entry(70_000, 'WARN', 'conn', 'offline', 'CON-110', { srv: '7c2e', conn: 'k3f', path: 'direct', close: 1006, why: 'socket-error', retry: '497ms', n: 1 }),
    entry(71_000, 'WARN', 'conn', 'offline', 'CON-110', { srv: '7c2e', conn: 'k3f', path: 'direct', close: 1006, why: 'socket-error', retry: '1.1s', n: 2 }),
  ]
  const desk = [
    '2026-10-14T11:59:59.000Z INFO  desk  life   start       -       ver=2.0.0-alpha.15 os=win32',
    '2026-10-14T12:01:05.000Z WARN  upd   update failed      UPD-110 why=net',
    `2026-10-14T12:01:06.000Z INFO  evil  life   start       -       msg="${SENSITIVE.message}"`,
    `not a line ${SENSITIVE.member}`,
    '2026-10-14T11:00:00.000Z INFO  desk  life   start       -       ver=old', // older than 30 minutes
  ]

  it('has a header, then servers, voice sessions and problems, then the timeline', () => {
    const logs = renderLogs({ now: at + 120_000, env, settings: { noise: 'strong' }, voice: { state: 'none' }, entries: session, startedAt: at - 3_600_000, extra: desk })
    const lines = logs.split('\n')
    expect(lines[0]).toBe('Iskra 2.0.0-alpha.15 (abc1234) web, Windows, Chrome 140, en')
    expect(lines[1]).toBe('report at 2026-10-14T12:02:00.000Z, up 1h02m')
    expect(logs).toContain('== Servers ==\nsrv=7c2e conn=k3f path=direct state=offline took=230ms retries=2 last-close=1006 last-code=CON-110')
    expect(logs).toContain('== Voice ==\n12:01:00 → 12:01:07 srv=7c2e conn=k3f chan=12 reason=other-device VOI-201 (7.1s)')
    expect(logs).toContain('== Problems ==\nCON-110 x2  12:01:10 .. 12:01:11\nUPD-110 x1  12:01:05\nVOI-201 x1  12:01:07')
    expect(logs).toContain('== Timeline (UTC, last 30 minutes, 10 lines) ==\n2026-10-14T11:59:59.000Z INFO  desk  life   start')
    // A gap of more than 5 s is marked; the desktop's lines sit in time order; anything else from it is left out.
    expect(logs).toContain('-- +59.7s --\n2026-10-14T12:01:00.000Z INFO  app   voice  connecting')
    expect(logs).toContain('2026-10-14T12:01:05.000Z WARN  upd   update failed      UPD-110 why=net\n2026-10-14T12:01:07.100Z INFO  app   voice  left')
    expect(logs).not.toContain('evil')
    expect(logs).not.toContain('ver=old')
  })

  it('stays under the size cap, keeping the newest lines', () => {
    const many = Array.from({ length: 3000 }, (_, i) => entry(i, 'WARN', 'conn', 'offline', 'CON-110', { srv: '7c2e', path: 'direct', close: 1006, why: 'socket-error', retry: '30.0s', n: i }))
    const logs = renderLogs({ now: at + 5000, env, settings: {}, voice: { state: 'none' }, entries: many })
    expect(logs.length).toBeLessThanOrEqual(MAX_LOGS)
    expect(logs).toContain('n=2999')
    expect(logs).not.toContain(' n=0\n')
    expect(logs).toMatch(/3000 lines, the oldest \d+ left out/)
  })
})

describe('connection lines', () => {
  afterEach(() => {
    setLogClock(null)
    useLogIds.setState({ logIds: {} })
  })

  it('name the server by its log id, with the path, close code, retry schedule and the end', async () => {
    const key = sodium.to_base64(new Uint8Array(32).fill(7), sodium.base64_variants.URLSAFE_NO_PADDING)
    diagnostics.clear()
    setLogClock(() => at)
    const series: ConnectSeries = new Map()
    connectionLine(key, { state: 'connecting' }, series, at)
    connectionLine(key, { state: 'offline', retryInMs: 497, closeCode: 1006 }, series, at)
    connectionLine(key, { state: 'connecting' }, series, at + 500)
    useLogIds.setState({ logIds: { [key]: 'k3f' } })
    connectionLine(key, { state: 'online' }, series, at + 730)
    await Promise.resolve()
    connectionLine(key, { state: 'rejected', code: 'banned', message: SENSITIVE.message }, series, at + 900)
    const seen = diagnostics.entries(at).map((e) => formatLine(e).slice(25))
    const srv = /srv=([0-9a-f]{4})/.exec(seen[0])![1]
    expect(seen).toEqual([
      `INFO  app   conn   connecting  -       srv=${srv} path=direct n=0`,
      `WARN  app   conn   offline     CON-110 srv=${srv} path=direct close=1006 why=socket-error retry=497ms n=1`,
      `INFO  app   conn   online      -       srv=${srv} conn=k3f path=direct took=730ms n=1`,
      `WARN  app   conn   rejected    CON-150 srv=${srv} conn=k3f path=direct code=banned`,
    ])
    expect(seen.join('\n')).not.toContain(key)
  })

  it('say why a socket closed, and what a voice end means', () => {
    expect(closeWhy(undefined)).toBe('no-socket')
    expect(closeWhy(1006)).toBe('socket-error')
    expect(closeWhy(1001, true)).toBe('stopped')
    expect(closeWhy(4403)).toBe('server-close')
    expect(voiceLeftCode('other_device')).toEqual({ level: 'INFO', code: 'VOI-201' })
    expect(voiceLeftCode('dropped')).toEqual({ level: 'WARN', code: 'VOI-204' })
    expect(voiceLeftCode('user')).toEqual({ level: 'INFO', code: null })
  })
})

describe('privacy', () => {
  afterEach(() => setLogClock(null))

  it('a whole session fed hostile values leaves nothing personal in the report or the payload', async () => {
    const values = Object.values(SENSITIVE)
    diagnostics.clear()
    setLogClock(() => at)
    const key = sodium.to_base64(new Uint8Array(32).fill(9), sodium.base64_variants.URLSAFE_NO_PADDING)
    const series: ConnectSeries = new Map()
    useLogIds.setState({ logIds: { [key]: SENSITIVE.inviteCode } }) // not a log id's shape: never written
    connectionLine(key, { state: 'connecting' }, series)
    connectionLine(key, { state: 'online' }, series)
    await Promise.resolve()
    for (const value of values) {
      connectionLine(key, { state: 'rejected', code: value, message: value, detail: { name: value } }, series)
      log('INFO', 'conn', 'request-failed', null, { type: value, code: value })
      log('INFO', 'voice', 'left', null, { chan: value, reason: value, srv: value, why: value, msg: value })
      log('WARN', value, value, value, { [value]: value, name: value, frame: value, op: value })
      log('ERROR', 'ui', 'error', 'ERR-900', [['kind', 'window'], ...errorFields(Object.assign(new Error(value), { name: value, stack: `${value}\n at ${value}` }))])
      log('ERROR', 'ui', 'error', 'ERR-900', errorFields(new DOMException(`failed for ${SENSITIVE.ipv4} ${SENSITIVE.email} ${SENSITIVE.url} ${SENSITIVE.accountKey} ${SENSITIVE.path}`, 'NotAllowedError')))
    }
    useLogIds.setState({ logIds: {} })
    const extra = values.flatMap((value) => [
      `2026-10-14T12:00:00.000Z INFO  desk  life   start       -       ver=${value}`,
      `2026-10-14T12:00:00.000Z INFO  ${value}  life   start       -`,
      value,
    ])
    const settings: Record<string, string | boolean> = Object.fromEntries(values.map((v, i) => [`setting${i}`, v]))
    settings[SENSITIVE.serverName] = true
    const logs = renderLogs({
      now: at, env, entries: diagnostics.entries(at), extra,
      settings: { ...settings, noise: 'strong' },
      voice: { state: 'connected', call: 'channel', micEngine: 'rnnoise', codec: 'opus', lossIn: 0.5, jitterMs: 12 },
    })
    for (const value of values) expect(logs).not.toContain(value)
    expect(logs).toContain('noise=strong')
    expect(logs).toContain('conn   online')
    expect(logs).toMatch(/name=NotAllowedError (frame=\S+ )?msg="failed for <ip> <email> \[removed\] <token> <path>"/)

    const payload = buildPayload({ ...emptyDraft(), what: 'Mute broke' }, env, logs)
    const sent = JSON.stringify(payload) + previewPayload(payload)
    for (const value of values) expect(sent).not.toContain(value)
  })
})
