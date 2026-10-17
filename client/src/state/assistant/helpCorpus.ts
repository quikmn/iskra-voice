// The assistant's help corpus: Iskra's own docs (hosting, bots, the assistant, the wire protocol), split into sections at
// build time (vite.config.ts, virtual:iskra-help) and searched on this device. Nothing here goes anywhere until the model
// asks help_search and the matching sections go to the provider with the conversation.

export interface HelpSection {
  doc: string
  title: string
  text: string
}

/** Long fenced blocks (big JSON examples) are cut to this many lines. */
const MAX_FENCE_LINES = 30
const MAX_SECTION_CHARS = 6000

/** Splits a markdown file at its ## and ### headings, trimmed for the model. */
export function splitMarkdown(doc: string, markdown: string): HelpSection[] {
  const sections: HelpSection[] = []
  let title = doc
  let lines: string[] = []
  let fence = 0
  const flush = () => {
    const text = lines.join('\n').replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n').trim()
    if (text) sections.push({ doc, title, text: text.length > MAX_SECTION_CHARS ? `${text.slice(0, MAX_SECTION_CHARS)}\n…` : text })
    lines = []
  }
  let inFence = false
  for (const line of markdown.split(/\r?\n/)) {
    if (line.startsWith('```')) {
      inFence = !inFence
      fence = 0
      lines.push(line)
      continue
    }
    if (inFence) {
      if (++fence === MAX_FENCE_LINES) lines.push('…')
      if (fence < MAX_FENCE_LINES) lines.push(line)
      continue
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line)
    if (heading) {
      flush()
      title = heading[1].length === 1 ? heading[2] : `${heading[2]}`
      continue
    }
    lines.push(line)
  }
  flush()
  return sections
}

const words = (text: string): string[] => text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[\p{L}\p{N}]{2,}/gu) ?? []

/** The best sections for a question: title words count three times. */
export function searchHelp(sections: readonly HelpSection[], query: string, limit = 3): HelpSection[] {
  const terms = [...new Set(words(query))].filter((w) => !STOP.has(w))
  if (!terms.length) return []
  const scored = sections.map((section) => {
    const title = words(`${section.doc} ${section.title}`)
    const body = words(section.text)
    let score = 0
    for (const term of terms) {
      score += title.filter((w) => w.startsWith(term)).length * 3
      score += Math.min(body.filter((w) => w.startsWith(term)).length, 10)
    }
    return { section, score }
  })
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.section)
}

const STOP = new Set(['the', 'and', 'how', 'do', 'can', 'what', 'is', 'to', 'of', 'in', 'on', 'my', 'it', 'for', 'with', 'an', 'hur', 'och', 'jag', 'en', 'ett', 'att', 'det', 'som', 'vad', 'kan', 'med', 'min', 'mitt'])

/** The docs the corpus is built from (repo paths), in the order topics are listed. */
export const HELP_DOCS = [
  { doc: 'Assistant', path: 'docs/assistant.md' },
  { doc: 'Hosting', path: 'docs/hosting.md' },
  { doc: 'Bots', path: 'docs/bots.md' },
  { doc: 'Protocol', path: 'protocol/PROTOCOL.md' },
] as const
