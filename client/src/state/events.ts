// Scheduled events per server: loaded after welcome, kept live from events, plus in-app reminders.
import { create } from 'zustand'
import { roleRank, type EventFields, type Events, type Requests, type ServerEvent } from '../core/protocol'
import { connectionFor, onServerEvent, onWelcomeHook, useApp, type ServerState } from './store'
import { showNotification } from './notify'
import { t } from '../i18n'
import { baseRolesFor } from './baseRoles'
import { baseAllows } from './permissions'

export interface EventReminder {
  id: string
  serverKey: string
  event: ServerEvent
  kind: 'soon' | 'live'
}

interface EventsState {
  /** serverKey → event id → event (scheduled and live only). */
  events: Record<string, Record<number, ServerEvent>>
  reminders: EventReminder[]
  /** The events dialog, when open. */
  open: { serverKey: string; eventId?: number } | null
}

export const useEvents = create<EventsState>(() => ({ events: {}, reminders: [], open: null }))

function put(serverKey: string, event: ServerEvent): void {
  useEvents.setState((s) => {
    const mine = { ...s.events[serverKey] }
    if (event.status === 'scheduled' || event.status === 'live') mine[event.id] = event
    else delete mine[event.id]
    return { events: { ...s.events, [serverKey]: mine } }
  })
}

function remove(serverKey: string, id: number): void {
  useEvents.setState((s) => {
    const mine = { ...s.events[serverKey] }
    delete mine[id]
    return { events: { ...s.events, [serverKey]: mine } }
  })
}

export async function loadEvents(serverKey: string): Promise<void> {
  const connection = connectionFor(serverKey)
  if (!connection?.isOnline) return
  try {
    const { events } = await connection.request('event.list', {})
    useEvents.setState((s) => ({ events: { ...s.events, [serverKey]: Object.fromEntries(events.map((e) => [e.id, e])) } }))
  } catch {
    /* tried again on the next welcome */
  }
}

export const canCreateEvent = (server: ServerState) => baseAllows(baseRolesFor(server.key), server.me, 'events')

/** Whoever created it, or an admin who outranks them. Mirrors Permissions.CanManageEvent. */
export function canManageEvent(server: ServerState, event: ServerEvent): boolean {
  const me = server.me
  if (!me) return false
  if (event.createdBy === me.accountKey) return true
  const creator = server.members[event.createdBy]
  return roleRank(me.role) >= roleRank('admin') && (!creator || roleRank(me.role) > roleRank(creator.role))
}

export async function createEvent(serverKey: string, fields: Requests['event.create'][0]): Promise<ServerEvent> {
  const { event } = await request(serverKey, 'event.create', fields)
  put(serverKey, event)
  return event
}

export async function updateEvent(serverKey: string, id: number, fields: EventFields): Promise<ServerEvent> {
  const { event } = await request(serverKey, 'event.update', { id, ...fields })
  put(serverKey, event)
  return event
}

export async function cancelEvent(serverKey: string, id: number): Promise<void> {
  await request(serverKey, 'event.cancel', { id })
  remove(serverKey, id)
}

export async function setInterested(serverKey: string, id: number, on: boolean): Promise<void> {
  const { event } = await request(serverKey, 'event.interest', { id, on })
  put(serverKey, event)
}

function request<K extends 'event.create' | 'event.update' | 'event.cancel' | 'event.interest'>(
  serverKey: string, type: K, body: Requests[K][0],
): Promise<Requests[K][1]> {
  const connection = connectionFor(serverKey)
  if (!connection) return Promise.reject(new Error(t('errors.codes.disconnected')))
  return connection.request(type, body)
}

export function showEvents(serverKey: string, eventId?: number): void {
  useEvents.setState({ open: { serverKey, eventId } })
}

export function closeEvents(): void {
  useEvents.setState({ open: null })
}

export function dismissReminder(id: string): void {
  useEvents.setState((s) => ({ reminders: s.reminders.filter((r) => r.id !== id) }))
}

let reminderCounter = 0

onWelcomeHook((serverKey) => void loadEvents(serverKey))

onServerEvent((serverKey, type, body) => {
  if (type === 'event.updated') put(serverKey, (body as Events['event.updated']).event)
  else if (type === 'event.removed') remove(serverKey, (body as Events['event.removed']).id)
  else if (type === 'channels') void loadEvents(serverKey) // what you can see may have changed
  else if (type === 'event.reminder') {
    const { event, kind } = body as Events['event.reminder']
    put(serverKey, event)
    const id = `r${++reminderCounter}`
    useEvents.setState((s) => ({ reminders: [...s.reminders.filter((r) => r.event.id !== event.id || r.serverKey !== serverKey), { id, serverKey, event, kind }].slice(-3) }))
    setTimeout(() => dismissReminder(id), 60_000)
    const server = useApp.getState().servers[serverKey]
    showNotification(serverKey, kind === 'live' ? t('events.notifyLive', { title: event.title }) : t('events.notifySoon', { title: event.title }),
      server ? t('events.notifyOn', { server: server.name }) : '', () => showEvents(serverKey, event.id))
  }
})
