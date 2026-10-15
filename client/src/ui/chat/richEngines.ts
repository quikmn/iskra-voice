// The heavy parts of rich text, loaded only when a message needs them (richLoader.ts): syntax highlighting
// (lowlight, highlight.js's common languages) and LaTeX math (temml, to MathML). Both outputs go through the
// allowlists in safeTrees.ts on their way to React; nothing is ever inserted as HTML.
import { common, createLowlight } from 'lowlight'
import temml from 'temml'
import 'temml/dist/Temml-Local.css'
import type { ReactNode } from 'react'
import { hastToReact, mathmlToReact, type HastRoot } from './safeTrees'

const lowlight = createLowlight(common)
export const MAX_CODE = 20_000
/** Guessing needs a clear winner, or prose and logs would get random colours. */
const MIN_RELEVANCE = 6
/** What auto-detect picks from: the languages people paste most. */
const GUESSES = ['javascript', 'typescript', 'python', 'java', 'csharp', 'cpp', 'c', 'go', 'rust', 'bash', 'shell', 'sql', 'json',
  'xml', 'css', 'scss', 'yaml', 'ini', 'php', 'ruby', 'kotlin', 'swift', 'lua', 'diff', 'markdown', 'makefile']

/** Highlighted code, or null to show it plain (unknown language, nothing clear to guess, too long). */
export function highlightCode(code: string, language: string): ReactNode | null {
  if (code.length > MAX_CODE) return null
  try {
    if (language) {
      const name = language.toLowerCase()
      return lowlight.registered(name) ? hastToReact(lowlight.highlight(name, code) as HastRoot) : null
    }
    const guess = lowlight.highlightAuto(code, { subset: GUESSES.filter((l) => lowlight.registered(l)) })
    const relevance = (guess.data as { relevance?: number } | undefined)?.relevance ?? 0
    return relevance >= MIN_RELEVANCE ? hastToReact(guess as HastRoot) : null
  } catch {
    return null
  }
}

/** The language auto-detect would pick (for the label), or null. */
export function guessLanguage(code: string): string | null {
  if (code.length > MAX_CODE) return null
  try {
    const guess = lowlight.highlightAuto(code, { subset: GUESSES.filter((l) => lowlight.registered(l)) })
    const data = guess.data as { relevance?: number; language?: string } | undefined
    return (data?.relevance ?? 0) >= MIN_RELEVANCE ? data?.language ?? null : null
  } catch {
    return null
  }
}

/** LaTeX as MathML elements, or null if it doesn't parse (the source is shown instead). */
export function renderMath(tex: string, display: boolean): ReactNode | null {
  try {
    // trust: false (the default) keeps out \href, \url, \includegraphics, \class, \id, \style and \data.
    const markup = temml.renderToString(tex, { displayMode: display, throwOnError: true, trust: false, maxExpand: 300 })
    return mathmlToReact(markup)
  } catch {
    return null
  }
}
