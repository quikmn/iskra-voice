// Wire types. Source of truth: protocol/PROTOCOL.md.

export type Role = 'guest' | 'member' | 'trusted' | 'admin' | 'owner'
export const ROLES: Role[] = ['guest', 'member', 'trusted', 'admin', 'owner']
export const roleRank = (role: Role): number => ROLES.indexOf(role)

export interface Member extends PublicProfile {
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
  server: { name: string; key: string; appUrl: string; publicUrl?: string | null; profilePages?: boolean }
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
  'device.revoked': { deviceKey: string }
  'link.request': LinkRequest
  'call.ring': CallRing
  'call.accepted': { callId: string }
  'call.ended': { callId: string; reason: CallEndReason }
  'call.state': { callId: string; participants: string[] }
  'profile.pages': { enabled: boolean }
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
  'chat.history': [{ channelId: number; before?: number; after?: number; around?: number; limit?: number }, { messages: Message[]; hasMore: boolean; hasNewer?: boolean }]
  'chat.typing': [{ channelId: number }, Record<string, never>]
  'channel.create': [{ name: string; kind?: 'text' | 'voice'; readRole?: Role; writeRole?: Role }, { channel: Channel }]
  'channel.update': [{ id: number; name?: string; readRole?: Role; writeRole?: Role }, { channel: Channel }]
  'channel.delete': [{ id: number }, Record<string, never>]
  'profile.update': [ProfileUpdate, { member: Member }]
  'profile.page.set': [{ file: string }, { member: Member }]
  'profile.page.remove': [{ accountKey?: string }, Record<string, never>]
  'profile.pages.configure': [{ enabled: boolean }, Record<string, never>]
  'member.setRole': [{ accountKey: string; role: Role }, { member: Member }]
  'member.kick': [{ accountKey: string }, Record<string, never>]
  'member.ban': [{ accountKey: string; reason?: string }, Record<string, never>]
  'invite.create': [{ role?: Role; maxUses?: number; expiresInMs?: number }, { invite: Invite }]
  'invite.list': [Record<string, never>, { invites: Invite[] }]
  'invite.revoke': [{ code: string }, Record<string, never>]
  'voice.join': [{ channelId: number }, { url: string; token: string; room: string; canSpeak: boolean }]
  'voice.state': [{ muted: boolean; deafened: boolean }, Record<string, never>]
  'dm.devices': [{ accountKey: string }, DeviceBundle]
  'dm.send': [{ accountKey: string; envelope: import('./dm').DmEnvelope }, { message: WireDm }]
  'dm.history': [{ accountKey: string; before?: number; limit?: number }, { messages: WireDm[]; hasMore: boolean }]
  'dm.conversations': [Record<string, never>, { conversations: { accountKey: string; lastId: number; lastAt: number }[] }]
  'device.list': [Record<string, never>, { devices: DeviceInfo[]; revoked: Revocation[] }]
  'device.describe': [{ name?: string; platform?: string }, Record<string, never>]
  'device.rename': [{ deviceKey: string; name: string }, Record<string, never>]
  'device.revoke': [Revocation, Record<string, never>]
  'prekey.publish': [{ key: string; created: number; sig: string }, Record<string, never>]
  'link.create': [Record<string, never>, { token: string; putKey: string; expiresAt: number }]
  'link.respond': [{ token: string; epk: string; mac: string }, Record<string, never>]
  'link.cancel': [{ token: string }, Record<string, never>]
  'push.status': [Record<string, never>, { publicKey: string; endpoint: string | null }]
  'push.subscribe': [PushSubscriptionBody, Record<string, never>]
  'push.unsubscribe': [Record<string, never>, Record<string, never>]
  'push.focus': [{ focused: boolean }, Record<string, never>]
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

// ── push ──
export interface PushSubscriptionBody {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

// ── identity: devices, revocations, prekeys, device linking ──
type Revocation = import('./devices').Revocation

/** What `dm.devices` returns: everything a sender needs to encrypt to someone's devices. */
export interface DeviceBundle {
  devices: import('./identity').DeviceCert[]
  /** Added with forward secrecy; older servers leave these out. */
  prekeys?: import('./devices').SignedPrekey[]
  revoked?: Revocation[]
}

export interface DeviceInfo {
  deviceKey: string
  created: number
  name: string | null
  platform: string | null
  lastSeen: number
  /** The device asking. */
  current: boolean
}

export interface LinkRequest {
  token: string
  epk: string
  mac: string
  info: string | null
}

// ── profiles ──

/** Profile fields on every Member. URLs are relative to the server. Older servers leave them out. */
export interface PublicProfile {
  avatar?: string | null
  /** SHA-256 (hex) of the avatar file, so clients can tell whether theirs is current. */
  avatarHash?: string | null
  bio?: string | null
  pronouns?: string | null
  accent?: string | null
  page?: string | null
  pageHash?: string | null
}

/** Every field is optional; "" clears it. `avatar` is the id of your own uploaded image. */
export interface ProfileUpdate {
  name?: string
  bio?: string
  pronouns?: string
  accent?: string
  avatar?: string
}

export type ErrorCode =
  | 'bad_request' | 'forbidden' | 'not_found' | 'rate_limited' | 'unknown_type' | 'internal'
  | 'auth_failed' | 'invite_required' | 'banned' | 'voice_unavailable' | 'busy' | 'device_revoked'

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

// ── pins, search and threads ──

export interface Thread {
  id: number
  /** The parent channel. */
  channelId: number
  rootId: number
  name: string
  createdBy: string
  createdAt: number
  messageCount: number
  lastMessageAt: number | null
}

export interface Pin {
  message: Message
  pinnedBy: string
  pinnedAt: number
}

export interface SearchRequest {
  query?: string
  channelId?: number
  author?: string
  has?: ('file' | 'link')[]
  before?: number
  after?: number
  cursor?: number
  limit?: number
}

export interface SearchResult {
  message: Message
  /** [start, length] in UTF-16 units of message.text. */
  matches: [number, number][]
}

export interface Message {
  pinned?: boolean
  thread?: Thread | null
}

export interface Events {
  'chat.pinned': { id: number; channelId: number; on: boolean; by: string; at: number }
  'thread.updated': { thread: Thread }
  'thread.deleted': { id: number; channelId: number; rootId: number }
}

export interface Requests {
  'chat.pin': [{ id: number; on: boolean }, Record<string, never>]
  'pin.list': [{ channelId: number }, { pins: Pin[] }]
  search: [SearchRequest, { results: SearchResult[]; total: number; totalCapped?: boolean; hasMore: boolean; threads: Thread[] }]
  'thread.create': [{ messageId: number; name: string }, { thread: Thread }]
  'thread.get': [{ id: number }, { thread: Thread; root: Message | null }]
  'thread.list': [{ channelId: number; limit?: number }, { threads: Thread[] }]
  'thread.update': [{ id: number; name: string }, { thread: Thread }]
  'thread.delete': [{ id: number }, Record<string, never>]
}

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

// ── polls, custom emoji, soundboard ──
// (Declaration merging adds the new fields, events and requests to the interfaces above.)

export interface PollOption {
  text: string
  /** accountKeys, in the order they voted. */
  votes: string[]
}

export interface Poll {
  question: string
  options: PollOption[]
  multi: boolean
  expiresAt: number | null
  closedAt: number | null
}

export interface Message {
  /** Present on poll messages (the message text is the question). */
  poll?: Poll | null
}

/** A server emoji. Written in messages and reactions as <:name:id>. */
export interface CustomEmoji {
  id: string
  name: string
  /** Relative to the server's URL. */
  url: string | null
  animated: boolean
  createdBy: string
}

export interface Sound {
  id: string
  name: string
  emoji: string | null
  /** Relative to the server's URL. */
  url: string | null
  durationMs: number
  createdBy: string
}

export interface Events {
  'poll.updated': { id: number; channelId: number; poll: Poll }
  'emoji.updated': { emojis: CustomEmoji[] }
  'sounds.updated': { sounds: Sound[] }
  'sound.played': { channelId: number; accountKey: string; sound: Sound }
}

export interface Requests {
  'poll.create': [{ channelId: number; question: string; options: string[]; multi?: boolean; durationMs?: number }, { message: Message }]
  'poll.vote': [{ id: number; options: number[] }, Record<string, never>]
  'poll.end': [{ id: number }, Record<string, never>]
  'emoji.list': [Record<string, never>, { emojis: CustomEmoji[] }]
  'emoji.create': [{ name: string; fileId: string }, { emoji: CustomEmoji }]
  'emoji.rename': [{ id: string; name: string }, { emoji: CustomEmoji }]
  'emoji.delete': [{ id: string }, Record<string, never>]
  'sound.list': [Record<string, never>, { sounds: Sound[] }]
  'sound.create': [{ name: string; emoji?: string | null; fileId: string }, { sound: Sound }]
  'sound.update': [{ id: string; name: string; emoji?: string | null }, { sound: Sound }]
  'sound.delete': [{ id: string }, Record<string, never>]
  'sound.play': [{ id: string }, Record<string, never>]
}

// ── hosting ──

export type PortState = 'open' | 'failed' | 'pending' | 'manual' | 'skipped'

export interface HostPort {
  name: 'acme' | 'web' | 'voice-tcp' | 'voice-udp'
  protocol: 'tcp' | 'udp'
  internal: number
  external: number
  state: PortState
  error: string | null
}

/** "Open to the internet" as the server sees it (host.status). */
export interface HostStatus {
  enabled: boolean
  lanUrl: string | null
  router: { state: 'off' | 'searching' | 'found' | 'not_found' | 'disabled'; kind: string | null }
  publicIp: string | null
  cgnat: boolean
  ports: HostPort[]
  address: string | null
  autoAddress: boolean
  https: { state: 'off' | 'waiting' | 'needs_port_80' | 'requesting' | 'valid' | 'failed'; domain: string | null; expiresAt: number | null; error: string | null }
  reachable: 'verified' | 'router' | 'unknown'
  publicUrl: string | null
  checkedAt: number | null
}

export interface Events {
  'host.status': { status: HostStatus }
  'server.address': { publicUrl: string | null }
}

export interface Requests {
  'host.status': [Record<string, never>, { status: HostStatus }]
  'host.internet.set': [{ enabled: boolean }, { status: HostStatus }]
}

// ── activity ──

/** "Playing X": what someone is doing right now (PROTOCOL.md "Activity status"). */
export interface Activity {
  name: string
  /** When it started, ms since epoch (set by the server). */
  since: number
}

export interface Member {
  /** Only while online; null or missing when there's none. */
  activity?: Activity | null
}

export interface Requests {
  'activity.set': [{ name: string | null }, { activity: Activity | null }]
}
