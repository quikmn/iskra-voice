// Server stats' rules, apart from the bot (bot.ts) so they're easy to test. It only ever counts: messages per channel
// and how many people joined this week. Never who wrote what, who is most active, or anything else about a person.
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { Card } from 'iskra-bots'

export interface WeekCounts {
  /** "2026-W42", in this computer's time zone. */
  week: string
  /** Channel id → messages this week. */
  messages: Record<string, number>
  /** People (not bots) who joined this week. */
  joined: number
}

export interface Saved extends WeekCounts {
  /** Last week's counts, until its card is posted. */
  previous?: WeekCounts | null
}

/** "2026-W42": the ISO week (weeks start on Monday) of a date, in this computer's time zone. */
export function weekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7))
  const week = Math.ceil(((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

/** This week's counts in a small JSON file. When a week ends its counts are handed over once (for the card) and dropped. */
export class Counter {
  data: Saved
  private readonly file: string | null

  constructor(file: string | null, now: Date = new Date()) {
    this.file = file
    this.data = { week: weekKey(now), messages: {}, joined: 0, previous: null }
    if (!file) return
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as Saved
      if (typeof saved?.week === 'string' && saved.messages && typeof saved.messages === 'object') this.data = { ...this.data, ...saved }
    } catch {
      /* first run */
    }
  }

  /** A message in a channel (or a thread: counted under its id). */
  message(channelId: number, now: Date = new Date()): void {
    this.roll(now)
    this.data.messages[channelId] = (this.data.messages[channelId] ?? 0) + 1
    this.dirty = true
  }

  joinedOne(now: Date = new Date()): void {
    this.roll(now)
    this.data.joined += 1
    this.dirty = true
  }

  /** A new week: the one that ended waits in `previous` for its card (an older one waiting is dropped), and counting starts at 0. */
  roll(now: Date = new Date()): void {
    const current = weekKey(now)
    if (current === this.data.week) return
    const { previous: _older, ...finished } = this.data
    const busy = finished.joined > 0 || Object.keys(finished.messages).length > 0
    this.data = { week: current, messages: {}, joined: 0, previous: busy ? finished : null }
    this.dirty = true
    this.save()
  }

  /** Last week's counts if its card is due (see cardDue); call `posted()` once it's out. */
  due(now: Date, hour: number): WeekCounts | null {
    this.roll(now)
    return this.data.previous && cardDue(now, hour) ? this.data.previous : null
  }

  posted(): void {
    this.data.previous = null
    this.dirty = true
    this.save()
  }

  private dirty = false

  /** Writes the counts if they changed (called every minute, not on every message). */
  save(): void {
    if (!this.file || !this.dirty) return
    this.dirty = false
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data, null, 2))
    renameSync(`${this.file}.tmp`, this.file)
  }
}

export interface CardInput {
  week: string
  counts: WeekCounts
  /** People on the server now (bots not counted). */
  members: number
  /** Channel id → name, for the channels the bot can see. */
  channelNames: Map<number, string>
  /** The bot reads every message; else it only counts the messages it's sent (mentions, replies, its commands). */
  readsAll: boolean
  /** "so far" while the week is on. */
  partial?: boolean
}

/** The weekly card: members, new people, messages, and the busiest channels. Counts only. */
export function statsCard(input: CardInput): Card {
  const entries = Object.entries(input.counts.messages)
  const total = entries.reduce((sum, [, n]) => sum + n, 0)
  // Threads and channels the bot can't see any more are summed up as "elsewhere", never listed by id.
  let elsewhere = 0
  const named: [string, number][] = []
  for (const [id, n] of entries) {
    const name = input.channelNames.get(Number(id))
    if (name === undefined) elsewhere += n
    else named.push([name, n])
  }
  named.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const lines = named.slice(0, 10).map(([name, n]) => `#${name}: ${n.toLocaleString('en')}`)
  if (named.length > 10) elsewhere += named.slice(10).reduce((sum, [, n]) => sum + n, 0)
  if (elsewhere > 0) lines.push(`Threads and other channels: ${elsewhere.toLocaleString('en')}`)
  const weekNo = input.week.slice(-2).replace(/^0/, '')
  return {
    title: `📊 Week ${weekNo}${input.partial ? ' so far' : ''}`,
    color: 0x3ba55c,
    fields: [
      { name: 'Members', value: input.members.toLocaleString('en'), inline: true },
      { name: 'New this week', value: input.counts.joined.toLocaleString('en'), inline: true },
      { name: 'Messages', value: total.toLocaleString('en'), inline: true },
      { name: 'Busiest channels', value: lines.join('\n') || 'Quiet week.', inline: false },
    ],
    footer: {
      text: input.readsAll
        ? 'Counts only: nothing about who wrote what is kept.'
        : 'Counting only messages sent to me. An admin can let me read all messages (Bots & webhooks → Bots) for the full count.',
    },
  }
}

/** Last week's card goes out on Monday at `hour` o'clock (this computer's time zone), or as soon as the bot runs after that. */
export function cardDue(now: Date, hour: number): boolean {
  return now.getDay() !== 1 || now.getHours() >= hour
}
