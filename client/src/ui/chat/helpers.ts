// Non-component helpers shared by the chat UI.
import { create } from 'zustand'
import type { Message } from '../../core/protocol'

/** Which message the composer is replying to, per server+channel. */
export const useReply = create<{ replyTo: Record<string, Message | null> }>(() => ({ replyTo: {} }))
export const replyKey = (serverKey: string, channelId: number) => `${serverKey}:${channelId}`
export function setReply(serverKey: string, channelId: number, message: Message | null) {
  useReply.setState((s) => ({ replyTo: { ...s.replyTo, [replyKey(serverKey, channelId)]: message } }))
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '🎉', '👀', '✅', '❌', '💯', '🙏', '😎', '🤔', '👋', 'GG']

/** The first link in a message, outside code. */
export function firstLink(text: string): string | null {
  const withoutCode = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '')
  return /https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/.exec(withoutCode)?.[0] ?? null
}
