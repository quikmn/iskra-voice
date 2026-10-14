import { describe, expect, it } from 'vitest'
import { DiagnosticsBuffer, errorFrame, finalNet, MAX_AGE_MS, sanitizeEntry } from './diagnostics'
import { buildPayload, emptyDraft, previewPayload, renderLogs, type ReportEnv } from './payload'

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
}

const env: ReportEnv = { version: '2.0.0-alpha.15', commit: 'abc1234', os: 'Windows', browser: 'Chrome 140', device: 'web', language: 'en' }

describe('the allowlist', () => {
  it('keeps known kinds with their allowed fields only', () => {
    expect(sanitizeEntry({ at, kind: 'connection', server: 2, state: 'offline', retryMs: 1500, url: SENSITIVE.invite, name: SENSITIVE.serverName }))
      .toEqual({ at, kind: 'connection', server: 2, state: 'offline', retryMs: 1500 })
    expect(sanitizeEntry({ at, kind: 'request', type: 'chat.send', code: 'forbidden', text: SENSITIVE.message }))
      .toEqual({ at, kind: 'request', type: 'chat.send', code: 'forbidden' })
    expect(sanitizeEntry({ at, kind: 'error', source: 'window', name: 'TypeError', frame: 'index-3f2a.js:12:3456', message: SENSITIVE.message }))
      .toEqual({ at, kind: 'error', source: 'window', name: 'TypeError', frame: 'index-3f2a.js:12:3456' })
  })

  it('refuses unknown kinds and values that are not on the list', () => {
    expect(sanitizeEntry({ at, kind: 'chat', text: SENSITIVE.message })).toBeNull()
    expect(sanitizeEntry({ at, kind: 'connection', server: 1, state: SENSITIVE.serverName })).toBeNull()
    expect(sanitizeEntry({ at, kind: 'request', type: `chat.send ${SENSITIVE.message}`, code: 'x' })).toBeNull()
    expect(sanitizeEntry({ at, kind: 'request', type: 'chat.send', code: SENSITIVE.ipv4 })).toBeNull()
    expect(sanitizeEntry({ kind: 'app', event: 'start' })).toBeNull() // no time
    // A bad optional field is dropped, not kept.
    expect(sanitizeEntry({ at, kind: 'connection', server: 1, state: 'rejected', code: SENSITIVE.invite }))
      .toEqual({ at, kind: 'connection', server: 1, state: 'rejected' })
    expect(sanitizeEntry({ at, kind: 'error', source: 'promise', name: `Error: ${SENSITIVE.message}`, frame: SENSITIVE.url }))
      .toEqual({ at, kind: 'error', source: 'promise', name: 'Error' })
    expect(sanitizeEntry({ at, kind: 'update', state: 'ready', version: SENSITIVE.fileName })).toEqual({ at, kind: 'update', state: 'ready' })
  })

  it('takes only the file and line from a stack', () => {
    expect(errorFrame('TypeError: x is undefined\n    at send (app://iskra/assets/index-3f2a.js:12:3456)')).toBe('index-3f2a.js:12:3456')
    expect(errorFrame(`Error: ${SENSITIVE.message}`)).toBeUndefined()
    expect(errorFrame(undefined)).toBeUndefined()
  })
})

describe('the buffer', () => {
  it('keeps the newest entries within the limit and age', () => {
    const buffer = new DiagnosticsBuffer(3)
    for (let i = 0; i < 5; i++) buffer.record({ at: at + i, kind: 'app', event: 'visible' })
    expect(buffer.entries(at + 10).map((e) => e.at)).toEqual([at + 2, at + 3, at + 4])
    expect(buffer.entries(at + 4 + MAX_AGE_MS + 1)).toEqual([])
  })

  it('drops anything off the allowlist on the way in', () => {
    const buffer = new DiagnosticsBuffer()
    buffer.record({ at, kind: 'chat', text: SENSITIVE.message })
    buffer.record('a string')
    expect(buffer.entries(at)).toEqual([])
  })
})

describe('the final net', () => {
  it('removes addresses, emails, links and key-shaped strings', () => {
    for (const value of [SENSITIVE.ipv4, SENSITIVE.ipv6, SENSITIVE.email, SENSITIVE.invite, SENSITIVE.url, SENSITIVE.accountKey, SENSITIVE.token, SENSITIVE.inviteCode]) {
      expect(finalNet(`before ${value} after`)).not.toContain(value)
    }
    expect(finalNet('loopback ::1 and fe80::1 too')).not.toMatch(/::1|fe80::1/)
  })

  it('leaves times, versions and short words alone', () => {
    const line = '12:03:04.123 connection s1 online retry 1500ms update ready 2.0.0-alpha.15 echoCancellation=true'
    expect(finalNet(line)).toBe(line)
  })
})

describe('logs and payload', () => {
  it('never contain known-sensitive values, wherever they were put', () => {
    const buffer = new DiagnosticsBuffer()
    const values = Object.values(SENSITIVE)
    for (const value of values) {
      buffer.record({ at, kind: 'connection', server: 1, state: 'rejected', code: value, url: value })
      buffer.record({ at, kind: 'request', type: 'chat.send', code: 'forbidden', text: value })
      buffer.record({ at, kind: 'error', source: 'window', name: value, frame: value })
      buffer.record({ at, kind: 'voice', state: 'connected', engine: value })
      buffer.record({ at, kind: value })
    }
    const settings: Record<string, string | boolean> = Object.fromEntries(values.map((v, i) => [`setting${i}`, v]))
    settings[SENSITIVE.serverName] = true
    const logs = renderLogs({
      now: at, env, entries: buffer.entries(at),
      settings: { ...settings, noise: 'strong', leveling: true },
      voice: { state: 'connected', call: 'channel', micEngine: 'rnnoise', codec: 'opus', lossIn: 0.5, jitterMs: 12 },
    })
    for (const value of values) expect(logs).not.toContain(value)
    expect(logs).toContain('noise=strong')
    expect(logs).toContain('codec opus')
    expect(logs).toContain('request chat.send failed forbidden')

    const payload = buildPayload({ ...emptyDraft(), what: 'Mute broke' }, env, logs)
    const sent = JSON.stringify(payload) + previewPayload(payload)
    for (const value of values) expect(sent).not.toContain(value)
  })
})
