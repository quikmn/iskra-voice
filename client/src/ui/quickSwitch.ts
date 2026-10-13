// Ctrl/Cmd+K: what you can jump to, and how a typed query ranks them.
import type { Channel } from '../core/protocol'

export interface SwitchItem {
  id: string
  kind: 'channel' | 'dm' | 'friends'
  /** For channels: text, forum or docs (for the icon). */
  channelKind?: Channel['kind']
  label: string
  /** Where it is, e.g. the server's name. */
  context: string
  /** Unread messages, shown and ranked first when there's no query. */
  unread: number
}

/** Lower is better; null means no match. Prefix beats word start beats anywhere; a fuzzy in-order match comes last. */
export function matchScore(label: string, query: string): number | null {
  const text = label.toLowerCase()
  const q = query.trim().toLowerCase().replace(/^[#@]/, '')
  if (!q) return 0
  if (text.startsWith(q)) return 0
  if (new RegExp(`(^|[\\s\\-_.·])${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(text)) return 1
  if (text.includes(q)) return 2
  let at = 0
  for (const char of q) {
    at = text.indexOf(char, at) + 1
    if (at === 0) return null
  }
  return 3
}

export function rankItems(items: SwitchItem[], query: string, limit = 12): SwitchItem[] {
  const scored = items
    .map((item, index) => {
      const own = matchScore(item.label, query)
      const where = own === null && query.trim() ? matchScore(item.context, query) : null
      return { item, index, score: own ?? (where === null || where > 1 ? null : where + 4) }
    })
    .filter((s): s is { item: SwitchItem; index: number; score: number } => s.score !== null)
  scored.sort((a, b) =>
    a.score - b.score || (query.trim() ? 0 : Number(b.item.unread > 0) - Number(a.item.unread > 0)) || a.index - b.index)
  return scored.slice(0, limit).map((s) => s.item)
}
