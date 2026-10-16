// The moderators' tool pack (PROTOCOL.md "Mod pack"): selecting messages to delete together, warnings (and the notice
// when you get one), private notes about a person, their moderation history, and people who left. The server checks
// every request; what's shown comes back from it.
import { create } from 'zustand'
import type { AuditEntry, Departed, Events, ModNote } from '../core/protocol'
import { t } from '../i18n'
import { connectionFor, onServerEvent } from './store'

function connection(serverKey: string) {
  const c = connectionFor(serverKey)
  if (!c) throw new Error(t('errors.codes.disconnected'))
  return c
}

// ── Selecting messages ──────────────────────────────────────────────────────

interface BulkSelectState {
  /** The channel being selected in, and what's ticked (ids), or null. */
  selecting: { serverKey: string; channelId: number; ids: number[] } | null
}

export const useBulkSelect = create<BulkSelectState>(() => ({ selecting: null }))

export const MAX_BULK_DELETE = 100

export const startSelecting = (serverKey: string, channelId: number, firstId?: number) =>
  useBulkSelect.setState({ selecting: { serverKey, channelId, ids: firstId === undefined ? [] : [firstId] } })

export const stopSelecting = () => useBulkSelect.setState({ selecting: null })

export function toggleSelected(id: number): void {
  useBulkSelect.setState((s) => {
    if (!s.selecting) return s
    const has = s.selecting.ids.includes(id)
    if (!has && s.selecting.ids.length >= MAX_BULK_DELETE) return s
    return { selecting: { ...s.selecting, ids: has ? s.selecting.ids.filter((x) => x !== id) : [...s.selecting.ids, id] } }
  })
}

/** Is selection on in this channel? (Rows show their tick boxes.) */
export const useSelectingIn = (serverKey: string, channelId: number) =>
  useBulkSelect((s) => s.selecting?.serverKey === serverKey && s.selecting.channelId === channelId)

export const useIsSelected = (id: number) => useBulkSelect((s) => !!s.selecting?.ids.includes(id))

/** Deletes what's ticked; the rows vanish when the server's `chat.deleted` events arrive. */
export async function deleteSelected(): Promise<number> {
  const current = useBulkSelect.getState().selecting
  if (!current || current.ids.length === 0) return 0
  const { deleted } = await connection(current.serverKey).request('chat.delete.bulk', { channelId: current.channelId, ids: current.ids })
  stopSelecting()
  return deleted
}

// ── Warnings ────────────────────────────────────────────────────────────────

export interface Warning { serverKey: string; reason: string; byName: string; at: number }

/** Warnings you received this session, newest last (shown as a notice until dismissed). */
export const useWarnings = create<{ list: Warning[] }>(() => ({ list: [] }))

export const dismissWarning = (at: number) => useWarnings.setState((s) => ({ list: s.list.filter((w) => w.at !== at) }))

onServerEvent((serverKey, type, body) => {
  if (type !== 'member.warned') return
  const { reason, byName, at } = body as Events['member.warned']
  useWarnings.setState((s) => ({ list: [...s.list, { serverKey, reason, byName, at }] }))
})

export async function warnMember(serverKey: string, accountKey: string, reason: string): Promise<void> {
  await connection(serverKey).request('member.warn', { accountKey, reason: reason.trim() })
}

// ── Notes, history, people who left ─────────────────────────────────────────

export async function listNotes(serverKey: string, accountKey: string): Promise<ModNote[]> {
  return (await connection(serverKey).request('member.notes.list', { accountKey })).notes
}

export async function addNote(serverKey: string, accountKey: string, text: string): Promise<ModNote> {
  return (await connection(serverKey).request('member.notes.add', { accountKey, text: text.trim() })).note
}

export async function deleteNote(serverKey: string, id: number): Promise<void> {
  await connection(serverKey).request('member.notes.delete', { id })
}

export async function loadHistory(serverKey: string, accountKey: string): Promise<AuditEntry[]> {
  return (await connection(serverKey).request('member.history', { accountKey })).entries
}

export async function loadDeparted(serverKey: string): Promise<Departed[]> {
  return (await connection(serverKey).request('member.departed', {})).people
}

export async function banAccount(serverKey: string, accountKey: string, deleteMessagesMs?: number): Promise<number> {
  const reply = await connection(serverKey).request('member.ban', { accountKey, ...(deleteMessagesMs ? { deleteMessagesMs } : {}) })
  return reply.deletedMessages ?? 0
}

export async function unbanAccount(serverKey: string, accountKey: string): Promise<void> {
  await connection(serverKey).request('member.unban', { accountKey })
}
