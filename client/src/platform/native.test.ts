import { describe, expect, it } from 'vitest'
import { parseInvite } from '../core/invite'
import clientPackage from '../../package.json'
import shellPackage from '../../../mobile/package.json'
import { iosApp, native, nativeLinkTarget, nativePlatform, parseCallAction, safeFileName } from './native'

const INVITE = 'aHR0cHM6Ly9jaGF0LmV4YW1wbGUuY29t.' + 'A'.repeat(43) + '.abcdefgh12'

describe('native platform', () => {
  it('is only the phone app when Capacitor says it runs natively', () => {
    expect(nativePlatform({})).toBeNull()
    // @capacitor/core in a plain browser: platform "web", not native.
    expect(nativePlatform({ Capacitor: { isNativePlatform: () => false, getPlatform: () => 'web' } })).toBeNull()
    expect(nativePlatform({ Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' } })).toBe('ios')
    expect(nativePlatform({ Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' } })).toBe('android')
    expect(nativePlatform({ Capacitor: { isNativePlatform: () => true, getPlatform: () => 'electron' } })).toBeNull()
    expect(nativePlatform({ Capacitor: { isNativePlatform: () => { throw new Error('x') } } })).toBeNull()
  })

  it('leaves the web app alone', () => {
    expect(native).toBeUndefined()
    expect(iosApp).toBe(false)
  })
})

describe('links that open the app', () => {
  it('turns Universal Links and iskra:// into invites', () => {
    for (const url of [`https://app.iskra.foo/#/join/${INVITE}`, `iskra://join/${INVITE}`]) {
      const target = nativeLinkTarget(url)
      expect(target).toEqual({ kind: 'invite', token: INVITE })
      expect(parseInvite(target?.kind === 'invite' ? target.token : '')?.serverUrl).toBe('https://chat.example.com')
    }
  })

  it('passes device links on as the "#/link/…" code', () => {
    expect(nativeLinkTarget('https://app.iskra.foo/#/link/abc.def')).toEqual({ kind: 'link', code: '#/link/abc.def' })
  })

  it('ignores anything else', () => {
    for (const url of ['https://app.iskra.foo/', 'https://app.iskra.foo/join/x', 'iskra://open/x', 'https://evil.example/#/open/x', ''])
      expect(nativeLinkTarget(url)).toBeNull()
  })
})

describe('saved file names', () => {
  it('keeps names plain and inside the cache folder', () => {
    expect(safeFileName('photo.jpg')).toBe('photo.jpg')
    expect(safeFileName('../../etc/passwd')).toBe('_.._etc_passwd')
    expect(safeFileName('a\u0000b\nc.txt')).toBe('a_b_c.txt')
    expect(safeFileName('...')).toBe('file')
    expect(safeFileName('')).toBe('file')
    expect(safeFileName('x'.repeat(300) + '.pdf')).toHaveLength(120)
    expect(safeFileName('x'.repeat(300) + '.pdf').endsWith('.pdf')).toBe(true)
  })
})

describe('call actions from the phone', () => {
  const server = 'S'.repeat(43)
  it('take only answer/decline for a DM peer or a group', () => {
    expect(parseCallAction({ action: 'answer', server, peer: 'A'.repeat(43) })).toEqual({ action: 'answer', server, peer: 'A'.repeat(43) })
    expect(parseCallAction({ action: 'decline', server, group: 'g'.repeat(22) })).toEqual({ action: 'decline', server, group: 'g'.repeat(22) })
    expect(parseCallAction({ action: 'mute', server, peer: 'A'.repeat(43) })).toBeNull()
    expect(parseCallAction({ action: 'answer', server: 'short', peer: 'A'.repeat(43) })).toBeNull()
    expect(parseCallAction({ action: 'answer', server, peer: 'A/'.repeat(20) })).toBeNull()
    expect(parseCallAction({ action: 'answer', server })).toBeNull()
  })
})

describe('Capacitor versions', () => {
  it('match between the client and the app shell', () => {
    const client: Record<string, string> = clientPackage.dependencies
    const shell: Record<string, string> = shellPackage.dependencies
    const shared = Object.keys(client).filter((name) => name.startsWith('@capacitor/'))
    expect(shared.length).toBeGreaterThan(0)
    for (const name of shared) expect(shell[name], name).toBe(client[name])
  })
})
