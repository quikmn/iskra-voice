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
  kind: 'text' | 'voice' | 'forum' | 'stage' | 'docs'
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
  | { id: number; author: string; text: string; hasAttachments: boolean; deleted?: undefined; importedName?: string | null }
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
  server: { name: string; key: string; appUrl: string; publicUrl?: string | null; profilePages?: boolean; moved?: MoveNotice | null }
  channels: Channel[]
  members: Member[]
  voice: VoiceChannelState[]
  voiceAvailable: boolean
}

/** Server → client events, keyed by type. */
export interface Events {
  /** `nonce`: the sender's, so their app can match its placeholder. */
  'chat.message': { message: Message; nonce?: string | null }
  'chat.edited': { message: Message }
  'chat.deleted': { id: number; channelId: number }
  'chat.reactions': { id: number; channelId: number; reactions: Reaction[] }
  'chat.typing': { channelId: number; accountKey: string }
  channels: { channels: Channel[]; categories?: Category[] }
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
  'chat.send': [{ channelId: number; text: string; attachments?: string[]; replyTo?: number; voice?: VoiceInfo; sticker?: string; gif?: string | DirectGif; nonce?: string; cards?: Card[] }, { message: Message; nonce?: string | null }]
  'chat.react': [{ id: number; emoji: string; on: boolean }, Record<string, never>]
  'upload.begin': [{ name: string; size: number }, { url: string; maxBytes: number; /** Upload in parts: the most one part may carry (missing on older servers). */ partBytes?: number }]
  'link.preview': [{ url: string }, { preview: LinkPreview | null }]
  'chat.edit': [{ id: number; text?: string; cards?: Card[] }, { message: Message }]
  'chat.delete': [{ id: number }, Record<string, never>]
  'chat.history': [{ channelId: number; before?: number; after?: number; around?: number; limit?: number }, { messages: Message[]; hasMore: boolean; hasNewer?: boolean }]
  'chat.typing': [{ channelId: number }, Record<string, never>]
  'channel.create': [{ name: string; kind?: 'text' | 'voice' | 'forum' | 'stage' | 'docs'; readRole?: Role; writeRole?: Role; slowmode?: number; categoryId?: number; userLimit?: number; hifi?: boolean }, { channel: Channel }]
  'channel.update': [{ id: number; name?: string; readRole?: Role; writeRole?: Role; slowmode?: number; userLimit?: number; hifi?: boolean }, { channel: Channel }]
  'channel.delete': [{ id: number }, Record<string, never>]
  'profile.update': [ProfileUpdate & ProfileStamp, { member: Member; stale?: boolean }]
  'profile.page.set': [{ file: string } & ProfileStamp, { member: Member; stale?: boolean }]
  'profile.page.remove': [{ accountKey?: string } & ProfileStamp, { stale?: boolean }]
  'profile.pages.configure': [{ enabled: boolean }, Record<string, never>]
  'member.setRole': [{ accountKey: string; role: Role }, { member: Member }]
  'member.kick': [{ accountKey: string }, Record<string, never>]
  'member.ban': [{ accountKey: string; reason?: string }, Record<string, never>]
  'invite.create': [{ role?: Role; maxUses?: number; expiresInMs?: number }, { invite: Invite }]
  'invite.list': [Record<string, never>, { invites: Invite[] }]
  'invite.revoke': [{ code: string }, Record<string, never>]
  'voice.join': [{ channelId: number }, { url: string; token: string; room: string; canSpeak: boolean }]
  'voice.state': [{ muted: boolean; deafened: boolean; clips?: boolean }, Record<string, never>]
  'dm.devices': [{ accountKey: string }, DeviceBundle]
  // ── signing out ──
  'member.leave': [Record<string, never>, Record<string, never>]
  'dm.send': [{ accountKey: string; envelope: import('./dm').DmEnvelope; files?: string[]; /** No push (quiet friend actions). */ silent?: boolean }, { message: WireDm }]
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
  | 'auth_failed' | 'invite_required' | 'banned' | 'voice_unavailable' | 'busy' | 'device_revoked' | 'conflict' | 'moved'
  | 'account_rotated' | 'account_disputed' | 'rotation_conflict' | 'unavailable'
  | 'channel_full' | 'rules_required'
  | 'automod'

export class RequestError extends Error {
  readonly code: ErrorCode | 'disconnected' | 'timeout'
  /** The request that failed, so the app can say what went wrong in the reader's language. */
  readonly type?: string
  /** The server's name for its message (see PROTOCOL.md, Errors), with the values it was written with. */
  readonly key?: string
  readonly args?: Record<string, string | number>
  constructor(code: RequestError['code'], message: string, type?: string, key?: string, args?: Record<string, string | number>) {
    super(message)
    this.code = code
    this.type = type
    this.key = key
    this.args = args
  }
}

export const CloseCodes = {
  /** The server is stopping to restart (see "Restarts and reconnecting"). */
  Restarting: 1012,
  /** The server stopped and isn't expected back soon (reason `{"v":1,"reason":"stop"}`). */
  GoingAway: 1001,
  BadRequests: 4400,
  AuthFailed: 4401,
  Forbidden: 4403,
  Rotated: 4409,
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
  /** model: the router's make and model from its UPnP description (untrusted text, rendered as text only). */
  router: { state: 'off' | 'searching' | 'found' | 'not_found' | 'disabled'; kind: string | null; model?: string | null }
  publicIp: string | null
  cgnat: boolean
  ports: HostPort[]
  address: string | null
  autoAddress: boolean
  https: { state: 'off' | 'waiting' | 'needs_port_80' | 'requesting' | 'valid' | 'failed'; domain: string | null; expiresAt: number | null; error: string | null }
  reachable: 'verified' | 'router' | 'unknown'
  publicUrl: string | null
  checkedAt: number | null
  /** public; cgnat: 100.64.0.0/10, shared by the provider; private: another private range (double NAT); null: unknown. */
  nat?: 'public' | 'cgnat' | 'private' | null
  /** This computer on the home network, and the router there. */
  lanIp?: string | null
  gateway?: string | null
  /** The server computer's system. */
  os?: 'windows' | 'macos' | 'linux'
  /** How friends reach the server over Tailscale (http://<100.x address>:port), when it's on there. */
  tailscaleUrl?: string | null
}

export interface Events {
  'host.status': { status: HostStatus }
  'server.address': { publicUrl: string | null }
}

export interface Requests {
  'host.status': [Record<string, never>, { status: HostStatus }]
  'host.internet.set': [{ enabled: boolean }, { status: HostStatus }]
}

// ── forums and events ──
// See "Forum channels" and "Scheduled events" in PROTOCOL.md.

export interface ForumTag {
  id: number
  name: string
  emoji: string | null
}

export interface ForumPost {
  /** The post's thread id (use it as a channelId for replies). */
  id: number
  /** The forum channel. */
  channelId: number
  rootId: number
  title: string
  author: string
  createdAt: number
  replyCount: number
  lastMessageAt: number | null
  lastActivity: number
  lastAuthor: string | null
  tags: number[]
  pinned: boolean
  closed: boolean
  locked: boolean
  excerpt: string | null
  image: FileInfo | null
  attachmentCount: number
}

export type ForumSort = 'activity' | 'newest'

export type EventLocation = { kind: 'voice'; channelId: number | null } | { kind: 'place'; text: string }

export interface ServerEvent {
  id: number
  title: string
  description: string | null
  startAt: number
  endAt: number
  /** The creator's IANA time zone. */
  timeZone: string
  location: EventLocation
  image: FileInfo | null
  createdBy: string
  createdAt: number
  status: 'scheduled' | 'live' | 'ended' | 'cancelled'
  interested: string[]
}

export interface EventFields {
  title?: string
  description?: string
  startAt?: number
  endAt?: number
  timeZone?: string
  location?: { channelId: number } | { text: string }
  /** A file id; "" removes the cover. */
  image?: string
}

export interface Events {
  'forum.post.updated': { post: ForumPost }
  'forum.tags': { channelId: number; tags: ForumTag[] }
  'event.updated': { event: ServerEvent }
  'event.removed': { id: number }
  'event.reminder': { event: ServerEvent; kind: 'soon' | 'live' }
}

export interface Requests {
  'forum.posts': [
    { channelId: number; sort?: ForumSort; tag?: number; query?: string; cursor?: string; limit?: number },
    { posts: ForumPost[]; tags: ForumTag[]; hasMore: boolean; cursor: string | null },
  ]
  'forum.post.create': [
    { channelId: number; title: string; text: string; attachments?: string[]; tags?: number[] },
    { post: ForumPost; message: Message },
  ]
  'forum.post.get': [{ id: number }, { post: ForumPost; root: Message | null }]
  'forum.post.update': [{ id: number; title?: string; tags?: number[] }, { post: ForumPost }]
  'forum.post.set': [{ id: number; pinned?: boolean; closed?: boolean; locked?: boolean }, { post: ForumPost }]
  'forum.tags.set': [{ channelId: number; tags: { id?: number; name: string; emoji?: string | null }[] }, { tags: ForumTag[] }]
  'event.list': [Record<string, never>, { events: ServerEvent[] }]
  'event.create': [EventFields & Required<Pick<EventFields, 'title' | 'startAt' | 'endAt' | 'timeZone' | 'location'>>, { event: ServerEvent }]
  'event.update': [EventFields & { id: number }, { event: ServerEvent }]
  'event.cancel': [{ id: number }, Record<string, never>]
  'event.interest': [{ id: number; on: boolean }, { event: ServerEvent }]
}

// ── stage channels ──

export interface StageHand {
  accountKey: string
  raisedAt: number
}

export interface StageState {
  channelId: number
  live: boolean
  topic: string | null
  startedAt: number | null
  startedBy: string | null
  /** Who may publish right now (granted by the server through LiveKit). */
  speakers: string[]
  /** Raised hands, oldest first. */
  hands: StageHand[]
  /** Moderators an admin picked for this stage (admins always moderate). */
  moderators: string[]
}

export const MAX_STAGE_TOPIC = 120

export interface Welcome {
  stages?: StageState[]
}

export interface Events {
  'stage.state': StageState
}

type StageTarget = { channelId: number; accountKey: string }

export interface Requests {
  'stage.start': [{ channelId: number; topic: string }, StageState]
  'stage.update': [{ channelId: number; topic: string }, Record<string, never>]
  'stage.end': [{ channelId: number }, Record<string, never>]
  'stage.hand': [{ channelId: number; raised: boolean }, Record<string, never>]
  'stage.invite': [StageTarget, Record<string, never>]
  'stage.decline': [StageTarget, Record<string, never>]
  'stage.audience': [{ channelId: number; accountKey?: string }, Record<string, never>]
  'stage.mute': [StageTarget, Record<string, never>]
  'stage.remove': [StageTarget, Record<string, never>]
  'stage.moderator': [StageTarget & { on: boolean }, Record<string, never>]
}

// ── presence and voice messages ──

/** What others see. Invisible members show as "offline". */
export type PresenceStatus = 'online' | 'idle' | 'dnd' | 'offline'
/** What you can choose. */
export type ChosenStatus = 'online' | 'idle' | 'dnd' | 'invisible'

export interface CustomStatus {
  emoji: string | null
  text: string | null
  /** null: until cleared. */
  expiresAt: number | null
}

export interface Presence {
  status: ChosenStatus
  custom: CustomStatus | null
  /** When it was chosen (this device's clock); the newest choice wins everywhere. */
  updatedAt: number
}

export interface Member {
  /** Older servers leave these out (then `online` is all there is). */
  status?: PresenceStatus
  customStatus?: CustomStatus | null
}

export interface Welcome {
  /** Your own presence as this server keeps it (null if never set). */
  presence?: Presence | null
}

export interface VoiceInfo {
  /** Milliseconds. */
  duration: number
  /** b64u, one byte (0–255) per bar. */
  waveform: string
}

export interface Message {
  /** Voice messages: the recording is attachments[0]. */
  voice?: VoiceInfo | null
}

export interface Events {
  'presence.self': { presence: Presence }
}

export interface Requests {
  'presence.set': [Presence, { presence: Presence }]
  'presence.idle': [{ idle: boolean }, Record<string, never>]
}

// ── safety and moderation ──

/** One change to your block list; per person the newest `at` wins (unblocks are kept as entries). */
export interface BlockEntry {
  accountKey: string
  blocked: boolean
  at: number
}

export interface Member {
  /** When a running timeout ends (ms), or null. */
  timedOutUntil?: number | null
}

export interface Channel {
  /** Seconds between messages per member; 0 = off. */
  slowmode?: number
}

export interface AuditEntry {
  id: number
  at: number
  action: string
  actor: string
  actorName: string
  target: string | null
  targetName: string | null
  reason: string | null
  details: Record<string, unknown> | null
}

export interface Events {
  blocks: { blocks: BlockEntry[] }
}

export interface Requests {
  'block.list': [Record<string, never>, { blocks: BlockEntry[] }]
  'block.sync': [{ entries: BlockEntry[] }, { blocks: BlockEntry[] }]
  'member.timeout': [{ accountKey: string; durationMs: number; reason?: string }, { member: Member }]
  'member.timeout.remove': [{ accountKey: string }, { member: Member }]
  'member.timeout.status': [Record<string, never>, { timeout: { until: number; reason: string | null } | null }]
  'audit.list': [{ action?: string; person?: string; before?: number; limit?: number }, { entries: AuditEntry[]; hasMore: boolean }]
}

// ── organize: categories, channel order, nicknames, notification levels ──

export interface Category {
  id: number
  name: string
  position: number
}

export interface Channel {
  /** The category it sits in; null or missing = uncategorized (shown at the top). */
  categoryId?: number | null
}

export interface Member {
  /** This server's nickname for them, if any (`name` already shows it). */
  nick?: string | null
  /** Their own profile name. */
  profileName?: string
}

export type NotifyLevel = 'all' | 'mentions' | 'none'

/** Your choice for the whole server (channelId null) or one channel. mutedUntil: ms, -1 = until turned back on. */
export interface NotifySetting {
  channelId: number | null
  level: NotifyLevel | null
  mutedUntil: number | null
}

export interface Welcome {
  categories?: Category[]
  notify?: NotifySetting[]
}

export interface Events {
  'notify.updated': { setting: NotifySetting }
}

export interface Requests {
  'category.create': [{ name: string }, { category: Category }]
  'category.update': [{ id: number; name: string }, { category: Category }]
  'category.delete': [{ id: number }, Record<string, never>]
  'category.move': [{ id: number; before?: number | null }, Record<string, never>]
  'channel.move': [{ id: number; categoryId?: number | null; before?: number | null }, Record<string, never>]
  'member.nick': [{ accountKey?: string; nick: string }, { member: Member }]
  'notify.set': [{ channelId?: number | null; level?: NotifyLevel | 'default'; muteMinutes?: number }, { setting: NotifySetting }]
}

// ── watch parties ──

export interface WatchSource {
  kind: 'url' | 'file' | 'youtube'
  /** https media URL, or for files the server-relative /files/… path. */
  url: string | null
  fileId: string | null
  videoId: string | null
  title: string | null
}

/** `position` (seconds) is where playback was at server time `updatedAt`; while playing it moves on at `rate`. */
export interface WatchParty {
  id: string
  channelId: number
  source: WatchSource
  host: string
  anyoneControls: boolean
  playing: boolean
  position: number
  rate: number
  updatedAt: number
  startedAt: number
  updatedBy: string
}

export type WatchSourceInput = { kind: 'url'; url: string } | { kind: 'file'; fileId: string } | { kind: 'youtube'; videoId: string }

export interface Welcome {
  watch?: WatchParty[]
}

export interface Events {
  'watch.state': { channelId: number; party: WatchParty | null; serverTime: number }
  'watch.chat': { channelId: number; accountKey: string; text: string; at: number }
}

export interface Requests {
  'watch.start': [{ channelId: number; source: WatchSourceInput; title?: string }, { party: WatchParty }]
  'watch.control': [{ channelId: number; partyId: string; playing?: boolean; position?: number; rate?: number }, { party: WatchParty }]
  'watch.settings': [{ channelId: number; partyId: string; anyoneControls: boolean }, Record<string, never>]
  'watch.stop': [{ channelId: number; partyId: string }, Record<string, never>]
  'watch.chat': [{ channelId: number; text: string }, Record<string, never>]
  'watch.clock': [Record<string, never>, { now: number }]
}

// ── group DMs and group calls ──
type GroupEnvelope = import('./group').GroupEnvelope
type GroupChange = import('./group').GroupChange

export interface WireGroup {
  id: string
  version: number
  head: string
  /** In join order; the first is the owner. Clients trust their verified chain, not this. */
  members: string[]
  createdAt: number
}

export interface WireGroupMessage {
  id: number
  group: string
  from: string
  version: number
  envelope: GroupEnvelope
  createdAt: number
}

export interface WireGroupCall {
  id: string
  group: string
  from: string
  video: boolean
  createdAt: number
  /** Who LiveKit says is in the room, in the order they joined. */
  participants: string[]
  /** The group version the current key envelope was encrypted for. */
  keyVersion: number
}

/** A group call with its newest key envelope (carries the media key). */
export interface GroupCallRing {
  call: WireGroupCall
  envelope: GroupEnvelope
  /** gcall.list only: it's still ringing for you. */
  ringing?: boolean
}

export interface CallTicket {
  url: string
  token: string
  room: string
}

export interface Events {
  'group.changed': { group: WireGroup; change: GroupChange & { version: number } }
  'group.message': { message: WireGroupMessage }
  'gcall.ring': GroupCallRing
  'gcall.state': { call: WireGroupCall }
  'gcall.key': GroupCallRing
  'gcall.ended': { callId: string; group: string }
  'gcall.ring.stopped': { callId: string }
}

export interface Requests {
  'group.create': [{ change: GroupChange }, { group: WireGroup }]
  'group.change': [{ change: GroupChange }, { group: WireGroup }]
  'group.list': [Record<string, never>, { groups: { group: WireGroup; lastId: number | null; lastAt: number | null }[] }]
  'group.get': [{ groupId: string; since?: number }, { group: WireGroup; changes: (GroupChange & { version: number })[] }]
  'group.send': [{ groupId: string; version: number; envelope: GroupEnvelope; files?: string[] }, { message: WireGroupMessage }]
  'group.history': [{ groupId: string; before?: number; limit?: number }, { messages: WireGroupMessage[]; hasMore: boolean }]
  'gcall.start': [{ groupId: string; callId: string; version: number; video: boolean; envelope: GroupEnvelope }, { call: WireGroupCall; ticket: CallTicket }]
  'gcall.join': [{ callId: string }, { ring: GroupCallRing; ticket: CallTicket }]
  'gcall.decline': [{ callId: string }, Record<string, never>]
  'gcall.leave': [{ callId: string }, Record<string, never>]
  'gcall.key': [{ callId: string; version: number; envelope: GroupEnvelope }, Record<string, never>]
  'gcall.list': [Record<string, never>, { calls: GroupCallRing[] }]
}

// ── backups, moving and imports ──
// See "Backups, moving and imports" in PROTOCOL.md.

/** "This server moved to url", signed with the server key. */
export interface MoveNotice {
  serverKey: string
  url: string
  movedAt: number
  sig: string
}

/** What an imported message carries: who wrote it where it came from, reaction counts, files the export didn't include. */
export interface ImportedInfo {
  source: 'discord'
  name: string
  avatar: FileInfo | null
  bot: boolean
  reactions: { emoji: string; count: number }[]
  missingAttachments: { name: string; size: number }[]
}

export interface Message {
  /** Set on messages imported from another app (author is then "discord:<id>"). */
  imported?: ImportedInfo | null
}

export interface ImportJob {
  phase: 'reading' | 'importing' | 'done' | 'failed' | 'cancelled'
  channels: number
  channelsDone: number
  messages: number
  messagesDone: number
  files: number
  missingFiles: number
  skipped: number
  current: string | null
  error: string | null
  warnings: string[]
  imported: { id: number; name: string; category: string | null; messages: number; thread: boolean }[]
}

/** Upload and expression limits (0 = no limit, except maxUploadMb). */
export interface ServerLimits {
  maxUploadMb: number
  memberMbPerDay: number
  guestMbPerDay: number
  soundMaxSeconds: number
  soundMaxMb: number
  emojiMaxKb: number
  stickerMaxKb: number
}

export interface BackupStatus {
  auto: { enabled: boolean; keep: number; includeUploads: boolean }
  local: { name: string; size: number; createdAt: number }[]
  folder: string
}

export interface Events {
  'server.moved': { notice: MoveNotice | null }
  'backup.progress': { done: number; total: number }
  'import.progress': { job: ImportJob }
}

export interface Requests {
  'backup.create': [{ sealedPassphrase: string }, { url: string; name: string; size: number; expiresAt: number }]
  'backup.status': [Record<string, never>, BackupStatus]
  'limits.get': [Record<string, never>, ServerLimits]
  'limits.update': [Partial<ServerLimits>, ServerLimits]
  'backup.settings': [{ enabled?: boolean; keep?: number; includeUploads?: boolean }, BackupStatus]
  'server.move': [{ url: string }, { notice: MoveNotice }]
  'server.move.cancel': [Record<string, never>, Record<string, never>]
  'import.begin': [{ size: number; readOnly?: boolean }, { url: string; maxBytes: number }]
  'import.status': [Record<string, never>, { job: ImportJob | null; running: boolean }]
  'import.cancel': [Record<string, never>, Record<string, never>]
}

// ── account key rotation ──

export interface Welcome {
  /** The most recent account key rotations on this server (see "Account key rotation"). Older servers leave it out. */
  rotations?: import('./rotation').AppliedRotation[]
}

export interface Events {
  'account.rotated': { rotations: import('./rotation').AppliedRotation[]; handover: string | null }
  'member.rotated': { rotation: import('./rotation').AppliedRotation; member: Member }
  'account.disputed': { rotation: import('./rotation').AppliedRotation; member: Member }
  'account.resolved': { rotation: import('./rotation').AppliedRotation; previousKey: string; member: Member }
}

export interface Requests {
  'account.rotate': [
    { rotation: import('./rotation').Rotation; certs?: import('./identity').DeviceCert[]; handovers?: import('./rotation').Handover[] },
    { status: 'applied' | 'already' },
  ]
  'account.rotations': [{ accountKey: string }, { rotations: import('./rotation').AppliedRotation[] }]
  'account.dispute.resolve': [{ oldKey: string; keep: string }, Record<string, never>]
}

// ââ organize: forwarding and synced preferences ââ

/** "Forwarded from #channel". The source is null when not everyone here could read it. */
export interface ForwardInfo {
  channelId: number | null
  channelName: string | null
  messageId: number | null
  createdAt: number
}

export interface Message {
  forwarded?: ForwardInfo | null
}

export interface Events {
  'prefs.updated': { name: string; updatedAt: number }
}

export interface Requests {
  'chat.forward': [{ id: number; channelId: number }, { message: Message }]
  'prefs.get': [{ name: string }, { data: string | null; updatedAt: number | null }]
  'prefs.set': [{ name: string; data: string; updatedAt: number }, Record<string, never>]
}

// ── roles and permissions ──

export type Permission =
  | 'manageMessages' | 'timeoutMembers' | 'kickMembers' | 'banMembers' | 'manageChannels' | 'manageRoles'
  | 'viewAuditLog' | 'manageExpressions' | 'manageWebhooks' | 'mentionEveryone' | 'moveMembers' | 'muteMembers' | 'manageAutoMod'

export type ChannelPermission = 'view' | 'send' | 'connect' | 'speak'

/** A custom role. Position 1 is the lowest. */
export interface ServerRole {
  id: number
  name: string
  color: string | null
  icon: string | null
  hoist: boolean
  /** Anyone may @mention it (otherwise only people who may mention everyone). */
  mentionable?: boolean
  position: number
  permissions: Permission[]
}

export interface ChannelOverride {
  roleId: number
  allow: ChannelPermission[]
  deny: ChannelPermission[]
}

export interface Member {
  /** Custom role ids, highest first. */
  roles?: number[]
}

export interface Channel {
  overrides?: ChannelOverride[]
}

export interface VoiceParticipant {
  /** Muted by a moderator. */
  serverMuted?: boolean
}

export interface Events {
  roles: { roles: ServerRole[] }
  'voice.moved': { channelId: number }
}

export interface Requests {
  'role.list': [Record<string, never>, { roles: ServerRole[] }]
  'role.create': [{ name: string; color?: string; icon?: string; hoist?: boolean; mentionable?: boolean; permissions?: Permission[] }, { role: ServerRole }]
  'role.update': [{ id: number; name?: string; color?: string; icon?: string; hoist?: boolean; mentionable?: boolean; permissions?: Permission[] }, { role: ServerRole }]
  'role.delete': [{ id: number }, Record<string, never>]
  'role.reorder': [{ ids: number[] }, { roles: ServerRole[] }]
  'member.roles.set': [{ accountKey: string; roles: number[] }, { member: Member }]
  'channel.overrides.set': [{ id: number; roleId: number; allow?: ChannelPermission[]; deny?: ChannelPermission[] }, { channel: Channel }]
  'voice.mute': [{ accountKey: string; muted: boolean }, Record<string, never>]
  'voice.move': [{ accountKey: string; channelId: number }, Record<string, never>]
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

// ── encrypted DM attachments ──

export interface Requests {
  'dm.upload.begin': [{ accountKey?: string; groupId?: string; channelId?: number; size: number }, { url: string; maxBytes: number; partBytes?: number }]
  'dm.file.url': [{ id: string }, { url: string; size: number }]
}

// ── stickers ──

export interface Sticker {
  id: string
  name: string
  /** Relative to the server's URL; null once deleted (on messages). */
  url: string | null
  animated: boolean
  createdBy?: string
}

export interface Message {
  /** A sticker message (no text or attachments). */
  sticker?: Sticker | null
}

export interface Events {
  'stickers.updated': { stickers: Sticker[] }
}

export interface Requests {
  'sticker.list': [Record<string, never>, { stickers: Sticker[] }]
  'sticker.create': [{ name: string; fileId: string }, { sticker: Sticker }]
  'sticker.rename': [{ id: string; name: string }, { sticker: Sticker }]
  'sticker.delete': [{ id: string }, Record<string, never>]
}

// ── GIFs (through the server) ──

/** A GIF search result. Through the server: media URLs are its proxy (relative). Direct: KLIPY's own addresses. */
export interface GifResult {
  id: string
  title: string
  width: number
  height: number
  url: string
  preview: string
  /** Through the server: send this back in chat.send's `gif`. Empty in direct mode. */
  token: string
  /** Loaded straight from KLIPY (direct mode). */
  direct?: boolean
}

export type GifMode = 'direct' | 'proxy'

export interface GifStatus {
  enabled: boolean
  provider: string | null
  mode?: GifMode
  /** Direct mode only: the server's KLIPY key and this member's pseudonymous customer id. */
  key?: string | null
  customerId?: string | null
}

/** chat.send's `gif` in direct mode: the GIF as KLIPY gave it. */
export interface DirectGif {
  id: string
  title: string
  url: string
  preview: string
  width: number
  height: number
}

export interface GifCategory {
  name: string
  query: string
  preview: string | null
}

export interface MessageGif {
  /** KLIPY's own addresses (direct mode): shown after a click unless the viewer allows loading them. */
  direct?: boolean
  provider: string
  id: string
  title: string
  width: number
  height: number
  url: string
  preview: string
}

export interface Message {
  gif?: MessageGif | null
}

export interface Events {
  'gif.status': GifStatus
}

export interface Requests {
  'gif.status': [Record<string, never>, GifStatus]
  'gif.configure': [{ key?: string; mode?: GifMode }, Record<string, never>]
  'gif.trending': [{ page?: number }, { gifs: GifResult[]; hasNext: boolean }]
  'gif.search': [{ q: string; page?: number }, { gifs: GifResult[]; hasNext: boolean }]
  'gif.categories': [Record<string, never>, { categories: GifCategory[] }]
}

// ── voice user limits and server rules ──

export interface Channel {
  /** Voice channels: how many people fit (0 = no limit). People who can move members join anyway. */
  userLimit?: number
}

/** The server's rules as you see them. `version` goes up when everyone has to agree again. */
export interface ServerRules {
  text: string
  welcome: string
  required: boolean
  version: number
  updatedAt: number | null
  /** You still have to agree before writing, reacting or joining voice. */
  mustAgree: boolean
  agreedVersion: number
  /** Admins only (rules.get / rules.update): how many members agreed, and how many there are. */
  agreed?: number | null
  members?: number | null
}

export interface Welcome {
  rules?: ServerRules
}

export interface Events {
  rules: { rules: ServerRules }
}

export interface Requests {
  'rules.get': [Record<string, never>, { rules: ServerRules }]
  'rules.update': [{ text?: string; welcome?: string; required?: boolean; reaccept?: boolean }, { rules: ServerRules }]
  'rules.accept': [{ version: number }, { rules: ServerRules }]
}

// ── automod ──
// Server-side rules that block messages before they're stored. See "AutoMod" in PROTOCOL.md.

/** A block always happens; optionally also a timeout (one of the timeout lengths, 0 = none) and an alert. */
export interface AutoModAction {
  timeoutMs: number
  alert: boolean
}

export interface AutoModConfig {
  enabled: boolean
  words: { enabled: boolean; blocked: string[]; allowed: string[]; action: AutoModAction }
  mentions: { enabled: boolean; max: number; action: AutoModAction }
  flood: { enabled: boolean; count: number; seconds: number; action: AutoModAction }
  duplicates: { enabled: boolean; count: number; seconds: number; action: AutoModAction }
  links: { enabled: boolean; mode: 'invites' | 'all'; allowedDomains: string[]; action: AutoModAction }
  exemptRoles: number[]
  exemptChannels: number[]
  alertChannelId: number | null
}

export type AutoModRule = 'words' | 'mentions' | 'flood' | 'duplicates' | 'links'

/** On an AutoMod alert (author "automod:"): what was blocked. Channel and snippet are null when they'd reveal a private channel. */
export interface AutoModAlert {
  rule: AutoModRule
  what: 'message' | 'edit' | 'poll' | 'post' | 'thread' | 'event' | 'watch'
  member: string
  memberName: string
  channelId: number | null
  channelName: string | null
  snippet: string | null
  timeoutMs: number
}

export interface Message {
  automod?: AutoModAlert | null
}

export interface Requests {
  'automod.get': [Record<string, never>, { automod: AutoModConfig }]
  'automod.update': [{ automod: AutoModConfig }, { automod: AutoModConfig }]
}

// ── reports, account deletion and owner transfer ──
// See "Reports, deleting an account and handing over a server" in PROTOCOL.md.

export type ReportReason = 'spam' | 'harassment' | 'hate' | 'sexual' | 'violence' | 'self_harm' | 'illegal' | 'other'
export type ReportOutcome = 'dismissed' | 'deleted' | 'timeout' | 'kick' | 'ban' | 'other'

/** A message from an encrypted conversation that the reporter chose to share (the server can't check it). */
export interface SharedMessage {
  author: string
  text: string
  at: number
}

export interface Report {
  id: number
  at: number
  kind: 'message' | 'member' | 'dm'
  reason: ReportReason
  note: string | null
  status: 'open' | 'resolved'
  /** Null once the reporter deleted their account. */
  reporter: string | null
  reporterName: string
  target: string
  targetName: string
  /** A copy of the reported message as it was when reported. */
  message: { id: number; channelId: number; channelName: string; text: string; attachments: FileInfo[]; createdAt: number; deleted: boolean } | null
  messages: SharedMessage[] | null
  resolution: { by: string; byName: string; at: number; outcome: ReportOutcome; note: string | null } | null
}

/** Signed by the account key: "iskra/account-delete/v1" 0x00 accountKey(32) u64be(deletedAt) u8(messages). */
export interface AccountDeletion {
  accountKey: string
  deletedAt: number
  messages: boolean
  sig: string
}

export interface Events {
  'report.count': { open: number }
  'account.deleted': { deletion: AccountDeletion }
  'member.deleted': { accountKey: string; messages: boolean }
}

export interface Requests {
  'report.create': [
    { reason: ReportReason; note?: string; messageId?: number; accountKey?: string; messages?: SharedMessage[] },
    { id: number; already: boolean },
  ]
  'report.list': [{ status?: 'open' | 'resolved'; before?: number; limit?: number }, { reports: Report[]; hasMore: boolean }]
  'report.resolve': [{ id: number; outcome: ReportOutcome; note?: string }, { report: Report }]
  'report.count': [Record<string, never>, { open: number }]
  'account.delete': [{ deletion: AccountDeletion }, Record<string, never>]
  'owner.transfer': [{ accountKey: string }, Record<string, never>]
}

// ── productivity: edit history, reminders, scheduled messages, the inbox ──

export interface MessageVersion {
  text: string
  /** When this version was written. */
  at: number
}

/** `data` is sealed by your devices (core/sealed.ts); channelId/messageId only for reminders about a channel message. */
export interface WireReminder {
  id: number
  dueAt: number
  data: string
  channelId: number | null
  messageId: number | null
  createdAt: number
  firedAt: number | null
}

export type ScheduledKind = 'channel' | 'dm' | 'group'

export interface WireScheduled {
  id: number
  kind: ScheduledKind
  channelId: number | null
  /** The DM's recipient. */
  accountKey: string | null
  groupId: string | null
  version: number | null
  /** Channel messages only. */
  text: string | null
  replyTo: number | null
  /** DMs and groups: end-to-end encrypted when scheduled. */
  envelope: import('./dm').DmEnvelope | import('./group').GroupEnvelope | null
  sendAt: number
  createdAt: number
  status: 'pending' | 'sending' | 'failed'
  error: string | null
}

export type InboxKind = 'mention' | 'reply' | 'role' | 'everyone'

export interface InboxItem {
  kind: InboxKind
  channelId: number
  at: number
  message: Message
}

export interface Events {
  'reminder.updated': { reminder: WireReminder }
  'reminder.deleted': { id: number }
  'reminder.due': { reminder: WireReminder }
  'scheduled.updated': { scheduled: WireScheduled }
  'scheduled.deleted': { id: number; sent: boolean }
  'inbox.new': { item: InboxItem }
}

export interface Requests {
  'chat.edits': [{ id: number }, { versions: MessageVersion[] }]
  'reminder.create': [{ dueAt: number; data: string; messageId?: number }, { reminder: WireReminder }]
  'reminder.list': [Record<string, never>, { reminders: WireReminder[] }]
  'reminder.update': [{ id: number; dueAt: number; data?: string }, { reminder: WireReminder }]
  'reminder.delete': [{ id: number }, Record<string, never>]
  'scheduled.create': [
    { sendAt: number } & (
      | { channelId: number; text: string; replyTo?: number }
      | { accountKey: string; envelope: import('./dm').DmEnvelope }
      | { groupId: string; version: number; envelope: import('./group').GroupEnvelope }
    ),
    { scheduled: WireScheduled },
  ]
  'scheduled.list': [Record<string, never>, { scheduled: WireScheduled[] }]
  'scheduled.update': [
    { id: number; sendAt?: number; text?: string; envelope?: import('./dm').DmEnvelope | import('./group').GroupEnvelope; version?: number },
    { scheduled: WireScheduled },
  ]
  'scheduled.delete': [{ id: number }, Record<string, never>]
  'scheduled.send': [{ id: number }, { message: unknown }]
  'inbox.list': [{ before?: number; limit?: number }, { items: InboxItem[]; hasMore: boolean; next: number | null }]
}

// ── docs channels ──
// See "Docs channels" in PROTOCOL.md.

export interface DocPage {
  id: number
  channelId: number
  parentId: number | null
  title: string
  position: number
  version: number
  createdBy: string
  createdAt: number
  updatedBy: string
  updatedAt: number
  /** Text size in UTF-8 bytes. */
  size: number
  /** Only in docs.page.get / create / save / restore results. */
  text?: string
}

export interface DocRevision {
  version: number
  title: string
  author: string
  createdAt: number
  restoredFrom: number | null
  size: number
  text?: string
}

/** The server's "Start here" page, as you see it. */
export interface DocHome {
  pageId: number
  channelId: number
  title: string
}

export interface DocSearchResult {
  page: DocPage
  snippet: string
  matches: [number, number][]
}

export interface Events {
  'docs.page.updated': { page: DocPage }
  'docs.page.deleted': { channelId: number; ids: number[] }
  'docs.home': { home: DocHome | null }
}

export interface Requests {
  'docs.pages': [{ channelId: number }, { pages: DocPage[]; home: number | null }]
  'docs.page.get': [{ id: number; version?: number }, { page: DocPage; revision?: DocRevision }]
  'docs.page.create': [{ channelId: number; title: string; parentId?: number | null; text?: string; file?: string }, { page: DocPage }]
  'docs.page.save': [{ id: number; baseVersion: number; title?: string; text?: string; file?: string }, { page: DocPage }]
  'docs.page.move': [{ id: number; parentId?: number | null; before?: number | null }, { page: DocPage }]
  'docs.page.delete': [{ id: number }, Record<string, never>]
  'docs.page.history': [{ id: number }, { page: DocPage; revisions: DocRevision[] }]
  'docs.page.restore': [{ id: number; version: number; baseVersion: number }, { page: DocPage }]
  'docs.home.get': [Record<string, never>, { home: DocHome | null }]
  'docs.home.set': [{ pageId: number | null }, { home: DocHome | null }]
  'docs.search': [{ query: string; channelId?: number; limit?: number }, { results: DocSearchResult[] }]
}

// ── security log, retention and data export ──
// See "Security log, retention and your data" in PROTOCOL.md.

export interface SecurityEvent {
  id: number
  at: number
  event: string
  account: string | null
  accountName: string | null
  /** Only when the owner turned on securityLogIps. */
  ip: string | null
  details: Record<string, unknown> | null
}

/** Days to keep each kind of data (0 keeps forever). */
export interface Retention {
  messagesDays: number
  uploadsDays: number
  auditDays: number
  securityLogDays: number
  securityLogIps: boolean
}

export interface Requests {
  'security.log.list': [
    { event?: string; account?: string; before?: number; limit?: number; export?: boolean },
    { entries: SecurityEvent[]; hasMore: boolean },
  ]
  'retention.get': [Record<string, never>, Retention]
  'retention.update': [Partial<Retention>, Retention]
  'data.export': [{ accountKey?: string }, { url: string; name: string; size: number; expiresAt: number }]
}

// ── server updates ──
// See "Server updates and health" in PROTOCOL.md.

export type UpdateMode = 'off' | 'notify' | 'auto'
export type UpdateChannel = 'stable' | 'prerelease'
export type ServerUpdateState = 'idle' | 'checking' | 'downloading' | 'verifying' | 'installing' | 'restarting' | 'failed'
/** Why this server can't install updates itself. */
export type AutoUpdateBlock = 'desktop' | 'development' | 'platform' | 'guard' | 'readonly'

export interface ServerUpdateStatus {
  current: string
  mode: UpdateMode
  channel: UpdateChannel
  window: string
  requireAttestation: boolean
  managed: 'desktop' | null
  canCheck: boolean
  auto: { possible: boolean; reason: AutoUpdateBlock | null }
  latest: { version: string; url: string; publishedAt: number; prerelease: boolean; package: boolean } | null
  state: ServerUpdateState
  progress: { done: number; total: number } | null
  checkedAt: number | null
  error: string | null
  /** Which error, for showing it in the owner's language (PROTOCOL.md). */
  errorCode: string | null
  lastUpdate: { from: string; to: string; ok: boolean } | null
  attested: boolean | null
}

export interface Events {
  'update.status': { status: ServerUpdateStatus }
  'server.restarting': { reason: 'update'; version: string }
}

export interface Requests {
  'update.status': [Record<string, never>, { status: ServerUpdateStatus }]
  'update.check': [Record<string, never>, { status: ServerUpdateStatus }]
  'update.settings': [{ mode?: UpdateMode; channel?: UpdateChannel; window?: string; requireAttestation?: boolean }, { status: ServerUpdateStatus }]
  'update.install': [Record<string, never>, { status: ServerUpdateStatus }]
}

// ── voice chat and clips ──

export interface VoiceParticipant {
  /** They have clips turned on (they can save the last seconds of the call). */
  clips?: boolean
}

export interface Message {
  /** A "saved a clip" notice (the author saved it; no text). */
  clip?: Record<string, never> | null
}

export interface Requests {
  'voice.clip': [{ channelId: number }, { message: Message }]
}

// ── key transparency ──

/** A key log head the server signed: "iskra/keylog-head/v1" 0x00 serverKey(32) u64be(seq) hash(32) u64be(at). */
export interface KeyLogHead {
  seq: number
  hash: string
  at: number
  sig: string
}

export interface Welcome {
  /** Absent on servers from before key transparency. */
  keyLog?: KeyLogHead
}

export interface Requests {
  'keylog.head': [Record<string, never>, { head: KeyLogHead }]
  'keylog.entries': [{ after?: number; limit?: number }, { entries: { seq: number; data: string }[]; head: KeyLogHead }]
  'keylog.alert': [{ kind: string; seq?: number }, Record<string, never>]
}

// ── encrypted channels ──

/** On a Channel: set when the channel is end-to-end encrypted (its chain id and current version). */
export interface ChannelE2ee {
  chain: string
  version: number
}

export interface Channel {
  e2ee?: ChannelE2ee | null
}

export interface Message {
  /** Encrypted channels: the envelope (core/channelChain.ts) and the chain version it was encrypted for; `text` is "". */
  e2ee?: { version: number; envelope: import('./channelChain').ChannelEnvelope } | null
}

export interface WireChannelChain {
  chain: string
  version: number
  head: string
  members: string[]
}

export interface Events {
  'echan.changed': { channelId: number; e2ee: WireChannelChain; change: import('./group').GroupChange & { version: number } }
  'echan.keys': { channelId: number; version: number }
}

export interface Requests {
  'echan.get': [{ channelId: number; since?: number }, {
    e2ee: WireChannelChain
    changes: (import('./group').GroupChange & { version: number })[]
    want: { add: string[]; remove: string[]; full: boolean }
  }]
  'echan.change': [{ channelId: number; change: import('./group').GroupChange; keys: import('./channelChain').ChannelKeyEnvelope[] }, { e2ee: WireChannelChain }]
  'echan.keys.add': [{ channelId: number; version: number; keys: import('./channelChain').ChannelKeyEnvelope[] }, Record<string, never>]
  'echan.keys': [{ channelId: number; since?: number }, { keys: { version: number; from: string; envelope: import('./channelChain').ChannelKeyEnvelope }[]; hasMore: boolean }]
}

// ── hi-fi voice channels ──

export interface Channel {
  /** Voice channels: people may send hi-fi audio here (stereo, 128 kbps, no processing). */
  hifi?: boolean
}

// ── profile sync ──

/** When the profile was last edited and on which device (see Profile sync). The newest one wins. */
export interface ProfileStamp {
  updatedAt?: number
  by?: string
}

export interface Requests {
  'profile.page.get': [Record<string, never>, { html: string; hash: string }]
}

// ── bot commands and cards ──

export type CommandOptionType = 'string' | 'integer' | 'number' | 'boolean' | 'user' | 'channel' | 'role'

export interface CommandOption {
  /** 1–32 characters of a–z, 0–9, _ and -. */
  name: string
  /** 1–100 characters, one line. */
  description: string
  type: CommandOptionType
  required?: boolean
  /** Up to 25, for string, integer and number options. */
  choices?: { name: string; value: string | number }[]
}

/** A /command a bot answers (it's still sent as an ordinary message). */
export interface BotCommand {
  name: string
  description: string
  /** A hint shown after the name, like "2d6+1". */
  usage?: string
  /** Up to 25; required ones first. */
  options?: CommandOption[]
}

export interface BotCommandList {
  bot: string
  commands: BotCommand[]
}

/** A card on a bot's message: the webhook embed format plus pictures from this server or data: URLs. */
export interface Card extends Embed {
  thumbnail?: { url: string }
  image?: { url: string }
}

export interface Message {
  /** Cards a bot attached (null for everything else). */
  cards?: Card[] | null
}

export interface Welcome {
  botCommands?: BotCommandList[]
}

export interface Events {
  'bot.commands': BotCommandList
}

export interface Requests {
  'bot.commands.set': [{ commands: BotCommand[] }, { commands: BotCommand[] }]
  'bot.commands.available': [{ channelId: number }, { bots: string[] }]
}
