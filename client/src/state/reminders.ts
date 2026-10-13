// "Remind me about this". A reminder lives on one server, which fires it at its time (in the app and by push, even
// with every app closed). What it's about (the message, a snapshot, your note) is sealed with your account's private
// key, so for DMs and groups the server learns only the time; for a channel message it also knows which message.
import { create } from 'zustand'
import { t } from '../i18n'
import type { Events, WireReminder } from '../core/protocol'
import { openPrivate, privateKey, sealPrivate } from '../core/sealed'
import { connectionFor, onServerEvent, onWelcomeHook, useApp } from './store'
import { show } from './notify'
import { openRef, serverFor } from './messageRefs'
import { checkRef, checkSnap, type MessageRef, type MessageSnap } from './productivityLogic'
import { botReminderAbout } from './builtinBotsLogic'

const PURPOSE = 'reminder'

export interface ReminderContent {
  ref: MessageRef
  snap: MessageSnap
  note: string
}

export interface Reminder extends WireReminder {
  server: string
  /** Null if it can't be opened here (sealed under an earlier account key). */
  content: ReminderContent | null
}

interface RemindersState {
  /** By "<serverKey>:<id>". */
  all: Record<string, Reminder>
  /** Reminders that just fired, shown as toasts until dismissed. */
  toasts: string[]
}

export const useReminders = create<RemindersState>(() => ({ all: {}, toasts: [] }))

const tag = (server: string, id: number) => `${server}:${id}`

function keyNow(): Uint8Array | null {
  const identity = useApp.getState().identity
  return identity ? privateKey(identity.account.secretKey) : null
}

/** A reminder set with the Reminders bot (/remind): not sealed, it's about your own command message. */
function fromBot(server: string, wire: WireReminder): ReminderContent | null {
  const about = botReminderAbout(wire.data)
  if (!about || wire.channelId === null || wire.messageId === null) return null
  const me = useApp.getState().servers[server]?.me
  return {
    ref: { kind: 'channel', server, channelId: wire.channelId, messageId: wire.messageId },
    snap: { author: me?.accountKey ?? '', authorName: me?.name ?? '', preview: about.note || '/remind', at: about.at, where: about.where },
    note: about.note,
  }
}

function open(server: string, wire: WireReminder): Reminder {
  if (wire.data.startsWith('bot.')) return { ...wire, server, content: fromBot(server, wire) }
  const key = keyNow()
  const raw = key ? openPrivate(key, PURPOSE, wire.data) as Record<string, unknown> | null : null
  const ref = checkRef(raw?.ref)
  const snap = checkSnap(raw?.snap)
  const content = ref && snap ? { ref, snap, note: typeof raw?.note === 'string' ? raw.note.slice(0, 500) : '' } : null
  return { ...wire, server, content }
}

function put(server: string, wire: WireReminder): Reminder {
  const reminder = open(server, wire)
  useReminders.setState((s) => ({ all: { ...s.all, [tag(server, wire.id)]: reminder } }))
  return reminder
}

function drop(server: string, id: number): void {
  useReminders.setState((s) => {
    const all = { ...s.all }
    delete all[tag(server, id)]
    return { all, toasts: s.toasts.filter((x) => x !== tag(server, id)) }
  })
}

/** Upcoming ones (soonest first) and fired ones waiting for you (newest first). */
export function splitReminders(all: Record<string, Reminder>): { upcoming: Reminder[]; due: Reminder[] } {
  const list = Object.values(all)
  return {
    upcoming: list.filter((r) => r.firedAt === null).sort((a, b) => a.dueAt - b.dueAt),
    due: list.filter((r) => r.firedAt !== null).sort((a, b) => (b.firedAt ?? 0) - (a.firedAt ?? 0)),
  }
}

export class NoServerError extends Error {}

export async function createReminder(ref: MessageRef, snap: MessageSnap, dueAt: number, note = ''): Promise<Reminder> {
  const server = serverFor(ref)
  const key = keyNow()
  const connection = server ? connectionFor(server) : null
  if (!server || !connection || !key) throw new NoServerError(t('productivity.errors.noServer'))
  const data = sealPrivate(key, PURPOSE, { ref, snap, note: note.trim().slice(0, 500) })
  const { reminder } = await connection.request('reminder.create', {
    dueAt, data, ...(ref.kind === 'channel' ? { messageId: ref.messageId } : {}),
  })
  return put(server, reminder)
}

/** A new time (snooze, or changing an upcoming one). */
export async function rescheduleReminder(r: Reminder, dueAt: number): Promise<void> {
  const { reminder } = await connectionFor(r.server)!.request('reminder.update', { id: r.id, dueAt })
  put(r.server, reminder)
  dismissToast(r)
}

/** Done with it (or cancelled before it fired). */
export async function deleteReminder(r: Reminder): Promise<void> {
  await connectionFor(r.server)?.request('reminder.delete', { id: r.id })
  drop(r.server, r.id)
}

export function dismissToast(r: Reminder): void {
  useReminders.setState((s) => ({ toasts: s.toasts.filter((x) => x !== tag(r.server, r.id)) }))
}

/** Opens what the reminder is about (from a toast, the inbox or a push). */
export async function openReminder(server: string, id: number): Promise<boolean> {
  let reminder = useReminders.getState().all[tag(server, id)]
  if (!reminder) {
    await load(server)
    reminder = useReminders.getState().all[tag(server, id)]
  }
  if (!reminder?.content) return false
  dismissToast(reminder)
  return openRef(reminder.content.ref)
}

async function load(server: string): Promise<void> {
  const connection = connectionFor(server)
  if (!connection) return
  try {
    const { reminders } = await connection.request('reminder.list', {})
    useReminders.setState((s) => {
      const all = Object.fromEntries(Object.entries(s.all).filter(([k]) => !k.startsWith(`${server}:`)))
      for (const wire of reminders) all[tag(server, wire.id)] = open(server, wire)
      return { all }
    })
  } catch {
    /* an older server without reminders */
  }
}

onWelcomeHook((server) => void load(server))
onServerEvent((server, type, body) => {
  if (type === 'reminder.updated') put(server, (body as Events['reminder.updated']).reminder)
  if (type === 'reminder.deleted') drop(server, (body as Events['reminder.deleted']).id)
  if (type === 'reminder.due') {
    const reminder = put(server, (body as Events['reminder.due']).reminder)
    useReminders.setState((s) => ({ toasts: [...s.toasts.filter((x) => x !== tag(server, reminder.id)), tag(server, reminder.id)] }))
    const what = reminder.content
    show(server, t('productivity.reminders.notifyTitle'),
      what ? (what.note || `${what.snap.authorName}: ${what.snap.preview}`) : t('productivity.reminders.notifyBody'),
      () => void openReminder(server, reminder.id))
  }
})
// A server removed from the list takes its reminders with it.
useApp.subscribe((state, before) => {
  if (state.order === before.order) return
  const gone = before.order.filter((k) => !state.order.includes(k))
  if (gone.length === 0) return
  useReminders.setState((s) => ({ all: Object.fromEntries(Object.entries(s.all).filter(([k]) => !gone.some((g) => k.startsWith(`${g}:`)))) }))
})
