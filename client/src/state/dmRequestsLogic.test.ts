import { describe, expect, it } from 'vitest'
import { applyServerList, applyServerState, checkDecisions, decide, MAX_AHEAD_MS, saneStamp, serverClock, serversToSync, stampAfter, statusOf, storedDecisions, type PeerRequests } from './dmRequestsLogic'

describe('message request status', () => {
  it('is accepted unless a server holds the DMs as a request', () => {
    expect(statusOf(undefined, false)).toBe('accepted')
    expect(statusOf({ servers: { a: 'request' } }, false)).toBe('request')
    expect(statusOf({ servers: { a: 'ignored', b: 'request' } }, false)).toBe('request')
    expect(statusOf({ servers: { a: 'ignored' } }, false)).toBe('ignored')
  })

  it('counts writing to them as accepting, and your own decision wins', () => {
    expect(statusOf({ servers: { a: 'request' } }, true)).toBe('accepted')
    expect(statusOf({ servers: { a: 'request' }, decided: { state: 'accepted', at: 1 } }, false)).toBe('accepted')
    expect(statusOf({ servers: {}, decided: { state: 'ignored', at: 1 } }, false)).toBe('ignored')
  })

  it('tells servers that disagree', () => {
    const info: PeerRequests = { servers: { a: 'request', b: 'ignored' }, decided: { state: 'accepted', at: 1 } }
    expect(serversToSync(info, 'accepted')).toEqual({ accept: ['a', 'b'], ignore: [] })
    const ignored: PeerRequests = { servers: { a: 'request', b: 'ignored' }, decided: { state: 'ignored', at: 1 } }
    expect(serversToSync(ignored, 'ignored')).toEqual({ accept: [], ignore: ['a'] })
    // Ignored on one server only (another device), no decision here: nothing to push.
    expect(serversToSync({ servers: { a: 'ignored' } }, 'ignored')).toEqual({ accept: [], ignore: [] })
    expect(serversToSync({ servers: { a: 'request' } }, 'request')).toEqual({ accept: [], ignore: [] })
  })
})

describe('keeping track of servers', () => {
  it('replaces one server\'s answers with its full list', () => {
    let peers: Record<string, PeerRequests> = { x: { servers: { a: 'request', b: 'request' } }, y: { servers: { a: 'ignored' } } }
    peers = applyServerList(peers, 'a', [{ accountKey: 'z', state: 'request' }])
    expect(peers.x.servers).toEqual({ b: 'request' })
    expect(peers.y.servers).toEqual({})
    expect(peers.z.servers).toEqual({ a: 'request' })
  })

  it('sets and drops one answer, unchanged when nothing changes', () => {
    const peers: Record<string, PeerRequests> = { x: { servers: { a: 'request' } } }
    expect(applyServerState(peers, 'a', 'x', 'request')).toBe(peers)
    expect(applyServerState(peers, 'a', 'x', null).x.servers).toEqual({})
    expect(applyServerState(peers, 'b', 'x', 'ignored').x.servers).toEqual({ a: 'request', b: 'ignored' })
  })

  it('keeps the newest decision', () => {
    let peers = decide({}, 'x', 'ignored', 10)
    peers = decide(peers, 'x', 'accepted', 5)
    expect(peers.x.decided).toEqual({ state: 'ignored', at: 10 })
    peers = decide(peers, 'x', 'accepted', 20)
    expect(peers.x.decided).toEqual({ state: 'accepted', at: 20 })
  })

  it('stores and reads back decisions, dropping anything malformed', () => {
    const peers: Record<string, PeerRequests> = {
      a: { servers: {}, decided: { state: 'accepted', at: 1 } },
      b: { servers: {}, decided: { state: 'ignored', at: 3 } },
      c: { servers: { s: 'request' } },
    }
    expect(Object.keys(storedDecisions(peers, 1))).toEqual(['b'])
    expect(checkDecisions(storedDecisions(peers))).toEqual({ a: { state: 'accepted', at: 1 }, b: { state: 'ignored', at: 3 } })
    expect(checkDecisions({ a: { state: 'maybe', at: 1 }, b: null, c: { state: 'ignored', at: '1' } })).toEqual({})
    expect(checkDecisions('nope')).toEqual({})
  })
})

describe('stamping the setting', () => {
  it("uses the servers' clock, not only this device's", () => {
    expect(serverClock(1000, [])).toBe(1000)
    // This device runs an hour ahead: the servers say so, and a new choice is stamped by their time.
    const hour = 3_600_000
    const clock = serverClock(10 * hour, [-hour, -hour + 5, -hour - 5])
    expect(clock).toBe(9 * hour)
    expect(stampAfter(0, clock)).toBe(9 * hour)
  })

  it('comes after the current choice, unless that one came from a clock that ran ahead', () => {
    expect(stampAfter(5000, 4000)).toBe(5001)
    const ahead = 4000 + MAX_AHEAD_MS + 1
    expect(saneStamp(ahead, 4000)).toBe(0)
    expect(saneStamp(4000 + MAX_AHEAD_MS, 4000)).toBe(4000 + MAX_AHEAD_MS)
    expect(stampAfter(ahead, 4000)).toBe(4000) // never a stamp the servers would refuse
  })
})
