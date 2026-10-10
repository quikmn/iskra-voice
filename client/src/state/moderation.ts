// Safety and moderation: your block list (kept on this device and synced to every server you're on, which enforce it),
// timeouts (yours, with the reason), slowmode send times, and the admins' audit log.
import { create } from 'zustand'
import { b64u } from '../core/crypto'
import type { AuditEntry, BlockEntry, Events } from '../core/protocol'
import * as storage from '../core/storage'
import { connectionFor, onServerEvent, onWelcomeHook, useApp } from './store'
import { blockChange, mergeBlocks, sameBlocks } from './moderationRules'

export const useBlocks = create<{ entries: BlockEntry[] }>(() => ({ entries: [] }))

export const isBlocked = (entries: BlockEntry[], accountKey: string) => entries.some((e) => e.accountKey === accountKey && e.blocked)
export const useIsBlocked = (accountKey: string) => useBlocks((s) => isBlocked(s.entries, accountKey))

let loaded: Promise<void> | null = null
function ensureLoaded(): Promise<void> {
  loaded ??= storage.loadBlocks()
    .then((list) => useBlocks.setState((s) => ({ entries: mergeBlocks(s.entries, list) })))
    .catch(() => undefined)
  return loaded
}

/** Takes a merged list; saves it and tells the other servers if anything changed. */
async function adopt(next: BlockEntry[], from?: string): Promise<void> {
  if (sameBlocks(useBlocks.getState().entries, next)) return
  useBlocks.setState({ entries: next })
  await storage.saveBlocks(next).catch(() => undefined)
  pushAll(from)
}

function onlineServers(): string[] {
  return Object.keys(useApp.getState().servers).filter((key) => connectionFor(key)?.isOnline)
}

function pushAll(except?: string): void {
  for (const key of onlineServers()) if (key !== except) void push(key)
}

/** Sends our list to one server and takes back anything newer it had. */
async function push(serverKey: string): Promise<void> {
  const connection = connectionFor(serverKey)
  if (!connection?.isOnline) return
  try {
    const { blocks } = await connection.request('block.sync', { entries: useBlocks.getState().entries })
    await adopt(mergeBlocks(useBlocks.getState().entries, blocks), serverKey)
  } catch {
    /* retried on the next connect */
  }
}

async function syncServer(serverKey: string): Promise<void> {
  await ensureLoaded()
  const connection = connectionFor(serverKey)
  if (!connection?.isOnline) return
  try {
    const { blocks: remote } = await connection.request('block.list', {})
    const merged = mergeBlocks(useBlocks.getState().entries, remote)
    await adopt(merged, serverKey)
    if (!sameBlocks(merged, remote)) await push(serverKey)
  } catch {
    /* older server, or offline again */
  }
}

/** Block or unblock someone everywhere. */
export async function setBlocked(accountKey: string, blocked: boolean): Promise<void> {
  await ensureLoaded()
  await adopt(blockChange(useBlocks.getState().entries, accountKey, blocked))
}

// ── Timeouts ────────────────────────────────────────────────────────────────

/** Your own timeout per server, with the reason (only you and admins see it). */
export const useMyTimeouts = create<Record<string, { until: number; reason: string | null } | null>>(() => ({}))

async function refreshMyTimeout(serverKey: string): Promise<void> {
  try {
    const { timeout } = (await connectionFor(serverKey)?.request('member.timeout.status', {})) ?? { timeout: null }
    useMyTimeouts.setState({ [serverKey]: timeout })
  } catch {
    /* older server */
  }
}

export async function timeoutMember(serverKey: string, accountKey: string, durationMs: number, reason?: string): Promise<void> {
  const connection = connectionFor(serverKey)
  if (!connection) throw new Error('Not connected.')
  await connection.request('member.timeout', { accountKey, durationMs, reason: reason?.trim() || undefined })
}

export async function removeTimeout(serverKey: string, accountKey: string): Promise<void> {
  const connection = connectionFor(serverKey)
  if (!connection) throw new Error('Not connected.')
  await connection.request('member.timeout.remove', { accountKey })
}

// ── Slowmode ────────────────────────────────────────────────────────────────

/** When you last sent in each channel (`server:channel`), by this device's clock. */
export const useLastSent = create<Record<string, number>>(() => ({}))
export const lastSentKey = (serverKey: string, channelId: number) => `${serverKey}:${channelId}`

// ── Audit log ───────────────────────────────────────────────────────────────

export async function loadAudit(
  serverKey: string, filter: { action?: string; person?: string; before?: number },
): Promise<{ entries: AuditEntry[]; hasMore: boolean }> {
  const connection = connectionFor(serverKey)
  if (!connection) throw new Error('Not connected.')
  return connection.request('audit.list', { ...filter, limit: 50 })
}

// ── Wiring ──────────────────────────────────────────────────────────────────

const myKey = () => {
  const identity = useApp.getState().identity
  return identity ? b64u(identity.account.publicKey) : null
}

onWelcomeHook((serverKey, welcome) => {
  void syncServer(serverKey)
  if (welcome.you.timedOutUntil) void refreshMyTimeout(serverKey)
  else useMyTimeouts.setState({ [serverKey]: null })
})

onServerEvent((serverKey, type, body) => {
  if (type === 'blocks') {
    void adopt(mergeBlocks(useBlocks.getState().entries, (body as Events['blocks']).blocks), serverKey)
  } else if (type === 'member.updated') {
    const { member } = body as Events['member.updated']
    if (member.accountKey !== myKey()) return
    if (member.timedOutUntil) void refreshMyTimeout(serverKey)
    else useMyTimeouts.setState({ [serverKey]: null })
  } else if (type === 'chat.message') {
    const { message } = body as Events['chat.message']
    if (message.author === myKey()) useLastSent.setState({ [lastSentKey(serverKey, message.channelId)]: Date.now() })
  }
})
