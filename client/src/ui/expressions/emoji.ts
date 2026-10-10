// Custom emoji in text: stored as <:name:id>, typed as :name:. Standard emoji shortcodes (:fire:) become the emoji itself.
import type { CustomEmoji } from '../../core/protocol'
import { BY_SHORTCODE, STANDARD_EMOJI } from './emojiData'

export const CUSTOM_EMOJI_SOURCE = '<:([a-z0-9_]{2,32}):([A-Za-z0-9_-]{12})>'
const TOKEN = new RegExp(`^${CUSTOM_EMOJI_SOURCE}$`)
const CODE = /(```[\s\S]*?```|`[^`\n]*`)/

/** { name, id } for a <:name:id> token, else null. */
export function parseCustomEmoji(text: string): { name: string; id: string } | null {
  const match = TOKEN.exec(text)
  return match ? { name: match[1], id: match[2] } : null
}

/** Applies <paramref name="fn"/> to the parts of a message outside code. */
function outsideCode(text: string, fn: (part: string) => string): string {
  return text.split(CODE).map((part, i) => (i % 2 === 1 ? part : fn(part))).join('')
}

/** ":name:" → "<:name:id>" for this server's emoji, ":fire:" → "🔥". Unknown names stay as typed. */
export function encodeEmoji(text: string, custom: CustomEmoji[]): string {
  const byName = new Map(custom.map((e) => [e.name, e]))
  return outsideCode(text, (part) =>
    part.replace(/(?<![<\w]):([a-z0-9_+-]{1,32}):(?![A-Za-z0-9_-]{12}>)/g, (whole, name: string) => {
      const mine = byName.get(name)
      if (mine) return `<:${mine.name}:${mine.id}>`
      return BY_SHORTCODE.get(name) ?? whole
    }),
  )
}

/** The reverse, for editing: "<:name:id>" → ":name:". */
export function decodeEmoji(text: string): string {
  return text.replace(new RegExp(CUSTOM_EMOJI_SOURCE, 'g'), (_, name: string) => `:${name}:`)
}

/** A message that is only emoji (up to 27), which is shown big. */
export function isEmojiOnly(text: string): boolean {
  const rest = text.replace(new RegExp(CUSTOM_EMOJI_SOURCE, 'g'), '\u{1F600}').replace(/\s+/g, '')
  if (!rest) return false
  const segments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(rest)]
  return segments.length <= 27 && segments.every((s) => /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u.test(s.segment))
}

export type EmojiResult =
  | { kind: 'custom'; emoji: CustomEmoji }
  | { kind: 'standard'; char: string; name: string }

/** Emoji whose name starts with (or, after that, contains) the query. Server emoji first. */
export function searchEmoji(query: string, custom: CustomEmoji[], limit = 50): EmojiResult[] {
  const q = query.toLowerCase().replace(/^:|:$/g, '')
  if (!q) return []
  const score = (names: string[]) => {
    if (names[0].startsWith(q)) return 0
    if (names.some((n) => n.startsWith(q))) return 1
    if (names.some((n) => n.includes(q))) return 2
    return -1
  }
  const scored: [number, EmojiResult][] = []
  for (const emoji of custom) {
    const s = score([emoji.name])
    if (s >= 0) scored.push([s, { kind: 'custom', emoji }])
  }
  for (const e of STANDARD_EMOJI) {
    const s = score([e.name, ...e.keywords])
    if (s >= 0) scored.push([s + 0.5, { kind: 'standard', char: e.char, name: e.name }])
  }
  return scored.sort((a, b) => a[0] - b[0]).slice(0, limit).map(([, r]) => r)
}

/** The ":query" being typed right before the caret (at least 2 characters), or null. */
export function emojiQueryAt(text: string, caret: number): string | null {
  return /(?:^|[\s(])(:[a-z0-9_+-]{2,32})$/i.exec(text.slice(0, caret))?.[1].slice(1) ?? null
}

/** Puts an emoji in place of the ":query" before the caret. Returns the new text and caret. */
export function completeEmoji(text: string, caret: number, insert: string): { text: string; caret: number } {
  const before = text.slice(0, caret).replace(/:[a-z0-9_+-]{2,32}$/i, insert + ' ')
  return { text: before + text.slice(caret), caret: before.length }
}

/** Inserts text at the caret, with a space before it when needed. */
export function insertAt(text: string, caret: number, insert: string): { text: string; caret: number } {
  const at = Math.min(Math.max(caret, 0), text.length)
  const pad = at > 0 && !/\s$/.test(text.slice(0, at)) ? ' ' : ''
  const before = text.slice(0, at) + pad + insert
  return { text: before + text.slice(at), caret: before.length }
}
