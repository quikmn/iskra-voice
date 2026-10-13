import { describe, expect, it } from 'vitest'
import { deliveryState, hostOf, needsChannels, urlProblem } from './outhookRules'

describe('outgoing webhook addresses', () => {
  it('want https, or http on the own network when allowed', () => {
    expect(urlProblem('https://mc.example.com/iskra', false)).toBeNull()
    expect(urlProblem('http://mc.example.com/', false)).toBe('outhook_url_http')
    expect(urlProblem('http://192.168.1.20:8123/api/webhook/x', true)).toBeNull()
    expect(urlProblem('ftp://example.com/', false)).toBe('outhook_url')
    expect(urlProblem('not a url', false)).toBe('outhook_url')
    expect(urlProblem('https://me:pw@example.com/', false)).toBe('outhook_url_userinfo')
  })

  it('point out private and reserved addresses', () => {
    for (const url of ['https://127.0.0.1/', 'https://localhost:8443/', 'https://10.0.0.2/', 'https://172.20.1.1/', 'https://100.100.1.1/', 'https://[fd00::1]/'])
      expect(urlProblem(url, false)).toBe('outhook_address_private')
    expect(urlProblem('https://172.32.0.1/', false)).toBeNull()
    expect(urlProblem('https://127.0.0.1/', true)).toBeNull()
    expect(urlProblem('http://169.254.169.254/latest/meta-data', true)).toBe('outhook_address_reserved')
    expect(urlProblem('https://[fe80::1]/', true)).toBe('outhook_address_reserved')
  })

  it('show the host', () => {
    expect(hostOf('https://mc.example.com:8443/iskra?x=1')).toBe('mc.example.com')
    expect(hostOf('nonsense')).toBe('nonsense')
  })
})

describe('outgoing webhook events and log', () => {
  it('need channels for messages and reactions only', () => {
    expect(needsChannels(['member.joined', 'event.started'])).toBe(false)
    expect(needsChannels(['member.joined', 'reaction.added'])).toBe(true)
  })

  it('tell retries from failures', () => {
    const d = { delivery: 'x', event: 'ping' as const, attempt: 1, at: 0, ms: 5 }
    expect(deliveryState({ ...d, status: 200, outcome: 'ok' })).toBe('ok')
    expect(deliveryState({ ...d, status: 503, outcome: 'http' })).toBe('retry')
    expect(deliveryState({ ...d, status: 429, outcome: 'http' })).toBe('retry')
    expect(deliveryState({ ...d, status: null, outcome: 'timeout' })).toBe('retry')
    expect(deliveryState({ ...d, status: 404, outcome: 'http' })).toBe('failed')
    expect(deliveryState({ ...d, status: null, outcome: 'blocked' })).toBe('failed')
    expect(deliveryState({ ...d, status: 302, outcome: 'redirect' })).toBe('failed')
  })
})
