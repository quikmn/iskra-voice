// Read receipts for DMs and group DMs: the rules that need no connection (state/receipts.ts does the rest).
// A receipt names the newest message of a conversation, from someone else, that its sender has read.

export interface ReceiptMark {
  /** The message's id (the same on every device). */
  id: string
  sentAt: number
}

/** The setting that follows the account (sealed, prefs "receipts"). Off unless turned on. */
export interface ReceiptSettings {
  v: 1
  updatedAt: number
  send: boolean
}

export const emptyReceiptSettings = (): ReceiptSettings => ({ v: 1, updatedAt: 0, send: false })

export function parseReceiptSettings(raw: unknown): ReceiptSettings | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (r.v !== 1 || !Number.isSafeInteger(r.updatedAt) || (r.updatedAt as number) < 0 || typeof r.send !== 'boolean') return null
  return { v: 1, updatedAt: r.updatedAt as number, send: r.send }
}

/** A mark as it arrives inside a receipt; null unless well formed. */
export function parseReceiptMark(raw: unknown): ReceiptMark | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { id, sentAt } = raw as Record<string, unknown>
  if (typeof id !== 'string' || id.length === 0 || id.length > 64 || !Number.isSafeInteger(sentAt) || (sentAt as number) < 0) return null
  return { id, sentAt: sentAt as number }
}

/** What the rules look at in a DM or group message. */
export interface ReceiptMessage {
  id: string
  from: string
  sentAt: number
  pending?: unknown
  error?: unknown
  /** Lines that aren't messages someone wrote (friend actions, quiet renames): they are never the thing "seen". */
  quiet?: boolean
}

const real = (m: ReceiptMessage) => !m.pending && !m.error && !m.quiet

/** Of two marks, the one further along; a receipt never moves a mark back. */
export const laterMark = (a: ReceiptMark | undefined, b: ReceiptMark): ReceiptMark => (a && a.sentAt >= b.sentAt ? a : b)

/**
 * The receipt to send for a conversation you are looking at: its newest message from someone else, unless that is
 * what you already sent. `messages` are oldest first.
 */
export function receiptToSend(messages: ReceiptMessage[], me: string, lastSent: ReceiptMark | undefined): ReceiptMark | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.from === me || !real(m)) continue
    if (lastSent && (lastSent.id === m.id || lastSent.sentAt >= m.sentAt)) return null
    return { id: m.id, sentAt: m.sentAt }
  }
  return null
}

/**
 * The last message you sent that a reader's mark covers, or null. The mark names a message by id; when this device
 * doesn't have that message (not loaded, or deleted), the times decide.
 */
export function seenMessage(messages: ReceiptMessage[], me: string, mark: ReceiptMark | undefined): string | null {
  if (!mark) return null
  const at = messages.findIndex((m) => m.id === mark.id)
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.from !== me || !real(m)) continue
    if (at >= 0 ? i <= at : m.sentAt <= mark.sentAt) return m.id
  }
  return null
}

/**
 * Who has seen which of your messages: for each reader, the last message you sent that their mark covers.
 * Keyed by that message's id; readers in the order given. Leaves out yourself.
 */
export function seenBy(messages: ReceiptMessage[], me: string, marks: Record<string, ReceiptMark>, readers: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const reader of readers) {
    if (reader === me) continue
    const id = seenMessage(messages, me, marks[reader])
    if (id) (out[id] ??= []).push(reader)
  }
  return out
}
