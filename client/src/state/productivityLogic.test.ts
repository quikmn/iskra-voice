import { describe, expect, it } from 'vitest'
import {
  checkEntry, checkRef, decodeSaved, encodeSaved, fromLocalInput, liveSaved, MAX_SAVED, mergeSaved, nextWeekMorning, presetTime, pruneSaved,
  refKey, sameSaved, timeProblem, toLocalInput, tomorrowMorning, TOMBSTONE_MS, type MessageRef, type SavedEntry,
} from './productivityLogic'

const S = 'S'.repeat(43)
const A = 'a'.repeat(43)
const B = 'b'.repeat(42) + '_'
const G = `${S}/${'g'.repeat(22)}`

const channel = (id: number): MessageRef => ({ kind: 'channel', server: S, channelId: 3, messageId: id })
const entry = (ref: MessageRef, savedAt: number, extra: Partial<SavedEntry> = {}): SavedEntry =>
  ({ key: refKey(ref), ref, savedAt, snap: { author: A, authorName: 'Alice', preview: `message ${savedAt}`, at: savedAt - 5, where: '#general · Gaming' }, ...extra })

describe('message refs', () => {
  it('have one key per message and are checked field by field', () => {
    expect(refKey(channel(9))).toBe(`c:${S}:3:9`)
    expect(refKey({ kind: 'dm', peer: B, from: A, id: 'abc' })).toBe(`d:${B}:${A}:abc`)
    expect(checkRef({ kind: 'group', group: G, from: A, id: 'x_1' })).toEqual({ kind: 'group', group: G, from: A, id: 'x_1' })
    for (const bad of [
      null, 'x', { kind: 'channel', server: 'short', channelId: 1, messageId: 1 }, { kind: 'channel', server: S, channelId: 0, messageId: 1 },
      { kind: 'dm', peer: B, from: A, id: '../x' }, { kind: 'group', group: S, from: A, id: 'a' }, { kind: 'other' },
    ]) expect(checkRef(bad)).toBeNull()
    expect(checkEntry({ ref: channel(1), savedAt: 'soon' })).toEqual([])
  })
})

describe('times', () => {
  const now = new Date(2026, 9, 14, 15, 30) // a Wednesday afternoon

  it('offers the usual choices in local time', () => {
    expect(presetTime('20m', now) - now.getTime()).toBe(20 * 60_000)
    expect(presetTime('3h', now) - now.getTime()).toBe(3 * 3_600_000)
    expect(new Date(tomorrowMorning(now))).toEqual(new Date(2026, 9, 15, 9, 0))
    expect(new Date(nextWeekMorning(now))).toEqual(new Date(2026, 9, 19, 9, 0)) // the next Monday
    expect(new Date(nextWeekMorning(new Date(2026, 9, 19, 8, 0)))).toEqual(new Date(2026, 9, 26, 9, 0)) // on a Monday: a week on
    expect(new Date(nextWeekMorning(new Date(2026, 9, 18, 23, 0)))).toEqual(new Date(2026, 9, 19, 9, 0)) // Sunday night
  })

  it('round-trips the date and time field, to the second', () => {
    const at = new Date(2026, 0, 2, 3, 4, 5).getTime()
    expect(toLocalInput(at)).toBe('2026-01-02T03:04:05')
    expect(fromLocalInput(toLocalInput(at))).toBe(at)
    expect(fromLocalInput('2026-01-02T03:04')).toBe(new Date(2026, 0, 2, 3, 4).getTime())
    expect(fromLocalInput('tomorrow')).toBeNull()
  })

  it('wants a time ahead and within the limit', () => {
    expect(timeProblem(null, 1000, 10)).toBe('invalid')
    expect(timeProblem(1000, 1000, 10)).toBe('past')
    expect(timeProblem(1011, 1000, 10)).toBe('far')
    expect(timeProblem(1005, 1000, 10)).toBeNull()
  })
})

describe('saved messages', () => {
  it('merge entry by entry: the newest change wins, so saves on two devices both stay', () => {
    const one = entry(channel(1), 100)
    const two = entry({ kind: 'dm', peer: B, from: A, id: 'm1' }, 200)
    const merged = mergeSaved([one], [two])
    expect(merged.map((e) => e.key)).toEqual([two.key, one.key])

    const removed = { ...one, removedAt: 300, snap: undefined }
    expect(liveSaved(mergeSaved(merged, [removed])).map((e) => e.key)).toEqual([two.key])
    // Saved again after the removal: back.
    expect(liveSaved(mergeSaved([removed], [entry(channel(1), 400)])).map((e) => e.key)).toEqual([one.key])
    // An older save doesn't undo a newer removal.
    expect(liveSaved(mergeSaved([removed], [one]))).toEqual([])
  })

  it('keep the fuller snapshot of the same entry', () => {
    const full = entry(channel(1), 100)
    const bare = { ...full, snap: undefined }
    expect(mergeSaved([full], [bare])[0].snap?.preview).toBe('message 100')
    expect(mergeSaved([bare], [full])[0].snap?.preview).toBe('message 100')
  })

  it('forget removals after a while', () => {
    const list = [entry(channel(1), 1, { removedAt: 10 }), entry(channel(2), 5)]
    expect(pruneSaved(list, 10 + TOMBSTONE_MS - 1)).toHaveLength(2)
    expect(pruneSaved(list, 10 + TOMBSTONE_MS).map((e) => e.ref)).toEqual([channel(2)])
  })

  it('sync in a compact form that round-trips', () => {
    const list = [
      entry(channel(1), 100), entry({ kind: 'dm', peer: B, from: A, id: 'm1' }, 200),
      entry({ kind: 'group', group: G, from: B, id: 'g1' }, 300), entry(channel(2), 50, { removedAt: 400 }),
    ]
    const json = encodeSaved(list)
    const keys = (JSON.parse(json) as { keys: string[] }).keys
    expect(new Set(keys).size).toBe(keys.length) // long keys are in a table, once each
    const back = decodeSaved(json)!
    expect(sameSaved(back, list)).toBe(true)
    expect(back.find((e) => e.key === list[1].key)?.snap).toEqual(list[1].snap)
    expect(decodeSaved('{"v":2}')).toBeNull()
    expect(decodeSaved('nope')).toBeNull()
    expect(decodeSaved('{"v":1,"keys":[],"items":[[["c",5,1,1],1,0]]}')).toEqual([])
  })

  it('always fit into one synced preference, dropping previews before anything else', () => {
    const many = Array.from({ length: MAX_SAVED }, (_, i) =>
      entry({ kind: 'dm', peer: B, from: i % 2 ? A : B, id: `id${i}xxxxxxxxxxxx` }, 1000 + i, { snap: { author: A, authorName: 'Alice', preview: 'x'.repeat(200), at: 1, where: 'Bob' } }))
    const json = encodeSaved(many)
    expect(json.length).toBeLessThanOrEqual(11_500)
    const back = decodeSaved(json)!
    expect(back).toHaveLength(MAX_SAVED)
    expect(sameSaved(back, many)).toBe(true)
  })
})
