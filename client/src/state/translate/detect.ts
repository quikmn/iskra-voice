// Which language a message is in, on the device: ELD (Efficient Language Detector, Apache-2.0, n-grams, no model
// download) with chat in mind: links, mentions, emoji and numbers don't count, a few words aren't enough to be sure,
// and close languages (Swedish, Danish, Norwegian) lean toward the reader's own. No DOM: runs in the translate worker.

export interface Detection {
  /** ISO 639-1 ("sv"), or null when it can't tell. */
  language: string | null
  /** Sure enough to translate on its own (auto-translate); a manual Translate takes the best guess. */
  reliable: boolean
}

/** What ELD answers (eld's LanguageResult). */
export interface EldResult {
  language: string
  getScores(): Record<string, number>
  isReliable(): boolean
}

/** ELD's codes that differ from the models' ("no" is Norwegian Bokmål there). */
const ALIASES: Record<string, string> = { no: 'nb' }

/** Within this of the best score, the reader's own language wins (Swedish read as Danish, say). */
export const PREFER_MARGIN = 0.05
/** Fewer letters than this (after cleanup) is too little to tell: "lol", "ok", "gg". */
export const MIN_LETTERS = 6

/** The text without what says nothing about its language. */
export function detectableText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\bhttps?:\/\/\S+/gi, ' ')
    .replace(/\bwww\.\S+/gi, ' ')
    .replace(/(^|\s)[@#][^\s]+/g, ' ')
    .replace(/:[a-z0-9_+-]+:/gi, ' ')
    .replace(/[\p{N}\p{Extended_Pictographic}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const letters = (text: string) => (text.match(/\p{L}/gu) ?? []).length

/** The language from ELD's scores, leaning toward `prefer` (the reader's languages) when it's a close call. */
export function pickLanguage(scores: Record<string, number>, reliable: boolean, prefer: readonly string[]): Detection {
  const ranked = Object.entries(scores).map(([code, score]) => [ALIASES[code] ?? code, score] as const).sort((a, b) => b[1] - a[1])
  if (!ranked.length) return { language: null, reliable: false }
  const [best, top] = ranked[0]
  for (const language of prefer) {
    const own = ranked.find(([code]) => code === language)
    if (own && own[1] >= top - PREFER_MARGIN) return { language, reliable }
  }
  return { language: best, reliable }
}

/** Detects with `eld`; null language for text too short or too odd to tell. */
export function detectWith(eld: { detect(text: string): EldResult }, text: string, prefer: readonly string[]): Detection {
  const clean = detectableText(text)
  if (letters(clean) < MIN_LETTERS) return { language: null, reliable: false }
  const result = eld.detect(clean)
  const words = clean.split(' ').length
  return pickLanguage(result.getScores(), result.isReliable() && words >= 2, prefer)
}

let loaded: Promise<{ detect(text: string): EldResult }> | null = null

/** The smallest ELD database (under 1 MB), loaded the first time it's needed. */
export async function detectLanguage(text: string, prefer: readonly string[]): Promise<Detection> {
  loaded ??= import('eld/extrasmall').then((m) => m.eld.newInstance())
  return detectWith(await loaded, text, prefer)
}
