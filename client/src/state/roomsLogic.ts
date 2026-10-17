// Pure rules for join-to-create voice rooms (unit-tested; no React or sockets here). Mirrors RoomFeature on the server.
import type { Channel, Member } from '../core/protocol'

export const MAX_ROOM_NAME = 60

export const isLobby = (channel: Pick<Channel, 'kind' | 'lobby'> | undefined) => !!channel && channel.kind === 'voice' && !!channel.lobby
export const isRoom = (channel: Pick<Channel, 'room'> | undefined) => !!channel?.room

/** You host the room, or you manage channels (admins): the room's settings are yours to change. */
export function hostsRoom(channel: Pick<Channel, 'room'> | undefined, me: Member | null | undefined, managesChannels: boolean): boolean {
  if (!channel?.room || !me) return false
  return channel.room.host === me.accountKey || managesChannels
}

/** May you join this room as it is locked right now? (The server checks again; moved people get in for a minute too.) */
export function canEnterRoom(channel: Pick<Channel, 'room'> | undefined, me: Member | null | undefined, canMoveMembers: boolean): boolean {
  if (!channel?.room?.locked) return true
  if (!me) return false
  return channel.room.host === me.accountKey || channel.room.invited.includes(me.accountKey) || canMoveMembers
}

/** The room you're in and host, if the voice session is one. */
export function hostedRoom(channels: Channel[], channelId: number | undefined, me: Member | null | undefined, managesChannels: boolean): Channel | null {
  const channel = channels.find((c) => c.id === channelId)
  return channel && hostsRoom(channel, me, managesChannels) ? channel : null
}

/** The room name as the server will keep it (lowercase, words joined with dashes), or null when it's empty. */
export function roomSlug(raw: string): string | null {
  const slug = raw.trim().toLowerCase().split(/\s+/).filter(Boolean).join('-')
  return slug.length > 0 && slug.length <= MAX_ROOM_NAME ? slug : null
}
