// The built-in activities' rules: every player applies the same messages in the same order and must end up in the same
// state, and nothing a player sends out of turn (or malformed) changes anything.
import { describe, expect, it } from 'vitest'
import { COLS, initialFour, landingRow, parseFour, reduceFour, winningLine, type FourState } from './four/logic'
import { BONUS, initialQuiz, parseQuiz, POINTS, ranking, reduceQuiz, shuffleOptions, type QuizState } from './trivia/logic'
import {
  DRAWER_POINTS, drawerOf, guessPoints, hashOf, initialDraw, isRight, maskOf, MAX_POINTS, parseDraw, reduceDraw, type DrawState,
} from './draw/logic'
import { threeWords, WORDS } from './draw/words'
import { QUESTIONS } from './trivia/questions'
import { fmt, fnv1a, normalizeGuess } from './util'
import { en } from '../i18n/en'
import { sv } from '../i18n/sv'

function play<S>(reduce: (s: S, d: unknown, from: string) => S, state: S, moves: [string, unknown][]): S {
  return moves.reduce((s, [from, data]) => reduce(s, data, from), state)
}

describe('four in a row', () => {
  const seated = (): FourState => play(reduceFour, initialFour(), [['a', { t: 'sit', seat: 0 }], ['b', { t: 'sit', seat: 1 }]])

  it('takes turns and finds four in a row', () => {
    let s = seated()
    expect(s.seats).toEqual(['a', 'b'])
    s = reduceFour(s, { t: 'drop', col: 0 }, 'b') // not b's turn
    expect(s.moves).toBe(0)
    // a builds a column at 0, b plays at 1.
    s = play(reduceFour, s, [['a', { t: 'drop', col: 0 }], ['b', { t: 'drop', col: 1 }], ['a', { t: 'drop', col: 0 }], ['b', { t: 'drop', col: 1 }],
      ['a', { t: 'drop', col: 0 }], ['b', { t: 'drop', col: 1 }]])
    expect(s.result).toBe(0)
    s = reduceFour(s, { t: 'drop', col: 0 }, 'a')
    expect(s.result).toBe(1)
    expect(s.line).toHaveLength(4)
    expect(reduceFour(s, { t: 'drop', col: 3 }, 'b')).toBe(s) // over
    // Again: the other seat starts.
    const again = reduceFour(s, { t: 'again' }, 'b')
    expect(again.board.every((c) => c === 0)).toBe(true)
    expect(again.turn).toBe(1)
  })

  it('finds diagonals and full columns', () => {
    const board = Array(42).fill(0)
    // A rising diagonal for player 2, from the bottom-left.
    for (let i = 0; i < 4; i++) board[(5 - i) * COLS + i] = 2
    expect(winningLine(board, 5 * COLS)).toHaveLength(4)
    expect(winningLine(board, 3 * COLS + 2).length).toBe(4)
    const full = Array(42).fill(0).map((_, i) => (i % COLS === 3 ? 1 : 0))
    expect(landingRow(full, 3)).toBe(-1)
  })

  it('ignores bad seats, moves and strangers', () => {
    const s = seated()
    expect(reduceFour(s, { t: 'sit', seat: 1 }, 'c')).toBe(s) // taken
    expect(reduceFour(s, { t: 'drop', col: 7 }, 'a')).toBe(s)
    expect(reduceFour(s, { t: 'drop', col: '1' }, 'a')).toBe(s)
    expect(reduceFour(s, { t: 'drop', col: 1 }, 'c')).toBe(s)
    expect(reduceFour(s, 'drop', 'a')).toBe(s)
    expect(reduceFour(s, { t: 'again' }, 'c')).toBe(s)
    const freed = reduceFour(s, { t: 'free', seat: 1 }, 'c')
    expect(freed.seats).toEqual(['a', null])
    expect(reduceFour(freed, { t: 'sit', seat: 1 }, 'c').seats).toEqual(['a', 'c'])
  })

  it('checks snapshots', () => {
    const s = seated()
    expect(parseFour(JSON.parse(JSON.stringify(s)))).toEqual(s)
    expect(parseFour({ ...s, board: [1, 2, 3] })).toBeNull()
    expect(parseFour({ ...s, seats: ['a'] })).toBeNull()
    expect(parseFour({ ...s, turn: 2 })).toBeNull()
    expect(parseFour('x')).toBeNull()
  })
})

describe('quiz', () => {
  const q = (n: number, total = 2) => ({ t: 'q', n, total, text: `Question ${n}?`, options: ['Yes', 'No', 'Maybe'] })

  it('scores right answers, faster ones more', () => {
    let s: QuizState = play(reduceQuiz, initialQuiz(), [['m', { t: 'host' }], ['x', { t: 'host' }], ['m', q(1)]])
    expect(s.master).toBe('m')
    expect(s.phase).toBe('question')
    s = play(reduceQuiz, s, [['b', { t: 'a', n: 1, choice: 1 }], ['c', { t: 'a', n: 1, choice: 1 }], ['d', { t: 'a', n: 1, choice: 0 }],
      ['b', { t: 'a', n: 1, choice: 0 }], ['m', { t: 'a', n: 1, choice: 1 }], ['e', { t: 'a', n: 2, choice: 1 }], ['f', { t: 'a', n: 1, choice: 9 }]])
    expect(s.order).toEqual(['b', 'c', 'd'])
    expect(s.answers.b).toBe(1) // the first answer counts
    expect(reduceQuiz(s, { t: 'reveal', n: 1, correct: 1 }, 'b')).toBe(s) // only the quizmaster reveals
    s = reduceQuiz(s, { t: 'reveal', n: 1, correct: 1 }, 'm')
    expect(s.scores).toEqual({ b: POINTS + BONUS[0], c: POINTS + BONUS[1], d: 0 })
    expect(reduceQuiz(s, { t: 'a', n: 1, choice: 1 }, 'e')).toBe(s) // too late

    // Questions go in order; then the results.
    expect(reduceQuiz(s, q(1), 'm')).toBe(s)
    s = play(reduceQuiz, s, [['m', q(2)], ['d', { t: 'a', n: 2, choice: 2 }], ['m', { t: 'reveal', n: 2, correct: 2 }], ['m', { t: 'over' }]])
    expect(s.phase).toBe('over')
    expect(ranking(s.scores).map((r) => r.id)).toEqual(['b', 'd', 'c'])
    expect(s.scores.d).toBe(POINTS + BONUS[0])
    // A new quiz starts from nothing.
    s = play(reduceQuiz, s, [['m', { t: 'reset' }], ['m', q(1, 1)]])
    expect(s.scores).toEqual({})
  })

  it('refuses bad questions and lets someone take over', () => {
    const s = reduceQuiz(initialQuiz(), { t: 'host' }, 'm')
    expect(reduceQuiz(s, { ...q(1), options: ['only one'] }, 'm')).toBe(s)
    expect(reduceQuiz(s, { ...q(1), text: 'x'.repeat(301) }, 'm')).toBe(s)
    expect(reduceQuiz(s, { ...q(1), options: ['a', 'b', 'c', 'd', 'e'] }, 'm')).toBe(s)
    expect(reduceQuiz(s, q(2), 'm')).toBe(s) // starts at 1
    expect(reduceQuiz(s, q(1), 'x')).toBe(s)
    expect(reduceQuiz(s, { t: 'takeover' }, 'x').master).toBe('x')
    expect(reduceQuiz(s, { t: 'resign' }, 'm').master).toBeNull()
  })

  it('shuffles options and keeps track of the right one', () => {
    let i = 0
    const random = () => [0.9, 0.1, 0.5][i++ % 3]
    const shuffledQ = shuffleOptions({ text: 'q', options: ['right', 'b', 'c', 'd'], correct: 0 }, random)
    expect(shuffledQ.options[shuffledQ.correct]).toBe('right')
    expect([...shuffledQ.options].sort()).toEqual(['b', 'c', 'd', 'right'])
  })

  it('checks snapshots', () => {
    const s = play(reduceQuiz, initialQuiz(), [['m', { t: 'host' }], ['m', q(1)], ['b', { t: 'a', n: 1, choice: 2 }]])
    expect(parseQuiz(JSON.parse(JSON.stringify(s)))).toEqual(s)
    expect(parseQuiz({ ...s, phase: 'party' })).toBeNull()
    expect(parseQuiz({ ...s, scores: { b: 'lots' } })).toBeNull()
  })

  it('has bundled questions in both languages, each with its right answer among 2–4 options', () => {
    for (const list of [QUESTIONS.en, QUESTIONS.sv]) {
      expect(list.length).toBeGreaterThanOrEqual(20)
      for (const item of list) {
        expect(item.options.length).toBeGreaterThanOrEqual(2)
        expect(item.options.length).toBeLessThanOrEqual(4)
        expect(item.options[item.correct]).toBeTruthy()
        expect(item.text.length).toBeLessThanOrEqual(300)
      }
    }
    expect(QUESTIONS.sv).toHaveLength(QUESTIONS.en.length)
  })
})

describe('draw & guess', () => {
  const salt = 'abcd1234'
  const lobby = (): DrawState => play(reduceDraw, initialDraw(), [['a', { t: 'join' }], ['b', { t: 'join' }], ['c', { t: 'join' }], ['a', { t: 'join' }]])
  const pick = (word: string) => ({ t: 'pick', mask: maskOf(word), hash: hashOf(salt, word), salt })

  it('runs a round: pick, draw, guess, score, next', () => {
    let s = lobby()
    expect(s.roster).toEqual(['a', 'b', 'c'])
    s = reduceDraw(s, { t: 'start' }, 'a')
    expect(s.phase).toBe('picking')
    expect(drawerOf(s)).toBe('a')
    expect(reduceDraw(s, pick('ice cream'), 'b')).toBe(s) // not the drawer
    s = reduceDraw(s, pick('ice cream'), 'a')
    expect(s.mask).toBe('___ _____')
    s = reduceDraw(s, { t: 's', g: 1, c: 0, w: 1, p: [10, 10, 20, 20, 30, 40] }, 'a')
    expect(s.strokes).toHaveLength(1)
    expect(reduceDraw(s, { t: 's', g: 1, c: 0, w: 1, p: [10, 10] }, 'b')).toBe(s) // only the drawer draws

    // A guesser's own app checks a guess against the hash.
    expect(isRight(s, '  Ice   CREAM ')).toBe(true)
    expect(isRight(s, 'ice-cream')).toBe(false)
    s = reduceDraw(s, { t: 'g', text: 'cake' }, 'b')
    s = reduceDraw(s, { t: 'got' }, 'c')
    s = reduceDraw(s, { t: 'got' }, 'c') // only once
    s = reduceDraw(s, { t: 'got' }, 'b')
    expect(s.guessed).toEqual(['c', 'b'])
    expect(s.scores).toEqual({ c: guessPoints(0), b: guessPoints(1), a: DRAWER_POINTS * 2 })
    expect(s.guesses).toEqual([{ from: 'b', text: 'cake' }])

    s = reduceDraw(s, { t: 'end', word: 'ice cream' }, 'a')
    expect(s.phase).toBe('between')
    expect(s.word).toBe('ice cream')
    s = reduceDraw(s, { t: 'next' }, 'a')
    s = reduceDraw(s, { t: 'next' }, 'b') // a second "next" changes nothing
    expect(s.phase).toBe('picking')
    expect(s.round).toBe(2)
    expect(drawerOf(s)).toBe('b')
    expect(s.strokes).toEqual([])
  })

  it('ends after everyone has drawn, and copes with people leaving', () => {
    let s = reduceDraw(lobby(), { t: 'start' }, 'a')
    for (let round = 0; round < 3; round++) {
      s = reduceDraw(s, { t: 'end', word: null }, drawerOf(s)!)
      s = reduceDraw(s, { t: 'next' }, 'a')
    }
    expect(s.phase).toBe('over')

    // The drawer leaves mid-round: the round ends, and the next one goes to whoever was after them.
    s = play(reduceDraw, reduceDraw(lobby(), { t: 'start' }, 'a'), [['a', pick('cat')], ['a', { t: 'leave' }]])
    expect(s.phase).toBe('between')
    s = reduceDraw(s, { t: 'next' }, 'b')
    expect(drawerOf(s)).toBe('b')
    // Down to one player: game over.
    expect(reduceDraw(s, { t: 'leave' }, 'c').phase).toBe('over')
  })

  it('caps the ink and checks every stroke', () => {
    let s = play(reduceDraw, reduceDraw(lobby(), { t: 'start' }, 'a'), [['a', pick('cat')]])
    const big = Array.from({ length: 400 }, (_, i) => i % 700)
    for (let i = 0; i < MAX_POINTS / 200 + 2; i++) s = reduceDraw(s, { t: 's', g: i, c: 1, w: 0, p: big }, 'a')
    expect(s.points).toBeLessThanOrEqual(MAX_POINTS)
    for (const bad of [{ p: [1] }, { p: [1, 2, 3] }, { p: [-1, 0] }, { p: [1001, 0] }, { c: 99, p: [1, 1] }, { p: Array(402).fill(1) }]) {
      expect(reduceDraw(s, { t: 's', g: 0, c: 0, w: 0, ...bad }, 'a')).toBe(s)
    }
    const undone = reduceDraw(s, { t: 'undo' }, 'a')
    expect(undone.strokes.length).toBe(s.strokes.length - 1)
    expect(reduceDraw(s, { t: 'clear' }, 'a').strokes).toEqual([])
  })

  it('checks snapshots and picks', () => {
    const s = play(reduceDraw, reduceDraw(lobby(), { t: 'start' }, 'a'), [['a', pick('cat')], ['a', { t: 's', g: 1, c: 2, w: 2, p: [1, 1, 2, 2] }]])
    expect(parseDraw(JSON.parse(JSON.stringify(s)))).toEqual(s)
    expect(parseDraw({ ...s, strokes: [{ g: 1, c: 2, w: 2, p: [1] }] })).toBeNull()
    expect(parseDraw({ ...s, phase: 'x' })).toBeNull()
    const picking = reduceDraw(lobby(), { t: 'start' }, 'a')
    expect(reduceDraw(picking, { t: 'pick', mask: 'cat', hash: 'abcdef12', salt }, 'a')).toBe(picking) // a mask shows no letters
    expect(reduceDraw(picking, { t: 'pick', mask: '___', hash: 'nothex!!', salt }, 'a')).toBe(picking)
  })

  it('offers three different words in both languages', () => {
    for (const list of [WORDS.en, WORDS.sv]) {
      expect(new Set(threeWords(list)).size).toBe(3)
      expect(list.length).toBeGreaterThan(80)
      for (const word of list) expect(word.length).toBeLessThanOrEqual(40)
    }
  })
})

describe('shared helpers', () => {
  it('fill in values and compare guesses loosely', () => {
    expect(fmt('{{name}} wins {{n}}', { name: 'Ann', n: 2 })).toBe('Ann wins 2')
    expect(normalizeGuess('  Smörgås̈ ')).toBe('smörgås̈')
    expect(normalizeGuess('ÄPPLE')).toBe('äpple')
    expect(fnv1a('')).toBe('811c9dc5')
    expect(fnv1a('a')).toBe('e40c292c')
  })

  it('have the games’ texts in both languages', () => {
    expect(Object.keys(sv.activities.games.draw).sort()).toEqual(Object.keys(en.activities.games.draw).sort())
  })
})
