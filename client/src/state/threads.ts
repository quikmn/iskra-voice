// Threads: side conversations under a message. On the wire a thread is a channel id of its own,
// so its messages and typing live in the server state, and its read state in readState.ts, like any channel's.
import { create } from 'zustand'
import { t } from '../i18n'
import type { Events, Message, Thread } from '../core/protocol'
import { connectionFor, forgetChannels, onChannelsGone, onServerEvent, patchServer, useApp, type ServerState } from './store'
import { channelConv, forgetConversation, seeConversation } from './readState'

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
  // Threads in encrypted channels have no name on the server: they're just "Thread".
  const sealed = new Set(useApp.getState().servers[key]?.channels.filter((c) => c.e2ee).map((c) => c.id))
  const named = list.map((th) => (sealed.has(th.channelId) ? { ...th, name: t('e2ee.thread.title') } : th))
  useThreads.setState((s) => ({ threads: { ...s.threads, [key]: { ...s.threads[key], ...Object.fromEntries(named.map((th) => [th.id, th])) } } }))
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
  if (!connection) throw new Error(t('errors.codes.disconnected'))
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
  seeConversation(channelConv(key, id))
}

export function closeThread(): void {
  useThreads.setState({ open: null })
}

/** "#general › Game night" for notifications and search results. */
export function conversationLabel(server: ServerState, channelId: number): string {
  const channel = server.channels.find((c) => c.id === channelId)
  if (channel) return `#${channel.name}`
  const thread = knownThread(server.key, channelId)
  if (!thread) return t('chat.threads.aThread')
  const parent = server.channels.find((c) => c.id === thread.channelId)
  return `#${parent?.name ?? t('chat.threads.channel')} › ${thread.name}`
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
      return { messages }
    })
    forgetConversation(channelConv(key, id))
  } else if (type === 'chat.message') {
    const { message } = body as Events['chat.message']
    const server = useApp.getState().servers[key]
    if (!server || !isThreadId(server, message.channelId)) return
    // Learn about threads we haven't seen, so badges and notifications can name them.
    if (!knownThread(key, message.channelId)) void fetchThread(key, message.channelId)
  }
})

// A channel that's gone takes its threads (their messages, drafts and read state) with it.
// Messages kept under an id that is neither a listed channel nor a known thread may belong to a thread of the channel
// that went (one this device never looked up): they go too (opening a thread fetches it again).
onChannelsGone((key, channelIds, how) => {
  const gone = new Set(channelIds)
  const threads = Object.values(useThreads.getState().threads[key] ?? {}).filter((th) => gone.has(th.channelId) || gone.has(th.id))
  for (const th of threads) forget(key, th.id)
  const server = useApp.getState().servers[key]
  const known = useThreads.getState().threads[key] ?? {}
  const unknown = server
    ? Object.keys(server.messages).map(Number).filter((id) => !gone.has(id) && !server.channels.some((c) => c.id === id) && !known[id])
    : []
  forgetChannels(key, [...new Set([...threads.map((th) => th.id), ...unknown])].filter((id) => !gone.has(id)), how)
})
