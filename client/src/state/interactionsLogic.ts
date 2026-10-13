// The pure parts of bot interactions on this device (tested in interactionsLogic.test.ts).
import type { InteractionResponse } from '../core/protocol'

/** How long an app waits for a first answer before saying the bot didn't answer (PROTOCOL.md: 15 s). */
export const ANSWER_TIMEOUT_MS = 15_000
/** Private answers kept per channel on this device. */
export const MAX_ANSWERS = 20

export interface PendingInteraction {
  serverKey: string
  channelId: number
  bot: string
  /** What was asked, as shown: "/roll", a button's label, a form's title. */
  label: string
  state: 'thinking' | 'deferred' | 'failed'
  startedAt: number
  expiresAt: number
  /** Why it failed (null: the bot didn't answer in time). */
  error: string | null
}

export const channelKey = (serverKey: string, channelId: number) => `${serverKey}:${channelId}`

/** A new private answer goes last; an update replaces the answer in place. */
export function addAnswer(list: InteractionResponse[], answer: InteractionResponse): InteractionResponse[] {
  const at = list.findIndex((a) => a.responseId === answer.responseId)
  if (at >= 0) return list.map((a, i) => (i === at ? { ...answer, createdAt: a.createdAt } : a))
  if (answer.updated) return list // updating one we dismissed: leave it gone
  return [...list, answer].slice(-MAX_ANSWERS)
}

export function settle<T>(pending: Record<string, T>, id: string): Record<string, T> {
  if (!(id in pending)) return pending
  const { [id]: _done, ...rest } = pending
  return rest
}

/** Pending interactions for one channel, oldest first. */
export function pendingIn<T extends { serverKey: string; channelId: number; startedAt: number }>(
  pending: Record<string, T>, serverKey: string, channelId: number,
): [string, T][] {
  return Object.entries(pending)
    .filter(([, p]) => p.serverKey === serverKey && p.channelId === channelId)
    .sort((a, b) => a[1].startedAt - b[1].startedAt)
}
