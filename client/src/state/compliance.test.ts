import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildDeviceExport, deletesMore, parseDays, securityEventLabel, SECURITY_EVENTS } from './compliance'
import { en } from '../i18n/en'
import type { Retention } from '../core/protocol'

const dm = (id: string, extra: Record<string, unknown> = {}) => ({ id, from: 'me', to: 'friend', text: `text ${id}`, sentAt: 1, ...extra })

describe('data on this device', () => {
  const exported = buildDeviceExport({
    now: 1760000000000,
    accountKey: 'acc',
    deviceKey: 'dev',
    profile: { name: 'Sam', bio: 'hi', avatar: { bytes: new ArrayBuffer(4), type: 'image/png', hash: 'h' }, page: { html: '<p>', hash: 'x' } },
    servers: [{ url: 'https://chat.example.com', serverKey: 'srv', name: 'Hangout', invite: 'secret-invite' }],
    friends: [{ accountKey: 'f', name: 'Friend', addedAt: 5 }],
    blocks: [{ accountKey: 'b', blocked: true, at: 2 }],
    dms: { friend: [dm('1'), dm('2', { files: [{ key: 'file-key-secret', name: 'a.png' }], call: { kind: 'missed' } })] },
    groups: [{ serverKey: 'srv', id: 'g', chain: [{ payload: 'p', sig: 's' }], name: 'Crew', nameAt: 1, names: { me: 'Sam' }, messages: [dm('3')] }],
    saved: [{ key: 'k1', ref: { kind: 'dm', peer: 'friend', from: 'me', id: '1' }, savedAt: 9, snap: { preview: 'text 1' } }, { key: 'k2', ref: {}, savedAt: 1, removedAt: 2 }],
  })
  const text = JSON.stringify(exported)

  it('has the conversations and what you set up', () => {
    expect(exported.account).toEqual({ accountKey: 'acc', deviceKey: 'dev' })
    expect(exported.profile).toEqual({ name: 'Sam', bio: 'hi', pronouns: null, accent: null, hasAvatar: true })
    expect(exported.directMessages[0].messages.map((m) => m.text)).toEqual(['text 1', 'text 2'])
    expect(exported.directMessages[0].messages[1]).toMatchObject({ attachments: 1, call: true })
    expect(exported.groups[0]).toMatchObject({ name: 'Crew', members: { me: 'Sam' } })
    expect(exported.servers).toEqual([{ name: 'Hangout', url: 'https://chat.example.com', serverKey: 'srv' }])
    expect(exported.savedMessages).toEqual([{ message: { kind: 'dm', peer: 'friend', from: 'me', id: '1' }, savedAt: 9, snapshot: { preview: 'text 1' } }])
  })

  it('leaves out keys, invites and raw bytes', () => {
    expect(text).not.toContain('file-key-secret')
    expect(text).not.toContain('secret-invite')
    expect(text).not.toContain('"chain"')
    expect(text).not.toContain('bytes')
  })
})

describe('retention', () => {
  const now: Retention = { messagesDays: 0, uploadsDays: 30, auditDays: 90, securityLogDays: 365, securityLogIps: false }

  it('asks first when a change deletes more', () => {
    expect(deletesMore(now, { messagesDays: 365 })).toBe(true) // from "keep forever"
    expect(deletesMore(now, { uploadsDays: 7 })).toBe(true)
    expect(deletesMore(now, { uploadsDays: 60 })).toBe(false)
    expect(deletesMore(now, { auditDays: 0 })).toBe(false) // keeping forever deletes nothing
    expect(deletesMore(now, { securityLogIps: true })).toBe(false)
  })

  it('takes whole days from 0 to 36500', () => {
    expect(parseDays(' 30 ')).toBe(30)
    expect(parseDays('0')).toBe(0)
    expect(parseDays('36500')).toBe(36500)
    for (const bad of ['', '-1', '1.5', '36501', 'abc', '1e3']) expect(parseDays(bad)).toBeNull()
  })
})

describe('security log', () => {
  it('has words for every event the server sends', () => {
    for (const event of SECURITY_EVENTS) expect(en.compliance.events).toHaveProperty(event.replace(/\./g, '_'))
    expect(securityEventLabel('auth.failed')).toBe('Sign-in failed')
    expect(securityEventLabel('something.new')).toBe('something.new')
  })

  it('knows every event the server records', () => {
    const recorded = new Set<string>()
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) { if (name !== 'bin' && name !== 'obj') walk(path) }
        else if (name.endsWith('.cs')) {
          for (const m of readFileSync(path, 'utf8').matchAll(/SecurityLog\.Record\([^;]*?"([a-z_]+(?:\.[a-z_]+)+)"/g)) recorded.add(m[1])
        }
      }
    }
    walk(join(__dirname, '../../../server/src/Iskra.Server'))
    expect(recorded.size).toBeGreaterThan(10)
    expect([...recorded].filter((event) => !(SECURITY_EVENTS as readonly string[]).includes(event))).toEqual([])
  })
})
