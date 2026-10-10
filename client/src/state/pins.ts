// Pinned messages. Pinning is announced with an event; the "X pinned a message" note in the
// timeline is drawn from it (it isn't a message, so it isn't in history after a reload).
import { create } from 'zustand'
import { roleRank, type Events, type Message, type Pin } from '../core/protocol'
import { connectionFor, onServerEvent, patchServer, type ServerState } from './store'
import { knownThread } from './threads'

export interface PinNote {
  messageId: number
  by: string
  at: number
}

export const MAX_PINS = 50

/** `${serverKey}:${channelId}` → pin notes seen this session; version changes whenever a pin list may have. */
export const usePinNotes = create<{ notes: Record<string, PinNote[]>; version: number }>(() => ({ notes: {}, version: 0 }))

const noteKey = (serverKey: string, channelId: number) => `${serverKey}:${channelId}`
export const pinNotesFor = (serverKey: string, channelId: number) => (s: { notes: Record<string, PinNote[]> }) =>
  s.notes[noteKey(serverKey, channelId)]

/** Trusted+ who can write where the message is (threads follow their channel). Mirrors Permissions.CanPin. */
export function canPin(server: ServerState, channelId: number): boolean {
  const me = server.me
  if (!me || roleRank(me.role) < roleRank('trusted')) return false
  const parentId = knownThread(server.key, channelId)?.channelId ?? channelId
  const channel = server.channels.find((c) => c.id === parentId)
  return !!channel && roleRank(me.role) >= roleRank(channel.writeRole)
}

export async function setPinned(serverKey: string, message: Message, on: boolean): Promise<void> {
  const connection = connectionFor(serverKey)
  if (!connection) throw new Error('Not connected.')
  await connection.request('chat.pin', { id: message.id, on })
}

export async function loadPins(serverKey: string, channelId: number): Promise<Pin[]> {
  const connection = connectionFor(serverKey)
  if (!connection) return []
  return (await connection.request('pin.list', { channelId })).pins
}

onServerEvent((key, type, body) => {
  if (type === 'chat.deleted' || type === 'chat.edited') usePinNotes.setState((s) => ({ version: s.version + 1 }))
  if (type !== 'chat.pinned') return
  const { id, channelId, on, by, at } = body as Events['chat.pinned']
  patchServer(key, (s) => {
    const list = s.messages[channelId]
    if (!list) return {}
    return { messages: { ...s.messages, [channelId]: list.map((m) => (m.id === id && !m.tempId ? { ...m, pinned: on } : m)) } }
  })
  usePinNotes.setState((s) => ({ version: s.version + 1 }))
  if (on) {
    usePinNotes.setState((s) => ({
      notes: { ...s.notes, [noteKey(key, channelId)]: [...(s.notes[noteKey(key, channelId)] ?? []), { messageId: id, by, at }] },
    }))
  }
})
