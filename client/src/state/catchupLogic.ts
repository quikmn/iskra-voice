// "What did I miss?": a summary of the unread stretch of a conversation, worked out on this device and deterministically
// (no AI, nothing leaves the device; DMs and groups stay end-to-end encrypted). The same messages always give the same
// summary. Kept free of the DOM and React so it can run in a worker (state/catchup.worker.ts).
//
// A future opt-in summarizer (say, a local model) plugs in through `CatchUpSummarizer` (state/catchup.ts): it gets the
// same input and may add prose, while this deterministic one stays the default and the fallback.

/** One message in the stretch, reduced to what the summary looks at. Sources (channels, threads, DMs, groups) map to it. */
export interface CatchUpMessage {
  id: number | string
  /** Account key (or "webhook:…"). */
  author: string
  at: number
  text: string
  /** Your own message: not counted, but replies to it stand out. */
  mine: boolean
  /** Reactions in total (every person and emoji). */
  reactions: number
  /** The message it replies to, if any. */
  replyTo: number | string | null
  /** Messages in a thread started from it. */
  threadReplies: number
  pinned: boolean
  mentionsMe: boolean
  images: number
  /** Attachments that aren't pictures. */
  files: number
  /** The question, when it's a poll. */
  poll: string | null
}

export type Reason = 'mention' | 'replyToYou' | 'pinned' | 'poll' | 'reactions' | 'replies' | 'thread' | 'link' | 'image' | 'file'

export interface CatchUpItem {
  id: number | string
  author: string
  at: number
  /** The start of the text, one line. */
  excerpt: string
  reasons: Reason[]
  reactions: number
  replies: number
  score: number
}

export interface Stretch {
  start: number
  end: number
  count: number
  /** The first message, to jump to. */
  firstId: number | string
}

export interface CatchUpSummary {
  overview: {
    messages: number
    people: number
    start: number
    end: number
    links: number
    images: number
    files: number
    polls: number
    mentions: number
  }
  /** The most interesting messages, best first. */
  highlights: CatchUpItem[]
  /** Mentions of you and replies to you, oldest first. */
  forYou: CatchUpItem[]
  pinned: CatchUpItem[]
  polls: CatchUpItem[]
  /** Messages with links or attachments, oldest first. */
  shared: CatchUpItem[]
  /** Who talked, most first. */
  people: { author: string; count: number }[]
  /** The busiest stretches (messages close together), in time order. */
  busy: Stretch[]
}

export const CATCH_UP_THRESHOLD = 30
export const MAX_HIGHLIGHTS = 8
export const MAX_SHARED = 12
export const EXCERPT_LENGTH = 140
/** Messages further apart than this start a new stretch. */
export const STRETCH_GAP_MS = 10 * 60 * 1000

const LINK = /https?:\/\/[^\s<>"']+/g

/** How many links a text has (each address once). */
export function linkCount(text: string): number {
  return new Set(text.match(LINK) ?? []).size
}

/** One line of text for a list: mentions and emoji tokens as they are (the panel shows names), markers kept short. */
export function excerpt(text: string, max = EXCERPT_LENGTH): string {
  const line = text.replace(/```[\s\S]*?```/g, '[code]').replace(/\s+/g, ' ').trim()
  return line.length <= max ? line : line.slice(0, max - 1).trimEnd() + '…'
}

const WEIGHTS = { reaction: 3, reply: 2, thread: 1.5, mention: 6, replyToYou: 5, pinned: 5, poll: 4, link: 1.5, attachment: 1.5, long: 0.5 }

/** The summary of a stretch of messages (oldest first or not: they're sorted by time, then id). */
export function summarize(input: CatchUpMessage[], maxHighlights = MAX_HIGHLIGHTS): CatchUpSummary {
  const all = [...input].sort((a, b) => a.at - b.at || compareIds(a.id, b.id))
  const mineIds = new Set(all.filter((m) => m.mine).map((m) => String(m.id)))
  const others = all.filter((m) => !m.mine)

  // Replies inside the stretch, per message.
  const replies = new Map<string, number>()
  for (const m of all) if (m.replyTo !== null) replies.set(String(m.replyTo), (replies.get(String(m.replyTo)) ?? 0) + 1)

  const items = others.map((m): CatchUpItem => {
    const links = linkCount(m.text)
    const replyCount = replies.get(String(m.id)) ?? 0
    const replyToYou = m.replyTo !== null && mineIds.has(String(m.replyTo))
    const reasons: Reason[] = []
    let score = 0
    if (m.mentionsMe) { reasons.push('mention'); score += WEIGHTS.mention }
    if (replyToYou) { reasons.push('replyToYou'); score += WEIGHTS.replyToYou }
    if (m.pinned) { reasons.push('pinned'); score += WEIGHTS.pinned }
    if (m.poll !== null) { reasons.push('poll'); score += WEIGHTS.poll }
    if (m.reactions > 0) { reasons.push('reactions'); score += WEIGHTS.reaction * m.reactions }
    if (replyCount > 0) { reasons.push('replies'); score += WEIGHTS.reply * replyCount }
    if (m.threadReplies > 0) { reasons.push('thread'); score += WEIGHTS.thread * Math.min(m.threadReplies, 20) }
    if (links > 0) { reasons.push('link'); score += WEIGHTS.link }
    if (m.images > 0) { reasons.push('image'); score += WEIGHTS.attachment }
    if (m.files > 0) { reasons.push('file'); score += WEIGHTS.attachment }
    if (m.text.length > 280) score += WEIGHTS.long
    return {
      id: m.id, author: m.author, at: m.at, excerpt: excerpt(m.poll ?? m.text), reasons, reactions: m.reactions, replies: replyCount + m.threadReplies,
      score: Math.round(score * 10) / 10,
    }
  })

  // Items are in time order. Highlights: what stood out, beyond just being shared or mentioning you (those have their own lists too).
  const highlights = items
    .filter((i) => i.score >= 3)
    .sort((a, b) => b.score - a.score || a.at - b.at || compareIds(a.id, b.id))
    .slice(0, maxHighlights)

  const people = new Map<string, number>()
  for (const m of others) people.set(m.author, (people.get(m.author) ?? 0) + 1)

  const links = others.reduce((n, m) => n + linkCount(m.text), 0)
  return {
    overview: {
      messages: others.length,
      people: people.size,
      start: others[0]?.at ?? 0,
      end: others.at(-1)?.at ?? 0,
      links,
      images: others.reduce((n, m) => n + m.images, 0),
      files: others.reduce((n, m) => n + m.files, 0),
      polls: others.filter((m) => m.poll !== null).length,
      mentions: others.filter((m) => m.mentionsMe).length,
    },
    highlights,
    forYou: items.filter((i) => i.reasons.includes('mention') || i.reasons.includes('replyToYou')),
    pinned: items.filter((i) => i.reasons.includes('pinned')),
    polls: items.filter((i) => i.reasons.includes('poll')),
    shared: items.filter((i) => i.reasons.includes('link') || i.reasons.includes('image') || i.reasons.includes('file')).slice(-MAX_SHARED),
    people: [...people].map(([author, count]) => ({ author, count })).sort((a, b) => b.count - a.count || (a.author < b.author ? -1 : 1)),
    busy: busyStretches(others),
  }
}

/** Runs of messages close together; the busiest few (at least 5 messages and a tenth of the stretch), in time order. */
export function busyStretches(messages: Pick<CatchUpMessage, 'id' | 'at'>[], gap = STRETCH_GAP_MS, max = 3): Stretch[] {
  const runs: Stretch[] = []
  for (const m of messages) {
    const last = runs.at(-1)
    if (last && m.at - last.end <= gap) {
      last.end = m.at
      last.count++
    } else runs.push({ start: m.at, end: m.at, count: 1, firstId: m.id })
  }
  if (runs.length < 2) return []
  const min = Math.max(5, Math.ceil(messages.length / 10))
  return runs
    .filter((r) => r.count >= min)
    .sort((a, b) => b.count - a.count || a.start - b.start)
    .slice(0, max)
    .sort((a, b) => a.start - b.start)
}

function compareIds(a: number | string, b: number | string): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0
}

// ── The one-line overview ───────────────────────────────────────────────────

/** i18next's t, or anything with its shape (tests pass one bound to a language). */
export type Translate = (key: string, options?: Record<string, unknown>) => string

/** "3 h", "45 min", "2 days": how long the stretch lasted. */
export function durationText(ms: number, t: Translate): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return t('catchup.duration.minutes', { count: Math.max(1, minutes) })
  const hours = Math.round(minutes / 60)
  if (hours < 48) return t('catchup.duration.hours', { count: hours })
  return t('catchup.duration.days', { count: Math.round(hours / 24) })
}

/** "128 messages from 6 people over 3 h; 4 links, 2 images, 1 poll". */
export function overviewText(o: CatchUpSummary['overview'], t: Translate): string {
  const messages = t('catchup.overview.messages', { count: o.messages })
  const people = t('catchup.overview.people', { count: o.people })
  const span = o.end - o.start
  const main = span < 60_000
    ? t('catchup.overview.mainMoment', { messages, people })
    : t('catchup.overview.main', { messages, people, duration: durationText(span, t) })
  const extras = [
    o.mentions && t('catchup.overview.mentions', { count: o.mentions }),
    o.links && t('catchup.overview.links', { count: o.links }),
    o.images && t('catchup.overview.images', { count: o.images }),
    o.files && t('catchup.overview.files', { count: o.files }),
    o.polls && t('catchup.overview.polls', { count: o.polls }),
  ].filter((x): x is string => !!x)
  return extras.length ? t('catchup.overview.withExtras', { main, extras: extras.join(', ') }) : main
}
