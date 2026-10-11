// Poll results maths and wording, kept apart from the UI so it can be tested.
import type { Poll } from '../../core/protocol'
import { t } from '../../i18n'

/** Labels are keys under expressions.poll.durations. */
export const POLL_DURATIONS: { id: 'h1' | 'h4' | 'h8' | 'h24' | 'd3' | 'w1' | 'none'; ms: number | null }[] = [
  { id: 'h1', ms: 3_600_000 },
  { id: 'h4', ms: 4 * 3_600_000 },
  { id: 'h8', ms: 8 * 3_600_000 },
  { id: 'h24', ms: 24 * 3_600_000 },
  { id: 'd3', ms: 3 * 86_400_000 },
  { id: 'w1', ms: 7 * 86_400_000 },
  { id: 'none', ms: null },
]

export const POLL_LIMITS = { question: 300, option: 55, minOptions: 2, maxOptions: 10 }

export function isPollClosed(poll: Poll, now: number): boolean {
  return poll.closedAt !== null || (poll.expiresAt !== null && now >= poll.expiresAt)
}

export interface PollResults {
  /** People who voted (each counted once, even with several answers). */
  voters: number
  counts: number[]
  /** Share of voters who picked each answer, 0–100, rounded. */
  percents: number[]
  /** Answers with the most votes (none if nobody voted). */
  leaders: number[]
}

export function pollResults(poll: Poll): PollResults {
  const counts = poll.options.map((o) => o.votes.length)
  const voters = new Set(poll.options.flatMap((o) => o.votes)).size
  const percents = counts.map((c) => (voters ? Math.round((c / voters) * 100) : 0))
  const top = Math.max(0, ...counts)
  const leaders = top > 0 ? counts.flatMap((c, i) => (c === top ? [i] : [])) : []
  return { voters, counts, percents, leaders }
}

export function myVotes(poll: Poll, me: string | undefined): number[] {
  if (!me) return []
  return poll.options.flatMap((o, i) => (o.votes.includes(me) ? [i] : []))
}

/** "45m left", "3h left", "2d left". */
export function timeLeft(ms: number): string {
  if (ms < 60_000) return t('expressions.poll.lessThanMinute')
  if (ms < 3_600_000) return t('expressions.poll.minutesLeft', { count: Math.floor(ms / 60_000) })
  if (ms < 86_400_000) return t('expressions.poll.hoursLeft', { count: Math.floor(ms / 3_600_000) })
  return t('expressions.poll.daysLeft', { count: Math.floor(ms / 86_400_000) })
}

/** Checks a poll before sending it; returns the problem, or null. */
export function pollProblem(question: string, options: string[]): string | null {
  const q = question.trim()
  const answers = options.map((o) => o.trim()).filter(Boolean)
  if (!q) return t('expressions.poll.askQuestion')
  if (q.length > POLL_LIMITS.question) return t('expressions.poll.questionTooLong', { max: POLL_LIMITS.question })
  if (answers.length < POLL_LIMITS.minOptions) return t('expressions.poll.twoAnswers')
  if (answers.some((a) => a.length > POLL_LIMITS.option)) return t('expressions.poll.answerTooLong', { max: POLL_LIMITS.option })
  if (new Set(answers.map((a) => a.toLowerCase())).size !== answers.length) return t('expressions.poll.different')
  return null
}
