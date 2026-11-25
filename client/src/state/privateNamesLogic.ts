// Private names: a name you give someone, shown to you instead of theirs. Pure rules; state/privateNames.ts keeps the
// list and syncs it (sealed, like favorites) across your devices. Nobody else ever gets it.

export const MAX_PRIVATE_NAMES = 100
export const PRIVATE_NAME_MAX = 32
const KEY = /^[A-Za-z0-9_-]{43}$/

export interface PrivateNames {
  v: 1
  updatedAt: number
  /** Account key → the name you gave them. */
  names: Record<string, string>
}

export const emptyPrivateNames = (): PrivateNames => ({ v: 1, updatedAt: 0, names: {} })

/** A name as it is kept: no control or invisible characters, single spaces, at most 32 characters. '' means none. */
export function cleanPrivateName(text: string): string {
  return [...text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim()].slice(0, PRIVATE_NAME_MAX).join('').trim()
}

/** Checks a stored or synced copy; malformed entries are dropped (null if the whole thing is not ours). */
export function parsePrivateNames(raw: unknown): PrivateNames | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (r.v !== 1 || !Number.isSafeInteger(r.updatedAt) || (r.updatedAt as number) < 0 || typeof r.names !== 'object' || r.names === null) return null
  const names: Record<string, string> = {}
  for (const [key, value] of Object.entries(r.names as Record<string, unknown>)) {
    if (!KEY.test(key) || typeof value !== 'string') continue
    const name = cleanPrivateName(value)
    if (name && Object.keys(names).length < MAX_PRIVATE_NAMES) names[key] = name
  }
  return { v: 1, updatedAt: r.updatedAt as number, names }
}

/** The list with this person's name set ('' removes it). Null when the list is full; the same object when nothing changes. */
export function withPrivateName(names: Record<string, string>, accountKey: string, name: string): Record<string, string> | null {
  const clean = cleanPrivateName(name)
  if ((names[accountKey] ?? '') === clean) return names
  const next = { ...names }
  if (!clean) delete next[accountKey]
  else {
    if (!KEY.test(accountKey)) return names
    if (!(accountKey in names) && Object.keys(names).length >= MAX_PRIVATE_NAMES) return null
    next[accountKey] = clean
  }
  return next
}

/** After account keys moved: entries follow the person (an entry already under the new key wins). */
export function rekeyPrivateNames(names: Record<string, string>, resolve: (key: string) => string): Record<string, string> {
  const next: Record<string, string> = {}
  let moved = false
  for (const [key, name] of Object.entries(names)) {
    const target = resolve(key)
    if (target !== key) moved = true
    if (target === key || !(target in names)) next[target] = name
  }
  return moved ? next : names
}

interface Named {
  accountKey: string
  name: string
  /** Set by this app only, never by a server: the name everyone else sees, while `name` holds your private name. */
  publicName?: string
  profileName?: string
}

/** The name everyone sees for this member on the server (their nickname there, else their own name). */
export const publicNameOf = (member: Pick<Named, 'name' | 'publicName'>): string => member.publicName ?? member.name

/** Their own profile name: not a server nickname, not your private name. */
export const ownNameOf = (member: Pick<Named, 'name' | 'publicName' | 'profileName'>): string => member.profileName ?? publicNameOf(member)

/**
 * A member as shown to you: `name` is your private name for them when you set one, and `publicName` keeps what
 * everyone else sees. Never changes your own entry. Returns the same object when nothing changes.
 */
export function applyPrivateName<M extends Named>(member: M, names: Record<string, string>, myKey: string, resolve: (key: string) => string = (k) => k): M {
  const base = publicNameOf(member)
  const mine = member.accountKey === myKey ? undefined : names[resolve(member.accountKey)]
  if (!mine) {
    if (member.publicName === undefined) return member
    const { publicName: _gone, ...rest } = member
    return { ...rest, name: base } as unknown as M
  }
  if (member.name === mine && member.publicName === base) return member
  return { ...member, name: mine, publicName: base }
}
