// Keyword alerts and quiet hours. The settings live on this device and follow the account, sealed, through every
// server (prefs "alerts"); the app matches alert words itself, so they work in encrypted channels and DMs too. A
// server gets a readable copy only where push needs one (alertsLogic.serverCopy): the words with "Also when Iskra is
// closed", quiet hours where push is on.
import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { openPrefs, prefsKey, sealPrefs } from '../core/prefs'
import type { InboxItem, Message, ServerAlerts } from '../core/protocol'
import {
  alertPattern, emptyAlerts, matchesAlert, parseAlerts, quietActive, sameCopy, serverCopy, wordsFor, type AlertSettings,
} from './alertsLogic'
import { mergeItems } from './inboxLogic'
import { quietRules } from './notify'
import { usePush } from './push'
import { senderRules } from './senderRules'
import { connectionFor, onServerEvent, onWelcomeHook, useApp } from './store'

const STORAGE_KEY = 'iskra.alerts'
const PREF = 'alerts'

interface AlertsState {
  settings: AlertSettings
  /** What each server keeps (null: not known yet, or an older server). */
  stored: Record<string, ServerAlerts | null>
  /** Messages with an alert word that arrived while the app was open, per server (the inbox lists them). */
  hits: Record<string, InboxItem[]>
}

function load(): AlertSettings {
  try {
    return parseAlerts(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')) ?? emptyAlerts()
  } catch {
    return emptyAlerts()
  }
}

export const useAlerts = create<AlertsState>(() => ({ settings: load(), stored: {}, hits: {} }))

function keep(settings: AlertSettings): void {
  useAlerts.setState({ settings })
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    /* private mode */
  }
}

/** Changes the settings here, on your other devices (sealed) and in each server's copy. */
export function updateAlerts(patch: Partial<Omit<AlertSettings, 'updatedAt'>>): void {
  const current = useAlerts.getState().settings
  const settings = { ...current, ...patch, updatedAt: Math.max(Date.now(), current.updatedAt + 1) }
  keep(settings)
  for (const key of useApp.getState().order) {
    void sealTo(key, settings)
    void reconcile(key)
  }
}

// ── Matching ────────────────────────────────────────────────────────────────

/** The pattern for a server's alert words (null: none). DMs and groups use the words for everywhere. */
export const alertPatternFor = (serverKey: string | null): RegExp | null =>
  alertPattern(wordsFor(useAlerts.getState().settings.words, serverKey))

export function useAlertPattern(serverKey: string | null): RegExp | null {
  const words = useAlerts((s) => s.settings.words)
  return alertPattern(wordsFor(words, serverKey))
}

senderRules.alertsMe = (server, message) =>
  !!server.me && message.author !== server.me.accountKey && matchesAlert(alertPatternFor(server.key), message.text)

senderRules.alerted = (serverKey: string, message: Message) => {
  const item: InboxItem = { kind: 'keyword', channelId: message.channelId, at: message.createdAt, message }
  useAlerts.setState((s) => ({ hits: { ...s.hits, [serverKey]: mergeItems(s.hits[serverKey] ?? [], [item], 200) } }))
}

// ── Quiet hours ─────────────────────────────────────────────────────────────

/** Quiet hours right now, or null. */
export function quietNow(at = new Date()): { mentions: boolean } | null {
  const { quietOn, quiet } = useAlerts.getState().settings
  return quietOn && quietActive(quiet, at) ? { mentions: quiet.mentions } : null
}
quietRules.now = () => quietNow()

/** Whether quiet hours are on right now, checked again every 30 seconds. */
export function useQuietNow(): boolean {
  const settings = useAlerts((s) => s.settings)
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!settings.quietOn) return
    const timer = setInterval(() => setTick((n) => n + 1), 30_000)
    return () => clearInterval(timer)
  }, [settings.quietOn])
  return settings.quietOn && quietActive(settings.quiet, new Date())
}

// ── The servers' copies ─────────────────────────────────────────────────────

const busy = new Set<string>()

/** Brings a server's copy in line with the settings (only what push there needs). */
async function reconcile(serverKey: string, again = 0): Promise<void> {
  const connection = connectionFor(serverKey)
  const stored = useAlerts.getState().stored[serverKey]
  if (!connection?.isOnline || !stored || busy.has(serverKey)) return // not known yet, or an older server
  const want = serverCopy(useAlerts.getState().settings, serverKey, usePush.getState().servers[serverKey] === 'on', stored)
  if (sameCopy(stored, want)) return
  busy.add(serverKey)
  try {
    const { alerts } = await connection.request('alerts.set', want)
    useAlerts.setState((s) => ({ stored: { ...s.stored, [serverKey]: alerts } }))
  } catch {
    return // offline, or refused: tried again on the next change or connect
  } finally {
    busy.delete(serverKey)
  }
  // Changed again meanwhile?
  const now = useAlerts.getState().stored[serverKey]
  if (now && !sameCopy(now, serverCopy(useAlerts.getState().settings, serverKey, usePush.getState().servers[serverKey] === 'on', now)) && again < 2) void reconcile(serverKey, again + 1)
}

// ── Sync across devices (sealed, like the rail) ─────────────────────────────

function keyNow(): Uint8Array | null {
  const identity = useApp.getState().identity
  return identity ? prefsKey(identity.account.secretKey) : null
}

async function sealTo(serverKey: string, settings: AlertSettings): Promise<void> {
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
    const local = useAlerts.getState().settings
    const opened = data ? openPrefs(key, PREF, data) : null
    if (opened !== null && updatedAt !== null && updatedAt > local.updatedAt) {
      const remote = parseAlerts(JSON.parse(opened))
      if (remote) {
        keep(remote)
        for (const k of useApp.getState().order) void reconcile(k)
      }
    } else if ((updatedAt ?? 0) < local.updatedAt || (data && opened === null)) {
      await sealTo(serverKey, local)
    }
  } catch {
    /* an older server without prefs, or offline: the local copy still works */
  }
}

onWelcomeHook((serverKey) => {
  const connection = connectionFor(serverKey)
  void (async () => {
    try {
      const { alerts } = await connection!.request('alerts.get', {})
      useAlerts.setState((s) => ({ stored: { ...s.stored, [serverKey]: alerts } }))
    } catch {
      useAlerts.setState((s) => ({ stored: { ...s.stored, [serverKey]: null } }))
      return // an older server: nothing to keep in step
    }
    await syncWith(serverKey)
    await reconcile(serverKey)
  })()
})

onServerEvent((serverKey, type, body) => {
  if (type === 'alerts.updated') useAlerts.setState((s) => ({ stored: { ...s.stored, [serverKey]: (body as { alerts: ServerAlerts }).alerts } }))
  if (type === 'prefs.updated' && (body as { name: string }).name === PREF) void syncWith(serverKey)
  if (type === 'chat.deleted') {
    const { id } = body as { id: number }
    useAlerts.setState((s) => (s.hits[serverKey]?.some((i) => i.message.id === id)
      ? { hits: { ...s.hits, [serverKey]: s.hits[serverKey].filter((i) => i.message.id !== id) } }
      : s))
  }
})

// Push turned on or off here: quiet hours follow it to that server.
usePush.subscribe((state, before) => {
  if (state.servers === before.servers) return
  for (const key of Object.keys(state.servers)) if (state.servers[key] !== before.servers[key]) void reconcile(key)
})

// A server you left: forget what it had.
useApp.subscribe((state, before) => {
  if (state.order === before.order) return
  const gone = before.order.filter((k) => !state.order.includes(k))
  if (!gone.length) return
  useAlerts.setState((s) => ({
    stored: Object.fromEntries(Object.entries(s.stored).filter(([k]) => !gone.includes(k))),
    hits: Object.fromEntries(Object.entries(s.hits).filter(([k]) => !gone.includes(k))),
  }))
})
