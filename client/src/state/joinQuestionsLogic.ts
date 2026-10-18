// Join questions as a member answers them (pure; tested in joinQuestionsLogic.test.ts). The server decides which roles
// an answer gives; this only works out what to show and when to ask.
import type { JoinAnswer, RoleGroup, ServerRole } from '../core/protocol'

/**
 * A question's answers. Older servers send only `roles` (each role is an answer, with the role's id): `legacy`, and
 * answering goes through `roles.self` there.
 */
export function answersOf(group: RoleGroup): { answers: JoinAnswer[]; legacy: boolean } {
  if (group.answers) return { answers: group.answers, legacy: false }
  return { answers: group.roles.map((id) => ({ id, label: '', emoji: null, roles: [id], channels: [] })), legacy: true }
}

const pickable = (roles: ServerRole[], id: number) => roles.some((r) => r.id === id && r.selfAssign)

/** The answers worth showing: named ones, and unnamed ones whose role still exists and is pickable. */
export function shownAnswers(group: RoleGroup, roles: ServerRole[]): JoinAnswer[] {
  return answersOf(group).answers.filter((a) => a.label.trim() !== '' || a.roles.some((id) => pickable(roles, id)))
}

/** Questions with at least one answer to show, in order. */
export const askableQuestions = (groups: RoleGroup[], roles: ServerRole[]): RoleGroup[] =>
  groups.filter((g) => shownAnswers(g, roles).length > 0)

/** What an answer is called: its label, or (unnamed) its roles' names. */
export function answerName(answer: JoinAnswer, roles: ServerRole[]): string {
  if (answer.label.trim()) return answer.label
  return answer.roles.map((id) => roles.find((r) => r.id === id)?.name).filter(Boolean).join(', ')
}

/** Your answers to one question, out of all your answer ids (legacy: the question's roles you hold). */
export function chosenFor(group: RoleGroup, mine: number[], myRoles: number[]): number[] {
  const { answers, legacy } = answersOf(group)
  const have = new Set(legacy ? myRoles : mine)
  return answers.filter((a) => have.has(a.id)).map((a) => a.id)
}

/** Tapping an answer: single choice swaps (or clears it when tapped again), multiple choice toggles. */
export function toggleAnswer(selected: number[], id: number, multi: boolean): number[] {
  if (selected.includes(id)) return selected.filter((x) => x !== id)
  return multi ? [...selected, id] : [id]
}

/** Can this step move on with this selection? A required question needs an answer. */
export const canContinue = (group: RoleGroup, selected: number[]) => !group.required || selected.length > 0

/** Required questions you haven't answered yet. */
export const missingRequired = (groups: RoleGroup[], roles: ServerRole[], mine: number[], myRoles: number[]): RoleGroup[] =>
  askableQuestions(groups, roles).filter((g) => g.required && chosenFor(g, mine, myRoles).length === 0)

/** Channels your answers suggest, in question and answer order, only ones you can see (in `visible`), each once. */
export function suggestedChannels(groups: RoleGroup[], mine: number[], visible: number[]): number[] {
  const chosen = new Set(mine)
  const see = new Set(visible)
  const out: number[] = []
  for (const g of groups)
    for (const a of answersOf(g).answers)
      if (chosen.has(a.id)) for (const c of a.channels) if (see.has(c) && !out.includes(c)) out.push(c)
  return out
}

/** For `roles.self` on an older server: which roles to add and remove to go from one selection to another. */
export function legacyChange(before: number[], after: number[]): { add: number[]; remove: number[] } {
  return { add: after.filter((id) => !before.includes(id)), remove: before.filter((id) => !after.includes(id)) }
}

/**
 * After the welcome, open the questions by themselves? Never for bots, nor while the rules screen comes first (it
 * shows the questions after agreeing). Right after joining when the server asks anything; on any later connect only
 * while a required question is still unanswered.
 */
export function shouldAsk(opts: {
  firstJoin: boolean; mustAgree: boolean; bot: boolean; groups: RoleGroup[]; roles: ServerRole[]; mine: number[]; myRoles: number[]
}): boolean {
  if (opts.bot || opts.mustAgree) return false
  if (askableQuestions(opts.groups, opts.roles).length === 0) return false
  return opts.firstJoin || missingRequired(opts.groups, opts.roles, opts.mine, opts.myRoles).length > 0
}

// ── Settings: the editor ─────────────────────────────────────────────────────

export const MAX_QUESTIONS = 20
export const MAX_ANSWERS = 25
export const MAX_ANSWER_LABEL = 60
export const MAX_ANSWER_ROLES = 5
export const MAX_ANSWER_CHANNELS = 5
export const MAX_AUTO_ROLES = 10

export interface AnswerDraft {
  /** Kept answers carry their id (so who picked them stays); new ones don't. */
  id?: number
  label: string
  emoji: string
  roles: number[]
  channels: number[]
}

export const draftsOf = (group: RoleGroup | null): AnswerDraft[] =>
  group ? answersOf(group).answers.map((a) => ({ id: group.answers ? a.id : undefined, label: a.label, emoji: a.emoji ?? '', roles: a.roles, channels: a.channels })) : []

/** Why the answers can't be saved yet, as an i18n key under joinQuestions.editor, or null. */
export function answersProblem(answers: AnswerDraft[]): string | null {
  if (answers.length === 0) return 'needAnswer'
  if (answers.length > MAX_ANSWERS) return 'tooManyAnswers'
  for (const a of answers) {
    if (!a.label.trim() && a.roles.length === 0) return 'answerEmpty'
    if (a.label.trim().length > MAX_ANSWER_LABEL) return 'answerLong'
  }
  return null
}

/** The request body for the answers (empty emoji left out). */
export const answersBody = (answers: AnswerDraft[]) =>
  answers.map((a) => ({
    ...(a.id ? { id: a.id } : {}), label: a.label.trim(), ...(a.emoji.trim() ? { emoji: a.emoji.trim() } : {}), roles: a.roles, channels: a.channels,
  }))
