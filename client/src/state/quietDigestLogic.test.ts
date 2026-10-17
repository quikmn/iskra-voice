import { describe, expect, it } from 'vitest'
import type { InboxItem, Message, QuietHours, ServerEvent } from '../core/protocol'
import { advance, buildDigest, digestSeen, stretchEnd, stretchStart, MAX_STRETCH, SOON, STALE_AFTER, TOP, type DigestSources } from './quietDigestLogic'

const utc = (iso: string) => Date.parse(`${iso}Z`)
const MIN = 60_000
const SATURDAY = 1 << 6
const quiet = (days: number, from: number, to: number, timeZone = 'UTC'): QuietHours => ({ days, from, to, timeZone, mentions: false, digest: true })

describe('quiet stretches', () => {
  // Saturday 22:00 – Sunday 07:00 in Stockholm; autumn clock change on 25 Oct 2026 (CEST → CET).
  const night = quiet(SATURDAY, 22 * 60, 7 * 60, 'Europe/Stockholm')

  it('finds when the running stretch began, in its own time zone and across a clock change', () => {
    expect(stretchStart(night, utc('2026-10-25T05:59'))).toBe(utc('2026-10-24T20:00'))
    expect(stretchStart(night, utc('2026-03-29T04:59:30'))).toBe(utc('2026-03-28T21:00'))
    expect(stretchStart(quiet(127, 0, 0), utc('2026-05-01T12:00'))).toBe(utc('2026-05-01T12:00') - MAX_STRETCH)
  })

  it('finds when it ended by the schedule', () => {
    expect(stretchEnd(night, utc('2026-10-24T20:00'), utc('2026-10-25T09:00'))).toBe(utc('2026-10-25T06:00'))
    expect(stretchEnd(night, utc('2026-10-24T20:00'), utc('2026-10-25T03:00'))).toBe(utc('2026-10-25T03:00')) // never past now
  })

  it('starts a watch, keeps it, and ends it into a window', () => {
    const start = advance(true, night, null, utc('2026-10-24T23:00'))
    expect(start).toEqual({ watch: { since: utc('2026-10-24T20:00'), seen: utc('2026-10-24T23:00') }, ended: null })
    const still = advance(true, night, start.watch, utc('2026-10-25T05:59:40'))
    expect(still.watch?.since).toBe(utc('2026-10-24T20:00'))
    expect(still.ended).toBeNull()
    // Watching when it ends: the window ends now.
    expect(advance(true, night, still.watch, utc('2026-10-25T06:00:10'))).toEqual({ watch: null, ended: { start: utc('2026-10-24T20:00'), end: utc('2026-10-25T06:00:10') } })
    // Nothing running, nothing to end.
    expect(advance(true, night, null, utc('2026-10-25T12:00'))).toEqual({ watch: null, ended: null })
  })

  it('ends at the schedule when the device was off, and forgets stale ones', () => {
    const watch = { since: utc('2026-10-24T20:00'), seen: utc('2026-10-24T23:00') }
    expect(advance(true, night, watch, utc('2026-10-25T09:00')).ended).toEqual({ start: watch.since, end: utc('2026-10-25T06:00') })
    expect(advance(true, night, watch, utc('2026-10-25T06:00') + STALE_AFTER + MIN)).toEqual({ watch: null, ended: null })
  })

  it('ends at once when quiet hours are turned off by hand', () => {
    const watch = { since: utc('2026-10-24T20:00'), seen: utc('2026-10-24T23:00') }
    expect(advance(false, night, watch, utc('2026-10-24T23:00:20')).ended).toEqual({ start: watch.since, end: utc('2026-10-24T23:00:20') })
    expect(advance(false, night, null, utc('2026-10-24T23:00'))).toEqual({ watch: null, ended: null })
  })

  it('knows a dismissed stretch from a later one', () => {
    const window = { start: 1000, end: 5000 }
    expect(digestSeen(window, 0)).toBe(false)
    expect(digestSeen(window, 5100)).toBe(true) // dismissed on another device, which saw a slightly different end
    expect(digestSeen({ start: 9000, end: 12000 }, 5100)).toBe(false)
  })
})

// ── What came in ────────────────────────────────────────────────────────────

const ME = 'm'.repeat(43)
const ALICE = 'a'.repeat(43)
const BOB = 'b'.repeat(43)
const MALLORY = 'x'.repeat(43)
const WINDOW = { start: 10_000, end: 20_000 }

const message = (id: number, author: string, at: number) => ({ id, author, channelId: 1, text: 'secret words', createdAt: at }) as unknown as Message
const ping = (server: string, id: number, kind: InboxItem['kind'], at: number, author = ALICE) =>
  ({ server, item: { kind, channelId: 1, at, message: message(id, author, at) } })
const event = (id: number, startAt: number, interested: string[], status: ServerEvent['status'] = 'scheduled') =>
  ({ id, title: `Event ${id}`, startAt, status, interested }) as unknown as ServerEvent

function sources(patch: Partial<DigestSources> = {}): DigestSources {
  return {
    window: WINDOW, me: ME,
    servers: [{ key: 'A', name: 'Alpha', online: true }, { key: 'B', name: 'Beta', online: false }],
    pings: [], dms: [], groups: [], events: [], reminders: [],
    ...patch,
  }
}

describe('the digest', () => {
  it('counts each kind inside the window only, across servers', () => {
    const digest = buildDigest(sources({
      pings: [
        ping('A', 1, 'mention', 11_000), ping('A', 2, 'reply', 12_000), ping('B', 3, 'everyone', 13_000), ping('A', 4, 'role', 14_000),
        ping('A', 5, 'keyword', 15_000), ping('B', 6, 'follow', 16_000),
        ping('A', 7, 'mention', 9_999), ping('A', 8, 'mention', 20_000), // just outside
        ping('A', 1, 'mention', 11_000), // the same message twice
        ping('Gone', 9, 'mention', 11_000), // a server you left
      ],
      dms: [{ peer: ALICE, messages: [{ from: ALICE, sentAt: 11_000 }, { from: ALICE, sentAt: 12_000 }, { from: ME, sentAt: 13_000 }, { from: ALICE, sentAt: 21_000 }] }],
      groups: [{ key: 'A/g1', messages: [{ from: BOB, sentAt: 14_000 }, { from: ME, sentAt: 15_000 }] }],
      events: [
        event(1, 12_000, [ME]), event(2, 20_000 + SOON - 1, [ME]), // started, starting soon
        event(3, 20_000 + SOON, [ME]), event(4, 12_000, [ALICE]), event(5, 12_000, [ME], 'cancelled'),
      ].map((e) => ({ server: 'A', event: e })),
      reminders: [{ server: 'A', id: 1, firedAt: 19_000 }, { server: 'A', id: 2, firedAt: 5_000 }],
    }))
    expect(Object.fromEntries(digest.sections.map((s) => [s.kind, s.count]))).toEqual({ mentions: 4, messages: 3, keywords: 1, follows: 1, events: 2, reminders: 1 })
    expect(digest.total).toBe(12)
    expect(digest.offline.map((s) => s.name)).toEqual(['Beta'])
    const events = digest.sections.find((s) => s.kind === 'events')!.items
    expect(events.map((e) => e.type === 'event' && [e.eventId, e.started])).toEqual([[1, true], [2, false]])
  })

  it('lists the newest few per kind, conversations with their counts and never any text', () => {
    const digest = buildDigest(sources({
      pings: [1, 2, 3, 4, 5].map((n) => ping('A', n, 'mention', 10_000 + n * 1000)),
      dms: [{ peer: ALICE, messages: [{ from: ALICE, sentAt: 11_000 }, { from: ALICE, sentAt: 18_000 }] }, { peer: BOB, messages: [{ from: BOB, sentAt: 12_000 }] }],
    }))
    const mentions = digest.sections.find((s) => s.kind === 'mentions')!
    expect(mentions.count).toBe(5)
    expect(mentions.items).toHaveLength(TOP)
    expect(mentions.items.map((i) => i.type === 'ping' && i.messageId)).toEqual([5, 4, 3])
    const messages = digest.sections.find((s) => s.kind === 'messages')!
    expect(messages.items).toEqual([
      { type: 'dm', key: `d:${ALICE}`, peer: ALICE, count: 2, at: 18_000 },
      { type: 'dm', key: `d:${BOB}`, peer: BOB, count: 1, at: 12_000 },
    ])
    expect(JSON.stringify(digest)).not.toContain('secret')
  })

  it('leaves out people you blocked', () => {
    const digest = buildDigest(sources({
      pings: [ping('A', 1, 'mention', 11_000, MALLORY), ping('A', 2, 'mention', 12_000)],
      dms: [{ peer: MALLORY, messages: [{ from: MALLORY, sentAt: 11_000 }] }],
      groups: [{ key: 'A/g1', messages: [{ from: MALLORY, sentAt: 14_000 }, { from: BOB, sentAt: 15_000 }] }],
      blocked: (key) => key === MALLORY,
    }))
    expect(Object.fromEntries(digest.sections.map((s) => [s.kind, s.count]))).toEqual({ mentions: 1, messages: 1 })
  })

  it('is empty when nothing happened', () => {
    expect(buildDigest(sources())).toEqual({ total: 0, sections: [], offline: [{ key: 'B', name: 'Beta', online: false }] })
  })
})
