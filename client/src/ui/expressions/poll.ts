// Poll results maths and wording, kept apart from the UI so it can be tested.
import type { Poll } from '../../core/protocol'

export const POLL_DURATIONS: { label: string; ms: number | null }[] = [
  { label: '1 hour', ms: 3_600_000 },
  { label: '4 hours', ms: 4 * 3_600_000 },
  { label: '8 hours', ms: 8 * 3_600_000 },
  { label: '24 hours', ms: 24 * 3_600_000 },
  { label: '3 days', ms: 3 * 86_400_000 },
  { label: '1 week', ms: 7 * 86_400_000 },
  { label: 'No end', ms: null },
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
  if (ms < 60_000) return 'less than a minute left'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m left`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h left`
  return `${Math.floor(ms / 86_400_000)}d left`
}

/** Checks a poll before sending it; returns the problem, or null. */
export function pollProblem(question: string, options: string[]): string | null {
  const q = question.trim()
  const answers = options.map((o) => o.trim()).filter(Boolean)
  if (!q) return 'Ask a question.'
  if (q.length > POLL_LIMITS.question) return `Questions can be up to ${POLL_LIMITS.question} characters.`
  if (answers.length < POLL_LIMITS.minOptions) return 'Add at least two answers.'
  if (answers.some((a) => a.length > POLL_LIMITS.option)) return `Answers can be up to ${POLL_LIMITS.option} characters.`
  if (new Set(answers.map((a) => a.toLowerCase())).size !== answers.length) return 'Answers must be different from each other.'
  return null
}
