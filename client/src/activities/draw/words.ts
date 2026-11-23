// Words to draw: everyday things that are fun to sketch, one file per language in ./words/<code>.ts.
// The drawer's app offers three; the drawer picks one.
import { byLanguage } from '../util'

export const WORDS: Record<string, string[]> = byLanguage(import.meta.glob<string[]>('./words/*.ts', { eager: true, import: 'words' }))

/** Three different words, picked at random. */
export function threeWords(list: readonly string[], random: () => number = Math.random): string[] {
  const unique = [...new Set(list)]
  const picked: string[] = []
  while (picked.length < 3 && picked.length < unique.length) {
    const word = unique[Math.floor(random() * unique.length)]
    if (!picked.includes(word)) picked.push(word)
  }
  return picked
}
