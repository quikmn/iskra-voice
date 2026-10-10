// Wire types. Source of truth: protocol/PROTOCOL.md.

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

export interface FileInfo {
  id: string
  name: string
  size: number
  type: string
  width: number | null
  height: number | null
  /** Relative to the server's URL. */
  url: string
}

export type ReplyPreview =
  | { id: number; author: string; text: string; hasAttachments: boolean; deleted?: undefined }
  | { id: number; deleted: true }

export interface LinkPreview {
  url: string
  siteName: string | null
  title: string | null
  description: string | null
}

export interface Reaction {
  emoji: string
  accounts: string[]
}

export interface Message {
  id: number
  channelId: number
  author: string
  text: string
  createdAt: number
  editedAt: number | null
  attachments: FileInfo[]
  replyTo: ReplyPreview | null
  reactions: Reaction[]
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
  'chat.reactions': { id: number; channelId: number; reactions: Reaction[] }
  'chat.typing': { channelId: number; accountKey: string }
  channels: { channels: Channel[] }
  'member.joined': { member: Member }
  'member.updated': { member: Member }
  'member.removed': { accountKey: string }
  kicked: { reason: string }
  'voice.state': VoiceChannelState
  'dm.message': { message: WireDm }
  'voice.available': { available: boolean }
  'call.ring': CallRing
  'call.accepted': { callId: string }
  'call.ended': { callId: string; reason: CallEndReason }
  'call.state': { callId: string; participants: string[] }
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
  'chat.send': [{ channelId: number; text: string; attachments?: string[]; replyTo?: number }, { message: Message }]
  'chat.react': [{ id: number; emoji: string; on: boolean }, Record<string, never>]
  'upload.begin': [{ name: string; size: number }, { url: string; maxBytes: number }]
  'link.preview': [{ url: string }, { preview: LinkPreview | null }]
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
  'call.start': [{ accountKey: string; callId: string; video: boolean; envelope: import('./dm').DmEnvelope }, CallMedia]
  'call.accept': [{ callId: string }, CallMedia]
  'call.decline': [{ callId: string; reason?: 'declined' | 'busy' }, Record<string, never>]
  'call.end': [{ callId: string }, Record<string, never>]
  'call.pending': [Record<string, never>, { calls: CallRing[] }]
}

// ── calls ──
export interface WireCall {
  id: string
  from: string
  to: string
  video: boolean
  state: 'ringing' | 'active'
  createdAt: number
}

export type CallEndReason = 'ended' | 'cancelled' | 'declined' | 'busy' | 'no_answer'

/** The callee's ring: the call plus the caller's encrypted invite (which carries the media key). */
export interface CallRing {
  call: WireCall
  envelope: import('./dm').DmEnvelope
}

export interface CallMedia {
  call: WireCall
  url: string
  token: string
  room: string
}

export type ErrorCode =
  | 'bad_request' | 'forbidden' | 'not_found' | 'rate_limited' | 'unknown_type' | 'internal'
  | 'auth_failed' | 'invite_required' | 'banned' | 'voice_unavailable' | 'busy'

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

// ── bots and webhooks ──
// Declaration merging adds fields to the types above. See "Bots and webhooks" in PROTOCOL.md.

export interface Member {
  /** A bot account (set by the server when it joined with a bot invite). */
  bot?: boolean
}

export interface Message {
  /** Set when a webhook posted this message (author is then "webhook:<id>"). */
  webhook?: WebhookPost | null
}

/** A Discord-style embed, text only. */
export interface Embed {
  title?: string
  description?: string
  url?: string
  color?: number
  timestamp?: number
  author?: { name: string; url?: string }
  footer?: { text: string }
  fields?: { name: string; value: string; inline: boolean }[]
}

export interface WebhookPost {
  id: string
  name: string
  avatar: FileInfo | null
  embeds: Embed[]
}

export interface Webhook {
  id: string
  channelId: number
  name: string
  avatar: FileInfo | null
  mentions: boolean
  createdBy: string
  createdAt: number
  lastUsedAt: number | null
}

export interface Requests {
  'bot.invite': [{ role?: Role; expiresInMs?: number }, { invite: Invite }]
  'webhook.list': [{ channelId?: number }, { webhooks: Webhook[] }]
  'webhook.create': [{ channelId: number; name: string; avatar?: string; mentions?: boolean }, { webhook: Webhook; secret: string; path: string }]
  'webhook.update': [{ id: string; name?: string; avatar?: string; mentions?: boolean; channelId?: number }, { webhook: Webhook }]
  'webhook.regenerate': [{ id: string }, { webhook: Webhook; secret: string; path: string }]
  'webhook.delete': [{ id: string }, Record<string, never>]
}
