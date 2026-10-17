// Quiz: one quizmaster sends questions (their own, or from the bundled set) and reveals the answer; everyone else
// answers. Faster correct answers score more. The quizmaster's app keeps the answers until it reveals them.
import { isId, isInt, isObject, isText } from '../util'

export const MAX_QUESTION = 300
export const MAX_OPTION = 100
export const MAX_QUESTIONS = 50
/** Points for a right answer, and the bonus for the first, second and third right ones. */
export const POINTS = 100
export const BONUS = [50, 30, 10]

export interface Question {
  text: string
  options: string[]
}

export interface QuizState {
  phase: 'lobby' | 'question' | 'reveal' | 'over'
  master: string | null
  /** The question number (1-based; 0 before the first). */
  n: number
  total: number
  question: Question | null
  /** Player id → the option they picked, this question. */
  answers: Record<string, number>
  /** Who answered, in order (earlier right answers get a bonus). */
  order: string[]
  correct: number | null
  scores: Record<string, number>
  /** What each player got for the last question. */
  gained: Record<string, number>
}

export const initialQuiz = (): QuizState => ({
  phase: 'lobby', master: null, n: 0, total: 0, question: null, answers: {}, order: [], correct: null, scores: {}, gained: {},
})

function question(data: Record<string, unknown>): Question | null {
  const { text, options } = data
  if (!isText(text, MAX_QUESTION) || !Array.isArray(options) || options.length < 2 || options.length > 4) return null
  if (!options.every((o) => isText(o, MAX_OPTION))) return null
  return { text, options: options as string[] }
}

export function reduceQuiz(state: QuizState, data: unknown, from: string): QuizState {
  if (!isObject(data)) return state
  const master = state.master === from
  switch (data.t) {
    case 'host':
      return state.master === null ? { ...state, master: from } : state
    case 'resign': // between quizzes
      return master && (state.phase === 'lobby' || state.phase === 'over') ? { ...state, master: null } : state
    case 'takeover': // offered only when the quizmaster left
      return master ? state : { ...state, master: from }
    case 'q': {
      const q = question(data)
      if (!master || !q || !isInt(data.total, 1, MAX_QUESTIONS) || !isInt(data.n, 1, data.total as number)) return state
      const fresh = state.phase === 'lobby' || state.phase === 'over'
      if (fresh ? data.n !== 1 : state.phase !== 'reveal' || data.n !== state.n + 1) return state
      return {
        ...state, phase: 'question', n: data.n, total: data.total as number, question: q, answers: {}, order: [], correct: null, gained: {},
        scores: fresh ? {} : state.scores,
      }
    }
    case 'a': {
      if (master || state.phase !== 'question' || data.n !== state.n || from in state.answers) return state
      if (!isInt(data.choice, 0, (state.question?.options.length ?? 0) - 1)) return state
      return { ...state, answers: { ...state.answers, [from]: data.choice }, order: [...state.order, from] }
    }
    case 'reveal': {
      if (!master || state.phase !== 'question' || data.n !== state.n || !isInt(data.correct, 0, (state.question?.options.length ?? 0) - 1)) return state
      const right = state.order.filter((id) => state.answers[id] === data.correct)
      const gained: Record<string, number> = {}
      right.forEach((id, rank) => (gained[id] = POINTS + (BONUS[rank] ?? 0)))
      const scores = { ...state.scores }
      for (const id of state.order) scores[id] = (scores[id] ?? 0) + (gained[id] ?? 0)
      return { ...state, phase: 'reveal', correct: data.correct, scores, gained }
    }
    case 'over':
      return master && state.phase === 'reveal' ? { ...state, phase: 'over' } : state
    case 'reset':
      return master ? { ...initialQuiz(), master: state.master } : state
    default:
      return state
  }
}

/** Players by score, highest first (ties by name order of their ids, so everyone sees the same list). */
export function ranking(scores: Record<string, number>): { id: string; score: number }[] {
  return Object.entries(scores).map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
}

export function parseQuiz(raw: unknown): QuizState | null {
  if (!isObject(raw)) return null
  const s = raw as Partial<QuizState>
  if (!['lobby', 'question', 'reveal', 'over'].includes(s.phase as string)) return null
  if (!(s.master === null || isId(s.master)) || !isInt(s.n, 0, MAX_QUESTIONS) || !isInt(s.total, 0, MAX_QUESTIONS)) return null
  const q = s.question === null ? null : isObject(s.question) ? question(s.question as Record<string, unknown>) : undefined
  if (q === undefined) return null
  const numbers = (v: unknown) => isObject(v) && Object.entries(v).every(([k, n]) => isId(k) && typeof n === 'number' && Number.isFinite(n))
  if (!numbers(s.answers) || !numbers(s.scores) || !numbers(s.gained)) return null
  if (!Array.isArray(s.order) || !s.order.every(isId)) return null
  if (!(s.correct === null || isInt(s.correct, 0, 3))) return null
  return { phase: s.phase!, master: s.master!, n: s.n!, total: s.total!, question: q, answers: s.answers!, order: s.order, correct: s.correct!, scores: s.scores!, gained: s.gained! }
}

/** Shuffles a copy (the quizmaster's app does this; the order then goes out in the messages). */
export function shuffled<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

/** A question with its options in a new order, and where the right one went. */
export function shuffleOptions(q: { text: string; options: string[]; correct: number }, random: () => number = Math.random) {
  const order = shuffled(q.options.map((_, i) => i), random)
  return { text: q.text, options: order.map((i) => q.options[i]), correct: order.indexOf(q.correct) }
}
