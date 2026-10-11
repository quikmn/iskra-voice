// App state. Components read from here; all server traffic goes through the actions below.
import { create } from 'zustand'
import { Connection, type ConnectionStatus } from '../core/connection'
import { ready } from '../core/crypto'
import { createIdentity, type Identity } from '../core/identity'
import { restoreIdentity } from '../core/recovery'
import { authProfile } from '../core/profile'
import { canPingGroups, mentions } from '../ui/markdown'
import type { InviteLink } from '../core/invite'
import type { Channel, Events, FileInfo, Member, Message, Sticker, VoiceInfo, VoiceParticipant, Welcome } from '../core/protocol'
import * as storage from '../core/storage'

export interface PendingMessage extends Message {
  pending?: 'sending' | 'failed'
  /** Client-side id for messages that aren't confirmed yet. */
  tempId?: string
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
  unread: Record<number, number>
  /** Unread messages that mention you, per channel. */
  mentions: Record<number, number>
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
  phase: 'loading' | 'onboarding' | 'ready'
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
        messages: {}, hasMore: {}, typing: {}, unread: {}, mentions: {}, voice: {}, voiceAvailable: false, appUrl: null, publicUrl: null,
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
    onStatus: (status) => patchServer(key, () => ({ status })),
    onWelcome: (welcome) => onWelcome(key, welcome),
    onEvent: (type, body) => onEvent(key, type, body),
  })
  connections.set(key, connection)
  connection.start()
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
      const lastId = list.filter((m) => !m.tempId).at(-1)?.id
      if (lastId !== undefined) void catchUp(key, Number(channelId), lastId)
    }
  }
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

function onEvent<K extends keyof Events>(key: string, type: K, body: Events[K]): void {
  for (const listener of eventListeners) listener(key, type, body)
  switch (type) {
    case 'chat.message': {
      const { message } = body as Events['chat.message']
      const state = useApp.getState()
      const viewing = state.activeServer === key && activeChannelId(state) === message.channelId && document.hasFocus()
      patchServer(key, (s) => {
        const typing = { ...s.typing[message.channelId] }
        delete typing[message.author]
        return {
          messages: s.messages[message.channelId] && !s.detached?.[message.channelId]
            ? { ...s.messages, [message.channelId]: upsertMessage(s.messages[message.channelId], message) }
            : s.messages, // not loaded yet: history will fetch it
          typing: { ...s.typing, [message.channelId]: typing },
          unread: message.author === s.me?.accountKey || viewing
            ? s.unread
            : { ...s.unread, [message.channelId]: (s.unread[message.channelId] ?? 0) + 1 },
          mentions: message.author === s.me?.accountKey || viewing || !s.me
            || !mentions(message.text, s.me.accountKey, canPingGroups(s.members[message.author]?.role, !!message.webhook), !invisible())
            ? s.mentions
            : { ...s.mentions, [message.channelId]: (s.mentions[message.channelId] ?? 0) + 1 },
        }
      })
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
  patchServer(key, (s) => ({ unread: { ...s.unread, [channelId]: 0 }, mentions: { ...s.mentions, [channelId]: 0 } }))
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
    attachments, reactions: [], voice: options.voice ?? null, sticker: options.sticker ?? null,
    replyTo: reply ? { id: reply.id, author: reply.author, text: reply.text, hasAttachments: reply.attachments.length > 0 } : null,
    pending: 'sending', tempId,
  }
  patchServer(key, (s) => ({ messages: { ...s.messages, [channelId]: [...(s.messages[channelId] ?? []), temp] } }))
  try {
    const { message } = await connection.request('chat.send', {
      channelId, text, attachments: attachments.map((a) => a.id), replyTo: reply?.id, voice: options.voice, sticker: options.sticker?.id,
    })
    patchServer(key, (s) => ({
      messages: { ...s.messages, [channelId]: upsertMessage((s.messages[channelId] ?? []).filter((m) => m.tempId !== tempId), message) },
    }))
  } catch {
    patchServer(key, (s) => ({
      messages: {
        ...s.messages,
        [channelId]: (s.messages[channelId] ?? []).map((m) => (m.tempId === tempId ? { ...m, pending: 'failed' as const } : m)),
      },
    }))
  }
}

export function discardFailed(key: string, channelId: number, tempId: string): void {
  patchServer(key, (s) => ({ messages: { ...s.messages, [channelId]: (s.messages[channelId] ?? []).filter((m) => m.tempId !== tempId) } }))
}

export async function retryFailed(key: string, channelId: number, message: PendingMessage): Promise<void> {
  if (!message.tempId) return
  discardFailed(key, channelId, message.tempId)
  await sendMessage(key, channelId, message.text, { attachments: message.attachments, voice: message.voice ?? undefined, sticker: message.sticker ?? undefined })
}

/** Uploads a file to a server, reporting progress (0–1). Resolves with the stored file. */
export async function uploadFile(key: string, file: File, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<FileInfo> {
  const server = useApp.getState().servers[key]
  const connection = connections.get(key)
  if (!server || !connection) throw new Error('Not connected.')
  const { url } = await connection.request('upload.begin', { name: file.name, size: file.size })
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', server.url + url)
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total)
    xhr.onload = () => {
      if (xhr.status === 200) resolve((JSON.parse(xhr.responseText) as { file: FileInfo }).file)
      else reject(new Error(xhr.status === 413 ? 'That file is too big for this server.' : `Upload failed (${xhr.status}).`))
    }
    xhr.onerror = () => reject(new Error('Upload failed. Check your connection.'))
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
  const profile = { ...useApp.getState().profile, name }
  await storage.saveProfile(profile)
  useApp.setState({ profile })
  await Promise.all(
    [...connections.values()].filter((c) => c.isOnline).map((c) => c.request('profile.update', { name }).catch(() => undefined)),
  )
}
