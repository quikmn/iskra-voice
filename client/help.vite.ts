// The assistant's help corpus (src/state/assistant/helpCorpus.ts): Iskra's docs split into trimmed sections at build
// time, as the virtual module `virtual:iskra-help`. The app loads it only when the assistant searches help.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
import { HELP_DOCS, splitMarkdown, type HelpSection } from './src/state/assistant/helpCorpus.ts'

const ID = 'virtual:iskra-help'
const RESOLVED = '\0' + ID

export function helpCorpus(): HelpSection[] {
  return HELP_DOCS.flatMap(({ doc, path }) => {
    try {
      return splitMarkdown(doc, readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8'))
    } catch {
      return [] // a doc that isn't there yet (a fresh checkout without it) just isn't searchable
    }
  })
}

export function help(): Plugin {
  return {
    name: 'iskra-help',
    resolveId: (id) => (id === ID ? RESOLVED : null),
    load: (id) => (id === RESOLVED ? `export default ${JSON.stringify(helpCorpus())}` : null),
  }
}
