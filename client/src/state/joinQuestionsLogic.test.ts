import { describe, expect, it } from 'vitest'
import type { JoinAnswer, RoleGroup, ServerRole } from '../core/protocol'
import {
  answerName, answersBody, answersProblem, askableQuestions, canContinue, chosenFor, draftsOf, legacyChange, missingRequired,
  shouldAsk, shownAnswers, suggestedChannels, toggleAnswer,
} from './joinQuestionsLogic'

const role = (id: number, selfAssign = true): ServerRole => ({ id, name: `r${id}`, color: null, icon: null, hoist: false, position: id, permissions: [], selfAssign })
const answer = (id: number, label: string, roles: number[] = [], channels: number[] = []): JoinAnswer => ({ id, label, emoji: null, roles, channels })
const question = (id: number, answers: JoinAnswer[], extra: Partial<RoleGroup> = {}): RoleGroup =>
  ({ id, title: `q${id}`, question: '', multi: false, roles: answers.flatMap((a) => a.roles), answers, ...extra })
const roles = [role(1), role(2), role(3, false)]

describe('join questions', () => {
  it('shows named answers and unnamed ones whose role is still pickable', () => {
    const q = question(1, [answer(10, 'PC', [1]), answer(11, '', [2]), answer(12, '', [3]), answer(13, 'Just looking')])
    expect(shownAnswers(q, roles).map((a) => a.id)).toEqual([10, 11, 13])
    expect(askableQuestions([q, question(2, [answer(20, '', [3])])], roles).map((g) => g.id)).toEqual([1])
    expect(answerName(answer(11, '', [1, 2]), roles)).toBe('r1, r2')
    expect(answerName(answer(10, 'Computer', [1]), roles)).toBe('Computer')
  })

  it('treats an older server’s roles as answers', () => {
    const old: RoleGroup = { id: 1, title: 'P', question: '', multi: true, roles: [1, 2] }
    expect(shownAnswers(old, roles).map((a) => a.id)).toEqual([1, 2])
    expect(chosenFor(old, [], [2, 7])).toEqual([2]) // the roles you hold
    expect(legacyChange([2], [1])).toEqual({ add: [1], remove: [2] })
    expect(draftsOf(old)[0].id).toBeUndefined()
  })

  it('picks one or many, and a required question needs an answer', () => {
    expect(toggleAnswer([10], 11, false)).toEqual([11])
    expect(toggleAnswer([10], 10, false)).toEqual([])
    expect(toggleAnswer([10], 11, true)).toEqual([10, 11])
    expect(toggleAnswer([10, 11], 10, true)).toEqual([11])
    const required = question(1, [answer(10, 'A')], { required: true })
    expect(canContinue(required, [])).toBe(false)
    expect(canContinue(required, [10])).toBe(true)
    expect(canContinue(question(2, [answer(20, 'B')]), [])).toBe(true)
  })

  it('finds required questions still unanswered', () => {
    const qs = [question(1, [answer(10, 'A')], { required: true }), question(2, [answer(20, 'B')], { required: true }), question(3, [answer(30, 'C')])]
    expect(missingRequired(qs, roles, [10], []).map((g) => g.id)).toEqual([2])
    expect(missingRequired(qs, roles, [10, 20], [])).toEqual([])
  })

  it('suggests the channels of your answers that you can see, once each', () => {
    const qs = [question(1, [answer(10, 'A', [], [5, 6]), answer(11, 'B', [], [7])]), question(2, [answer(20, 'C', [], [6, 8])])]
    expect(suggestedChannels(qs, [10, 20], [5, 6, 7])).toEqual([5, 6])
    expect(suggestedChannels(qs, [], [5, 6, 7])).toEqual([])
  })

  it('opens by itself after a join, or while a required question is unanswered; never for bots or before the rules', () => {
    const groups = [question(1, [answer(10, 'A')])]
    const base = { firstJoin: true, mustAgree: false, bot: false, groups, roles, mine: [], myRoles: [] }
    expect(shouldAsk(base)).toBe(true)
    expect(shouldAsk({ ...base, mustAgree: true })).toBe(false) // the rules screen shows them after agreeing
    expect(shouldAsk({ ...base, bot: true })).toBe(false)
    expect(shouldAsk({ ...base, firstJoin: false })).toBe(false) // a reconnect, nothing required
    expect(shouldAsk({ ...base, groups: [] })).toBe(false)
    const required = [question(1, [answer(10, 'A')], { required: true })]
    expect(shouldAsk({ ...base, firstJoin: false, groups: required })).toBe(true)
    expect(shouldAsk({ ...base, firstJoin: false, groups: required, mine: [10] })).toBe(false)
  })

  it('checks and builds the answers an admin saves', () => {
    expect(answersProblem([])).toBe('needAnswer')
    expect(answersProblem([{ label: ' ', emoji: '', roles: [], channels: [] }])).toBe('answerEmpty')
    expect(answersProblem([{ label: '', emoji: '', roles: [1], channels: [] }])).toBeNull()
    expect(answersProblem([{ label: 'x'.repeat(61), emoji: '', roles: [], channels: [] }])).toBe('answerLong')
    expect(answersBody([{ id: 4, label: ' PC ', emoji: '', roles: [1], channels: [2] }, { label: 'New', emoji: '🎮', roles: [], channels: [] }]))
      .toEqual([{ id: 4, label: 'PC', roles: [1], channels: [2] }, { label: 'New', emoji: '🎮', roles: [], channels: [] }])
  })
})
