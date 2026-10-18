// "Share to Iskra": text, links and files another app shared (the phone apps' share sheet, platform/native.ts) wait
// here until you pick where they go (ui/share/SharePicker.tsx). Sending uses the normal paths, so encrypted channels,
// DMs and groups encrypt the files on this device and the server checks permissions and limits as for any message.
import { create } from 'zustand'
import { t } from '../i18n'
import type { DmFile } from '../core/dmFiles'
import { native } from '../platform/native'
import { connectionFor, selectChannel, selectServer, sendMessage, useApp } from './store'
import { isEncrypted, prepareChannel, uploadFor } from './e2eeChannels'
import { uploadDmFile } from './dmFiles'
import { nameOf, openConversation, sendDm, sharedServers, useDms } from './dms'
import { isArchived, isMember, openGroup, sendGroupMessage, titleOf, useGroups } from './groups'
import { useRoles } from './roles'
import { canSendIn } from './permissions'
import {
  channelTargetId, dmTargetId, groupTargetId, MAX_SHARE_TEXT, overLimit, parseShare, rememberTarget,
  type IncomingShare, type SharedFile, type ShareTarget,
} from './shareInLogic'
import { formatSize } from '../ui/chat/helpers'

export const useShareIn = create<{ share: IncomingShare | null }>(() => ({ share: null }))

/** The entry point for a share: the native side's (via platform/native.ts) and the end-to-end tests'. */
export function receiveShare(raw: unknown): boolean {
  const share = parseShare(raw, location.origin)
  const before = useShareIn.getState().share
  if (before && before.id !== share?.id) native?.shareDone(before.id)
  useShareIn.setState({ share })
  return !!share
}

/** Cancelled or sent: the app can delete its copies. */
export function discardShare(): void {
  const share = useShareIn.getState().share
  if (share) native?.shareDone(share.id)
  useShareIn.setState({ share: null })
}

/** Listens for shares in the phone app. The tests reach the same entry point through window.iskraShare. */
export function startShareIn(): () => void {
  ;(window as { iskraShare?: typeof receiveShare }).iskraShare = receiveShare
  const stop = native?.onShare((raw) => void receiveShare(raw)) ?? (() => {})
  return () => {
    stop()
    delete (window as { iskraShare?: typeof receiveShare }).iskraShare
  }
}

// ── Recents (this device only) ──────────────────────────────────────────────

const RECENTS = 'iskra.shareRecents'

export function loadRecents(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENTS) ?? '[]') as unknown
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string').slice(0, 8) : []
  } catch {
    return []
  }
}

function saveRecent(id: string): void {
  try {
    localStorage.setItem(RECENTS, JSON.stringify(rememberTarget(loadRecents(), id)))
  } catch {
    /* private mode: no recents */
  }
}

// ── Destinations ────────────────────────────────────────────────────────────

const lastActivity = (list: { sentAt?: number; createdAt?: number; pending?: unknown }[] | undefined) => {
  const last = list?.at(-1)
  return last?.sentAt ?? last?.createdAt ?? 0
}

/** Everywhere you can post right now: text channels you may write in, DMs you've had, your groups; and people to DM. */
export function useShareTargets(): { targets: ShareTarget[]; people: ShareTarget[] } {
  const servers = useApp((s) => s.servers)
  const order = useApp((s) => s.order)
  const conversations = useDms((s) => s.conversations)
  const friends = useDms((s) => s.friends)
  const groups = useGroups((s) => s.groups)
  // Every server's roles (channel permission overrides).
  const roles = useRoles((s) => s)

  const targets: ShareTarget[] = []
  const people: ShareTarget[] = []
  const meKeys = new Set(order.map((k) => servers[k]?.me?.accountKey).filter((k): k is string => !!k))
  for (const key of order) {
    const server = servers[key]
    if (!server?.me) continue
    for (const c of server.channels) {
      if (c.kind !== 'text' || !canSendIn(server.me, c, roles[key] ?? [])) continue
      targets.push({
        kind: 'channel', id: channelTargetId(key, c.id), serverKey: key, channelId: c.id, name: c.name, serverName: server.name,
        encrypted: isEncrypted(key, c.id), activity: lastActivity(server.messages[c.id]),
      })
    }
  }
  const bots = new Set<string>()
  for (const s of Object.values(servers)) for (const m of Object.values(s.members)) if (m.bot) bots.add(m.accountKey)
  const dmPeers = new Set<string>()
  for (const [peer, conv] of Object.entries(conversations)) {
    if (meKeys.has(peer) || bots.has(peer) || conv.messages.length === 0) continue
    dmPeers.add(peer)
    targets.push({ kind: 'dm', id: dmTargetId(peer), peer, name: nameOf(peer), activity: lastActivity(conv.messages) })
  }
  for (const f of Object.values(friends)) {
    if (dmPeers.has(f.accountKey) || meKeys.has(f.accountKey)) continue
    dmPeers.add(f.accountKey)
    targets.push({ kind: 'dm', id: dmTargetId(f.accountKey), peer: f.accountKey, name: nameOf(f.accountKey), activity: 0 })
  }
  for (const g of Object.values(groups)) {
    if (!isMember(g) || isArchived(g) || g.problem) continue
    targets.push({
      kind: 'group', id: groupTargetId(g.key), key: g.key, name: titleOf(g), serverName: servers[g.serverKey]?.name ?? '',
      activity: lastActivity(g.messages),
    })
  }
  for (const s of Object.values(servers)) {
    for (const m of Object.values(s.members)) {
      if (m.bot || meKeys.has(m.accountKey) || dmPeers.has(m.accountKey)) continue
      dmPeers.add(m.accountKey)
      people.push({ kind: 'dm', id: dmTargetId(m.accountKey), peer: m.accountKey, name: nameOf(m.accountKey), activity: 0 })
    }
  }
  return { targets, people }
}

// ── Sending ────────────────────────────────────────────────────────────────

async function fileOf(f: SharedFile): Promise<File> {
  const response = await fetch(f.url)
  if (!response.ok) throw new Error(t('share.errors.fileGone', { name: f.name }))
  return new File([await response.blob()], f.name, { type: f.type })
}

/** The server's upload limit, checked before anything is uploaded (the server checks again). */
async function checkLimit(serverKey: string, files: SharedFile[]): Promise<void> {
  if (files.length === 0) return
  const connection = connectionFor(serverKey)
  if (!connection) throw new Error(t('errors.codes.disconnected'))
  const limits = await connection.request('limits.get', {}).catch(() => null)
  const big = overLimit(files, limits?.maxUploadMb ?? 0)
  if (big.length) throw new Error(t('share.errors.tooBig', { name: big[0].name, max: formatSize((limits?.maxUploadMb ?? 0) * 1024 * 1024) }))
}

/** Where a target's files go (the server that carries the message). */
export function routeOf(target: ShareTarget): string | null {
  if (target.kind === 'channel') return target.serverKey
  if (target.kind === 'group') return useGroups.getState().groups[target.key]?.serverKey ?? null
  return sharedServers(target.peer)[0] ?? null
}

/**
 * Sends the share to one place: uploads (encrypted for encrypted channels, DMs and groups), then one message with the
 * text and the files. Then opens that conversation, where the message shows as sending, sent or failed as usual.
 */
export async function sendShare(target: ShareTarget, text: string, files: SharedFile[], onProgress: (fraction: number) => void): Promise<void> {
  const body = text.trim().slice(0, MAX_SHARE_TEXT)
  if (!body && files.length === 0) throw new Error(t('share.errors.empty'))
  const route = routeOf(target)
  if (!route || useApp.getState().servers[route]?.status.state !== 'online') throw new Error(t('share.errors.offline'))
  await checkLimit(route, files)
  const total = files.reduce((n, f) => n + f.size, 0) || 1
  let done = 0
  const progress = (f: SharedFile) => (fraction: number) => onProgress(Math.min(1, (done + fraction * f.size) / total))
  if (target.kind === 'channel') {
    if (target.encrypted) await prepareChannel(target.serverKey, target.channelId).catch(() => undefined)
    const attachments = []
    for (const f of files) {
      attachments.push(await uploadFor(target.serverKey, target.channelId, await fileOf(f), progress(f)))
      done += f.size
    }
    selectServer(target.serverKey)
    selectChannel(target.serverKey, target.channelId)
    void sendMessage(target.serverKey, target.channelId, body, { attachments })
  } else {
    const where = target.kind === 'dm' ? target.peer : { groupId: useGroups.getState().groups[target.key]!.id }
    const sent: DmFile[] = []
    for (const f of files) {
      sent.push(await uploadDmFile(route, where, await fileOf(f), progress(f)))
      done += f.size
    }
    const extra = sent.length ? { files: sent } : {}
    if (target.kind === 'dm') {
      openConversation(target.peer)
      void sendDm(target.peer, body, extra)
    } else {
      openGroup(target.key)
      void sendGroupMessage(target.key, body, extra)
    }
  }
  onProgress(1)
  saveRecent(target.id)
}
