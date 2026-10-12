// Where catch-up gets its messages: a channel, thread or forum post (fetched from the server from the first unread
// message on), or a DM or group DM (already decrypted on this device; nothing is sent anywhere).
import type { Message } from '../../core/protocol'
import { prepareChannel, readable } from '../../state/e2eeChannels'
import { b64u } from '../../core/crypto'
import { scrollBehavior } from '../a11y'
import type { CatchUpMessage } from '../../state/catchupLogic'
import type { MessageRef } from '../../state/readState'
import { connectionFor, useApp } from '../../state/store'
import { canPingGroups, mentionsMyRole } from '../../state/permissions'
import { rolesFor } from '../../state/roles'
import { useDms, nameOf as dmName } from '../../state/dms'
import { knownName, useGroups } from '../../state/groups'
import { flash, jumpToMessage } from '../../state/jump'
import { mentions } from '../markdown'

export type CatchUpSpec =
  | { kind: 'channel'; serverKey: string; channelId: number }
  | { kind: 'dm'; peer: string }
  | { kind: 'group'; key: string }

export interface LoadedSpan {
  messages: CatchUpMessage[]
  /** Display names by author, for messages whose author isn't a known member (webhooks, imports). */
  names: Record<string, string>
}

/** The most a catch-up reads (older unread messages beyond it are left out). */
export const MAX_SPAN = 2000
const PAGE = 100

const isImage = (type: string) => type.startsWith('image/')

export function fromMessage(m: Message, me: string, mentioned: boolean): CatchUpMessage {
  const images = m.attachments.filter((a) => isImage(a.type)).length + (m.gif ? 1 : 0)
  return {
    id: m.id,
    author: m.author,
    at: m.createdAt,
    text: m.text,
    mine: m.author === me,
    reactions: m.reactions.reduce((n, r) => n + r.accounts.length, 0),
    replyTo: m.replyTo?.id ?? null,
    threadReplies: m.thread?.messageCount ?? 0,
    pinned: !!m.pinned,
    mentionsMe: mentioned,
    images,
    files: m.attachments.length - m.attachments.filter((a) => isImage(a.type)).length,
    poll: m.poll ? m.text : null,
  }
}

async function loadChannel(serverKey: string, channelId: number, from: MessageRef, signal: AbortSignal): Promise<LoadedSpan> {
  const connection = connectionFor(serverKey)
  const server = useApp.getState().servers[serverKey]
  if (!connection || !server) throw new Error('Not connected')
  const me = server.me?.accountKey ?? ''
  const roles = rolesFor(serverKey)
  const out: CatchUpMessage[] = []
  const names: Record<string, string> = {}
  let after = typeof from.id === 'number' ? from.id - 1 : 0
  for (let page = 0; page < MAX_SPAN / PAGE; page++) {
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError')
    const { messages, hasMore } = await connection.request('chat.history', { channelId, after, limit: PAGE })
    // Encrypted channels: decrypted here, on the device (catch-up never leaves it).
    if (page === 0) await prepareChannel(serverKey, channelId).catch(() => {})
    for (const raw of messages) {
      const m = readable(serverKey, raw)
      const author = server.members[m.author]
      const webhook = !!m.webhook
      const mentioned = !!server.me && (mentions(m.text, me, canPingGroups(author, roles, webhook)) || mentionsMyRole(m.text, server.me, author, roles, webhook))
      out.push(fromMessage(m, me, mentioned))
      if (m.webhook) names[m.author] = m.webhook.name
      else if (m.imported) names[m.author] = m.imported.name
    }
    if (!hasMore || messages.length === 0) break
    after = messages[messages.length - 1].id
  }
  return { messages: out, names }
}

function myKey(): string {
  const identity = useApp.getState().identity
  return identity ? b64u(identity.account.publicKey) : ''
}

function localSpan(list: { id: string; from: string; text: string; sentAt: number; files?: { type: string }[]; error?: string; notice?: string; friend?: unknown; call?: unknown; group?: unknown }[], from: MessageRef): LoadedSpan {
  const me = myKey()
  const messages = list
    .filter((m) => m.sentAt >= from.at && !m.error && !m.notice && !m.friend && !m.call && !m.group)
    .map((m): CatchUpMessage => ({
      id: m.id, author: m.from, at: m.sentAt, text: m.text, mine: m.from === me, reactions: 0, replyTo: null, threadReplies: 0,
      pinned: false, mentionsMe: false, poll: null,
      images: (m.files ?? []).filter((f) => isImage(f.type)).length,
      files: (m.files ?? []).filter((f) => !isImage(f.type)).length,
    }))
  return { messages, names: {} }
}

export function loadSpan(spec: CatchUpSpec, from: MessageRef, signal: AbortSignal): Promise<LoadedSpan> {
  if (spec.kind === 'channel') return loadChannel(spec.serverKey, spec.channelId, from, signal)
  if (spec.kind === 'dm') return Promise.resolve(localSpan(useDms.getState().conversations[spec.peer]?.messages ?? [], from))
  return Promise.resolve(localSpan(useGroups.getState().groups[spec.key]?.messages ?? [], from))
}

/** A person's name as this conversation shows it. */
export function nameFor(spec: CatchUpSpec, key: string, names: Record<string, string>): string {
  if (names[key]) return names[key]
  if (spec.kind === 'channel') return useApp.getState().servers[spec.serverKey]?.members[key]?.name ?? dmName(key)
  return spec.kind === 'dm' ? dmName(key) : knownName(key)
}

/** Shows a message from the summary in its conversation. */
export function jumpTo(spec: CatchUpSpec, id: number | string): void {
  if (spec.kind === 'channel') {
    if (typeof id === 'number') void jumpToMessage(spec.serverKey, spec.channelId, id)
    return
  }
  const row = document.querySelector(`[data-dm-id="${CSS.escape(String(id))}"]`)
  if (!row) return
  row.scrollIntoView({ block: 'center', behavior: scrollBehavior() })
  flash(row)
}
