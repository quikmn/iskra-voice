// Draw & guess: players take turns drawing a word while the others guess it. The drawer's app knows the word; the
// others get its shape ("_ _ _") and a salted hash, so each guesser's own app can tell a right guess and say only
// "got it" (wrong guesses show for everyone). The hash keeps the word out of sight; it isn't a secret from a cheater
// who reads the code, which is fine among friends.
import { fnv1a, isId, isInt, isObject, isText, normalizeGuess } from '../util'

/** Drawing coordinates are whole numbers on a 1000 × 750 board. */
export const WIDTH = 1000
export const HEIGHT = 750
export const COLORS = ['#111827', '#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#ec4899', '#ffffff'] as const
export const SIZES = [4, 10, 24] as const
/** Points per round (keeps a snapshot well under the 48 KB limit), and per stroke message. */
export const MAX_POINTS = 3000
export const MAX_STROKE_POINTS = 200
export const MAX_GUESS = 60
export const ROUND_SECONDS = 80
const MAX_SHOWN_GUESSES = 30

export interface Stroke {
  /** Which pointer-down it belongs to (undo removes a whole one). */
  g: number
  c: number
  w: number
  /** x0, y0, x1, y1, … */
  p: number[]
}

export interface DrawState {
  phase: 'lobby' | 'picking' | 'drawing' | 'between' | 'over'
  /** Who's playing, in the order they draw. */
  roster: string[]
  /** Index into the roster of who draws this round. */
  drawer: number
  round: number
  rounds: number
  /** The word's shape (letters as "_"), and its hash with the salt. */
  mask: string
  hash: string
  salt: string
  strokes: Stroke[]
  points: number
  /** Who guessed it this round, in order. */
  guessed: string[]
  guesses: { from: string; text: string }[]
  scores: Record<string, number>
  /** The word, once the round is over. */
  word: string | null
}

export const initialDraw = (): DrawState => ({
  phase: 'lobby', roster: [], drawer: 0, round: 0, rounds: 0, mask: '', hash: '', salt: '', strokes: [], points: 0,
  guessed: [], guesses: [], scores: {}, word: null,
})

/** Who draws now (null if nobody). */
export const drawerOf = (state: DrawState): string | null => (state.roster.length ? state.roster[state.drawer % state.roster.length] : null)

/** The word's shape: each letter a "_", spaces and dashes kept. */
export const maskOf = (word: string): string => [...word].map((c) => (/[\s-]/.test(c) ? c : '_')).join('')

export const hashOf = (salt: string, word: string): string => fnv1a(`${salt}|${normalizeGuess(word)}`)

/** Whether a guess is the word (checked on the guesser's own device). */
export const isRight = (state: DrawState, guess: string): boolean => !!state.hash && hashOf(state.salt, guess) === state.hash

/** Points for the n-th right guess (0-based), and what the drawer gets for each. */
export const guessPoints = (rank: number) => Math.max(40, 100 - rank * 15)
export const DRAWER_POINTS = 25

function stroke(data: Record<string, unknown>): Stroke | null {
  const { g, c, w, p } = data
  if (!isInt(g, 0, 1_000_000) || !isInt(c, 0, COLORS.length - 1) || !isInt(w, 0, SIZES.length - 1)) return null
  if (!Array.isArray(p) || p.length < 2 || p.length > MAX_STROKE_POINTS * 2 || p.length % 2) return null
  for (let i = 0; i < p.length; i += 2) if (!isInt(p[i], 0, WIDTH) || !isInt(p[i + 1], 0, HEIGHT)) return null
  return { g, c, w, p: p as number[] }
}

function nextRound(state: DrawState): DrawState {
  if (state.round >= state.rounds || state.roster.length < 2) return { ...state, phase: 'over', strokes: [], points: 0, mask: '', hash: '', salt: '' }
  return {
    ...state, phase: 'picking', round: state.round + 1, drawer: (state.drawer + 1) % state.roster.length,
    strokes: [], points: 0, guessed: [], guesses: [], mask: '', hash: '', salt: '', word: null,
  }
}

export function reduceDraw(state: DrawState, data: unknown, from: string): DrawState {
  if (!isObject(data)) return state
  const drawer = drawerOf(state)
  const isDrawer = drawer === from
  switch (data.t) {
    case 'join':
      return state.roster.includes(from) || state.roster.length >= 25 ? state : { ...state, roster: [...state.roster, from] }
    case 'leave': {
      const at = state.roster.indexOf(from)
      if (at < 0) return state
      const roster = state.roster.filter((id) => id !== from)
      // Keep the same drawer (if it was them, the next round goes to whoever was after them).
      const index = at <= state.drawer % state.roster.length ? state.drawer - 1 : state.drawer
      const left = { ...state, roster, drawer: roster.length ? ((index % roster.length) + roster.length) % roster.length : 0 }
      if (state.phase === 'lobby' || state.phase === 'over') return left
      if (roster.length < 2) return { ...left, phase: 'over', word: null }
      return isDrawer ? { ...left, phase: 'between', word: null } : left
    }
    case 'start':
      if ((state.phase !== 'lobby' && state.phase !== 'over') || !state.roster.includes(from) || state.roster.length < 2) return state
      return { ...initialDraw(), roster: state.roster, phase: 'picking', round: 1, rounds: state.roster.length, drawer: 0 }
    case 'pick': {
      const { mask, hash, salt } = data
      if (!isDrawer || state.phase !== 'picking' || !isText(mask, 40) || !/^[_\s-]+$/.test(mask)) return state
      if (typeof hash !== 'string' || !/^[0-9a-f]{8}$/.test(hash) || typeof salt !== 'string' || !/^[0-9a-z]{4,16}$/.test(salt)) return state
      return { ...state, phase: 'drawing', mask, hash, salt, strokes: [], points: 0, guessed: [], guesses: [] }
    }
    case 's': {
      const s = stroke(data)
      if (!isDrawer || state.phase !== 'drawing' || !s || state.points + s.p.length / 2 > MAX_POINTS) return state
      return { ...state, strokes: [...state.strokes, s], points: state.points + s.p.length / 2 }
    }
    case 'undo': {
      if (!isDrawer || state.phase !== 'drawing' || !state.strokes.length) return state
      const g = state.strokes[state.strokes.length - 1].g
      const strokes = state.strokes.filter((s) => s.g !== g)
      return { ...state, strokes, points: strokes.reduce((n, s) => n + s.p.length / 2, 0) }
    }
    case 'clear':
      return isDrawer && state.phase === 'drawing' ? { ...state, strokes: [], points: 0 } : state
    case 'g': {
      if (state.phase !== 'drawing' || isDrawer || !state.roster.includes(from) || state.guessed.includes(from) || !isText(data.text, MAX_GUESS)) return state
      return { ...state, guesses: [...state.guesses, { from, text: data.text.trim() }].slice(-MAX_SHOWN_GUESSES) }
    }
    case 'got': {
      if (state.phase !== 'drawing' || isDrawer || !state.roster.includes(from) || state.guessed.includes(from) || !drawer) return state
      const scores = { ...state.scores }
      scores[from] = (scores[from] ?? 0) + guessPoints(state.guessed.length)
      scores[drawer] = (scores[drawer] ?? 0) + DRAWER_POINTS
      return { ...state, guessed: [...state.guessed, from], scores }
    }
    case 'end': {
      // The drawer's app ends the round (time's up, or everyone got it) and says the word.
      if (!isDrawer || (state.phase !== 'drawing' && state.phase !== 'picking')) return state
      const word = typeof data.word === 'string' && data.word.length <= 40 ? data.word : null
      return { ...state, phase: 'between', word }
    }
    case 'skip':
      // Anyone, when the drawer left the activity (the app only offers it then).
      return state.phase === 'drawing' || state.phase === 'picking' ? { ...state, phase: 'between', word: null } : state
    case 'next':
      return state.phase === 'between' && state.roster.includes(from) ? nextRound(state) : state
    default:
      return state
  }
}

export function parseDraw(raw: unknown): DrawState | null {
  if (!isObject(raw)) return null
  const s = raw as Partial<DrawState>
  if (!['lobby', 'picking', 'drawing', 'between', 'over'].includes(s.phase as string)) return null
  if (!Array.isArray(s.roster) || !s.roster.every(isId) || s.roster.length > 25) return null
  if (!isInt(s.drawer, 0, 24) || !isInt(s.round, 0, 25) || !isInt(s.rounds, 0, 25) || !isInt(s.points, 0, MAX_POINTS)) return null
  if (typeof s.mask !== 'string' || s.mask.length > 40 || typeof s.hash !== 'string' || s.hash.length > 8 || typeof s.salt !== 'string' || s.salt.length > 16) return null
  if (!Array.isArray(s.strokes) || !s.strokes.every((st) => isObject(st) && stroke(st) !== null)) return null
  if (!Array.isArray(s.guessed) || !s.guessed.every(isId)) return null
  if (!Array.isArray(s.guesses) || !s.guesses.every((g) => isObject(g) && isId(g.from) && isText(g.text, MAX_GUESS))) return null
  if (!isObject(s.scores) || !Object.entries(s.scores).every(([k, v]) => isId(k) && typeof v === 'number' && Number.isFinite(v))) return null
  if (!(s.word === null || (typeof s.word === 'string' && s.word.length <= 40))) return null
  return s as DrawState
}
