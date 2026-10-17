// Tags, Suggestions, Giveaways and Counting: pure helpers for their settings, cards and answers.
import type { Bots3Configs, Bots3Id, Bots3Reply, BuiltinReply, GiveawayStatus, ServerRole, Tag } from '../core/protocol'

export const BOTS3: readonly Bots3Id[] = ['tags', 'suggestions', 'giveaways', 'counting']
export const MAX_TAG_NAME = 32
export const MAX_TAG_TEXT = 2000
export const MAX_TAGS = 200
export const MAX_SUGGESTION = 1000
export const MAX_REASON = 300
const RESERVED = ['list', 'set', 'remove']

export function isBots3(id: string): id is Bots3Id {
  return (BOTS3 as readonly string[]).includes(id)
}

const KINDS = new Set<string>([
  'tag', 'tag.list', 'tag.saved', 'tag.removed', 'tag.unknown', 'tag.usage',
  'suggestion', 'suggestion.prompt', 'suggestion.posted', 'suggestion.usage', 'suggestion.decided',
  'giveaway', 'giveaway.won', 'giveaway.none', 'giveaway.usage',
  'counting.card', 'counting.broken', 'counting.changed', 'counting.start',
])

export function isBots3Reply(reply: BuiltinReply): reply is BuiltinReply & Bots3Reply {
  return KINDS.has(reply.kind)
}

/** A tag's name as the server stores it (lowercased, trimmed). */
export function tagName(raw: string): string {
  return raw.trim().toLowerCase()
}

/** What's wrong with a tag being saved (an i18n key under bots3.tags.invalid), or null. */
export function tagProblem(name: string, text: string): 'name' | 'reserved' | 'text' | null {
  const n = tagName(name)
  if (!/^[a-z0-9-]{1,32}$/.test(n)) return 'name'
  if (RESERVED.includes(n)) return 'reserved'
  if (!text.trim() || text.length > MAX_TAG_TEXT) return 'text'
  return null
}

/** Tags whose name or text has the query, names first. */
export function filterTags(tags: Tag[], query: string): Tag[] {
  const q = query.trim().toLowerCase()
  if (!q) return tags
  const byName = tags.filter((t) => t.name.includes(q))
  return [...byName, ...tags.filter((t) => !t.name.includes(q) && t.text.toLowerCase().includes(q))]
}

/** Clicking a vote button: the same vote again takes it back. */
export function nextVote(current: 1 | -1 | 0, clicked: 1 | -1): 1 | -1 | 0 {
  return current === clicked ? 0 : clicked
}

/** The counts after a vote changes from `from` to `to` (shown right away; the server's card follows). */
export function applyVote(counts: { up: number; down: number }, from: 1 | -1 | 0, to: 1 | -1 | 0): { up: number; down: number } {
  let { up, down } = counts
  if (from === 1) up--
  if (from === -1) down--
  if (to === 1) up++
  if (to === -1) down++
  return { up: Math.max(0, up), down: Math.max(0, down) }
}

/** Whether people can still enter (the server ends it within a second of `endsAt`). */
export function giveawayOpen(reply: { status: GiveawayStatus; endsAt: number }, now: number): boolean {
  return reply.status === 'open' && reply.endsAt > now
}

/** Roles a staff or manager role can be: not ones members give themselves. */
export function staffRoles(roles: ServerRole[]): ServerRole[] {
  return roles.filter((r) => !r.selfAssign)
}

const READ_ONLY = new Set(['current', 'best', 'bestAt'])

/** Only what changed, ready for builtin.bots.config.set (read-only fields left out). */
export function bots3Patch<K extends Bots3Id>(saved: Bots3Configs[K], draft: Bots3Configs[K]): Partial<Bots3Configs[K]> {
  const patch: Record<string, unknown> = {}
  for (const key of Object.keys(draft) as (keyof Bots3Configs[K] & string)[]) {
    if (READ_ONLY.has(key)) continue
    if (draft[key] !== saved[key]) patch[key] = draft[key]
  }
  return patch as Partial<Bots3Configs[K]>
}

/** "Ends in 2 h 5 min"-style parts, or null once it's over. */
export function timeLeft(endsAt: number, now: number): { days: number; hours: number; minutes: number } | null {
  const ms = endsAt - now
  if (ms <= 0) return null
  const minutes = Math.ceil(ms / 60_000)
  return { days: Math.floor(minutes / 1440), hours: Math.floor((minutes % 1440) / 60), minutes: minutes % 60 }
}
