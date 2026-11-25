// A task board's rules (pure): columns and their order, filters, where a moved task lands, due days, who may delete.
// No React, no store.
import type { Task, TaskAssignment, TaskStatus } from '../core/protocol'

export const STATUSES: readonly TaskStatus[] = ['todo', 'doing', 'done']

export const MAX_TITLE_LENGTH = 100
export const MAX_DESCRIPTION_LENGTH = 4000
export const MAX_ASSIGNEES = 10
export const MAX_TASK_LABELS = 5
export const MAX_BOARD_LABELS = 20

export interface TaskFilter {
  /** Only tasks assigned to me. */
  mine: boolean
  /** Only tasks assigned to this person ("" : to nobody). */
  assignee: string | null
  label: number | null
  hideDone: boolean
}

export const NO_FILTER: TaskFilter = { mine: false, assignee: null, label: null, hideDone: false }

export const isFiltering = (f: TaskFilter): boolean => f.mine || f.assignee !== null || f.label !== null

/** Board order: by rank, the older task first when two share one. */
export const byRank = (a: Task, b: Task): number => a.rank - b.rank || a.id - b.id

/**
 * Replaces or adds a task. Lists come without descriptions: a task that arrives without one keeps the text this
 * device already has, as long as nothing has changed since.
 */
export function upsertTask(tasks: Task[], task: Task): Task[] {
  const index = tasks.findIndex((t) => t.id === task.id)
  if (index < 0) return [...tasks, task]
  const had = tasks[index]
  const next = task.description === null && had.description !== null && had.updatedAt === task.updatedAt
    ? { ...task, description: had.description } : task
  return tasks.map((t, i) => (i === index ? next : t))
}

export function matches(task: Task, filter: TaskFilter, me: string | undefined): boolean {
  if (filter.mine && !(me && task.assignees.includes(me))) return false
  if (filter.assignee === '' && task.assignees.length > 0) return false
  if (filter.assignee && !task.assignees.includes(filter.assignee)) return false
  if (filter.label !== null && !task.labels.includes(filter.label)) return false
  return true
}

/** The tasks of one column that are on the board (not archived), in order. */
export const columnOf = (tasks: Task[], status: TaskStatus): Task[] =>
  tasks.filter((t) => t.status === status && !t.archived).sort(byRank)

/** What each column shows under a filter. */
export function columnsOf(tasks: Task[], filter: TaskFilter, me: string | undefined): Record<TaskStatus, Task[]> {
  const column = (status: TaskStatus) => columnOf(tasks, status).filter((t) => matches(t, filter, me))
  return { todo: column('todo'), doing: column('doing'), done: filter.hideDone ? [] : column('done') }
}

/** How many tasks each column holds, whatever the filter. */
export function countsOf(tasks: Task[]): Record<TaskStatus, number> {
  const counts: Record<TaskStatus, number> = { todo: 0, doing: 0, done: 0 }
  for (const t of tasks) if (!t.archived) counts[t.status]++
  return counts
}

/**
 * The rank a task gets when it is put before `before` in a column (null: last), by the server's rule, so the board
 * can show the move at once. `column`: the whole column in order, without the task being moved.
 */
export function rankFor(column: Task[], before: number | null): number {
  const at = before === null ? -1 : column.findIndex((t) => t.id === before)
  const index = at < 0 ? column.length : at
  const below = index > 0 ? column[index - 1].rank : null
  const above = index < column.length ? column[index].rank : null
  if (below === null && above === null) return 1
  if (below === null) return above! - 1
  if (above === null) return below + 1
  return (below + above) / 2
}

/** The board after a move, before the server has answered. */
export function applyMove(tasks: Task[], id: number, status: TaskStatus, before: number | null): Task[] {
  const column = columnOf(tasks, status).filter((t) => t.id !== id)
  const rank = rankFor(column, before)
  return tasks.map((t) => (t.id === id ? { ...t, status, rank } : t))
}

/**
 * Moving a task one step up or down among the tasks shown in its column: the task to put it before (null: last), or
 * undefined when it is already at that end.
 */
export function stepTarget(shown: Task[], id: number, direction: -1 | 1): { before: number | null } | undefined {
  const index = shown.findIndex((t) => t.id === id)
  if (index < 0) return undefined
  if (direction === -1) return index === 0 ? undefined : { before: shown[index - 1].id }
  if (index === shown.length - 1) return undefined
  return { before: shown[index + 2]?.id ?? null }
}

/**
 * Dropping a task at position `index` of the tasks shown in a column: the task to put it before (null: last), or
 * undefined when that is where it already is.
 */
export function dropTarget(shown: Task[], id: number, status: TaskStatus, index: number): { before: number | null } | undefined {
  const from = shown.findIndex((t) => t.id === id)
  const moved = shown.find((t) => t.id === id)
  if (moved && moved.status === status && (index === from || index === from + 1)) return undefined
  const before = shown.slice(index).find((t) => t.id !== id)
  return { before: before?.id ?? null }
}

/** Today as a calendar day in this device's time zone, "YYYY-MM-DD". */
export function todayString(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** A due day as a date at local noon (for formatting; noon keeps the day right in every zone). */
export function dueDate(due: string): Date {
  const [y, m, d] = due.split('-').map(Number)
  return new Date(y, m - 1, d, 12)
}

export type DueState = 'overdue' | 'today' | 'soon' | 'later' | 'done'

/** How urgent a due day is: past, today, within three days, or later. A done task is never late. */
export function dueState(task: Pick<Task, 'due' | 'status'>, today = todayString()): DueState | null {
  if (!task.due) return null
  if (task.status === 'done') return 'done'
  if (task.due < today) return 'overdue'
  if (task.due === today) return 'today'
  const days = Math.round((dueDate(task.due).getTime() - dueDate(today).getTime()) / 86_400_000)
  return days <= 3 ? 'soon' : 'later'
}

/** Adds or removes one person, as "Assign me" and the people picker do. */
export const toggleAssignee = (assignees: string[], key: string): string[] =>
  assignees.includes(key) ? assignees.filter((k) => k !== key) : [...assignees, key]

/** Whoever made the task, the people it is assigned to, and moderators delete it (the server checks again). */
export const canDeleteTask = (task: Task, me: string | undefined, moderator: boolean): boolean =>
  !!me && (moderator || task.createdBy === me || task.assignees.includes(me))

/**
 * Assignments the inbox lists as new: made by someone else and not yet seen on this device. `seen`: task id → the
 * assignment time that was seen (undefined before this device has looked at this server: nothing is new then).
 */
export function newAssignments(mine: TaskAssignment[], seen: Record<number, number> | undefined, me: string | undefined): TaskAssignment[] {
  if (!seen) return []
  return mine.filter((a) => a.by !== me && seen[a.task.id] !== a.at)
}

/** The seen map after looking at these assignments, without entries for tasks that are no longer assigned. */
export function seenAfter(mine: TaskAssignment[], seen: Record<number, number> | undefined, ids: number[] | 'all'): Record<number, number> {
  const next: Record<number, number> = {}
  for (const a of mine) {
    if (ids === 'all' || ids.includes(a.task.id)) next[a.task.id] = a.at
    else if (seen?.[a.task.id] !== undefined) next[a.task.id] = seen[a.task.id]
  }
  return next
}
