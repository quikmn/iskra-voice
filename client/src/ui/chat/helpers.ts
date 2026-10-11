// Non-component helpers shared by the chat UI.
import { create } from 'zustand'
import type { Message } from '../../core/protocol'
import { formatNumber } from '../../i18n/format'

/** Which message the composer is replying to, per server+channel. */
export const useReply = create<{ replyTo: Record<string, Message | null> }>(() => ({ replyTo: {} }))
export const replyKey = (serverKey: string, channelId: number) => `${serverKey}:${channelId}`
export function setReply(serverKey: string, channelId: number, message: Message | null) {
  useReply.setState((s) => ({ replyTo: { ...s.replyTo, [replyKey(serverKey, channelId)]: message } }))
}

/** "512 B", "34 KB", "1.5 MB", "2.25 GB", with the language's decimal mark. */
export function formatSize(bytes: number): string {
  const n = (value: number, digits: number) => formatNumber(value, { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false })
  if (bytes < 1024) return `${n(bytes, 0)} B`
  if (bytes < 1024 * 1024) return `${n(bytes / 1024, 0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${n(bytes / 1024 / 1024, 1)} MB`
  return `${n(bytes / 1024 / 1024 / 1024, 2)} GB`
}

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '🎉', '👀', '✅', '❌', '💯', '🙏', '😎', '🤔', '👋', 'GG']

/** The first link in a message, outside code. */
export function firstLink(text: string): string | null {
  const withoutCode = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '')
  return /https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/.exec(withoutCode)?.[0] ?? null
}
