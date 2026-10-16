// Streamer mode: a display mode for when your screen is on a stream. While it's on the app hides invite links and
// codes, account ids and safety numbers, email addresses in profiles and message previews, keeps notifications and
// sounds quiet, and shows a small pill so you know. Nothing changes on the server: it's all in how things are shown.
// The switch itself follows your account (prefs.get/prefs.set under "streamer", like the rail); the desktop app can
// also turn it on by itself while one of your own listed programs (OBS, Streamlabs, ...) runs, and that part stays
// on this device.
import { create } from 'zustand'
import { openPrefs, prefsKey, sealPrefs } from '../core/prefs'
import { desktop } from '../platform/desktop'
import { connectionFor, onServerEvent, onWelcomeHook, useApp } from './store'
import { emptyStreamerPref, parseStreamerPref, streamerActive, type StreamerPref } from './streamerLogic'

const STORAGE_KEY = 'iskra.streamer'
const PREF = 'streamer'

interface StreamerState {
  pref: StreamerPref
  /** The desktop app sees a streaming program from your list running (never saved). */
  autoOn: boolean
}

function load(): StreamerPref {
  try {
    return parseStreamerPref(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')) ?? emptyStreamerPref()
  } catch {
    return emptyStreamerPref()
  }
}

export const useStreamer = create<StreamerState>(() => ({ pref: load(), autoOn: false }))

/** Is streamer mode on right now? (Components: `useStreamerMode()`.) */
export const streamerOn = () => streamerActive(useStreamer.getState().pref.on, useStreamer.getState().autoOn)
export const useStreamerMode = () => useStreamer((s) => streamerActive(s.pref.on, s.autoOn))

function keyNow(): Uint8Array | null {
  const identity = useApp.getState().identity
  return identity ? prefsKey(identity.account.secretKey) : null
}

function keep(pref: StreamerPref): void {
  useStreamer.setState({ pref })
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pref))
  } catch {
    /* private mode */
  }
}

async function pushTo(serverKey: string, pref: StreamerPref): Promise<void> {
  const key = keyNow()
  const connection = connectionFor(serverKey)
  if (!key || !connection?.isOnline || pref.updatedAt === 0) return
  await connection.request('prefs.set', { name: PREF, data: sealPrefs(key, PREF, JSON.stringify(pref)), updatedAt: pref.updatedAt }).catch(() => undefined)
}

/** The switch: here and on every connected server, for your other devices. */
export function setStreamerMode(on: boolean): void {
  const current = useStreamer.getState().pref
  const pref: StreamerPref = { on, updatedAt: Math.max(Date.now(), current.updatedAt + 1) }
  keep(pref)
  for (const serverKey of useApp.getState().order) void pushTo(serverKey, pref)
}

export const toggleStreamerMode = () => setStreamerMode(!useStreamer.getState().pref.on)

/** Reads the server's copy; takes it if newer, or sends ours if that is. */
async function syncWith(serverKey: string): Promise<void> {
  const connection = connectionFor(serverKey)
  const key = keyNow()
  if (!connection || !key) return
  try {
    const { data, updatedAt } = await connection.request('prefs.get', { name: PREF })
    const local = useStreamer.getState().pref
    const opened = data ? openPrefs(key, PREF, data) : null
    if (data && opened === null && updatedAt !== null && local.updatedAt > 0) {
      // Sealed under an earlier account key (it was replaced): seal ours again under the current one.
      const resealed = { ...local, updatedAt: Math.max(local.updatedAt, updatedAt + 1) }
      keep(resealed)
      await pushTo(serverKey, resealed)
    } else if (opened !== null && updatedAt !== null && updatedAt > local.updatedAt) {
      const remote = parseStreamerPref(JSON.parse(opened))
      if (remote) keep(remote)
    } else if ((updatedAt ?? 0) < local.updatedAt) {
      await pushTo(serverKey, local)
    }
  } catch {
    /* an older server without prefs, or offline: the local copy still works */
  }
}

onWelcomeHook((serverKey) => void syncWith(serverKey))
onServerEvent((serverKey, type, body) => {
  if (type === 'prefs.updated' && (body as { name: string }).name === PREF) void syncWith(serverKey)
})

/** Desktop: follows "a streaming program from your list is running" (desktop/src/main.ts). Call once at start-up. */
export function startStreamerWatch(): () => void {
  if (!desktop?.onStreamerProgram) return () => {}
  void desktop.streamerProgram?.().then((running) => useStreamer.setState({ autoOn: !!running }), () => undefined)
  return desktop.onStreamerProgram((running) => useStreamer.setState({ autoOn: running }))
}
