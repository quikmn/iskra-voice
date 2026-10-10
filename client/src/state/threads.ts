// Threads: side conversations under a message. On the wire a thread is a channel id of its own,
// so its messages, unread counts and typing live in the server state like any channel's.
import { create } from 'zustand'
import type { Events, Message, Thread } from '../core/protocol'
import { connectionFor, onServerEvent, patchServer, useApp, type ServerState } from './store'

interface ThreadsState {
  /** serverKey → thread id → thread. */
  threads: Record<string, Record<number, Thread>>
  /** The thread shown in the side panel. */
  open: { key: string; id: number } | null
}

export const useThreads = create<ThreadsState>(() => ({ threads: {}, open: null }))

export const knownThread = (key: string, id: number): Thread | undefined => useThreads.getState().threads[key]?.[id]

/** A conversation id that isn't one of the server's channels is a thread. */
export const isThreadId = (server: ServerState, channelId: number) => !server.channels.some((c) => c.id === channelId)

export function rememberThreads(key: string, list: Thread[]): void {
  if (list.length === 0) return
  useThreads.setState((s) => ({ threads: { ...s.threads, [key]: { ...s.threads[key], ...Object.fromEntries(list.map((t) => [t.id, t])) } } }))
}

function forget(key: string, id: number): void {
  useThreads.setState((s) => {
    const mine = { ...s.threads[key] }
    delete mine[id]
    return { threads: { ...s.threads, [key]: mine }, open: s.open?.key === key && s.open.id === id ? null : s.open }
  })
}

/** Keeps the "N replies" line on the root message in step with the thread. */
function patchRoot(key: string, channelId: number, rootId: number, thread: Thread | null): void {
  patchServer(key, (s) => {
    const list = s.messages[channelId]
    if (!list?.some((m) => m.id === rootId)) return {}
    return { messages: { ...s.messages, [channelId]: list.map((m) => (m.id === rootId && !m.tempId ? { ...m, thread } : m)) } }
  })
}

const fetching = new Map<string, Promise<Thread | null>>()

/** Looks a thread up on the server (once at a time per thread). */
export function fetchThread(key: string, id: number): Promise<Thread | null> {
  const tag = `${key}:${id}`
  let promise = fetching.get(tag)
  if (!promise) {
    promise = (connectionFor(key)?.request('thread.get', { id }) ?? Promise.reject(new Error('offline')))
      .then(({ thread }) => {
        rememberThreads(key, [thread])
        return thread
      })
      .catch(() => null)
      .finally(() => fetching.delete(tag))
    fetching.set(tag, promise)
  }
  return promise
}

export async function loadThreads(key: string, channelId: number): Promise<Thread[]> {
  const connection = connectionFor(key)
  if (!connection) return []
  const { threads } = await connection.request('thread.list', { channelId })
  rememberThreads(key, threads)
  return threads
}

export async function createThread(key: string, message: Message, name: string): Promise<Thread> {
  const connection = connectionFor(key)
  if (!connection) throw new Error('Not connected.')
  const { thread } = await connection.request('thread.create', { messageId: message.id, name })
  rememberThreads(key, [thread])
  patchRoot(key, thread.channelId, thread.rootId, thread)
  return thread
}

export async function renameThread(key: string, id: number, name: string): Promise<void> {
  const { thread } = await connectionFor(key)!.request('thread.update', { id, name })
  rememberThreads(key, [thread])
}

export async function deleteThread(key: string, id: number): Promise<void> {
  await connectionFor(key)!.request('thread.delete', { id })
}

export function openThread(key: string, id: number, thread?: Thread): void {
  if (thread) rememberThreads(key, [thread])
  useThreads.setState({ open: { key, id } })
  markThreadRead(key, id)
}

export function closeThread(): void {
  useThreads.setState({ open: null })
}

export function markThreadRead(key: string, id: number): void {
  const server = useApp.getState().servers[key]
  if (!server || (!server.unread[id] && !server.mentions[id])) return
  patchServer(key, (s) => ({ unread: { ...s.unread, [id]: 0 }, mentions: { ...s.mentions, [id]: 0 } }))
}

export function isViewingThread(key: string, id: number): boolean {
  const open = useThreads.getState().open
  return document.hasFocus() && open?.key === key && open.id === id && useApp.getState().activeServer === key
}

/** Unread mentions in a channel's threads (shown on the channel in the sidebar). */
export function threadMentions(server: ServerState, channelId: number): number {
  const threads = useThreads.getState().threads[server.key] ?? {}
  let total = 0
  for (const [id, count] of Object.entries(server.mentions)) {
    if (count && threads[Number(id)]?.channelId === channelId) total += count
  }
  return total
}

/** "#general › Game night" for notifications and search results. */
export function conversationLabel(server: ServerState, channelId: number): string {
  const channel = server.channels.find((c) => c.id === channelId)
  if (channel) return `#${channel.name}`
  const thread = knownThread(server.key, channelId)
  if (!thread) return 'a thread'
  const parent = server.channels.find((c) => c.id === thread.channelId)
  return `#${parent?.name ?? 'channel'} › ${thread.name}`
}

onServerEvent((key, type, body) => {
  if (type === 'thread.updated') {
    const { thread } = body as Events['thread.updated']
    rememberThreads(key, [thread])
    patchRoot(key, thread.channelId, thread.rootId, thread)
  } else if (type === 'thread.deleted') {
    const { id, channelId, rootId } = body as Events['thread.deleted']
    forget(key, id)
    patchRoot(key, channelId, rootId, null)
    patchServer(key, (s) => {
      const messages = { ...s.messages }
      delete messages[id]
      return { messages, unread: { ...s.unread, [id]: 0 }, mentions: { ...s.mentions, [id]: 0 } }
    })
  } else if (type === 'chat.message') {
    const { message } = body as Events['chat.message']
    const server = useApp.getState().servers[key]
    if (!server || !isThreadId(server, message.channelId)) return
    // Learn about threads we haven't seen, so badges and notifications can name them.
    if (!knownThread(key, message.channelId)) void fetchThread(key, message.channelId)
    // The store counts it as unread; undo that when the thread is on screen.
    if (isViewingThread(key, message.channelId)) queueMicrotask(() => markThreadRead(key, message.channelId))
  }
})
