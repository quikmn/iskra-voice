// Server stats' rules: weekly counts and the card. Run: npm test (in bots/, or in a copy of this folder).
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { cardDue, Counter, statsCard, weekKey } from './stats.ts'

const dir = mkdtempSync(join(tmpdir(), 'stats-test-'))
after(() => rmSync(dir, { recursive: true, force: true }))

const sunday = new Date(2026, 9, 18, 20)
const mondayEarly = new Date(2026, 9, 19, 7)
const mondayNine = new Date(2026, 9, 19, 9, 1)

describe('counting', () => {
  it('counts messages per channel and joins, and nothing about people', () => {
    const file = join(dir, 'stats.json')
    const counter = new Counter(file, sunday)
    counter.message(1, sunday)
    counter.message(1, sunday)
    counter.message(2, sunday)
    counter.joinedOne(sunday)
    counter.save()
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepEqual(saved, { week: weekKey(sunday), messages: { 1: 2, 2: 1 }, joined: 1, previous: null })
    assert.deepEqual(new Counter(file, sunday).data.messages, { 1: 2, 2: 1 }) // after a restart
  })

  it('keeps last week until its card is out on Monday at the hour, then forgets it', () => {
    const counter = new Counter(null, sunday)
    counter.message(1, sunday)
    assert.equal(counter.due(sunday, 9), null)
    assert.equal(counter.due(mondayEarly, 9), null) // a new week, but not 9 yet
    counter.message(3, mondayEarly) // counts for the new week
    const last = counter.due(mondayNine, 9)
    assert.deepEqual(last?.messages, { 1: 1 })
    assert.deepEqual(counter.data.messages, { 3: 1 })
    counter.posted()
    assert.equal(counter.due(mondayNine, 9), null)
  })

  it('a quiet week has no card', () => {
    const counter = new Counter(null, sunday)
    assert.equal(counter.due(mondayNine, 9), null)
  })

  it('the card is due from Monday at the hour, or any later day', () => {
    assert.ok(!cardDue(mondayEarly, 9))
    assert.ok(cardDue(mondayNine, 9))
    assert.ok(cardDue(new Date(2026, 9, 20, 1), 9))
  })
})

describe('the card', () => {
  it('lists the busiest channels and sums up threads and unknown channels', () => {
    const messages: Record<string, number> = { 1: 5, 2: 12, 99: 3 }
    for (let i = 10; i < 22; i++) messages[i] = 1
    const names = new Map([[1, 'general'], [2, 'games'], ...Array.from({ length: 12 }, (_, i) => [10 + i, `c${String(i).padStart(2, '0')}`] as [number, string])])
    const card = statsCard({ week: '2026-W42', counts: { week: '2026-W42', messages, joined: 2, }, members: 40, channelNames: names, readsAll: true })
    assert.equal(card.title, '📊 Week 42')
    assert.deepEqual(card.fields?.slice(0, 3).map((f) => f.value), ['40', '2', '32'])
    const busiest = card.fields?.[3].value.split('\n') ?? []
    assert.equal(busiest[0], '#games: 12')
    assert.equal(busiest[1], '#general: 5')
    assert.equal(busiest.length, 11)
    assert.equal(busiest[10], 'Threads and other channels: 7') // 3 in a thread + 4 channels past the top 10
    assert.match(card.footer?.text ?? '', /Counts only/)
  })

  it('says when it can only count messages sent to it', () => {
    const card = statsCard({ week: '2026-W02', counts: { week: '2026-W02', messages: {}, joined: 0 }, members: 3, channelNames: new Map(), readsAll: false, partial: true })
    assert.equal(card.title, '📊 Week 2 so far')
    assert.equal(card.fields?.[3].value, 'Quiet week.')
    assert.match(card.footer?.text ?? '', /read all messages/)
  })
})
