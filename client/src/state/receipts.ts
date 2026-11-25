// Read receipts for DMs and group DMs (state/receiptsLogic.ts). Off by default, and mutual: only someone who sends
// receipts is shown other people's. A receipt is sealed like a message of that conversation and goes through its own
// requests (dm.receipt, group.receipt): the server relays it and keeps the newest one per reader and conversation,
// so it knows that and when you read a conversation, never which message. The switch itself follows the account,
// sealed (prefs "receipts"), so servers aren't told about it either.
import { create } from 'zustand'
import { decryptDm } from '../core/dm'
import { decryptGroup } from '../core/group'
import type { WireDmReceipt, WireGroupReceipt } from '../core/protocol'
import { b64u } from '../core/crypto'
import { openPrefs, prefsKey, sealPrefs } from '../core/prefs'
import { botMember } from './botDms'
import { dmStatus } from './dmRequests'
import { encryptFor, sharedServers, useDms, type Dm } from './dms'
import type { GroupMsg } from './groupLogic'
import { groupKey, sealForGroup, useGroups } from './groups'
import { keysReady, resolveKey, sameAccount } from './keyMap'
import { isBlocked, useBlocks } from './moderation'
import { dmConv, groupConv, isOnScreen, readOf } from './readState'
import {
  emptyReceiptSettings, laterMark, parseReceiptMark, parseReceiptSettings, receiptToSend, type ReceiptMark, type ReceiptMessage, type ReceiptSettings,
} from './receiptsLogic'
import { connectionFor, onServerEvent, onWelcomeHook, useApp } from './store'

const STORAGE_KEY = 'iskra.receipts'
const SENT_KEY = 'iskra.receipts.sent'
const PREF = 'receipts'
/** What a receipt carries as its text: never shown (receipts don't travel as messages), only there because content needs one. */
const FALLBACK_TEXT = '✓'
const MAX_SENT = 300

interface ReceiptsState {
  settings: ReceiptSettings
  /** Per conversation (readState's keys), each reader's newest mark. Empty while your own receipts are off. */
  marks: Record<string, Record<string, ReceiptMark>>
}

function load(): ReceiptSettings {
  try {
    return parseReceiptSettings(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')) ?? emptyReceiptSettings()
  } catch {
    return emptyReceiptSettings()
  }
}

export const useReceipts = create<ReceiptsState>(() => ({ settings: load(), marks: {} }))

export const useSendsReceipts = (): boolean => useReceipts((s) => s.settings.send)
const EMPTY: Record<string, ReceiptMark> = {}
/** The marks of a conversation's readers (none while your own receipts are off). */
export const useReceiptMarks = (conv: string): Record<string, ReceiptMark> => useReceipts((s) => s.marks[conv] ?? EMPTY)

const me = () => {
  const identity = useApp.getState().identity
  return identity ? b64u(identity.account.publicKey) : ''
}

// ── What this device already sent (so a reload doesn't send it again) ──────────

let sent: Record<string, ReceiptMark> = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem(SENT_KEY) ?? '{}') as Record<string, unknown>
    return Object.fromEntries(Object.entries(raw).flatMap(([conv, mark]) => {
      const parsed = parseReceiptMark(mark)
      return parsed ? [[conv, parsed]] : []
    }))
  } catch {
    return {}
  }
})()

function noteSent(conv: string, mark: ReceiptMark): void {
  delete sent[conv]
  sent[conv] = mark // newest last
  const keys = Object.keys(sent)
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_SENT))) delete sent[old]
  try {
    localStorage.setItem(SENT_KEY, JSON.stringify(sent))
  } catch {
    /* private mode */
  }
}

// ── Receiving ────────────────────────────────────────────────────────────────

function keepMark(conv: string, reader: string, mark: ReceiptMark): void {
  useReceipts.setState((s) => {
    const current = s.marks[conv]?.[reader]
    const next = laterMark(current, mark)
    if (next === current) return s
    return { marks: { ...s.marks, [conv]: { ...s.marks[conv], [reader]: next } } }
  })
}

async function onDmReceipt(wire: WireDmReceipt): Promise<void> {
  // Mutual: someone who doesn't send receipts isn't shown anyone's.
  if (!useReceipts.getState().settings.send) return
  await keysReady()
  const identity = useApp.getState().identity
  const mine = me()
  if (!identity || !sameAccount(wire.to, mine) || sameAccount(wire.from, mine)) return
  try {
    const content = decryptDm(identity, wire.envelope, wire.from, wire.to, sameAccount)
    const mark = parseReceiptMark(content.receipt)
    if (mark) keepMark(dmConv(resolveKey(wire.from)), resolveKey(wire.from), mark)
  } catch {
    /* not for this device, or not a receipt: nothing to show */
  }
}

function onGroupReceipt(serverKey: string, wire: WireGroupReceipt): void {
  if (!useReceipts.getState().settings.send) return
  const identity = useApp.getState().identity
  const key = groupKey(serverKey, wire.group)
  const view = useGroups.getState().groups[key]?.view
  if (!identity || !view || sameAccount(wire.from, me())) return
  try {
    const content = decryptGroup(identity, wire.envelope, { group: wire.group, from: wire.from, version: wire.version }, view)
    const mark = parseReceiptMark(content.receipt)
    if (mark) keepMark(groupConv(key), resolveKey(wire.from), mark)
  } catch {
    /* sealed before this device was in the group, or not a receipt */
  }
}

/** The receipts people sent you while you were away (the server keeps each person's newest). */
async function loadDmReceipts(serverKey: string): Promise<void> {
  if (!useReceipts.getState().settings.send) return
  try {
    const { receipts } = await connectionFor(serverKey)!.request('dm.receipts', {})
    for (const receipt of receipts) await onDmReceipt(receipt)
  } catch {
    /* an older server without receipts, or offline */
  }
}

const groupsLoaded = new Set<string>()

/** The same for one group, the first time it is opened after connecting. */
export async function loadGroupReceipts(key: string): Promise<void> {
  const g = useGroups.getState().groups[key]
  if (!g?.view || !useReceipts.getState().settings.send || groupsLoaded.has(key)) return
  groupsLoaded.add(key)
  try {
    const { receipts } = await connectionFor(g.serverKey)!.request('group.receipts', { groupId: g.id })
    for (const receipt of receipts) onGroupReceipt(g.serverKey, receipt)
  } catch {
    groupsLoaded.delete(key)
  }
}

// ── Sending ──────────────────────────────────────────────────────────────────

/** A conversation's messages as the receipt rules see them: lines nobody wrote as a message (calls, friend actions, timer and rename lines) are never "seen". */
export const dmReceiptMessages = (messages: Dm[]): ReceiptMessage[] =>
  messages.map((m) => ({ id: m.id, from: m.from, sentAt: m.sentAt, pending: m.pending, error: m.error, quiet: !!(m.friend || m.call || m.disappear || m.notice) }))

export const groupReceiptMessages = (messages: GroupMsg[]): ReceiptMessage[] =>
  messages.map((m) => ({ id: m.id, from: m.from, sentAt: m.sentAt, pending: m.pending, error: m.error, quiet: !!(m.group || m.call || m.disappear) }))

const sending = new Set<string>()

/** Whether you have read this conversation: on screen with the window focused, and not marked unread. */
const reading = (conv: string): boolean => isOnScreen(conv) && readOf(conv).unread === 0

/**
 * Tells the other person how far you have read this DM, if your receipts are on, you are looking at it, and there is
 * something new from them. Never for a message request, an ignored or blocked person, or a bot.
 */
export async function sendDmReceipt(peer: string): Promise<void> {
  const conv = dmConv(peer)
  const mine = me()
  if (!useReceipts.getState().settings.send || peer === mine || sending.has(conv) || !reading(conv)) return
  if (dmStatus(peer) !== 'accepted' || botMember(peer) || isBlocked(useBlocks.getState().entries, peer)) return
  const messages = dmReceiptMessages(useDms.getState().conversations[peer]?.messages ?? [])
  const mark = receiptToSend(messages, mine, sent[conv])
  const route = sharedServers(peer)[0]
  if (!mark || !route) return
  sending.add(conv)
  try {
    const envelope = await encryptFor(route, peer, { text: FALLBACK_TEXT, receipt: mark })
    await connectionFor(route)!.request('dm.receipt', { accountKey: peer, envelope })
    noteSent(conv, mark)
  } catch {
    /* refused (they take no messages from you) or offline: nothing to tell, the next message tries again */
  } finally {
    sending.delete(conv)
  }
}

/** The same for a group you are in. */
export async function sendGroupReceipt(key: string): Promise<void> {
  const conv = groupConv(key)
  const mine = me()
  const g = useGroups.getState().groups[key]
  if (!g?.view || !useReceipts.getState().settings.send || sending.has(conv) || !reading(conv)) return
  const messages = groupReceiptMessages(g.messages)
  const mark = receiptToSend(messages, mine, sent[conv])
  if (!mark) return
  sending.add(conv)
  try {
    const { envelope, version } = await sealForGroup(key, { text: FALLBACK_TEXT, receipt: mark })
    await connectionFor(g.serverKey)!.request('group.receipt', { groupId: g.id, version, envelope })
    noteSent(conv, mark)
  } catch {
    /* the group changed or its server is offline: the next message tries again */
  } finally {
    sending.delete(conv)
  }
}

// ── The setting, synced across devices (sealed) ─────────────────────────────

function keep(settings: ReceiptSettings): void {
  const was = useReceipts.getState().settings.send
  // Turned off: what others told you is dropped, since you no longer share yours.
  useReceipts.setState(settings.send ? { settings } : { settings, marks: {} })
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    /* private mode */
  }
  if (settings.send && !was) {
    groupsLoaded.clear()
    for (const key of useApp.getState().order) void loadDmReceipts(key)
  }
}

export function setSendReceipts(send: boolean): void {
  const current = useReceipts.getState().settings
  if (current.send === send) return
  const settings: ReceiptSettings = { v: 1, send, updatedAt: Math.max(Date.now(), current.updatedAt + 1) }
  keep(settings)
  for (const key of useApp.getState().order) void sealTo(key, settings)
}

function keyNow(): Uint8Array | null {
  const identity = useApp.getState().identity
  return identity ? prefsKey(identity.account.secretKey) : null
}

async function sealTo(serverKey: string, settings: ReceiptSettings): Promise<void> {
  const key = keyNow()
  const connection = connectionFor(serverKey)
  if (!key || !connection?.isOnline || settings.updatedAt === 0) return
  await connection.request('prefs.set', { name: PREF, data: sealPrefs(key, PREF, JSON.stringify(settings)), updatedAt: settings.updatedAt }).catch(() => undefined)
}

async function syncWith(serverKey: string): Promise<void> {
  const connection = connectionFor(serverKey)
  const key = keyNow()
  if (!connection || !key) return
  try {
    const { data, updatedAt } = await connection.request('prefs.get', { name: PREF })
    const local = useReceipts.getState().settings
    const opened = data ? openPrefs(key, PREF, data) : null
    if (opened !== null && updatedAt !== null && updatedAt > local.updatedAt) {
      const remote = parseReceiptSettings(JSON.parse(opened))
      if (remote) keep({ ...remote, updatedAt })
    } else if ((updatedAt ?? 0) < local.updatedAt || (data && opened === null)) {
      await sealTo(serverKey, local)
    }
  } catch {
    /* an older server without prefs, or offline: the local copy still works */
  }
}

onWelcomeHook((serverKey) => {
  for (const key of [...groupsLoaded]) if (key.startsWith(`${serverKey}/`)) groupsLoaded.delete(key)
  void syncWith(serverKey).then(() => loadDmReceipts(serverKey))
})

onServerEvent((serverKey, type, body) => {
  if (type === 'prefs.updated' && (body as { name: string }).name === PREF) void syncWith(serverKey)
  else if (type === 'dm.receipt') void onDmReceipt(body as WireDmReceipt)
  else if (type === 'group.receipt') onGroupReceipt(serverKey, body as WireGroupReceipt)
})
