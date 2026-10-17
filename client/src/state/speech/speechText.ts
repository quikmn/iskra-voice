// What a message sounds like read aloud: plain words, no markup. Code blocks are named, not read; links become their
// host names; spoilers stay hidden; emoji runs and stretched letters are shortened. Pure (tested in speechText.test.ts).
import { stripMarkdown } from '../../ui/plainMarkdown'

/** The words it adds, in the app's language. */
export interface SpeechWords {
  /** "code block, 3 lines". */
  codeBlock: (lines: number) => string
  /** Said instead of a spoiler's text. */
  spoiler: string
  /** "link to github.com". */
  link: (host: string) => string
  /** Added when the text was cut short. */
  more: string
}

/** Read at most this much of one message. */
export const MAX_SPOKEN = 300

const CUSTOM_EMOJI = /<:([a-z0-9_]{2,32}):[A-Za-z0-9_-]{12}>/g
const CODE_BLOCK = /```[^\n`]*\n?([\s\S]*?)(?:```|$)/g
const SPOILER = /\|\|(?=\S)[\s\S]*?\S\|\|/g
const URL = /\bhttps?:\/\/([^\s/?#<>"']+)[^\s<>"']*/gi
const EMOJI_RUN = /(\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?)(?:\s*\1)+/gu
const STRETCHED = /(\p{L})\1{3,}/gu
const PUNCTUATION_RUN = /([!?.])[!?.]{2,}/g

/** Custom emoji by name ("<:party_parrot:…>" → "party parrot"), before anything else sees the token. */
export const speakCustomEmoji = (raw: string) => raw.replace(CUSTOM_EMOJI, (_, name: string) => ` ${name.replace(/_/g, ' ')} `)

/**
 * Plain text (mentions already turned into names, see plainText) into what's said. `max`: characters at most,
 * cut at a word, with `words.more` after.
 */
export function speakableText(plain: string, words: SpeechWords, max = MAX_SPOKEN): string {
  let text = plain
    .replace(CODE_BLOCK, (_, body: string) => ` ${words.codeBlock(Math.max(1, body.replace(/\n+$/, '').split('\n').length))}. `)
    .replace(SPOILER, ` ${words.spoiler} `)
    .replace(URL, (_, host: string) => ` ${words.link(host.replace(/^www\./i, '').replace(/:\d+$/, '').toLowerCase())} `)
  text = stripMarkdown(text)
    .replace(/`/g, '')
    .replace(EMOJI_RUN, '$1')
    .replace(STRETCHED, '$1$1$1')
    .replace(PUNCTUATION_RUN, '$1')
    // Line breaks pause; spaces don't pile up.
    .replace(/\s*\n+\s*/g, (_, offset: number, all: string) => (/[.!?:;,]$/.test(all.slice(0, offset).trimEnd()) ? ' ' : '. '))
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,!?;:])/g, '$1')
    .replace(/^[.\s]+/, '')
    .trim()
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, '')}… ${words.more}`
}
