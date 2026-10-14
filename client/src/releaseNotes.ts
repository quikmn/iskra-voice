// The "What's new" lines of a release, read from docs/releases/<version>.md at build time (vite.config.ts) and shown
// once after an update (state/whatsNew.ts). Plain text only: React renders it, nothing here becomes HTML.

export interface WhatsNewNotes {
  version: string
  /** The highlights in English (the bold lead of each "What's new" bullet). */
  en: string[]
  /** The same from docs/releases/<version>.sv.md, when there is one. */
  sv?: string[]
}

/** At most this many lines on the card; the full notes are a link away. */
export const MAX_LINES = 6
const MAX_LINE = 160

const HEADING = /^#{1,6}\s+(.*)$/
const WHATS_NEW = /^(what['’]s new|nytt|nyheter|vad är nytt)\b/i

/** Markdown to plain text: links keep their text; bold, italics and code marks go. */
function plain(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|\W)[*_](\S(?:.*?\S)?)[*_](?=\W|$)/g, '$1$2')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function short(text: string): string {
  return text.length <= MAX_LINE ? text : `${text.slice(0, MAX_LINE - 1).trimEnd()}…`
}

/**
 * The highlights under "### What's new": each bullet's bold lead ("**Report a bug from inside the app.** Press…"
 * → "Report a bug from inside the app."), or its first sentence when it has none.
 */
export function whatsNewLines(markdown: string, max = MAX_LINES): string[] {
  const lines: string[] = []
  let inSection = false
  for (const raw of markdown.split(/\r?\n/)) {
    const heading = HEADING.exec(raw.trim())
    if (heading) {
      if (inSection) break
      inSection = WHATS_NEW.test(heading[1].trim())
      continue
    }
    if (!inSection) continue
    const bullet = /^[-*+]\s+(.*)$/.exec(raw) // top-level bullets only
    if (!bullet) continue
    const body = bullet[1].trim()
    const lead = /^\*\*(.+?)\*\*/.exec(body)
    // A lead that runs on into the bullet ("**Richer cards:** the full…") loses its colon.
    const text = plain(lead ? lead[1] : (/^.*?[.!?](?=\s|$)/.exec(body)?.[0] ?? body)).replace(/\s*[:;,–—-]$/, '')
    if (text) lines.push(short(text))
    if (lines.length >= max) break
  }
  return lines
}

/** Reads a version's notes (English, and Swedish if present) with `read(fileName)`; null without English lines. */
export function releaseNotesFor(version: string, read: (file: string) => string | null): WhatsNewNotes | null {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) return null
  const en = whatsNewLines(read(`${version}.md`) ?? '')
  if (en.length === 0) return null
  const svText = read(`${version}.sv.md`)
  const sv = svText ? whatsNewLines(svText) : []
  return { version, en, ...(sv.length > 0 ? { sv } : {}) }
}

/** Where the full notes are. */
export const releaseNotesUrl = (version: string) => `https://github.com/quikmn/iskra-voice/releases/tag/v${version}`
