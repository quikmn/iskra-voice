// Saved messages (bookmarks), across channels, threads, DMs and groups. Private to your account: kept on this device
// (encrypted at rest) and synced through every server you're on as a sealed preference ("saved"), which servers can't
// read. Lists from different devices merge entry by entry, so saving on two devices at once loses nothing.
import { create } from 'zustand'
import { openPrefs, prefsKey, sealPrefs } from '../core/prefs'
import { loadPrivate, savePrivate } from '../core/storage'
import { connectionFor, onServerEvent, onWelcomeHook, useApp } from './store'
import {
  checkEntry, decodeSaved, encodeSaved, liveSaved, MAX_SAVED, mergeSaved, pruneSaved, refKey, sameSaved,
  type MessageRef, type MessageSnap, type SavedEntry,
} from './productivityLogic'

const PREF = 'saved'
const SLOT = 'saved'

export const useSaved = create<{ entries: SavedEntry[]; loaded: boolean }>(() => ({ entries: [], loaded: false }))

/** Saved (and not removed) entries, newest first. */
export const useSavedList = () => liveSaved(useSaved((s) => s.entries))

export const useIsSaved = (ref: MessageRef | null) =>
  useSaved((s) => !!ref && s.entries.some((e) => e.key === refKey(ref) && !e.removedAt))

function keyNow(): Uint8Array | null {
  const identity = useApp.getState().identity
  return identity ? prefsKey(identity.account.secretKey) : null
}

let loading: Promise<void> | null = null

/** The copy on this device (loaded once there's an identity and the vault is open). */
function loadLocal(): Promise<void> {
  loading ??= (async () => {
    const stored = await loadPrivate<SavedEntry[]>(SLOT).catch(() => undefined)
    const checked = Array.isArray(stored) ? stored.flatMap(checkEntry) : []
    useSaved.setState((s) => ({ entries: mergeSaved(checked, s.entries), loaded: true }))
  })()
  return loading
}

function keep(entries: SavedEntry[]): void {
  useSaved.setState({ entries })
  void savePrivate(SLOT, entries).catch(() => undefined)
}

const updatedAt = (entries: SavedEntry[]) => entries.reduce((n, e) => Math.max(n, e.savedAt, e.removedAt ?? 0), 0)

async function pushTo(serverKey: string, entries: SavedEntry[]): Promise<void> {
  const key = keyNow()
  const connection = connectionFor(serverKey)
  if (!key || !connection?.isOnline || entries.length === 0) return
  const data = sealPrefs(key, PREF, encodeSaved(entries))
  await connection.request('prefs.set', { name: PREF, data, updatedAt: updatedAt(entries) }).catch(() => undefined)
}

function pushEverywhere(entries: SavedEntry[]): void {
  for (const serverKey of useApp.getState().order) void pushTo(serverKey, entries)
}

/** Merges the server's copy with ours; whoever is missing something gets the merged list. */
async function syncWith(serverKey: string): Promise<void> {
  const connection = connectionFor(serverKey)
  const key = keyNow()
  if (!connection || !key) return
  await loadLocal()
  try {
    const { data } = await connection.request('prefs.get', { name: PREF })
    const opened = data ? openPrefs(key, PREF, data) : null
    const remote = opened ? decodeSaved(opened) ?? [] : []
    const local = useSaved.getState().entries
    const merged = pruneSaved(mergeSaved(local, remote), Date.now())
    if (!sameSaved(merged, local)) keep(merged)
    // Sealed under an earlier account key, or behind: send ours (merged).
    if ((data && !opened) || !sameSaved(merged, remote)) await pushTo(serverKey, merged)
  } catch {
    /* an older server without prefs, or offline: the local copy still works */
  }
}

function change(next: SavedEntry[]): void {
  const pruned = pruneSaved(next, Date.now())
  keep(pruned)
  pushEverywhere(pruned)
}

export class SavedFullError extends Error {}

export async function saveMessage(ref: MessageRef, snap: MessageSnap): Promise<void> {
  await loadLocal()
  const entries = useSaved.getState().entries
  if (liveSaved(entries).length >= MAX_SAVED) throw new SavedFullError(`You can save up to ${MAX_SAVED} messages.`)
  const now = Math.max(Date.now(), updatedAt(entries) + 1)
  change(mergeSaved(entries, [{ key: refKey(ref), ref, savedAt: now, snap }]))
}

export async function unsaveMessage(key: string): Promise<void> {
  await loadLocal()
  const entries = useSaved.getState().entries
  const entry = entries.find((e) => e.key === key)
  if (!entry || entry.removedAt) return
  const now = Math.max(Date.now(), updatedAt(entries) + 1)
  change(mergeSaved(entries, [{ key, ref: entry.ref, savedAt: entry.savedAt, removedAt: now }]))
}

export async function toggleSaved(ref: MessageRef, snap: MessageSnap): Promise<boolean> {
  const key = refKey(ref)
  if (useSaved.getState().entries.some((e) => e.key === key && !e.removedAt)) {
    await unsaveMessage(key)
    return false
  }
  await saveMessage(ref, snap)
  return true
}

onWelcomeHook((serverKey) => void syncWith(serverKey))
onServerEvent((serverKey, type, body) => {
  if (type === 'prefs.updated' && (body as { name: string }).name === PREF) void syncWith(serverKey)
})
useApp.subscribe((state) => {
  if (state.phase === 'ready' && !loading) void loadLocal().catch(() => undefined)
})
