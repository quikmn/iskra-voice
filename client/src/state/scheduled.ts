// "Send later". Channel messages are kept on their server as text and sent at their time as you, with the checks of
// a normal send then. DMs and groups stay end-to-end encrypted: we encrypt when you schedule (with the send time as
// the message's time) and the server only holds the envelope until it's due. The trade-off: a device the recipient
// adds in between can't read it, a group that changes in between refuses it (you're told and can send it again), and
// it can be scheduled at most 30 days ahead (prekeys are kept that long). In exchange it goes out while your apps are
// closed, and the server never sees the text.
import { create } from 'zustand'
import { t } from '../i18n'
import { decryptDm, type DmEnvelope } from '../core/dm'
import { decryptGroup, type GroupEnvelope } from '../core/group'
import type { Events, WireScheduled } from '../core/protocol'
import { loadPrivate, savePrivate } from '../core/storage'
import { connectionFor, onServerEvent, onWelcomeHook, selectChannel, selectServer, useApp } from './store'
import { show } from './notify'
import { encryptFor, nameOf, openConversation, sharedServers } from './dms'
import { cannotSend, groupKey, openGroup, sealForGroup, titleOf, useGroups } from './groups'
import { sameAccount } from './keyMap'
import { conversationLabel } from './threads'

export interface Scheduled extends WireScheduled {
  server: string
  /** The text, if this device can show it (channel messages always; encrypted ones if we made or can open them). */
  shown: string | null
}

export type ScheduleTarget =
  | { kind: 'channel'; server: string; channelId: number; replyTo?: number }
  | { kind: 'dm'; peer: string }
  | { kind: 'group'; key: string }

export const useScheduled = create<{ all: Record<string, Scheduled> }>(() => ({ all: {} }))

const tag = (server: string, id: number) => `${server}:${id}`
const TEXTS = 'scheduled-texts'

/** Texts of encrypted ones we scheduled here, so they show even when the envelope can't be opened any more. */
let texts: Record<string, string> = {}
let textsLoaded: Promise<void> | null = null
const loadTexts = () => (textsLoaded ??= loadPrivate<Record<string, string>>(TEXTS).then((v) => { texts = { ...(v ?? {}), ...texts } }).catch(() => undefined))

function rememberText(server: string, id: number, text: string | null): void {
  if (text === null) delete texts[tag(server, id)]
  else texts[tag(server, id)] = text
  void savePrivate(TEXTS, texts).catch(() => undefined)
}

function shownText(server: string, wire: WireScheduled): string | null {
  if (wire.kind === 'channel') return wire.text
  const kept = texts[tag(server, wire.id)]
  if (kept !== undefined) return kept
  const identity = useApp.getState().identity
  if (!identity || !wire.envelope) return null
  try {
    if (wire.kind === 'dm') return decryptDm(identity, wire.envelope as DmEnvelope, identity.cert.accountKey, wire.accountKey!, sameAccount).text
    const view = useGroups.getState().groups[groupKey(server, wire.groupId!)]?.view
    if (!view || view.version !== wire.version) return null
    return decryptGroup(identity, wire.envelope as GroupEnvelope, { group: wire.groupId!, from: identity.cert.accountKey, version: wire.version! }, view).text
  } catch {
    return null
  }
}

function put(server: string, wire: WireScheduled): Scheduled {
  const item = { ...wire, server, shown: shownText(server, wire) }
  useScheduled.setState((s) => ({ all: { ...s.all, [tag(server, wire.id)]: item } }))
  return item
}

function drop(server: string, id: number): void {
  useScheduled.setState((s) => {
    const all = { ...s.all }
    delete all[tag(server, id)]
    return { all }
  })
  rememberText(server, id, null)
}

export const scheduledList = (all: Record<string, Scheduled>) => Object.values(all).sort((a, b) => a.sendAt - b.sendAt)

/** Where it goes, for lists: "#general · Gaming", a person, or a group. */
export function scheduledWhere(item: Scheduled): string {
  if (item.kind === 'dm') return nameOf(item.accountKey!)
  if (item.kind === 'group') {
    const g = useGroups.getState().groups[groupKey(item.server, item.groupId!)]
    return g ? titleOf(g) : t('groups.notify.aGroup')
  }
  const server = useApp.getState().servers[item.server]
  return server ? `${conversationLabel(server, item.channelId!)} · ${server.name}` : t('productivity.scheduled.unknownPlace')
}

export function canSchedule(target: ScheduleTarget): boolean {
  if (target.kind === 'channel') return useApp.getState().servers[target.server]?.status.state === 'online'
  if (target.kind === 'dm') return sharedServers(target.peer).length > 0
  return cannotSend(useGroups.getState().groups[target.key]) === null
}

export async function scheduleMessage(target: ScheduleTarget, text: string, sendAt: number): Promise<Scheduled> {
  await loadTexts()
  if (target.kind === 'channel') {
    const { scheduled } = await connectionFor(target.server)!.request('scheduled.create', {
      channelId: target.channelId, text, sendAt, ...(target.replyTo ? { replyTo: target.replyTo } : {}),
    })
    return put(target.server, scheduled)
  }
  if (target.kind === 'dm') {
    const server = sharedServers(target.peer)[0]
    if (!server) throw new Error(t('dms.errors.noSharedServer'))
    const envelope = await encryptFor(server, target.peer, { text }, sendAt)
    const { scheduled } = await connectionFor(server)!.request('scheduled.create', { accountKey: target.peer, envelope, sendAt })
    rememberText(server, scheduled.id, text)
    return put(server, scheduled)
  }
  const g = useGroups.getState().groups[target.key]!
  const { envelope, version } = await sealForGroup(target.key, { text }, sendAt)
  const { scheduled } = await connectionFor(g.serverKey)!.request('scheduled.create', { groupId: g.id, version, envelope, sendAt })
  rememberText(g.serverKey, scheduled.id, text)
  return put(g.serverKey, scheduled)
}

/** A new time and/or text. Encrypted ones are encrypted again (their time is inside the envelope). */
export async function updateScheduled(item: Scheduled, change: { sendAt?: number; text?: string }): Promise<void> {
  const connection = connectionFor(item.server)
  if (!connection) throw new Error(t('productivity.errors.offline'))
  const sendAt = change.sendAt ?? item.sendAt
  const text = change.text ?? item.shown
  if (item.kind === 'channel') {
    const { scheduled } = await connection.request('scheduled.update', { id: item.id, sendAt, ...(change.text !== undefined ? { text: change.text } : {}) })
    put(item.server, scheduled)
    return
  }
  if (text === null) throw new Error(t('productivity.scheduled.cantOpen'))
  const sealed = item.kind === 'dm'
    ? { envelope: await encryptFor(item.server, item.accountKey!, { text }, sendAt) }
    : await sealForGroup(groupKey(item.server, item.groupId!), { text }, sendAt)
  const { scheduled } = await connection.request('scheduled.update', { id: item.id, sendAt, ...sealed })
  rememberText(item.server, item.id, text)
  put(item.server, scheduled)
}

export async function sendScheduledNow(item: Scheduled): Promise<void> {
  // A failed group message was encrypted for an old member list: encrypt it again for the group as it is now.
  if (item.kind === 'group' && item.status === 'failed' && item.shown !== null) await updateScheduled(item, { sendAt: Date.now() + 60_000 })
  await connectionFor(item.server)!.request('scheduled.send', { id: item.id })
  drop(item.server, item.id)
}

export async function deleteScheduled(item: Scheduled): Promise<void> {
  await connectionFor(item.server)?.request('scheduled.delete', { id: item.id })
  drop(item.server, item.id)
}

/** Opens the conversation a scheduled message goes to. */
export function openScheduledPlace(item: Scheduled): void {
  if (item.kind === 'dm') return openConversation(item.accountKey!)
  if (item.kind === 'group') return openGroup(groupKey(item.server, item.groupId!))
  selectServer(item.server)
  selectChannel(item.server, item.channelId!)
}

async function load(server: string): Promise<void> {
  const connection = connectionFor(server)
  if (!connection) return
  try {
    await loadTexts()
    const { scheduled } = await connection.request('scheduled.list', {})
    useScheduled.setState((s) => {
      const all = Object.fromEntries(Object.entries(s.all).filter(([k]) => !k.startsWith(`${server}:`)))
      for (const wire of scheduled) all[tag(server, wire.id)] = { ...wire, server, shown: shownText(server, wire) }
      return { all }
    })
  } catch {
    /* an older server without scheduled messages */
  }
}

onWelcomeHook((server) => void load(server))
onServerEvent((server, type, body) => {
  if (type === 'scheduled.deleted') drop(server, (body as Events['scheduled.deleted']).id)
  if (type === 'scheduled.updated') {
    const before = useScheduled.getState().all[tag(server, (body as Events['scheduled.updated']).scheduled.id)]
    const item = put(server, (body as Events['scheduled.updated']).scheduled)
    if (item.status === 'failed' && before?.status !== 'failed') {
      show(server, t('productivity.scheduled.failedTitle'), item.error ?? t('productivity.scheduled.failedBody'), () => openScheduledPlace(item))
    }
  }
})
useApp.subscribe((state, before) => {
  if (state.order === before.order) return
  const gone = before.order.filter((k) => !state.order.includes(k))
  if (gone.length) useScheduled.setState((s) => ({ all: Object.fromEntries(Object.entries(s.all).filter(([k]) => !gone.some((g) => k.startsWith(`${g}:`)))) }))
})
