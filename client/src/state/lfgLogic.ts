// Looking for group, the pure parts: a post's state, "/lfg 3 Valheim", and the time field. Tested in lfgLogic.test.ts.
import type { Lfg } from '../core/protocol'

export const LFG_LIMITS = { game: 100, note: 200, minSlots: 1, maxSlots: 20 } as const

export type LfgStatus = 'open' | 'full' | 'closed'

export function lfgStatus(lfg: Lfg, now: number): LfgStatus {
  if (lfg.closedAt !== null || now >= lfg.expiresAt) return 'closed'
  return lfg.joined.length >= lfg.slots ? 'full' : 'open'
}

export const slotsLeft = (lfg: Lfg) => Math.max(0, lfg.slots - lfg.joined.length)

/** "/lfg 3 Valheim" → 3 people for Valheim; "/lfg Valheim" leaves the number to the dialog. */
export function parseLfgArgs(args: string): { slots: number | null; game: string } {
  const text = args.trim()
  const match = /^(\d{1,2})\s+(?:(?:for|till|för)\s+)?(.+)$/iu.exec(text)
  if (match) {
    const n = Number(match[1])
    if (n >= LFG_LIMITS.minSlots && n <= LFG_LIMITS.maxSlots) return { slots: n, game: match[2].trim().slice(0, LFG_LIMITS.game) }
  }
  return { slots: null, game: text.slice(0, LFG_LIMITS.game) }
}

const pad = (n: number) => String(n).padStart(2, '0')

/** A time for an <input type="datetime-local"> (the device's own time zone). */
export function toLocalInput(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Back from the input; null when empty or not a time. */
export function fromLocalInput(value: string): number | null {
  if (!value) return null
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms : null
}

/** The suggested start: the next full hour, at least 30 minutes away. */
export function defaultStart(now: number): number {
  const d = new Date(now + 30 * 60_000)
  d.setMinutes(0, 0, 0)
  d.setHours(d.getHours() + 1)
  return d.getTime()
}

/** Whether a time is one the server takes: from 5 minutes ago up to a week ahead. */
export const validStart = (ms: number, now: number) => ms >= now - 5 * 60_000 && ms <= now + 7 * 24 * 3_600_000
