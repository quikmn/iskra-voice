// Jumping to any message (search results, pins, reply quotes, notifications) through one path:
// select its channel (and thread), load history around it if it isn't loaded, then scroll to it.
import { useLayoutEffect, type RefObject } from 'react'
import { create } from 'zustand'
import { connectionFor, patchServer, selectChannel, selectServer, upsertMessage, useApp } from './store'
import { knownThread, fetchThread, openThread } from './threads'
import { setStageOpen } from './voice'

interface JumpTarget {
  key: string
  channelId: number
  messageId: number
  n: number
}

export const useJump = create<{ target: JumpTarget | null }>(() => ({ target: null }))
let counter = 0

/** Replaces a channel's loaded history with the messages around one message. */
export async function loadAround(key: string, channelId: number, messageId: number): Promise<boolean> {
  const connection = connectionFor(key)
  if (!connection?.isOnline) return false
  try {
    const { messages, hasMore, hasNewer } = await connection.request('chat.history', { channelId, around: messageId, limit: 50 })
    patchServer(key, (s) => ({
      messages: { ...s.messages, [channelId]: messages },
      hasMore: { ...s.hasMore, [channelId]: hasMore },
      detached: { ...s.detached, [channelId]: !!hasNewer },
    }))
    return true
  } catch {
    return false
  }
}

const loadingNewer = new Set<string>()

/** Scrolled to the bottom of an older stretch: load the next newer page. */
export async function loadNewer(key: string, channelId: number): Promise<void> {
  const server = useApp.getState().servers[key]
  const connection = connectionFor(key)
  const last = server?.messages[channelId]?.filter((m) => !m.tempId).at(-1)
  const tag = `${key}:${channelId}`
  if (!connection?.isOnline || !last || !server.detached?.[channelId] || loadingNewer.has(tag)) return
  loadingNewer.add(tag)
  try {
    const { messages, hasMore } = await connection.request('chat.history', { channelId, after: last.id, limit: 50 })
    patchServer(key, (s) => ({
      messages: { ...s.messages, [channelId]: messages.reduce(upsertMessage, s.messages[channelId] ?? []) },
      detached: { ...s.detached, [channelId]: hasMore },
    }))
  } catch {
    /* try again on the next scroll */
  } finally {
    loadingNewer.delete(tag)
  }
}

/** Back to the latest messages (and live updates). */
export async function jumpToPresent(key: string, channelId: number): Promise<void> {
  const connection = connectionFor(key)
  if (!connection?.isOnline) return
  try {
    const { messages, hasMore } = await connection.request('chat.history', { channelId, limit: 50 })
    patchServer(key, (s) => ({
      messages: { ...s.messages, [channelId]: messages },
      hasMore: { ...s.hasMore, [channelId]: hasMore },
      detached: { ...s.detached, [channelId]: false },
    }))
  } catch {
    /* stays where it is */
  }
}

/** Opens the channel or thread a message is in and scrolls to it. Resolves false if it can't be shown. */
export async function jumpToMessage(key: string, channelId: number, messageId: number): Promise<boolean> {
  const state = useApp.getState()
  const server = state.servers[key]
  if (!server) return false
  if (state.activeServer !== key) selectServer(key)

  if (server.channels.some((c) => c.id === channelId)) {
    if (state.activeChannel[key] !== channelId) selectChannel(key, channelId)
  } else {
    // Not a channel: a thread. Open its parent with the thread beside it.
    const thread = knownThread(key, channelId) ?? (await fetchThread(key, channelId))
    if (!thread) return false
    if (useApp.getState().activeChannel[key] !== thread.channelId) selectChannel(key, thread.channelId)
    openThread(key, thread.id)
  }
  setStageOpen(false)

  const list = useApp.getState().servers[key]?.messages[channelId]
  if (!list?.some((m) => m.id === messageId && !m.tempId) && !(await loadAround(key, channelId, messageId))) return false
  useJump.setState({ target: { key, channelId, messageId, n: ++counter } })
  return true
}

/** Highlight a message for a moment. */
export function flash(element: Element): void {
  element.classList.remove('flash')
  void (element as HTMLElement).offsetWidth // restart the animation
  element.classList.add('flash')
  setTimeout(() => element.classList.remove('flash'), 1600)
}

/** In a message list: scroll to the jump target once it has rendered. */
export function useJumpTarget(key: string, channelId: number, scroller: RefObject<HTMLDivElement | null>, onJumped: () => void, deps: unknown): void {
  const target = useJump((s) => s.target)
  useLayoutEffect(() => {
    if (!target || target.key !== key || target.channelId !== channelId) return
    const element = scroller.current?.querySelector(`#msg-${target.messageId}`)
    if (!element) return
    onJumped()
    element.scrollIntoView({ block: 'center' })
    flash(element)
    useJump.setState({ target: null })
  }, [target, key, channelId, deps, scroller, onJumped])
}
