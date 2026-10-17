// The tunnel's log lines: which connections get one, the route and NAT words, rate limits, and that nothing but
// types, counts and durations reaches the line (formatted through the desktop log's own allowlist).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatLine, makeEntry } from '../log'
import { errorWhy, FriendNotes, HostNotes, isLocalAddress, natType, nodeNat, punchCounters, routeOf, serverLogId, type TunnelLogEvent } from './tunnelLog'

const AT = Date.parse('2026-10-17T13:00:00.000Z')
const line = (e: TunnelLogEvent) => formatLine(makeEntry(AT, e.level, 'p2p', 'tunnel', e.event, e.code ?? null, e.fields)!)

function recorder() {
  const events: TunnelLogEvent[] = []
  return { events, log: (e: TunnelLogEvent) => events.push(e), lines: () => events.map(line) }
}

test('NAT types are one word, from HyperDHT flags only', () => {
  assert.equal(natType({ firewalled: false, randomized: false }), 'open')
  assert.equal(natType({ firewalled: true, randomized: false }), 'consistent')
  assert.equal(natType({ firewalled: true, randomized: true }), 'randomized')
  assert.equal(natType(null), undefined)
  assert.equal(nodeNat({ firewalled: true, randomized: true, destroyed: false }), 'randomized')
  assert.equal(nodeNat({ destroyed: true, firewalled: true }), undefined)
})

test('the route comes from the punch counters, then the relay knob, then whether the peer is local', () => {
  const zero = { open: 0, consistent: 0, random: 0 }
  assert.equal(routeOf(zero, { ...zero, consistent: 1 }, { relayed: false, local: false }), 'punched')
  assert.equal(routeOf(zero, { ...zero, random: 1 }, { relayed: false, local: false }), 'punched-random')
  assert.equal(routeOf(zero, zero, { relayed: true, local: true }), 'relay')
  assert.equal(routeOf(zero, { ...zero, open: 1 }, { relayed: false, local: false }), 'open')
  assert.equal(routeOf(zero, zero, { relayed: false, local: true }), 'lan')
  assert.deepEqual(punchCounters({ stats: { punches: { open: 2, consistent: 1, random: 0, tryLater: 4 } } }), { open: 2, consistent: 1, random: 0 })
  assert.deepEqual(punchCounters(null), zero)
  assert.ok(isLocalAddress('127.0.0.1') && isLocalAddress('192.168.1.4') && isLocalAddress('fe80::1'))
  assert.ok(!isLocalAddress('203.0.113.9') && !isLocalAddress(undefined))
})

test("HyperDHT error codes become words; messages and anything else don't", () => {
  assert.equal(errorWhy(Object.assign(new Error('Could not find peer 203.0.113.5'), { code: 'PEER_NOT_FOUND' })), 'peer-not-found')
  assert.equal(errorWhy(Object.assign(new Error('x'), { code: 'HOLEPUNCH_DOUBLE_RANDOMIZED_NATS' })), 'holepunch-double-randomized-nats')
  assert.equal(errorWhy(new Error('203.0.113.5:49737 timed out')), 'error')
  assert.equal(errorWhy({ code: '203.0.113.5' }), 'error')
})

test('the server id matches the app and the server (BLAKE2b-256 of the context and the key)', () => {
  assert.equal(serverLogId('AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA'), '5f7f')
  assert.equal(serverLogId('short'), null)
})

test('a friend tunnel logs its first connection, path changes and slow ones, not every request', () => {
  const r = recorder()
  const notes = new FriendNotes(r.log, () => [['srv', '5f7f']])
  notes.connected('punched', 1430, 'consistent')
  notes.connected('punched', 120, 'consistent')
  notes.connected('punched', 95, 'consistent')
  notes.connected('relay', 400, 'consistent')
  notes.connected('relay', 4200, 'consistent')
  assert.deepEqual(r.lines(), [
    '2026-10-17T13:00:00.000Z INFO  p2p   tunnel connected   -       srv=5f7f path=punched nat=consistent took=1.4s kind=cold n=1',
    '2026-10-17T13:00:00.000Z INFO  p2p   tunnel connected   -       srv=5f7f path=relay nat=consistent took=400ms kind=warm n=4',
    '2026-10-17T13:00:00.000Z INFO  p2p   tunnel connected   -       srv=5f7f path=relay nat=consistent took=4.2s kind=warm n=5',
  ])
})

test('failures: once a minute per reason, with how many were skipped', () => {
  let now = AT
  const r = recorder()
  const notes = new FriendNotes(r.log, () => [['srv', '5f7f']], () => now)
  notes.failed('peer-not-found', 10_200, 'randomized')
  notes.failed('peer-not-found', 10_100, 'randomized')
  notes.failed('holepunch-aborted', 9000, 'randomized')
  now += 61_000
  notes.failed('peer-not-found', 10_000, 'randomized')
  notes.turnClosed(12_500)
  assert.deepEqual(r.lines(), [
    '2026-10-17T13:00:00.000Z WARN  p2p   tunnel failed      TUN-160 srv=5f7f why=peer-not-found nat=randomized took=10.2s',
    '2026-10-17T13:00:00.000Z WARN  p2p   tunnel failed      TUN-160 srv=5f7f why=holepunch-aborted nat=randomized took=9.0s',
    '2026-10-17T13:00:00.000Z WARN  p2p   tunnel failed      TUN-160 srv=5f7f why=peer-not-found nat=randomized took=10.0s count=1',
    '2026-10-17T13:00:00.000Z INFO  p2p   tunnel closed      TUN-170 srv=5f7f what=turn dur=12.5s',
  ])
})

test('the host: announce time, NAT type changes, peer counts at most every 30 s, voice carried when there is some', () => {
  let now = AT
  const r = recorder()
  const notes = new HostNotes(r.log, () => now)
  notes.announced(840, 'consistent')
  notes.natSeen('consistent')
  notes.natSeen('randomized')
  notes.peers(1, 1)
  notes.peers(2, 2) // within 30 s: the timer catches it later
  now += 31_000
  notes.peers(2, 3)
  notes.peers(2, 3)
  notes.turn(0, 0, 0)
  notes.turn(2, 1520, 1498)
  notes.turn(2, 1520, 1498)
  notes.turn(1, 1600, 1550)
  assert.deepEqual(r.lines(), [
    '2026-10-17T13:00:00.000Z INFO  p2p   tunnel announced   -       took=840ms nat=consistent',
    '2026-10-17T13:00:00.000Z INFO  p2p   tunnel changed     -       what=nat nat=randomized',
    '2026-10-17T13:00:00.000Z INFO  p2p   tunnel peers       -       count=1 n=1',
    '2026-10-17T13:00:00.000Z INFO  p2p   tunnel peers       -       count=2 n=3',
    '2026-10-17T13:00:00.000Z INFO  p2p   tunnel turn        -       count=2 in=1520 out=1498',
    '2026-10-17T13:00:00.000Z INFO  p2p   tunnel turn        -       count=1 in=80 out=52',
  ])
})

test('hostile values never reach a tunnel line', () => {
  const r = recorder()
  const notes = new FriendNotes(r.log, () => [['srv', '203.0.113.5'], ['path', 'candidate:1 1 udp 2122260223 192.168.1.20 54321 typ host']])
  notes.connected('203.0.113.5:49737', 100, 'udp 192.168.1.20 typ srflx raddr 10.0.0.2')
  const text = r.lines().join('\n')
  for (const bad of ['203.0.113', '192.168', '10.0.0', 'candidate', '49737', 'typ']) assert.ok(!text.includes(bad), `${bad} in ${text}`)
})
