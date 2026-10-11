import { describe, expect, it } from 'vitest'
import { messageLink, parseOpenRoute, pushScope, pushSupport, serverOfScope } from './pushRoute'

const S = 'A'.repeat(43)
const P = 'b'.repeat(42) + '_'

describe('push routes', () => {
  it('reads channel, DM and server routes, from messages or the address bar', () => {
    expect(parseOpenRoute(`/open/${S}/c/12`)).toEqual({ server: S, kind: 'channel', channelId: 12 })
    expect(parseOpenRoute(`#/open/${S}/dm/${P}`)).toEqual({ server: S, kind: 'dm', peer: P })
    expect(parseOpenRoute(`/open/${S}`)).toEqual({ server: S, kind: 'server' })
    expect(parseOpenRoute(`/open/${S}/g/${'g'.repeat(22)}`)).toEqual({ server: S, kind: 'group', group: 'g'.repeat(22) })
    expect(parseOpenRoute(`/open/${S}/r/7`)).toEqual({ server: S, kind: 'reminder', id: 7 })
  })

  it('rejects anything else', () => {
    for (const bad of [
      '/open/short/c/1',
      `/open/${S}/c/0`,
      `/open/${S}/c/-1`,
      `/open/${S}/c/1e3`,
      `/open/${S}/c/99999999999999999`,
      `/open/${S}/dm/../../x`,
      `/open/${S}/x/1`,
      `/open/${S}/g/short`,
      `/open/${S}/r/0`,
      `/open/${S}/r/x`,
      `https://evil.example/open/${S}`,
      `/join/${S}`,
    ]) {
      expect(parseOpenRoute(bad), bad).toBeNull()
    }
  })

  it('maps servers to worker scopes and back', () => {
    expect(pushScope(S)).toBe(`/push/${S}/`)
    expect(serverOfScope(`https://app.iskra.foo/push/${S}/`)).toBe(S)
    expect(serverOfScope('https://app.iskra.foo/')).toBeNull()
  })
})

describe('push support', () => {
  const full = { maxTouchPoints: 0, standalone: false, hasServiceWorker: true, hasPushManager: true, hasNotification: true }
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'
  const ipad = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15'

  it('works in desktop and Android browsers', () => {
    expect(pushSupport({ ...full, userAgent: 'Mozilla/5.0 (Linux; Android 15) Chrome/140 Mobile' })).toBe('supported')
  })

  it('asks iPhone and iPad users to add Iskra to the Home Screen first', () => {
    const safariTab = { ...full, hasPushManager: false, hasNotification: false }
    expect(pushSupport({ ...safariTab, userAgent: iphone })).toBe('needs-install')
    expect(pushSupport({ ...safariTab, userAgent: ipad, maxTouchPoints: 5 })).toBe('needs-install')
    expect(pushSupport({ ...full, userAgent: iphone, standalone: true })).toBe('supported')
  })

  it('says so when the browser has no push at all', () => {
    expect(pushSupport({ ...full, hasPushManager: false, userAgent: 'Firefox' })).toBe('unsupported')
    expect(pushSupport({ ...full, userAgent: ipad, standalone: true, hasPushManager: false })).toBe('unsupported')
  })
})

describe('message links', () => {
  it('round-trip through the open route', () => {
    const link = messageLink('https://app.iskra.foo/', S, 12, 345)
    expect(link).toBe(`https://app.iskra.foo/#/open/${S}/c/12/m/345`)
    expect(parseOpenRoute(new URL(link).hash)).toEqual({ server: S, kind: 'channel', channelId: 12, messageId: 345 })
    expect(parseOpenRoute(`#/open/${S}/c/12/m/0`)).toBeNull()
    expect(parseOpenRoute(`#/open/${S}/m/3`)).toBeNull()
  })
})
