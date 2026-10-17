// Join-to-create voice rooms: the room settings dialog (which room it's for) and the host's requests. Rooms themselves
// arrive and go through the ordinary `channels` events (store.ts), with `channel.room` saying who hosts and who may join.
import { create } from 'zustand'
import type { Channel } from '../core/protocol'
import { connectionFor, useApp } from './store'
import { t } from '../i18n'

interface RoomsState {
  /** The room settings dialog: which room it's open for. */
  open: { serverKey: string; channelId: number } | null
}

export const useRooms = create<RoomsState>(() => ({ open: null }))

export const openRoomSettings = (serverKey: string, channelId: number) => useRooms.setState({ open: { serverKey, channelId } })
export const closeRoomSettings = () => useRooms.setState({ open: null })

function connection(serverKey: string) {
  const c = connectionFor(serverKey)
  if (!c) throw new Error(t('errors.codes.disconnected'))
  return c
}

export async function updateRoom(serverKey: string, channelId: number, change: { name?: string; userLimit?: number; locked?: boolean }): Promise<Channel> {
  const { channel } = await connection(serverKey).request('room.update', { channelId, ...change })
  return channel
}

export async function setRoomInvite(serverKey: string, channelId: number, accountKey: string, on: boolean): Promise<Channel> {
  const { channel } = await connection(serverKey).request(on ? 'room.invite' : 'room.uninvite', { channelId, accountKey })
  return channel
}

// The dialog closes when its room is gone (deleted once empty) or its server left.
useApp.subscribe((state) => {
  const open = useRooms.getState().open
  if (!open) return
  const server = state.servers[open.serverKey]
  if (!server || !server.channels.some((c) => c.id === open.channelId && c.room)) closeRoomSettings()
})
