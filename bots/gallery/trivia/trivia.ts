// Trivia's rules, apart from the bot (bot.ts) so they're easy to test: the question bank, one question's answers, the
// weekly scoreboard and the cards. No points carry over between weeks: there are no levels, ranks or all-time tables.
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { Card, ComponentRow } from 'iskra-bots'

/** A question with answer buttons (`choices` and the index of the right one), or an open one answered by replying. */
export type Question =
  | { question: string; choices: string[]; answer: number; category?: string }
  | { question: string; answers: string[]; category?: string }

export const MAX_CHOICES = 5 // one row of buttons

/** Reads a question bank: a JSON array of questions. Broken entries are skipped and reported, so one typo doesn't stop the game. */
export function parseQuestions(json: string): { questions: Question[]; problems: string[] } {
  const questions: Question[] = []
  const problems: string[] = []
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch (e) {
    return { questions, problems: [`Not valid JSON: ${(e as Error).message}`] }
  }
  if (!Array.isArray(raw)) return { questions, problems: ['The file must be a JSON array of questions.'] }
  raw.forEach((q: Record<string, unknown>, i) => {
    const text = typeof q?.question === 'string' ? q.question.trim() : ''
    const category = typeof q?.category === 'string' ? q.category.slice(0, 40) : undefined
    if (!text || text.length > 300) return problems.push(`#${i + 1}: "question" must be 1-300 characters.`)
    if (Array.isArray(q.choices)) {
      const choices = q.choices.filter((c): c is string => typeof c === 'string' && c.trim().length > 0 && c.length <= 80)
      const answer = q.answer
      if (choices.length !== q.choices.length || choices.length < 2 || choices.length > MAX_CHOICES)
        return problems.push(`#${i + 1}: "choices" must be 2-${MAX_CHOICES} answers of 1-80 characters.`)
      if (typeof answer !== 'number' || !Number.isInteger(answer) || answer < 0 || answer >= choices.length)
        return problems.push(`#${i + 1}: "answer" must be the number of the right choice, counting from 0.`)
      questions.push({ question: text, choices, answer, category })
    } else if (Array.isArray(q.answers)) {
      const answers = q.answers.filter((a): a is string => typeof a === 'string' && normalize(a).length > 0)
      if (answers.length === 0) return problems.push(`#${i + 1}: "answers" needs at least one accepted answer.`)
      questions.push({ question: text, answers, category })
    } else {
      problems.push(`#${i + 1}: give either "choices" and "answer", or "answers".`)
    }
  })
  return { questions, problems }
}

export function loadQuestions(file: string): { questions: Question[]; problems: string[] } {
  return parseQuestions(readFileSync(file, 'utf8'))
}

/** `count` different questions in random order (fewer if the bank is smaller). */
export function pickQuestions(bank: Question[], count: number, random: () => number = Math.random): Question[] {
  const copy = [...bank]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy.slice(0, Math.max(0, count))
}

/** Lowercase, no accents, punctuation or leading "the/a/an", single spaces: "The Beatles!" and "beatles" match. */
export function normalize(text: string): string {
  return text
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/^(the|a|an) /, '')
}

export function isRight(q: Question, typed: string): boolean {
  if (!('answers' in q)) return false
  const t = normalize(typed)
  return t.length > 0 && q.answers.some((a) => normalize(a) === t)
}

/** One question being asked: who answered what. Everyone gets one try; answers count until it closes. */
export class Round {
  private readonly picks = new Map<string, { name: string; right: boolean }>()
  open = true
  readonly question: Question

  constructor(question: Question) {
    this.question = question
  }

  /** A button press (choice index). 'locked': counted; 'again': this person already answered; 'closed': too late. */
  choose(user: string, name: string, choice: number): 'locked' | 'again' | 'closed' {
    if (!this.open) return 'closed'
    if (this.picks.has(user)) return 'again'
    const q = this.question
    this.picks.set(user, { name, right: 'choices' in q && choice === q.answer })
    return 'locked'
  }

  /** A reply to an open question. 'right'/'wrong': counted (only the first try); 'again', 'closed' as for choose. */
  reply(user: string, name: string, text: string): 'right' | 'wrong' | 'again' | 'closed' {
    if (!this.open) return 'closed'
    if (this.picks.has(user)) return 'again'
    const right = isRight(this.question, text)
    this.picks.set(user, { name, right })
    return right ? 'right' : 'wrong'
  }

  /** Closes it: the people who got it right (account key and name), in the order they answered. */
  close(): { user: string; name: string }[] {
    this.open = false
    return [...this.picks].filter(([, p]) => p.right).map(([user, p]) => ({ user, name: p.name }))
  }

  get answered(): number {
    return this.picks.size
  }
}

/** "2026-W42": the ISO week of a date, in this computer's time zone (weeks start on Monday). */
export function weekKey(date: Date): string {
  // The local calendar date, counted in UTC so daylight saving can't shift it.
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7)) // the Thursday of this week decides the year
  const week = Math.ceil(((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

export interface WeekScores {
  week: string
  /** Where the results card goes: the channel of the last game. */
  channelId: number | null
  /** Account key → name and this week's points. Nothing else about anyone is kept. */
  scores: Record<string, { name: string; points: number }>
}

/** This week's points, kept in a small JSON file and emptied when the week's results are posted. */
export class Scoreboard {
  data: WeekScores
  private readonly file: string | null

  constructor(file: string | null, now: Date = new Date()) {
    this.file = file
    this.data = { week: weekKey(now), channelId: null, scores: {} }
    if (!file) return
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as WeekScores
      if (typeof saved?.week === 'string' && saved.scores && typeof saved.scores === 'object') this.data = saved
    } catch {
      /* first run */
    }
  }

  add(user: string, name: string, points: number, channelId: number): void {
    const entry = (this.data.scores[user] ??= { name, points: 0 })
    entry.name = name
    entry.points += points
    this.data.channelId = channelId
    this.save()
  }

  /** Highest first; ties share a place ("1, 2, 2, 4"). */
  standings(): { place: number; name: string; points: number }[] {
    const sorted = Object.values(this.data.scores).filter((s) => s.points > 0).sort((a, b) => b.points - a.points || a.name.localeCompare(b.name))
    return sorted.map((s) => ({ place: sorted.findIndex((o) => o.points === s.points) + 1, name: s.name, points: s.points }))
  }

  /**
   * A new week started: returns the finished week (to post its card), and starts the new one empty. Null while it's
   * still the same week. A finished week without points is dropped quietly.
   */
  rollover(now: Date = new Date()): WeekScores | null {
    const current = weekKey(now)
    if (current === this.data.week) return null
    const finished = this.data
    this.data = { week: current, channelId: finished.channelId, scores: {} }
    this.save()
    return Object.keys(finished.scores).length > 0 ? finished : null
  }

  private save(): void {
    if (!this.file) return
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data, null, 2))
    renameSync(`${this.file}.tmp`, this.file)
  }
}

const LETTERS = ['A', 'B', 'C', 'D', 'E']
const COLOR = 0xf5a524

/** The question card, with a button per choice (open questions: "reply to this message"). */
export function questionCard(q: Question, number: number, total: number, seconds: number): { text: string; cards: Card[]; components: ComponentRow[] } {
  const choices = 'choices' in q ? q.choices.map((c, i) => `**${LETTERS[i]}** ${c}`).join('\n') : null
  return {
    text: '',
    cards: [{
      title: `❓ Question ${number} of ${total}${q.category ? ` · ${q.category}` : ''}`,
      description: `${q.question}${choices ? `\n\n${choices}` : ''}`,
      color: COLOR,
      footer: { text: 'choices' in q ? `Pick an answer within ${seconds} seconds. One try each.` : `Reply to this message with your answer within ${seconds} seconds. One try each.` },
    }],
    components: 'choices' in q
      ? [{ type: 'row', items: q.choices.map((_, i) => ({ type: 'button' as const, customId: `trivia:${number}:${i}`, label: LETTERS[i], style: 'secondary' as const })) }]
      : [],
  }
}

/** The same card once it closed: the right answer and who got it (no buttons). */
export function revealCard(q: Question, number: number, total: number, winners: { name: string }[]): { text: string; cards: Card[]; components: ComponentRow[] } {
  const right = 'choices' in q ? `**${LETTERS[q.answer]}** ${q.choices[q.answer]}` : `**${q.answers[0]}**`
  const who = winners.length === 0 ? 'Nobody got it this time.' : `Right: ${listNames(winners.map((w) => w.name))} (+1 each)`
  return {
    text: '',
    cards: [{ title: `✅ Question ${number} of ${total}`, description: `${q.question}\n\nAnswer: ${right}\n${who}`, color: COLOR }],
    components: [],
  }
}

/** After a game: this game's points and the week so far. */
export function gameOverCard(game: Map<string, { name: string; points: number }>, week: { place: number; name: string; points: number }[]): Card {
  const thisGame = [...game.values()].filter((g) => g.points > 0).sort((a, b) => b.points - a.points).slice(0, 10)
  return {
    title: '🏁 Trivia over',
    description: thisGame.length ? thisGame.map((g) => `${g.name}: ${g.points}`).join('\n') : 'No points this game. Next time!',
    color: COLOR,
    fields: [{ name: 'This week so far', value: table(week), inline: false }],
    footer: { text: 'Points reset every Monday. /trivia start plays again.' },
  }
}

/** The weekly results card, posted once a week ends. */
export function weeklyCard(finished: WeekScores, standings: { place: number; name: string; points: number }[]): Card {
  return {
    title: `🏆 Trivia: week ${finished.week.slice(-2).replace(/^0/, '')} results`,
    description: table(standings),
    color: COLOR,
    footer: { text: 'A new week starts now, everyone at 0. /trivia start to play.' },
  }
}

function table(rows: { place: number; name: string; points: number }[]): string {
  if (rows.length === 0) return 'No points yet.'
  const medal = (place: number) => ['🥇', '🥈', '🥉'][place - 1] ?? `${place}.`
  const shown = rows.slice(0, 10).map((r) => `${medal(r.place)} ${r.name}: ${r.points}`)
  if (rows.length > 10) shown.push(`…and ${rows.length - 10} more`)
  return shown.join('\n')
}

function listNames(names: string[]): string {
  if (names.length <= 1) return names.join('')
  const shown = names.slice(0, 8)
  const rest = names.length - shown.length
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`
}
