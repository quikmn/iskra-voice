// Wire types. Source of truth: v2/protocol/PROTOCOL.md.

export type Role = 'guest' | 'member' | 'trusted' | 'admin' | 'owner'
export const ROLES: Role[] = ['guest', 'member', 'trusted', 'admin', 'owner']
export const roleRank = (role: Role): number => ROLES.indexOf(role)

export interface Member {
  accountKey: string
  name: string
  role: Role
  online: boolean
}

export interface Channel {
  id: number
  name: string
  kind: 'text' | 'voice'
  position: number
  readRole: Role
  writeRole: Role
}

export interface Message {
  id: number
  channelId: number
  author: string
  text: string
  createdAt: number
  editedAt: number | null
}

export interface Invite {
  code: string
  role: Role
  createdBy: string
  createdAt: number
  expiresAt: number | null
  maxUses: number | null
  uses: number
}

export interface VoiceParticipant {
  accountKey: string
  muted: boolean
  deafened: boolean
}

export interface VoiceChannelState {
  channelId: number
  participants: VoiceParticipant[]
}

export interface Welcome {
  you: Member
  server: { name: string; key: string; appUrl: string }
  channels: Channel[]
  members: Member[]
  voice: VoiceChannelState[]
  voiceAvailable: boolean
}

/** Server → client events, keyed by type. */
export interface Events {
  'chat.message': { message: Message }
  'chat.edited': { message: Message }
  'chat.deleted': { id: number; channelId: number }
  'chat.typing': { channelId: number; accountKey: string }
  channels: { channels: Channel[] }
  'member.joined': { member: Member }
  'member.updated': { member: Member }
  'member.removed': { accountKey: string }
  kicked: { reason: string }
  'voice.state': VoiceChannelState
  'dm.message': { message: WireDm }
  'voice.available': { available: boolean }
}

export interface WireDm {
  id: number
  from: string
  to: string
  envelope: import('./dm').DmEnvelope
  createdAt: number
}

/** Client → server requests: [body, result]. */
export interface Requests {
  ping: [Record<string, never>, Record<string, never>]
  'chat.send': [{ channelId: number; text: string }, { message: Message }]
  'chat.edit': [{ id: number; text: string }, { message: Message }]
  'chat.delete': [{ id: number }, Record<string, never>]
  'chat.history': [{ channelId: number; before?: number; after?: number; limit?: number }, { messages: Message[]; hasMore: boolean }]
  'chat.typing': [{ channelId: number }, Record<string, never>]
  'channel.create': [{ name: string; kind?: 'text' | 'voice'; readRole?: Role; writeRole?: Role }, { channel: Channel }]
  'channel.update': [{ id: number; name?: string; readRole?: Role; writeRole?: Role }, { channel: Channel }]
  'channel.delete': [{ id: number }, Record<string, never>]
  'profile.update': [{ name: string }, { member: Member }]
  'member.setRole': [{ accountKey: string; role: Role }, { member: Member }]
  'member.kick': [{ accountKey: string }, Record<string, never>]
  'member.ban': [{ accountKey: string; reason?: string }, Record<string, never>]
  'invite.create': [{ role?: Role; maxUses?: number; expiresInMs?: number }, { invite: Invite }]
  'invite.list': [Record<string, never>, { invites: Invite[] }]
  'invite.revoke': [{ code: string }, Record<string, never>]
  'voice.join': [{ channelId: number }, { url: string; token: string; room: string; canSpeak: boolean }]
  'voice.state': [{ muted: boolean; deafened: boolean }, Record<string, never>]
  'dm.devices': [{ accountKey: string }, { devices: import('./identity').DeviceCert[] }]
  'dm.send': [{ accountKey: string; envelope: import('./dm').DmEnvelope }, { message: WireDm }]
  'dm.history': [{ accountKey: string; before?: number; limit?: number }, { messages: WireDm[]; hasMore: boolean }]
  'dm.conversations': [Record<string, never>, { conversations: { accountKey: string; lastId: number; lastAt: number }[] }]
}

export type ErrorCode =
  | 'bad_request' | 'forbidden' | 'not_found' | 'rate_limited' | 'unknown_type' | 'internal'
  | 'auth_failed' | 'invite_required' | 'banned' | 'voice_unavailable'

export class RequestError extends Error {
  readonly code: ErrorCode | 'disconnected' | 'timeout'
  constructor(code: RequestError['code'], message: string) {
    super(message)
    this.code = code
  }
}

export const CloseCodes = {
  BadRequests: 4400,
  AuthFailed: 4401,
  Forbidden: 4403,
  TooLarge: 4413,
} as const
