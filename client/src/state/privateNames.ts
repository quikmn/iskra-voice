// Private names (state/privateNamesLogic.ts): a name you give someone, shown to you instead of theirs everywhere.
// The list lives on this device and follows the account, sealed, through every server (prefs "names", the same path
// as favorites), so servers can't read it and the person you renamed never gets it.
import { create } from 'zustand'
import { b64u } from '../core/crypto'
import type { Member } from '../core/protocol'
import { openPrefs, prefsKey, sealPrefs } from '../core/prefs'
import { resolveKey } from './keyMap'
import { applyPrivateName, emptyPrivateNames, parsePrivateNames, rekeyPrivateNames, withPrivateName, type PrivateNames } from './privateNamesLogic'
import { connectionFor, memberHooks, onServerEvent, onWelcomeHook, useApp } from './store'

const STORAGE_KEY = 'iskra.names'
const PREF = 'names'

function load(): PrivateNames {
  try {
    return parsePrivateNames(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')) ?? emptyPrivateNames()
  } catch {
    return emptyPrivateNames()
  }
}

export const usePrivateNames = create<{ settings: PrivateNames }>(() => ({ settings: load() }))

const myKey = () => {
  const identity = useApp.getState().identity
  return identity ? b64u(identity.account.publicKey) : ''
}

/** Your private name for someone, or undefined. */
export const privateNameOf = (accountKey: string): string | undefined => usePrivateNames.getState().settings.names[resolveKey(accountKey)]
export const usePrivateName = (accountKey: string): string | undefined => usePrivateNames((s) => s.settings.names[resolveKey(accountKey)])

const shown = (member: Member): Member => applyPrivateName(member, usePrivateNames.getState().settings.names, myKey(), resolveKey)
memberHooks.shown = shown

/** Every server's member list again, after the names changed. `me` is never touched. */
function reapply(): void {
  useApp.setState((state) => {
    let changed = false
    const servers = { ...state.servers }
    for (const [key, server] of Object.entries(state.servers)) {
      let members = server.members
      for (const member of Object.values(server.members)) {
        const next = shown(member)
        if (next === member) continue
        if (members === server.members) members = { ...members }
        members[member.accountKey] = next
      }
      if (members !== server.members) {
        servers[key] = { ...server, members }
        changed = true
      }
    }
    return changed ? { servers } : state
  })
}

function keep(settings: PrivateNames): void {
  usePrivateNames.setState({ settings })
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    /* private mode */
  }
  reapply()
}

function change(names: Record<string, string>): void {
  const current = usePrivateNames.getState().settings
  const settings: PrivateNames = { v: 1, names, updatedAt: Math.max(Date.now(), current.updatedAt + 1) }
  keep(settings)
  for (const key of useApp.getState().order) void sealTo(key, settings)
}

/** Gives someone a private name ('' removes it). False when the list is full. */
export function setPrivateName(accountKey: string, name: string): boolean {
  const key = resolveKey(accountKey)
  if (key === myKey()) return true
  const { names } = usePrivateNames.getState().settings
  const next = withPrivateName(names, key, name)
  if (!next) return false
  if (next !== names) change(next)
  return true
}

/** Account keys moved (state/dms.ts tells us): the names follow the people. */
export function movePrivateNames(resolve: (key: string) => string): void {
  const { names } = usePrivateNames.getState().settings
  const next = rekeyPrivateNames(names, resolve)
  if (next !== names) change(next)
  else reapply()
}

// ── Sync across devices (sealed) ────────────────────────────────────────────

function keyNow(): Uint8Array | null {
  const identity = useApp.getState().identity
  return identity ? prefsKey(identity.account.secretKey) : null
}

async function sealTo(serverKey: string, settings: PrivateNames): Promise<void> {
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
    const local = usePrivateNames.getState().settings
    const opened = data ? openPrefs(key, PREF, data) : null
    if (opened !== null && updatedAt !== null && updatedAt > local.updatedAt) {
      const remote = parsePrivateNames(JSON.parse(opened))
      if (remote) keep({ ...remote, updatedAt })
    } else if ((updatedAt ?? 0) < local.updatedAt || (data && opened === null)) {
      await sealTo(serverKey, local)
    }
  } catch {
    /* an older server without prefs, or offline: the local copy still works */
  }
}

onWelcomeHook((serverKey) => void syncWith(serverKey))

onServerEvent((serverKey, type, body) => {
  if (type === 'prefs.updated' && (body as { name: string }).name === PREF) void syncWith(serverKey)
})
