// Non-component helpers for pins and threads in the message list.
import type { PinNote } from '../../state/pins'
import type { PendingMessage } from '../../state/store'
import { messageTime } from '../format'

/** "3m ago", "2h ago", or a date. */
export function relativeTime(ms: number, now = Date.now()): string {
  const minutes = Math.floor((now - ms) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ago`
  return messageTime(ms, now)
}

export interface ListItem {
  message: PendingMessage
  grouped: boolean
  note?: PinNote
}

/** Places pin notes after the last message sent before them. Notes older than the loaded messages are left out. */
export function withPinNotes(rendered: { message: PendingMessage; grouped: boolean }[], notes: PinNote[] | undefined): ListItem[] {
  if (!notes?.length || rendered.length === 0) return rendered
  const out: ListItem[] = []
  const pending = [...notes].sort((a, b) => a.at - b.at)
  let n = 0
  while (n < pending.length && pending[n].at < rendered[0].message.createdAt) n++
  rendered.forEach((item, i) => {
    out.push(item)
    const next = rendered[i + 1]
    while (n < pending.length && (!next || next.message.tempId || pending[n].at < next.message.createdAt)) {
      out.push({ message: item.message, grouped: false, note: pending[n++] })
    }
  })
  return out
}
