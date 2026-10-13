// The server rail's order and folders. Kept on this device and synced, encrypted, through every server you're on
// (prefs.get/prefs.set under "rail"): the newest copy wins.
import { create } from 'zustand'
import { b64u } from '../core/crypto'
import { openPrefs, prefsKey, sealPrefs } from '../core/prefs'
import { connectionFor, onServerEvent, onWelcomeHook, railHooks, useApp } from './store'
import { emptyLayout, parseLayout, visibleRail, withHidden, type RailItem, type RailLayout } from './railLogic'

const STORAGE_KEY = 'iskra.rail'
const PREF = 'rail'

function load(): RailLayout {
  try {
    return parseLayout(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')) ?? emptyLayout()
  } catch {
    return emptyLayout()
  }
}

export const useRail = create<{ layout: RailLayout }>(() => ({ layout: load() }))

function keyNow(): Uint8Array | null {
  const identity = useApp.getState().identity
  return identity ? prefsKey(identity.account.secretKey) : null
}

function keep(layout: RailLayout): void {
  useRail.setState({ layout })
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout))
  } catch {
    /* private mode */
  }
}

async function pushTo(serverKey: string, layout: RailLayout): Promise<void> {
  const key = keyNow()
  const connection = connectionFor(serverKey)
  if (!key || !connection?.isOnline || layout.updatedAt === 0) return
  await connection.request('prefs.set', { name: PREF, data: sealPrefs(key, PREF, JSON.stringify(layout)), updatedAt: layout.updatedAt }).catch(() => undefined)
}

/** Changes the layout here and on every connected server. */
export function setRail(items: RailItem[], hidden = useRail.getState().layout.hidden): void {
  const current = useRail.getState().layout
  const layout: RailLayout = { items, ...(hidden?.length ? { hidden } : {}), updatedAt: Math.max(Date.now(), current.updatedAt + 1) }
  keep(layout)
  for (const serverKey of useApp.getState().order) void pushTo(serverKey, layout)
}

/**
 * "Hide server": takes it off your server list on every device of your account, nothing more. You stay a member,
 * it stays connected (quietly: no notifications from it), and My settings → Appearance shows it again.
 */
export function setServerHidden(serverKey: string, hide: boolean): void {
  const layout = useRail.getState().layout
  const hidden = withHidden(layout, serverKey, hide)
  setRail(layout.items, hidden)
  const { activeServer, order } = useApp.getState()
  if (hide && activeServer === serverKey) {
    const next = visibleRail({ ...layout, hidden }, order).flatMap((i) => (i.kind === 'server' ? [i.key] : i.servers))[0] ?? null
    useApp.setState({ activeServer: next })
  }
}

/** Is this server hidden from the rail? */
export const isServerHidden = (serverKey: string): boolean => useRail.getState().layout.hidden?.includes(serverKey) ?? false

railHooks.isHidden = isServerHidden
railHooks.show = (serverKey) => {
  if (isServerHidden(serverKey)) setServerHidden(serverKey, false)
}

/** Reads the server's copy; takes it if newer, or sends ours if that is. */
async function syncWith(serverKey: string): Promise<void> {
  const connection = connectionFor(serverKey)
  const key = keyNow()
  if (!connection || !key) return
  try {
    const { data, updatedAt } = await connection.request('prefs.get', { name: PREF })
    const local = useRail.getState().layout
    const opened = data ? openPrefs(key, PREF, data) : null
    if (data && opened === null && updatedAt !== null && local.updatedAt > 0) {
      // Sealed under an earlier account key (it was replaced): seal ours again under the current one.
      const resealed = { ...local, updatedAt: Math.max(local.updatedAt, updatedAt + 1) }
      keep(resealed)
      await pushTo(serverKey, resealed)
    } else if (opened !== null && updatedAt !== null && updatedAt > local.updatedAt) {
      const remote = parseLayout(JSON.parse(opened))
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

/** A new folder id. */
export const newFolderId = () => `f-${b64u(crypto.getRandomValues(new Uint8Array(9)))}`
