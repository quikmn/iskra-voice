// Join questions: your answers per server, the roles on join, and when the questions open by themselves.
// Your roles change only when the server says so (`member.updated`); the answers come back in the reply.
import { create } from 'zustand'
import type { RoleGroup, ServerRole } from '../core/protocol'
import { connectionFor, useApp } from './store'
import { t } from '../i18n'
import { answersOf, legacyChange, shouldAsk } from './joinQuestionsLogic'

interface JoinState {
  /** serverKey → your answer ids (all questions). */
  mine: Record<string, number[]>
  /** serverKey → roles every new member gets. */
  autoRoles: Record<string, number[]>
}

export const useJoinQuestions = create<JoinState>(() => ({ mine: {}, autoRoles: {} }))

const NONE: number[] = []
export const useMyAnswers = (serverKey: string | undefined) => useJoinQuestions((s) => (serverKey ? s.mine[serverKey] ?? NONE : NONE))
export const useAutoRoles = (serverKey: string | undefined) => useJoinQuestions((s) => (serverKey ? s.autoRoles[serverKey] ?? NONE : NONE))

export const putAutoRoles = (serverKey: string, ids: number[] | undefined) =>
  useJoinQuestions.setState((s) => ({ autoRoles: { ...s.autoRoles, [serverKey]: ids ?? [] } }))

const putMine = (serverKey: string, ids: number[]) => useJoinQuestions.setState((s) => ({ mine: { ...s.mine, [serverKey]: ids } }))

function connection(serverKey: string) {
  const c = connectionFor(serverKey)
  if (!c) throw new Error(t('errors.codes.disconnected'))
  return c
}

/** Fetches your answers (an older server has none to give: empty). */
export async function loadMyAnswers(serverKey: string): Promise<number[]> {
  const ids = await connectionFor(serverKey)?.request('onboarding.mine', {}).then((r) => r.answers, () => NONE) ?? NONE
  putMine(serverKey, ids)
  return ids
}

/** Saves your answers to one question. Older servers: the same through picking roles one by one. */
export async function answerQuestion(serverKey: string, group: RoleGroup, ids: number[]) {
  const c = connection(serverKey)
  if (answersOf(group).legacy) {
    const held = useApp.getState().servers[serverKey]?.me?.roles ?? []
    const before = group.roles.filter((id) => held.includes(id))
    const { add, remove } = legacyChange(before, ids)
    if (add.length + remove.length > 0) await c.request('roles.self', { ...(add.length ? { add } : {}), ...(remove.length ? { remove } : {}) })
    return
  }
  const { answers } = await c.request('onboarding.answer', { question: group.id, answers: ids })
  putMine(serverKey, answers)
}

export async function setAutoRoles(serverKey: string, roles: number[]) {
  const { autoRoles } = await connection(serverKey).request('onboarding.autoroles.set', { roles })
  putAutoRoles(serverKey, autoRoles)
}

/** "Give to everyone now": how many members got them. */
export async function applyAutoRoles(serverKey: string): Promise<number> {
  return (await connection(serverKey).request('onboarding.autoroles.apply', {})).members
}

/**
 * Called once the server's roles and questions have arrived after a welcome (roles.ts): fetches your answers and says
 * whether the questions should open by themselves.
 */
export async function askAfterWelcome(serverKey: string, firstJoin: boolean, mustAgree: boolean, groups: RoleGroup[], roles: ServerRole[]): Promise<boolean> {
  const me = useApp.getState().servers[serverKey]?.me
  if (!me || me.bot || groups.length === 0) return false
  const mine = await loadMyAnswers(serverKey)
  return shouldAsk({ firstJoin, mustAgree, bot: !!me.bot, groups, roles, mine, myRoles: useApp.getState().servers[serverKey]?.me?.roles ?? [] })
}
