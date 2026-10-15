// Whisper lists and priority ducking: the pure parts of state/whisper.ts (no LiveKit, no DOM), unit-tested.
import type { VoiceParticipant } from '../core/protocol'

export type WhisperSlot = 1 | 2 | 3
export const SLOTS: readonly WhisperSlot[] = [1, 2, 3]
export const MAX_PEOPLE = 25

/** Who a whisper list goes to: chosen people (anywhere in voice on the server) or everyone in one voice channel. */
export type WhisperTarget = { kind: 'people'; people: string[] } | { kind: 'channel'; channelId: number }

export interface WhisperList {
  slot: WhisperSlot
  /** Your own name for it ("Team", "Leads"); empty: the app names it by its targets. */
  name: string
  target: WhisperTarget | null
}

export const emptyLists = (): WhisperList[] => SLOTS.map((slot) => ({ slot, name: '', target: null }))

const isKey = (k: unknown): k is string => typeof k === 'string' && k.length > 0 && k.length <= 64

/** One server's lists from storage, keeping only what's well-formed (always three, in slot order). */
export function parseLists(raw: unknown): WhisperList[] {
  const lists = emptyLists()
  if (!Array.isArray(raw)) return lists
  for (const item of raw) {
    const v = item as { slot?: unknown; name?: unknown; target?: { kind?: unknown; people?: unknown; channelId?: unknown } | null }
    if (!v || typeof v !== 'object' || !SLOTS.includes(v.slot as WhisperSlot)) continue
    const list = lists[(v.slot as number) - 1]
    list.name = typeof v.name === 'string' ? v.name.slice(0, 32) : ''
    const t = v.target
    if (t?.kind === 'people' && Array.isArray(t.people)) {
      const people = [...new Set(t.people.filter(isKey))].slice(0, MAX_PEOPLE)
      list.target = people.length ? { kind: 'people', people } : null
    } else if (t?.kind === 'channel' && Number.isInteger(t.channelId) && (t.channelId as number) > 0) {
      list.target = { kind: 'channel', channelId: t.channelId as number }
    }
  }
  return lists
}

/** The whisper.start body for a list (null: nothing to whisper to). */
export function startBody(list: WhisperList): { slot: WhisperSlot; targets?: string[]; channelId?: number } | null {
  if (!list.target) return null
  return list.target.kind === 'channel'
    ? { slot: list.slot, channelId: list.target.channelId }
    : { slot: list.slot, targets: list.target.people }
}

/** dB to a volume factor (−12 dB ≈ 0.25). */
export const dbToGain = (db: number): number => Math.pow(10, -Math.abs(db) / 20)

export const DUCK_CHOICES = [6, 12, 18, 24] as const
export const DEFAULT_DUCK_DB = 12

/**
 * How loud to play `accountKey` right now: turned down by `duckDb` while someone else with priority is speaking
 * (people with priority themselves never are). Your own priority doesn't turn others down for you.
 */
export function duckFactor(
  accountKey: string, participants: readonly VoiceParticipant[], speaking: Record<string, true>, me: string | undefined, duckDb: number,
): number {
  if (duckDb <= 0) return 1
  const prioritySpeaking = participants.some((p) => p.priority && p.accountKey !== me && p.accountKey !== accountKey && speaking[p.accountKey])
  const isPriority = participants.some((p) => p.accountKey === accountKey && p.priority)
  return prioritySpeaking && !isPriority ? dbToGain(duckDb) : 1
}

/** Whether anyone else with priority is speaking (the badge on the call bar). */
export const priorityTalking = (participants: readonly VoiceParticipant[], speaking: Record<string, true>, me: string | undefined): string | null =>
  participants.find((p) => p.priority && p.accountKey !== me && speaking[p.accountKey])?.accountKey ?? null
