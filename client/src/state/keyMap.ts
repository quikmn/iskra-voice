// The account key rotations this device knows and has checked: its own account's and its contacts'.
// Shared by DMs (which keys are one person) and state/keys.ts (which learns and makes rotations).
import { bareRotation, KeyMap, verifyRotation, type Rotation } from '../core/rotation'
import * as storage from '../core/storage'
import { setGroupKeyResolver } from '../core/group'

let keys = new KeyMap()
let known: Rotation[] = []
let loading: Promise<void> | null = null

/** Loads the remembered rotations. DM code waits for this before decrypting. */
export function keysReady(): Promise<void> {
  loading ??= storage.loadRotations().then((list) => {
    known = list.filter((r) => verifyRotation(r))
    keys = new KeyMap(known)
  }, () => undefined)
  return loading
}

export const keyMap = () => keys
export const knownRotations = () => known
/** The current key of whoever held <paramref name="key"/>. */
export const resolveKey = (key: string) => keys.resolve(key)
// Group chains compare members under their current keys (core/group.ts).
setGroupKeyResolver(resolveKey)
export const sameAccount = (a: string, b: string) => keys.same(a, b)

/** Adds verified rotations (first claim on an old key wins). Returns the new ones. */
export async function remember(rotations: Rotation[]): Promise<Rotation[]> {
  await keysReady()
  const added: Rotation[] = []
  for (const r of rotations.map(bareRotation)) {
    if (keys.add(r)) {
      known.push(r)
      added.push(r)
    }
  }
  if (added.length) await storage.saveRotations(known)
  return added
}

/** Points an old key at a different new key (our own claim, or an admin's decision). */
export async function replaceRotation(rotation: Rotation): Promise<void> {
  await keysReady()
  if (!keys.replace(rotation)) return
  known = [...known.filter((r) => r.oldKey !== rotation.oldKey), bareRotation(rotation)]
  await storage.saveRotations(known)
}

/** Every key this person has had that we know of, current one first. */
export const keysOf = (key: string) => keys.aliases(key)
