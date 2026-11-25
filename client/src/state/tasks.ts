// Task boards: each board's tasks and labels, kept live from events, the tasks assigned to me (for the inbox and the
// notification when someone assigns one), and opening a task. A task's comments are a thread, so the task panel is
// opened like a thread (threads.ts) and its messages live in the server state. See "Task boards" in PROTOCOL.md.
import { create } from 'zustand'
import type { Events, ForumTag, Task, TaskAssignment, TaskFields, TaskStatus } from '../core/protocol'
import { connectionFor, onChannelsGone, onServerEvent, onWelcomeHook, selectChannel, selectServer, useApp } from './store'
import { withoutChannels } from './channelGone'
import { closeThread, openThread, rememberThreads, useThreads } from './threads'
import { showNotification } from './notify'
import { errorMessage } from '../i18n/errors'
import { t } from '../i18n'
import { applyMove, newAssignments, seenAfter, upsertTask } from './tasksLogic'

const SEEN_KEY = 'iskra.tasks.seen'

interface Board {
  tasks: Task[]
  labels: ForumTag[]
  loading: boolean
  error: string | null
  loaded: boolean
}

interface TasksState {
  /** `${serverKey}:${channelId}` → the tasks on the board (not archived) and its labels. */
  boards: Record<string, Board>
  /** `${serverKey}:${channelId}` → its archived tasks, once asked for. */
  archived: Record<string, Task[]>
  /** serverKey → tasks assigned to me that are still to do. */
  mine: Record<string, TaskAssignment[]>
  /** serverKey → task id → the assignment (its time) this device has seen. */
  seen: Record<string, Record<number, number>>
}

function loadSeen(): TasksState['seen'] {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}') as TasksState['seen']
  } catch {
    return {}
  }
}

function saveSeen(seen: TasksState['seen']): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen))
  } catch {
    /* private mode */
  }
}

export const useTasks = create<TasksState>(() => ({ boards: {}, archived: {}, mine: {}, seen: loadSeen() }))

export const boardKey = (serverKey: string, channelId: number) => `${serverKey}:${channelId}`

const EMPTY: Board = { tasks: [], labels: [], loading: false, error: null, loaded: false }

function connection(serverKey: string) {
  const c = connectionFor(serverKey)
  if (!c) throw new Error(t('errors.codes.disconnected'))
  return c
}

const myKey = (serverKey: string) => useApp.getState().servers[serverKey]?.me?.accountKey

function patchBoard(key: string, change: (board: Board) => Partial<Board>): void {
  useTasks.setState((s) => (s.boards[key] ? { boards: { ...s.boards, [key]: { ...s.boards[key], ...change(s.boards[key]) } } } : s))
}

/** Threads learn the tasks' names, so notifications, the inbox and unread counts can name a task's comments. */
function rememberTaskThreads(serverKey: string, tasks: Task[]): void {
  rememberThreads(serverKey, tasks.map((task) => {
    const known = useThreads.getState().threads[serverKey]?.[task.id]
    return {
      id: task.id, channelId: task.channelId, rootId: -task.id, name: task.title, createdBy: task.createdBy, createdAt: task.createdAt,
      messageCount: task.comments, lastMessageAt: known?.lastMessageAt ?? null,
    }
  }))
}

// ── Loading ─────────────────────────────────────────────────────────────────

export async function loadBoard(serverKey: string, channelId: number): Promise<void> {
  const key = boardKey(serverKey, channelId)
  useTasks.setState((s) => ({ boards: { ...s.boards, [key]: { ...(s.boards[key] ?? EMPTY), loading: true, error: null } } }))
  try {
    const { tasks, labels } = await connection(serverKey).request('task.list', { channelId })
    useTasks.setState((s) => {
      // Descriptions this device already fetched stay with tasks that haven't changed.
      const merged = tasks.reduce(upsertTask, (s.boards[key]?.tasks ?? []).filter((had) => tasks.some((now) => now.id === had.id)))
      return { boards: { ...s.boards, [key]: { tasks: merged, labels, loading: false, error: null, loaded: true } } }
    })
    rememberTaskThreads(serverKey, tasks)
  } catch (e) {
    useTasks.setState((s) => ({ boards: { ...s.boards, [key]: { ...(s.boards[key] ?? EMPTY), loading: false, error: errorMessage(e) } } }))
  }
}

export async function loadArchived(serverKey: string, channelId: number): Promise<void> {
  const { tasks } = await connection(serverKey).request('task.list', { channelId, archived: true })
  useTasks.setState((s) => ({ archived: { ...s.archived, [boardKey(serverKey, channelId)]: tasks } }))
  rememberTaskThreads(serverKey, tasks)
}

/** A task wherever this device has it: on its board or among the archived ones. */
export function knownTask(serverKey: string, id: number, state: TasksState = useTasks.getState()): Task | undefined {
  for (const [key, board] of Object.entries(state.boards)) {
    if (!key.startsWith(`${serverKey}:`)) continue
    const found = board.tasks.find((task) => task.id === id)
    if (found) return found
  }
  for (const [key, list] of Object.entries(state.archived)) {
    if (!key.startsWith(`${serverKey}:`)) continue
    const found = list.find((task) => task.id === id)
    if (found) return found
  }
  return undefined
}

/** Puts a task (as the server just sent it) wherever it belongs: on its board, or among the archived ones if loaded. */
function put(serverKey: string, task: Task): void {
  const key = boardKey(serverKey, task.channelId)
  useTasks.setState((s) => {
    const board = s.boards[key]
    const archived = s.archived[key]
    return {
      boards: board ? { ...s.boards, [key]: { ...board, tasks: task.archived ? board.tasks.filter((x) => x.id !== task.id) : upsertTask(board.tasks, task) } } : s.boards,
      archived: archived ? { ...s.archived, [key]: task.archived ? [task, ...archived.filter((x) => x.id !== task.id)] : archived.filter((x) => x.id !== task.id) } : s.archived,
    }
  })
  rememberTaskThreads(serverKey, [task])
}

/** The task with its description: from what this device has, else from the server. */
export async function fetchTask(serverKey: string, id: number): Promise<Task> {
  const { task } = await connection(serverKey).request('task.get', { id })
  put(serverKey, task)
  return task
}

// ── Changes ─────────────────────────────────────────────────────────────────

export async function createTask(serverKey: string, channelId: number, title: string, more: TaskFields & { status?: TaskStatus } = {}): Promise<Task> {
  const { task } = await connection(serverKey).request('task.create', { channelId, title, ...more })
  put(serverKey, task)
  return task
}

export async function updateTask(serverKey: string, id: number, change: TaskFields & { archived?: boolean }): Promise<Task> {
  const { task } = await connection(serverKey).request('task.update', { id, ...change })
  put(serverKey, task)
  return task
}

/** Moves a task: shown at once, then confirmed by the server (or put back). */
export async function moveTask(serverKey: string, task: Task, status: TaskStatus, before: number | null): Promise<void> {
  const key = boardKey(serverKey, task.channelId)
  patchBoard(key, (board) => ({ tasks: applyMove(board.tasks, task.id, status, before) }))
  try {
    const { task: moved } = await connection(serverKey).request('task.move', { id: task.id, status, before })
    put(serverKey, moved)
  } catch (e) {
    void loadBoard(serverKey, task.channelId)
    throw e
  }
}

export async function deleteTask(serverKey: string, task: Task): Promise<void> {
  await connection(serverKey).request('task.delete', { id: task.id })
  remove(serverKey, task.channelId, [task.id])
}

export async function archiveDone(serverKey: string, channelId: number): Promise<number> {
  const { ids } = await connection(serverKey).request('task.archiveDone', { channelId })
  markArchived(serverKey, channelId, ids)
  return ids.length
}

export async function saveLabels(serverKey: string, channelId: number, labels: { id?: number; name: string; emoji?: string | null }[]): Promise<void> {
  const result = await connection(serverKey).request('task.labels.set', { channelId, labels })
  patchBoard(boardKey(serverKey, channelId), () => ({ labels: result.labels }))
}

function remove(serverKey: string, channelId: number, ids: number[]): void {
  const key = boardKey(serverKey, channelId)
  useTasks.setState((s) => ({
    boards: s.boards[key] ? { ...s.boards, [key]: { ...s.boards[key], tasks: s.boards[key].tasks.filter((x) => !ids.includes(x.id)) } } : s.boards,
    archived: s.archived[key] ? { ...s.archived, [key]: s.archived[key].filter((x) => !ids.includes(x.id)) } : s.archived,
    mine: s.mine[serverKey]?.some((a) => ids.includes(a.task.id)) ? { ...s.mine, [serverKey]: s.mine[serverKey].filter((a) => !ids.includes(a.task.id)) } : s.mine,
  }))
}

function markArchived(serverKey: string, channelId: number, ids: number[]): void {
  const key = boardKey(serverKey, channelId)
  useTasks.setState((s) => {
    const board = s.boards[key]
    if (!board) return s
    const gone = board.tasks.filter((x) => ids.includes(x.id)).map((x) => ({ ...x, archived: true }))
    const archived = s.archived[key]
    return {
      boards: { ...s.boards, [key]: { ...board, tasks: board.tasks.filter((x) => !ids.includes(x.id)) } },
      archived: archived ? { ...s.archived, [key]: [...gone, ...archived.filter((x) => !ids.includes(x.id))] } : s.archived,
    }
  })
}

// ── Opening a task ──────────────────────────────────────────────────────────

/** Opens a task beside its board (its panel is the thread panel's place). */
export function openTask(serverKey: string, task: Pick<Task, 'id'>): void {
  openThread(serverKey, task.id)
  markAssignmentsSeen(serverKey, [task.id])
}

/** Goes to a board and opens one of its tasks (a link, a notification, the inbox). */
export function goToTask(serverKey: string, channelId: number, taskId: number): void {
  const app = useApp.getState()
  if (!app.servers[serverKey]) return
  if (app.activeServer !== serverKey) selectServer(serverKey)
  if (useApp.getState().activeChannel[serverKey] !== channelId) selectChannel(serverKey, channelId)
  openTask(serverKey, { id: taskId })
}

// ── Assigned to me ──────────────────────────────────────────────────────────

async function loadMine(serverKey: string): Promise<void> {
  const c = connectionFor(serverKey)
  if (!c) return
  try {
    const { tasks } = await c.request('task.mine', {})
    useTasks.setState((s) => {
      // The first look at a server on this device: what is assigned already isn't news.
      const seen = seenAfter(tasks, s.seen[serverKey], s.seen[serverKey] ? [] : 'all')
      const all = { ...s.seen, [serverKey]: seen }
      saveSeen(all)
      return { mine: { ...s.mine, [serverKey]: tasks }, seen: all }
    })
  } catch {
    /* an older server without task boards */
  }
}

export function markAssignmentsSeen(serverKey: string, ids: number[] | 'all'): void {
  useTasks.setState((s) => {
    const mine = s.mine[serverKey] ?? []
    if (newAssignments(mine, s.seen[serverKey], undefined).every((a) => ids !== 'all' && !ids.includes(a.task.id))) return s
    const all = { ...s.seen, [serverKey]: seenAfter(mine, s.seen[serverKey], ids) }
    saveSeen(all)
    return { seen: all }
  })
}

/** Assignments by other people that this device hasn't looked at yet, across servers (the inbox lists them). */
export function unseenAssignments(state: TasksState = useTasks.getState()): { server: string; assignment: TaskAssignment }[] {
  return Object.entries(state.mine).flatMap(([server, mine]) =>
    newAssignments(mine, state.seen[server], myKey(server)).map((assignment) => ({ server, assignment })))
}

/** Keeps "assigned to me" right when a task changes: gone when it's done, archived or no longer mine. */
function followMine(serverKey: string, task: Task): void {
  const me = myKey(serverKey)
  const stillMine = !!me && task.assignees.includes(me) && task.status !== 'done' && !task.archived
  const mine = useTasks.getState().mine[serverKey] ?? []
  const listed = mine.some((a) => a.task.id === task.id)
  if (listed && stillMine) {
    useTasks.setState((s) => ({ mine: { ...s.mine, [serverKey]: mine.map((a) => (a.task.id === task.id ? { ...a, task } : a)) } }))
  } else if (listed) {
    useTasks.setState((s) => ({ mine: { ...s.mine, [serverKey]: mine.filter((a) => a.task.id !== task.id) } }))
  } else if (stillMine) {
    void loadMine(serverKey) // assigned by me, or back from done: the server knows who assigned it and when
  }
}

// ── Live updates ───────────────────────────────────────────────────────────

onServerEvent((serverKey, type, body) => {
  if (type === 'task.updated') {
    const { task } = body as Events['task.updated']
    put(serverKey, task)
    followMine(serverKey, task)
  } else if (type === 'task.deleted') {
    const { channelId, id } = body as Events['task.deleted']
    remove(serverKey, channelId, [id])
    const open = useThreads.getState().open
    if (open?.key === serverKey && open.id === id) closeThread()
  } else if (type === 'task.archived') {
    const { channelId, ids } = body as Events['task.archived']
    markArchived(serverKey, channelId, ids)
    useTasks.setState((s) => (s.mine[serverKey]?.some((a) => ids.includes(a.task.id))
      ? { mine: { ...s.mine, [serverKey]: s.mine[serverKey].filter((a) => !ids.includes(a.task.id)) } } : s))
  } else if (type === 'task.labels') {
    const { channelId, labels } = body as Events['task.labels']
    patchBoard(boardKey(serverKey, channelId), () => ({ labels }))
  } else if (type === 'task.assigned') {
    const assignment = body as Events['task.assigned']
    useTasks.setState((s) => ({
      mine: { ...s.mine, [serverKey]: [assignment, ...(s.mine[serverKey] ?? []).filter((a) => a.task.id !== assignment.task.id)] },
      // A device that hasn't looked at this server yet starts counting now.
      seen: s.seen[serverKey] ? s.seen : { ...s.seen, [serverKey]: {} },
    }))
    const server = useApp.getState().servers[serverKey]
    const name = server?.members[assignment.by]?.name ?? t('common.someone')
    showNotification(serverKey, t('tasks.notify.assigned', { name }), assignment.task.title,
      () => goToTask(serverKey, assignment.task.channelId, assignment.task.id))
  } else if (type === 'thread.updated') {
    // A comment was written or deleted: the card's count follows.
    const { thread } = body as Events['thread.updated']
    patchBoard(boardKey(serverKey, thread.channelId), (board) =>
      board.tasks.some((x) => x.id === thread.id && x.comments !== thread.messageCount)
        ? { tasks: board.tasks.map((x) => (x.id === thread.id ? { ...x, comments: thread.messageCount } : x)) } : {})
  }
})

onWelcomeHook((serverKey) => {
  // What we had may be stale after a reconnect: a board on screen loads again (its view asks), the others when shown.
  useTasks.setState((s) => ({
    boards: Object.fromEntries(Object.entries(s.boards).map(([k, b]) => (k.startsWith(`${serverKey}:`) ? [k, { ...b, loaded: false }] : [k, b]))),
    archived: Object.fromEntries(Object.entries(s.archived).filter(([k]) => !k.startsWith(`${serverKey}:`))),
  }))
  void loadMine(serverKey)
})

// A board that's gone (deleted, or no longer readable): its tasks leave this device.
onChannelsGone((serverKey, channelIds) => {
  const gone = new Set(channelIds)
  useTasks.setState((s) => ({
    boards: withoutChannels(s.boards, serverKey, channelIds),
    archived: withoutChannels(s.archived, serverKey, channelIds),
    mine: s.mine[serverKey]?.some((a) => gone.has(a.task.channelId))
      ? { ...s.mine, [serverKey]: s.mine[serverKey].filter((a) => !gone.has(a.task.channelId)) } : s.mine,
  }))
})

// A server removed from this device takes its tasks along.
useApp.subscribe((state, before) => {
  if (state.order === before.order) return
  const gone = before.order.filter((k) => !state.order.includes(k))
  if (!gone.length) return
  const keep = <T,>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).filter(([k]) => !gone.some((g) => k === g || k.startsWith(`${g}:`))))
  useTasks.setState((s) => {
    const seen = keep(s.seen)
    saveSeen(seen)
    return { boards: keep(s.boards), archived: keep(s.archived), mine: keep(s.mine), seen }
  })
})
