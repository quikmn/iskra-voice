// Trivia's rules: the question bank, answers, the weekly scoreboard and the cards. Run: npm test (in bots/, or in a copy of this folder).
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import bundled from './questions.json' with { type: 'json' }
import { gameOverCard, isRight, normalize, parseQuestions, pickQuestions, questionCard, revealCard, Round, Scoreboard, weekKey, weeklyCard } from './trivia.ts'

const dir = mkdtempSync(join(tmpdir(), 'trivia-test-'))
after(() => rmSync(dir, { recursive: true, force: true }))

describe('the question bank', () => {
  it('the bundled questions are all valid', () => {
    const { questions, problems } = parseQuestions(JSON.stringify(bundled))
    assert.deepEqual(problems, [])
    assert.ok(questions.length >= 30)
  })

  it('skips broken entries and says why', () => {
    const { questions, problems } = parseQuestions(JSON.stringify([
      { question: 'Ok?', choices: ['Yes', 'No'], answer: 0 },
      { question: 'Out of range', choices: ['a', 'b'], answer: 2 },
      { question: 'One choice', choices: ['a'], answer: 0 },
      { question: 'Open', answers: ['Yes'] },
      { question: 'Nothing to answer' },
      { question: '' },
    ]))
    assert.equal(questions.length, 2)
    assert.equal(problems.length, 4)
    assert.match(problems[0], /^#2: "answer"/)
  })

  it('refuses something that is not a list', () => {
    assert.equal(parseQuestions('{').problems.length, 1)
    assert.match(parseQuestions('{}').problems[0], /array/)
  })

  it('picks different questions, at most as many as there are', () => {
    const bank = parseQuestions(JSON.stringify(bundled)).questions
    const five = pickQuestions(bank, 5, () => 0.3)
    assert.equal(new Set(five.map((q) => q.question)).size, 5)
    assert.equal(pickQuestions(bank.slice(0, 3), 10).length, 3)
  })
})

describe('answers', () => {
  it('ignores case, accents, punctuation and a leading article', () => {
    assert.equal(normalize('  The Beatles! '), 'beatles')
    assert.equal(normalize('Ångström'), 'angstrom')
    assert.ok(isRight({ question: 'q', answers: ['Vatican City'] }, 'vatican-city'))
    assert.ok(!isRight({ question: 'q', answers: ['Mars'] }, ''))
    assert.ok(!isRight({ question: 'q', choices: ['a', 'b'], answer: 0 }, 'a'))
  })

  it('counts one try per person, and nothing after it closed', () => {
    const round = new Round({ question: 'q', choices: ['a', 'b', 'c'], answer: 2 })
    assert.equal(round.choose('A', 'Ann', 2), 'locked')
    assert.equal(round.choose('A', 'Ann', 1), 'again')
    assert.equal(round.choose('B', 'Bo', 0), 'locked')
    assert.equal(round.choose('C', 'Cy', 2), 'locked')
    assert.deepEqual(round.close(), [{ user: 'A', name: 'Ann' }, { user: 'C', name: 'Cy' }])
    assert.equal(round.choose('D', 'Di', 2), 'closed')
    assert.equal(round.answered, 3)
  })

  it('open questions take replies', () => {
    const round = new Round({ question: 'q', answers: ['Mars'] })
    assert.equal(round.reply('A', 'Ann', 'Venus'), 'wrong')
    assert.equal(round.reply('A', 'Ann', 'Mars'), 'again') // no second try
    assert.equal(round.reply('B', 'Bo', 'mars.'), 'right')
    assert.deepEqual(round.close().map((w) => w.name), ['Bo'])
  })
})

describe('weeks', () => {
  it('names ISO weeks, starting on Monday', () => {
    assert.equal(weekKey(new Date(2026, 9, 12)), '2026-W42') // Monday
    assert.equal(weekKey(new Date(2026, 9, 18, 23, 59)), '2026-W42') // Sunday night
    assert.equal(weekKey(new Date(2026, 9, 19)), '2026-W43')
    assert.equal(weekKey(new Date(2027, 0, 1)), '2026-W53') // a Friday: still the last week of 2026
    assert.equal(weekKey(new Date(2024, 11, 30)), '2025-W01')
  })

  it('keeps this week\'s points, saves them, and starts over when a new week begins', () => {
    const file = join(dir, 'scores.json')
    const monday = new Date(2026, 9, 12, 10)
    const board = new Scoreboard(file, monday)
    board.add('A', 'Ann', 1, 7)
    board.add('B', 'Bo', 1, 7)
    board.add('A', 'Ann', 1, 7)
    board.add('C', 'Cy', 1, 7)
    assert.deepEqual(board.standings(), [{ place: 1, name: 'Ann', points: 2 }, { place: 2, name: 'Bo', points: 1 }, { place: 2, name: 'Cy', points: 1 }])
    assert.deepEqual(new Scoreboard(file, monday).standings(), board.standings()) // read back after a restart
    assert.equal(board.rollover(new Date(2026, 9, 18)), null) // same week

    const finished = board.rollover(new Date(2026, 9, 19, 0, 5))
    assert.equal(finished?.week, '2026-W42')
    assert.equal(finished?.channelId, 7)
    assert.deepEqual(board.standings(), [])
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepEqual(saved, { week: '2026-W43', channelId: 7, scores: {} }) // last week's names are gone from disk
    assert.equal(board.rollover(new Date(2026, 9, 26)), null) // an empty week has no results card
  })
})

describe('cards', () => {
  it('a choice question has a button per choice, tagged with the question number', () => {
    const card = questionCard({ question: 'Pick', choices: ['x', 'y', 'z'], answer: 1, category: 'Fun' }, 2, 5, 20)
    assert.equal(card.cards[0].title, '❓ Question 2 of 5 · Fun')
    assert.deepEqual(card.components[0].items.map((b) => b.type === 'button' && b.customId), ['trivia:2:0', 'trivia:2:1', 'trivia:2:2'])
    assert.deepEqual(questionCard({ question: 'Open', answers: ['a'] }, 1, 1, 20).components, [])
  })

  it('the reveal names the answer and who got it', () => {
    const card = revealCard({ question: 'Pick', choices: ['x', 'y'], answer: 1 }, 1, 1, [{ name: 'Ann' }, { name: 'Bo' }])
    assert.match(card.cards[0].description ?? '', /\*\*B\*\* y/)
    assert.match(card.cards[0].description ?? '', /Ann and Bo/)
    assert.match(revealCard({ question: 'Open', answers: ['Mars'] }, 1, 1, []).cards[0].description ?? '', /Nobody/)
  })

  it('game over and weekly results show places', () => {
    const game = new Map([['A', { name: 'Ann', points: 3 }], ['B', { name: 'Bo', points: 0 }]])
    const over = gameOverCard(game, [{ place: 1, name: 'Ann', points: 5 }])
    assert.equal(over.description, 'Ann: 3')
    assert.equal(over.fields?.[0].value, '🥇 Ann: 5')
    const weekly = weeklyCard({ week: '2026-W07', channelId: 1, scores: {} }, [{ place: 1, name: 'Ann', points: 5 }, { place: 2, name: 'Bo', points: 2 }])
    assert.equal(weekly.title, '🏆 Trivia: week 7 results')
  })
})
