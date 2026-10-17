import { describe, expect, it } from 'vitest'
import type { Buddy } from '../core/protocol'
import { buddyState, normalizeRecoveryCode, pairingCodeAddress, spotUsage } from './buddies'

const b64u = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const code = (json: object) => `iskra-buddy:${b64u(JSON.stringify(json))}`

const buddy = (patch: Partial<Buddy>): Buddy => ({
  id: 'a1', url: 'https://friend.example', holderKey: 'k', name: 'Friend', quotaBytes: 2 ** 31, keep: 3, addedAt: 1,
  lastOk: null, error: null, nextTryAt: null, uploading: null, removed: false, ...patch,
})

describe('backup buddies', () => {
  it('reads where a pairing code leads, and nothing else', () => {
    expect(pairingCodeAddress(code({ v: 1, url: 'https://friend.example', key: 'k', token: 't' }))).toBe('https://friend.example')
    expect(pairingCodeAddress(`  ${code({ v: 1, url: 'http://localhost:4000', key: 'k', token: 't' })}\n`)).toBe('http://localhost:4000')
    // Names with letters outside ASCII survive the round trip.
    expect(pairingCodeAddress(code({ v: 1, url: 'https://gräddhyllan.example', key: 'k', token: 't' }))).toBe('https://gräddhyllan.example')
    expect(pairingCodeAddress(code({ v: 2, url: 'https://friend.example' }))).toBeNull()
    expect(pairingCodeAddress(code({ v: 1, url: 'javascript:alert(1)' }))).toBeNull()
    expect(pairingCodeAddress('iskra-buddy:%%%')).toBeNull()
    expect(pairingCodeAddress('https://friend.example')).toBeNull()
    expect(pairingCodeAddress(`iskra-buddy:${'A'.repeat(2000)}`)).toBeNull()
  })

  it('reads recovery codes the way the server does', () => {
    expect(normalizeRecoveryCode('abcde-fghjk-mnpqr-stvwx-yz012')).toBe('ABCDEFGHJKMNPQRSTVWXYZ012')
    expect(normalizeRecoveryCode('O1234 IIIII LLLLL 56789 ABCDE')).toBe('01234111111111156789ABCDE')
    expect(normalizeRecoveryCode('ABCDE-FGHJK')).toBeNull()
    expect(normalizeRecoveryCode('UUUUU-UUUUU-UUUUU-UUUUU-UUUUU')).toBeNull() // U isn't in the alphabet
  })

  it('says how a buddy is doing', () => {
    expect(buddyState(buddy({}))).toBe('waiting')
    expect(buddyState(buddy({ lastOk: { at: 1, name: 'auto-2026-10-17.zip', size: 10 } }))).toBe('ok')
    expect(buddyState(buddy({ lastOk: { at: 1, name: 'x', size: 1 }, uploading: { done: 1, total: 2 } }))).toBe('sending')
    expect(buddyState(buddy({ error: { code: 'bad_request', message: 'x', key: 'buddy_unreachable', args: { reason: 'x' } } }))).toBe('problem')
    expect(buddyState(buddy({ removed: true, error: { code: 'bad_request', message: 'x', key: 'buddy_removed', args: null } }))).toBe('removed')
  })

  it('measures a spot', () => {
    expect(spotUsage({ used: 512, quotaBytes: 1024 })).toBe(0.5)
    expect(spotUsage({ used: 4096, quotaBytes: 1024 })).toBe(1)
    expect(spotUsage({ used: 1, quotaBytes: 0 })).toBe(0)
  })
})
