import { describe, expect, it } from 'vitest'
import type { Task, TaskAssignment, TaskStatus } from '../core/protocol'
import {
  applyMove, canDeleteTask, columnOf, columnsOf, countsOf, dropTarget, dueState, newAssignments, NO_FILTER, rankFor, seenAfter, stepTarget,
  todayString, toggleAssignee, upsertTask,
} from './tasksLogic'

let nextId = 1
const task = (title: string, status: TaskStatus, rank: number, more: Partial<Task> = {}): Task => ({
  id: nextId++, channelId: 5, title, description: null, hasDescription: false, status, rank, assignees: [], labels: [], due: null,
  createdBy: 'alice', createdAt: 1, updatedAt: 1, archived: false, comments: 0, ...more,
})
const titles = (list: Task[]) => list.map((t) => t.title)

describe('columns', () => {
  const a = task('A', 'todo', 1)
  const b = task('B', 'todo', 2, { assignees: ['me'], labels: [7] })
  const c = task('C', 'doing', 1, { assignees: ['bob'] })
  const d = task('D', 'done', 1, { assignees: ['me'] })
  const gone = task('Gone', 'todo', 0, { archived: true })
  const all = [d, c, b, a, gone]

  it('are in rank order without archived tasks', () => {
    expect(titles(columnOf(all, 'todo'))).toEqual(['A', 'B'])
    expect(countsOf(all)).toEqual({ todo: 2, doing: 1, done: 1 })
  })

  it('break a tie in rank by the older task', () => {
    const x = task('X', 'todo', 3)
    const y = task('Y', 'todo', 3)
    expect(titles(columnOf([y, x], 'todo'))).toEqual(['X', 'Y'])
  })

  it('filter by me, a person, nobody, a label, and hide done', () => {
    const cols = (filter: Partial<typeof NO_FILTER>) => columnsOf(all, { ...NO_FILTER, ...filter }, 'me')
    expect(titles(cols({ mine: true }).todo)).toEqual(['B'])
    expect(titles(cols({ mine: true }).done)).toEqual(['D'])
    expect(titles(cols({ assignee: 'bob' }).doing)).toEqual(['C'])
    expect(titles(cols({ assignee: 'bob' }).todo)).toEqual([])
    expect(titles(cols({ assignee: '' }).todo)).toEqual(['A'])
    expect(titles(cols({ label: 7 }).todo)).toEqual(['B'])
    expect(cols({ hideDone: true }).done).toEqual([])
    expect(titles(cols({ hideDone: true }).todo)).toEqual(['A', 'B'])
    // Without knowing who I am, "mine" is nothing.
    expect(columnsOf(all, { ...NO_FILTER, mine: true }, undefined).todo).toEqual([])
  })
})

describe('moving', () => {
  const a = task('A', 'todo', 1)
  const b = task('B', 'todo', 2)
  const c = task('C', 'todo', 3)
  const d = task('D', 'doing', 5)
  const board = [a, b, c, d]

  it('ranks a task between its new neighbours, as the server does', () => {
    expect(rankFor([], null)).toBe(1)
    expect(rankFor([a, b], a.id)).toBe(0)
    expect(rankFor([a, b], b.id)).toBe(1.5)
    expect(rankFor([a, b], null)).toBe(3)
    expect(rankFor([a, b], 999)).toBe(3) // a task that isn't there: last
  })

  it('shows a move at once', () => {
    expect(titles(columnOf(applyMove(board, c.id, 'todo', a.id), 'todo'))).toEqual(['C', 'A', 'B'])
    const moved = applyMove(board, a.id, 'doing', d.id)
    expect(titles(columnOf(moved, 'doing'))).toEqual(['A', 'D'])
    expect(titles(columnOf(moved, 'todo'))).toEqual(['B', 'C'])
    expect(titles(columnOf(applyMove(board, a.id, 'done', null), 'done'))).toEqual(['A'])
    // To the end of its own column.
    expect(titles(columnOf(applyMove(board, a.id, 'todo', null), 'todo'))).toEqual(['B', 'C', 'A'])
  })

  it('steps up and down among the tasks shown', () => {
    const shown = [a, b, c]
    expect(stepTarget(shown, a.id, -1)).toBeUndefined()
    expect(stepTarget(shown, b.id, -1)).toEqual({ before: a.id })
    expect(stepTarget(shown, a.id, 1)).toEqual({ before: c.id })
    expect(stepTarget(shown, b.id, 1)).toEqual({ before: null })
    expect(stepTarget(shown, c.id, 1)).toBeUndefined()
    expect(stepTarget(shown, 999, 1)).toBeUndefined()
    for (const [id, direction, want] of [[b.id, -1, ['B', 'A', 'C']], [a.id, 1, ['B', 'A', 'C']], [b.id, 1, ['A', 'C', 'B']]] as const) {
      const target = stepTarget(shown, id, direction)!
      expect(titles(columnOf(applyMove(board, id, 'todo', target.before), 'todo'))).toEqual(want)
    }
  })

  it('drops at a position, and knows when nothing would change', () => {
    const shown = [a, b, c]
    expect(dropTarget(shown, b.id, 'todo', 1)).toBeUndefined() // on itself
    expect(dropTarget(shown, b.id, 'todo', 2)).toBeUndefined() // just below itself
    expect(dropTarget(shown, b.id, 'todo', 0)).toEqual({ before: a.id })
    expect(dropTarget(shown, b.id, 'todo', 3)).toEqual({ before: null })
    expect(dropTarget(shown, a.id, 'todo', 2)).toEqual({ before: c.id })
    // From another column: any position is a move.
    expect(dropTarget(shown, d.id, 'todo', 0)).toEqual({ before: a.id })
    expect(dropTarget(shown, d.id, 'todo', 3)).toEqual({ before: null })
    expect(dropTarget([], d.id, 'done', 0)).toEqual({ before: null })
  })
})

describe('upsertTask', () => {
  it('adds, replaces, and keeps a description a list left out', () => {
    const full = task('A', 'todo', 1, { description: 'text', hasDescription: true })
    expect(upsertTask([], full)).toEqual([full])
    const listed = { ...full, description: null }
    expect(upsertTask([full], listed)[0].description).toBe('text')
    // Changed since: the old text may be stale.
    expect(upsertTask([full], { ...listed, updatedAt: 2 })[0].description).toBeNull()
    expect(upsertTask([full], { ...full, title: 'B', description: 'new' })).toEqual([{ ...full, title: 'B', description: 'new' }])
  })
})

describe('due days', () => {
  it('are late, today, soon or later, and never late once done', () => {
    const today = '2026-12-10'
    const state = (due: string | null, status: TaskStatus = 'todo') => dueState({ due, status }, today)
    expect(state(null)).toBeNull()
    expect(state('2026-12-09')).toBe('overdue')
    expect(state('2025-12-31')).toBe('overdue')
    expect(state('2026-12-10')).toBe('today')
    expect(state('2026-12-13')).toBe('soon')
    expect(state('2026-12-14')).toBe('later')
    expect(state('2027-01-01')).toBe('later')
    expect(state('2026-12-01', 'done')).toBe('done')
  })

  it('counts days across a month end and a clock change', () => {
    expect(dueState({ due: '2026-11-01', status: 'todo' }, '2026-10-30')).toBe('soon')
    expect(dueState({ due: '2026-03-30', status: 'doing' }, '2026-03-27')).toBe('soon')
    expect(dueState({ due: '2026-03-31', status: 'doing' }, '2026-03-27')).toBe('later')
  })

  it('writes today as a local calendar day', () => {
    expect(todayString(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05')
    expect(todayString(new Date(2026, 11, 31, 0, 1))).toBe('2026-12-31')
  })
})

describe('people', () => {
  it('toggles one assignee', () => {
    expect(toggleAssignee(['a'], 'b')).toEqual(['a', 'b'])
    expect(toggleAssignee(['a', 'b'], 'a')).toEqual(['b'])
  })

  it('lets its maker, its assignees and moderators delete a task', () => {
    const t = task('A', 'todo', 1, { createdBy: 'alice', assignees: ['bob'] })
    expect(canDeleteTask(t, 'alice', false)).toBe(true)
    expect(canDeleteTask(t, 'bob', false)).toBe(true)
    expect(canDeleteTask(t, 'carol', false)).toBe(false)
    expect(canDeleteTask(t, 'carol', true)).toBe(true)
    expect(canDeleteTask(t, undefined, true)).toBe(false)
  })
})

describe('new assignments', () => {
  const one = task('One', 'todo', 1)
  const two = task('Two', 'todo', 2)
  const mine: TaskAssignment[] = [{ task: one, by: 'bob', at: 100 }, { task: two, by: 'me', at: 200 }]

  it('are none before this device has looked at the server', () => {
    expect(newAssignments(mine, undefined, 'me')).toEqual([])
    expect(seenAfter(mine, undefined, 'all')).toEqual({ [one.id]: 100, [two.id]: 200 })
  })

  it("are the ones someone else made that haven't been seen", () => {
    expect(newAssignments(mine, {}, 'me')).toEqual([mine[0]])
    expect(newAssignments(mine, { [one.id]: 100 }, 'me')).toEqual([])
    // Assigned again later: new again.
    expect(newAssignments([{ task: one, by: 'bob', at: 300 }], { [one.id]: 100 }, 'me')).toHaveLength(1)
  })

  it('remembers what was seen and forgets tasks that are no longer assigned', () => {
    expect(seenAfter(mine, { 999: 5 }, [one.id])).toEqual({ [one.id]: 100 })
    expect(seenAfter(mine, { [two.id]: 200 }, [])).toEqual({ [two.id]: 200 })
    expect(seenAfter([], { [one.id]: 100 }, 'all')).toEqual({})
  })
})
