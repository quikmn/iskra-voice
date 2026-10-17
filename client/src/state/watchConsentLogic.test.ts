import { describe, expect, it } from 'vitest'
import { needsGate, startedSites, withAgreedSite } from './watchConsentLogic'

const fresh = { host: 'me', updatedBy: 'me', updatedAt: 100, startedAt: 100 }

describe('watch party consent per site', () => {
  it('pre-agrees the host only for the site of what they started themselves', () => {
    expect([...startedSites(fresh, 'me', 'youtube.com')]).toEqual(['youtube.com'])
    expect(startedSites(fresh, 'me', null).size).toBe(0) // a file on the group's own server
    expect(startedSites(fresh, 'you', 'youtube.com').size).toBe(0) // a viewer
    expect(startedSites({ ...fresh, host: 'you', updatedBy: 'you' }, 'me', 'youtube.com').size).toBe(0)
    // Moved on since (a queued item plays): whoever hosts now didn't start this one.
    expect(startedSites({ ...fresh, updatedAt: 200 }, 'me', 'youtube.com').size).toBe(0)
    expect(startedSites({ ...fresh, updatedBy: 'you', updatedAt: 200 }, 'me', 'media.example.com').size).toBe(0)
    expect(startedSites(fresh, null, 'youtube.com').size).toBe(0)
  })

  it('asks once per site unless the device always loads from it', () => {
    const none = new Set<string>()
    expect(needsGate('media.example.com', none, false)).toBe(true)
    expect(needsGate('media.example.com', new Set(['media.example.com']), false)).toBe(false)
    expect(needsGate('cdn.example.net', new Set(['media.example.com']), false)).toBe(true)
    expect(needsGate('media.example.com', none, true)).toBe(false)
    expect(needsGate(null, none, false)).toBe(false)
  })

  it('remembers an agreed site for the rest of the party', () => {
    const one = withAgreedSite(new Set(), 'media.example.com')
    expect([...one]).toEqual(['media.example.com'])
    const two = withAgreedSite(one, 'cdn.example.net')
    expect([...two].sort()).toEqual(['cdn.example.net', 'media.example.com'])
    expect(withAgreedSite(two, 'cdn.example.net')).toBe(two)
  })
})
