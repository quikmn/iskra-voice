// The quiz's bundled questions (general knowledge, easy to medium), one file per language in ./questions/<code>.ts.
// `correct` is the index of the right option; the quizmaster's app shuffles the options before sending them.
import { byLanguage } from '../util'

export interface BankQuestion {
  text: string
  options: string[]
  correct: number
}

export const QUESTIONS: Record<string, BankQuestion[]> = byLanguage(
  import.meta.glob<BankQuestion[]>('./questions/*.ts', { eager: true, import: 'questions' }),
)
