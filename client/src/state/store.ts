// App state. Components read from here; all server traffic goes through the actions below.
import { create } from 'zustand'
import { t } from '../i18n'
import { Connection, type ConnectionStatus } from '../core/connection'
import { b64u, randomBytes, ready } from '../core/crypto'
import { createIdentity, type Identity } from '../core/identity'
import { restoreIdentity } from '../core/recovery'
import { authProfile } from '../core/profile'
import { nextStamp, wireStamp } from '../core/profileSync'
import { senderRules } from './senderRules'
import type { InviteLink } from '../core/invite'
import type { Channel, DirectGif, Events, FileInfo, Member, Message, MessageGif, Sticker, VoiceInfo, VoiceParticipant, Welcome } from '../core/protocol'
import * as storage from '../core/storage'
import { openDeviceVault } from './lock'
import { channelConv, noteMessage, seeConversation } from './readState'

export interface PendingMessage extends Message {
  pending?: 'sending' | 'failed'
  /** Client-side id for messages that aren't confirmed yet. */
  tempId?: string
  /** Sent with chat.send; the server stores a message once per nonce, so retries can't duplicate it. */
  nonce?: string
  /** A pending GIF's token (or direct GIF), for retrying. */
  gifToken?: string | DirectGif
  /** Why AutoMod blocked it (retrying wouldn't help). */
  blockedReason?: string
}

export interface ServerState {
  key: string
  url: string
  name: string
  status: ConnectionStatus
  me: Member | null
  channels: Channel[]
  members: Record<string, Member>
  messages: Record<number, PendingMessage[]>
  hasMore: Record<number, boolean>
  /** accountKey → when the "typing" hint expires, per channel. */
  typing: Record<number, Record<string, number>>
  /** Who is in each voice channel (from the server, which hears it from LiveKit). */
  voice: Record<number, VoiceParticipant[]>
  voiceAvailable: boolean
  /** The web app address this server's invite links should open. */
  appUrl: string | null
  /** How friends on the internet reach this server (internet hosting), if it's open. */
  publicUrl: string | null
  /** Channels showing an older stretch of history after a jump; new messages wait until you return to the present. */
  detached?: Record<number, boolean>
}

interface AppState {
  /** locked: waiting for the app lock passphrase (or the keychain failed), see state/lock.ts. */
  phase: 'loading' | 'locked' | 'onboarding' | 'ready'
  identity: Identity | null
  profile: storage.Profile | null
  servers: Record<string, ServerState>
  order: string[]
  activeServer: string | null
  activeChannel: Record<string, number>
  /** An invite link the user opened, waiting for them to confirm. */
  pendingInvite: InviteLink | null
}

export const useApp = create<AppState>(() => ({
  phase: 'loading',
  identity: null,
  profile: null,
  servers: {},
  order: [],
  activeServer: null,
  activeChannel: {},
  pendingInvite: null,
}))

const connections = new Map<string, Connection>()

/** Account key rotations sent in the handshake (state/keys.ts fills this in). */
let authRotations: () => unknown[] = () => []
export function setAuthRotations(source: () => unknown[]): void {
  authRotations = source
}

type ServerEventListener = (serverKey: string, type: keyof Events, body: unknown) => void
const eventListeners = new Set<ServerEventListener>()
const welcomeListeners = new Set<(serverKey: string, welcome: Welcome) => void>()

/** Other state modules (DMs, …) subscribe to server events here instead of importing each other. */
export function onServerEvent(listener: ServerEventListener): void {
  eventListeners.add(listener)
}

export function onWelcomeHook(listener: (serverKey: string, welcome: Welcome) => void): void {
  welcomeListeners.add(listener)
}
const TYPING_MS = 6_000

let authPresence: () => unknown = () => undefined
let invisible: () => boolean = () => false
/** state/presence.ts says whether you're invisible: no typing hints then, and @here isn't for you. */
export function setInvisibleCheck(check: () => boolean): void {
  invisible = check
}
/** state/presence.ts hands its current choice to every connect. */
export function setAuthPresence(provider: () => unknown): void {
  authPresence = provider
}

// ── Small helpers ───────────────────────────────────────────────────────────

export function patchServer(key: string, patch: (s: ServerState) => Partial<ServerState>): void {
  useApp.setState((state) => {
    const server = state.servers[key]
    if (!server) return state
    return { servers: { ...state.servers, [key]: { ...server, ...patch(server) } } }
  })
}

export function upsertMessage(list: PendingMessage[] | undefined, message: PendingMessage): PendingMessage[] {
  const messages = list ?? []
  const index = messages.findIndex((m) => m.id === message.id && !m.tempId)
  if (index >= 0) return messages.map((m, i) => (i === index ? message : m))
  // Keep id order; pending messages (no real id yet) stay at the end.
  const confirmed = messages.filter((m) => !m.tempId)
  const pending = messages.filter((m) => m.tempId)
  const insertAt = confirmed.findIndex((m) => m.id > message.id)
  if (insertAt < 0) confirmed.push(message)
  else confirmed.splice(insertAt, 0, message)
  return [...confirmed, ...pending]
}

/**
 * Keeps a channel's loaded history to its newest `keep` messages once it holds more than `above` (pending ones
 * stay), so a busy channel left open doesn't grow without end; scrolling up loads the older ones again.
 */
export function trimMessages(list: PendingMessage[], keep: number, above = keep): PendingMessage[] | null {
  const confirmed = list.filter((m) => !m.tempId)
  if (confirmed.length <= above) return null
  return [...confirmed.slice(-keep), ...list.filter((m) => m.tempId)]
}

/** Live messages in channels you aren't looking at: keep the newest 100 once there are 200. */
const HIDDEN_KEEP = 100
const HIDDEN_ABOVE = 200
/** The channel you're looking at, while you're at the bottom (MessageList): the newest 300 once there are 600. */
export const SHOWN_KEEP = 300
export const SHOWN_ABOVE = 600

/** Drops a channel's oldest loaded messages (see trimMessages); older ones load again from the server on scroll. */
export function trimChannel(key: string, channelId: number, keep = SHOWN_KEEP, above = SHOWN_ABOVE): void {
  patchServer(key, (s) => {
    const list = s.messages[channelId]
    const trimmed = list && !s.detached?.[channelId] ? trimMessages(list, keep, above) : null
    return trimmed ? { messages: { ...s.messages, [channelId]: trimmed }, hasMore: { ...s.hasMore, [channelId]: true } } : {}
  })
}

export const activeServerState = (s: AppState): ServerState | null => (s.activeServer ? s.servers[s.activeServer] ?? null : null)

export function activeChannelId(s: AppState): number | null {
  const server = activeServerState(s)
  if (!server) return null
  const chosen = s.activeChannel[server.key]
  if (chosen && server.channels.some((c) => c.id === chosen)) return chosen
  return server.channels.find((c) => c.kind === 'text')?.id ?? null
}

async function persistServers(): Promise<void> {
  const { servers, order } = useApp.getState()
  const saved = await storage.loadServers()
  const byKey = new Map(saved.map((s) => [s.serverKey, s]))
  await storage.saveServers(
    order
      .filter((key) => servers[key])
      .map((key) => ({
        url: servers[key].url,
        serverKey: key,
        name: servers[key].name,
        invite: servers[key].me ? undefined : byKey.get(key)?.invite,
      })),
  )
}

// ── Boot ────────────────────────────────────────────────────────────────────

export async function boot(): Promise<void> {
  await ready()
  if (!(await openDeviceVault())) {
    useApp.setState({ phase: 'locked' })
    return
  }
  const [identity, profile, saved] = await Promise.all([storage.loadIdentity(), storage.loadProfile(), storage.loadServers()])
  if (!identity || !profile) {
    useApp.setState({ phase: 'onboarding' })
    return
  }
  useApp.setState({ phase: 'ready', identity, profile })
  for (const server of saved) connectServer(server.url, server.serverKey, server.name, server.invite)
  if (saved.length) useApp.setState({ activeServer: saved[0].serverKey })
}

/** A new device for an existing account (from its recovery key). */
export async function restoreAccount(seed: Uint8Array, name: string): Promise<void> {
  const identity = restoreIdentity(seed)
  const profile = { name, recoverySaved: true }
  await storage.saveIdentity(identity)
  await storage.saveProfile(profile)
  void storage.requestPersistence()
  useApp.setState({ phase: 'ready', identity, profile })
}

export async function markRecoverySaved(): Promise<void> {
  const profile = useApp.getState().profile
  if (!profile || profile.recoverySaved) return
  const next = { ...profile, recoverySaved: true }
  await storage.saveProfile(next)
  useApp.setState({ profile: next })
}

export async function completeOnboarding(name: string): Promise<void> {
  const identity = createIdentity()
  const profile = { name }
  await storage.saveIdentity(identity)
  await storage.saveProfile(profile)
  void storage.requestPersistence()
  useApp.setState({ phase: 'ready', identity, profile })
}

// ── Servers ─────────────────────────────────────────────────────────────────

export function acceptInvite(invite: InviteLink): void {
  useApp.setState({ pendingInvite: null })
  if (useApp.getState().servers[invite.serverKey]?.me) {
    // Already a member: just go there.
    useApp.setState({ activeServer: invite.serverKey })
    return
  }
  connectServer(invite.serverUrl, invite.serverKey, invite.serverUrl.replace(/^https?:\/\//, ''), invite.code)
  useApp.setState({ activeServer: invite.serverKey })
  void persistServers().then(async () => {
    // Remember the invite until the first successful join, in case the tab closes mid-way.
    const saved = await storage.loadServers()
    await storage.saveServers(saved.map((s) => (s.serverKey === invite.serverKey ? { ...s, invite: invite.code } : s)))
  })
}

export function leaveServer(key: string): void {
  connections.get(key)?.stop()
  connections.delete(key)
  useApp.setState((state) => {
    const servers = { ...state.servers }
    delete servers[key]
    const order = state.order.filter((k) => k !== key)
    return { servers, order, activeServer: state.activeServer === key ? order[0] ?? null : state.activeServer }
  })
  void persistServers()
}

/**
 * Points a saved server at a new address (it moved, or was restored on this computer) and reconnects there.
 * Adds it to the list if it isn't there yet. The server key never changes, so the new address must be the same server.
 */
export function moveServer(key: string, url: string, name?: string): void {
  const existing = useApp.getState().servers[key]
  if (existing?.url === url) return
  connections.get(key)?.stop()
  connections.delete(key)
  if (existing) patchServer(key, () => ({ url, publicUrl: null }))
  connectServer(url, key, existing?.name ?? name ?? url.replace(/^https?:\/\//, ''))
  void persistServers()
}

function connectServer(url: string, key: string, name: string, invite?: string): void {
  const { identity } = useApp.getState()
  if (!identity) return
  connections.get(key)?.stop()

  useApp.setState((state) => ({
    order: state.order.includes(key) ? state.order : [...state.order, key],
    servers: {
      ...state.servers,
      [key]: state.servers[key] ?? {
        key, url, name, status: { state: 'connecting' }, me: null, channels: [], members: {},
        messages: {}, hasMore: {}, typing: {}, voice: {}, voiceAvailable: false, appUrl: null, publicUrl: null,
      },
    },
  }))

  const connection = new Connection({
    serverUrl: url,
    expectedServerKey: key,
    invite,
    identity,
    name: () => useApp.getState().profile?.name ?? 'Someone',
    profile: () => authProfile(useApp.getState().profile),
    presence: () => authPresence(),
    rotations: () => authRotations(),
    onStatus: (status) => patchServer(key, () => ({ status })),
    onWelcome: (welcome) => onWelcome(key, welcome),
    onEvent: (type, body) => onEvent(key, type, body),
  })
  connections.set(key, connection)
  connection.start()
}

/** Reconnects every server with the current identity (after an account key rotation). */
export function reconnectAll(): void {
  const { servers, order } = useApp.getState()
  for (const key of order) if (servers[key]) connectServer(servers[key].url, key, servers[key].name)
}

/** Retry servers that are waiting to reconnect (e.g. the network came back). */
export function retryAll(): void {
  for (const connection of connections.values()) connection.retryNow()
}

function onWelcome(key: string, welcome: Welcome): void {
  const before = useApp.getState().servers[key]
  patchServer(key, () => ({
    name: welcome.server.name,
    me: welcome.you,
    channels: welcome.channels,
    members: Object.fromEntries(welcome.members.map((m) => [m.accountKey, m])),
    voice: Object.fromEntries(welcome.voice.map((v) => [v.channelId, v.participants])),
    voiceAvailable: welcome.voiceAvailable,
    appUrl: welcome.server.appUrl ?? null,
    publicUrl: welcome.server.publicUrl ?? null,
  }))
  void persistServers()

  // Catch up on anything we missed while disconnected.
  if (before) {
    for (const [channelId, list] of Object.entries(before.messages)) {
      // A loaded channel that was empty catches up from the start (its first messages may have come meanwhile).
      const lastId = list.filter((m) => !m.tempId).at(-1)?.id ?? 0
      void catchUp(key, Number(channelId), lastId)
    }
  }
  // Sends cut off by the disconnect go again first (same nonce: the server answers with the stored message if it got it).
  for (const [tempId, unsent] of unsentSends) if (unsent.key === key) void deliver(key, unsent.channelId, tempId, unsent.body)
  const channel = activeChannelId(useApp.getState())
  if (channel !== null && useApp.getState().activeServer === key) void loadHistory(key, channel)
  for (const listener of welcomeListeners) listener(key, welcome)
}

async function catchUp(key: string, channelId: number, after: number): Promise<void> {
  const connection = connections.get(key)
  if (!connection) return
  try {
    let cursor = after
    for (let page = 0; page < 10; page++) {
      const { messages, hasMore } = await connection.request('chat.history', { channelId, after: cursor, limit: 100 })
      noteMissed(key, messages)
      patchServer(key, (s) => ({
        messages: { ...s.messages, [channelId]: messages.reduce(upsertMessage, s.messages[channelId]) },
      }))
      if (!hasMore || messages.length === 0) break
      cursor = messages[messages.length - 1].id
    }
  } catch {
    /* channel may be gone or we lost access; the channel list update handles that */
  }
}

/** Messages that came in while we were away count as unread, like ones that arrive live (not ones we already had). */
function noteMissed(key: string, messages: Message[]): void {
  const s = useApp.getState().servers[key]
  if (!s) return
  for (const message of messages) {
    if (message.author === s.me?.accountKey || senderRules.ignored(message.author)) continue
    if (s.messages[message.channelId]?.some((m) => m.id === message.id && !m.tempId)) continue
    noteMessage(channelConv(key, message.channelId), { id: message.id, at: message.createdAt },
      !message.forwarded && senderRules.mentionsMe(s, message))
  }
}

function onEvent<K extends keyof Events>(key: string, type: K, body: Events[K]): void {
  for (const listener of eventListeners) listener(key, type, body)
  switch (type) {
    case 'chat.message': {
      const { message, nonce } = body as Events['chat.message']
      // Our own send arriving (maybe before its reply, or after a reconnect): it replaces the placeholder.
      if (nonce) {
        for (const [tempId, unsent] of unsentSends) if (unsent.key === key && unsent.body.nonce === nonce) unsentSends.delete(tempId)
        patchServer(key, (s) => (s.messages[message.channelId]?.some((m) => m.tempId && m.nonce === nonce)
          ? { messages: { ...s.messages, [message.channelId]: s.messages[message.channelId].filter((m) => !(m.tempId && m.nonce === nonce)) } }
          : {}))
      }
      patchServer(key, (s) => {
        const typing = { ...s.typing[message.channelId] }
        delete typing[message.author]
        return {
          messages: s.messages[message.channelId] && !s.detached?.[message.channelId]
            ? { ...s.messages, [message.channelId]: upsertMessage(s.messages[message.channelId], message) }
            : s.messages, // not loaded yet: history will fetch it
          typing: { ...s.typing, [message.channelId]: typing },
        }
      })
      const app = useApp.getState()
      if (app.activeServer !== key || app.activeChannel[key] !== message.channelId) trimChannel(key, message.channelId, HIDDEN_KEEP, HIDDEN_ABOVE)
      // Unread and mentions (state/readState.ts): not your own messages, nor ones from people you blocked.
      const s = app.servers[key]
      if (s && message.author !== s.me?.accountKey && !senderRules.ignored(message.author)) {
        noteMessage(channelConv(key, message.channelId), { id: message.id, at: message.createdAt },
          !!s.me && !message.forwarded && senderRules.mentionsMe(s, message))
      }
      return
    }
    case 'chat.edited': {
      const { message } = body as Events['chat.edited']
      patchServer(key, (s) => ({ messages: { ...s.messages, [message.channelId]: upsertMessage(s.messages[message.channelId], message) } }))
      return
    }
    case 'chat.reactions': {
      const { id, channelId, reactions } = body as Events['chat.reactions']
      patchServer(key, (s) => ({
        messages: s.messages[channelId]
          ? { ...s.messages, [channelId]: s.messages[channelId].map((m) => (m.id === id && !m.tempId ? { ...m, reactions } : m)) }
          : s.messages,
      }))
      return
    }
    case 'chat.deleted': {
      const { id, channelId } = body as Events['chat.deleted']
      patchServer(key, (s) => ({
        messages: { ...s.messages, [channelId]: (s.messages[channelId] ?? []).filter((m) => m.id !== id || m.tempId) },
      }))
      return
    }
    case 'chat.typing': {
      const { channelId, accountKey } = body as Events['chat.typing']
      patchServer(key, (s) => ({
        typing: { ...s.typing, [channelId]: { ...s.typing[channelId], [accountKey]: Date.now() + TYPING_MS } },
      }))
      return
    }
    case 'channels': {
      const { channels } = body as Events['channels']
      patchServer(key, () => ({ channels }))
      return
    }
    case 'member.joined':
    case 'member.updated': {
      const { member } = body as Events['member.updated']
      patchServer(key, (s) => ({
        members: { ...s.members, [member.accountKey]: member },
        me: s.me?.accountKey === member.accountKey ? member : s.me,
      }))
      return
    }
    case 'voice.state': {
      const { channelId, participants } = body as Events['voice.state']
      patchServer(key, (s) => ({ voice: { ...s.voice, [channelId]: participants } }))
      return
    }
    case 'voice.available': {
      const { available } = body as Events['voice.available']
      patchServer(key, () => ({ voiceAvailable: available }))
      return
    }
    case 'member.removed': {
      const { accountKey } = body as Events['member.removed']
      patchServer(key, (s) => {
        const members = { ...s.members }
        delete members[accountKey]
        return { members }
      })
      return
    }
  }
}

// ── Channels and messages ───────────────────────────────────────────────────

export function selectChannel(key: string, channelId: number): void {
  useApp.setState((state) => ({ activeChannel: { ...state.activeChannel, [key]: channelId } }))
  seeConversation(channelConv(key, channelId))
  void loadHistory(key, channelId)
}

export function selectServer(key: string): void {
  useApp.setState({ activeServer: key })
  const channel = activeChannelId(useApp.getState())
  if (channel !== null) selectChannel(key, channel)
}

const loading = new Set<string>()

/** Loads the latest messages the first time, or older ones when <paramref name="older"/> is set. */
export async function loadHistory(key: string, channelId: number, older = false): Promise<void> {
  const server = useApp.getState().servers[key]
  const connection = connections.get(key)
  if (!server || !connection?.isOnline) return
  const existing = server.messages[channelId]
  if (existing && !older) return
  const tag = `${key}:${channelId}:${older}`
  if (loading.has(tag)) return
  loading.add(tag)
  try {
    const before = older ? existing?.find((m) => !m.tempId)?.id : undefined
    const { messages, hasMore } = await connection.request('chat.history', { channelId, before, limit: 50 })
    // After a jump to older messages, the latest page would leave a gap: skip it.
    patchServer(key, (s) => (!older && s.detached?.[channelId] ? {} : {
      messages: { ...s.messages, [channelId]: messages.reduce(upsertMessage, s.messages[channelId] ?? []) },
      hasMore: { ...s.hasMore, [channelId]: hasMore },
    }))
  } catch {
    /* shown as an empty channel; retried on next open */
  } finally {
    loading.delete(tag)
  }
}

let tempCounter = 0

export interface SendOptions {
  attachments?: FileInfo[]
  replyTo?: Message | null
  voice?: VoiceInfo
  sticker?: Sticker
  /** A GIF from the picker: shown right away, sent by its token. */
  gif?: { token: string | DirectGif; shown: MessageGif }
  /** Reuse a nonce (retrying a failed message). */
  nonce?: string
}

type SendBody = { channelId: number; text: string; attachments: string[]; replyTo?: number; nonce: string; voice?: VoiceInfo; sticker?: string; gif?: string | DirectGif }
/** Sends that lost their connection, by tempId: sent again when the server is back. */
const unsentSends = new Map<string, { key: string; channelId: number; body: SendBody }>()

type ChannelSender = (key: string, channelId: number, body: SendBody) => Promise<{ message: Message }> | null
let channelSender: ChannelSender = () => null
/** state/e2eeChannels.ts sends in encrypted channels itself (it returns null for other channels). */
export function setChannelSender(sender: ChannelSender): void {
  channelSender = sender
}

async function deliver(key: string, channelId: number, tempId: string, body: SendBody): Promise<void> {
  try {
    const connection = connections.get(key)
    if (!connection) throw new Error(t('errors.codes.disconnected'))
    const { message } = await (channelSender(key, channelId, body) ?? connection.request('chat.send', body))
    unsentSends.delete(tempId)
    patchServer(key, (s) => ({
      messages: { ...s.messages, [channelId]: upsertMessage((s.messages[channelId] ?? []).filter((m) => m.tempId !== tempId), message) },
    }))
  } catch (e) {
    if ((e as { code?: string }).code === 'disconnected') {
      unsentSends.set(tempId, { key, channelId, body }) // stays "sending" until we're back
      return
    }
    unsentSends.delete(tempId)
    patchServer(key, (s) => ({
      messages: {
        ...s.messages,
        [channelId]: (s.messages[channelId] ?? []).map((m) => (m.tempId === tempId
          ? { ...m, pending: 'failed' as const, blockedReason: (e as { code?: string }).code === 'automod' ? (e as Error).message : undefined }
          : m)),
      },
    }))
  }
}

export async function sendMessage(key: string, channelId: number, text: string, options: SendOptions = {}): Promise<void> {
  const server = useApp.getState().servers[key]
  const connection = connections.get(key)
  if (!server?.me || !connection) return
  const tempId = `t${++tempCounter}`
  const attachments = options.attachments ?? []
  const reply = options.replyTo
  const temp: PendingMessage = {
    id: Number.MAX_SAFE_INTEGER, channelId, author: server.me.accountKey, text, createdAt: Date.now(), editedAt: null,
    attachments, reactions: [], voice: options.voice ?? null, sticker: options.sticker ?? null, gif: options.gif?.shown ?? null, gifToken: options.gif?.token,
    replyTo: reply ? { id: reply.id, author: reply.author, text: reply.text, hasAttachments: reply.attachments.length > 0 } : null,
    pending: 'sending', tempId, nonce: options.nonce ?? b64u(randomBytes(16)),
  }
  patchServer(key, (s) => ({ messages: { ...s.messages, [channelId]: [...(s.messages[channelId] ?? []), temp] } }))
  await deliver(key, channelId, tempId, {
    channelId, text, attachments: attachments.map((a) => a.id), replyTo: reply?.id, nonce: temp.nonce!, voice: options.voice,
    sticker: options.sticker?.id, gif: options.gif?.token,
  })
}

export function discardFailed(key: string, channelId: number, tempId: string): void {
  patchServer(key, (s) => ({ messages: { ...s.messages, [channelId]: (s.messages[channelId] ?? []).filter((m) => m.tempId !== tempId) } }))
}

export async function retryFailed(key: string, channelId: number, message: PendingMessage): Promise<void> {
  if (!message.tempId) return
  discardFailed(key, channelId, message.tempId)
  await sendMessage(key, channelId, message.text, { attachments: message.attachments, voice: message.voice ?? undefined, nonce: message.nonce,
    sticker: message.sticker ?? undefined, gif: message.gif && message.gifToken ? { token: message.gifToken, shown: message.gif } : undefined,
  })
}

/** Uploads a file to a server, reporting progress (0–1). Resolves with the stored file. */
export async function uploadFile(key: string, file: File, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<FileInfo> {
  const server = useApp.getState().servers[key]
  const connection = connections.get(key)
  if (!server || !connection) throw new Error(t('errors.codes.disconnected'))
  const { url } = await connection.request('upload.begin', { name: file.name, size: file.size })
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', server.url + url)
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total)
    xhr.onload = () => {
      if (xhr.status === 200) resolve((JSON.parse(xhr.responseText) as { file: FileInfo }).file)
      else reject(new Error(xhr.status === 413 ? t('app.upload.tooBig') : t('app.upload.failedStatus', { status: xhr.status })))
    }
    xhr.onerror = () => reject(new Error(t('app.upload.failed')))
    xhr.onabort = () => reject(new DOMException('Upload cancelled.', 'AbortError'))
    signal?.addEventListener('abort', () => xhr.abort())
    xhr.send(file)
  })
}

export function toggleReaction(key: string, message: Message, emoji: string): void {
  const me = useApp.getState().servers[key]?.me?.accountKey
  const mine = !!me && message.reactions.some((r) => r.emoji === emoji && r.accounts.includes(me))
  connections.get(key)?.request('chat.react', { id: message.id, emoji, on: !mine }).catch(() => undefined)
}

/** Absolute URL of a server file. */
export const fileUrl = (key: string, file: FileInfo) => (useApp.getState().servers[key]?.url ?? '') + file.url

let lastTyping = 0
export function notifyTyping(key: string, channelId: number): void {
  if (Date.now() - lastTyping < 3_000 || invisible()) return
  lastTyping = Date.now()
  connections.get(key)?.request('chat.typing', { channelId }).catch(() => undefined)
}

/** Direct access for dialogs (invites, channel management, moderation). */
export function connectionFor(key: string): Connection | undefined {
  return connections.get(key)
}

export async function renameMe(name: string): Promise<void> {
  const current = useApp.getState().profile
  const profile = { ...current, name, ...nextStamp(current, useApp.getState().identity?.cert.deviceKey ?? '') }
  await storage.saveProfile(profile)
  useApp.setState({ profile })
  await Promise.all(
    [...connections.values()].filter((c) => c.isOnline).map((c) => c.request('profile.update', { name, ...wireStamp(profile) }).catch(() => undefined)),
  )
}
