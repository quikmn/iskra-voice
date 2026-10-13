// The server rail's order and folders, as pure functions. The stored layout may name servers this device doesn't
// have (it syncs across devices); those are kept but not shown.

export interface RailFolder {
  kind: 'folder'
  /** "f-" + random. */
  id: string
  name: string
  color: string
  servers: string[]
  collapsed: boolean
}

export type RailItem = { kind: 'server'; key: string } | RailFolder

export interface RailLayout {
  items: RailItem[]
  /** Servers hidden from the rail ("Hide server"): still saved and joined, just not shown. */
  hidden?: string[]
  updatedAt: number
}

export const FOLDER_COLORS = ['#7c6fff', '#4ade80', '#f87171', '#fbbf24', '#38bdf8', '#f472b6', '#a3a3a3']

export const emptyLayout = (): RailLayout => ({ items: [], updatedAt: 0 })

const KEY = /^[A-Za-z0-9_-]{43}$/
const COLOR = /^#[0-9a-f]{6}$/i

/** Accepts only a well-formed layout (it comes from storage or another device). */
export function parseLayout(raw: unknown): RailLayout | null {
  if (!raw || typeof raw !== 'object') return null
  const { items, updatedAt, hidden } = raw as Record<string, unknown>
  if (!Array.isArray(items) || items.length > 500 || typeof updatedAt !== 'number') return null
  if (hidden !== undefined && (!Array.isArray(hidden) || hidden.length > 500)) return null
  const seen = new Set<string>()
  const out: RailItem[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') return null
    const i = item as Record<string, unknown>
    if (i.kind === 'server' && typeof i.key === 'string' && KEY.test(i.key)) {
      if (!seen.has(i.key)) out.push({ kind: 'server', key: i.key })
      seen.add(i.key)
    } else if (i.kind === 'folder' && typeof i.id === 'string' && /^f-[A-Za-z0-9_-]{1,32}$/.test(i.id) && Array.isArray(i.servers)) {
      const servers: string[] = []
      for (const k of i.servers) {
        if (typeof k === 'string' && KEY.test(k) && !seen.has(k)) servers.push(k)
        if (typeof k === 'string') seen.add(k)
      }
      out.push({
        kind: 'folder', id: i.id, servers,
        name: typeof i.name === 'string' ? i.name.slice(0, 32) : '',
        color: typeof i.color === 'string' && COLOR.test(i.color) ? i.color : FOLDER_COLORS[0],
        collapsed: i.collapsed === true,
      })
    } else return null
  }
  const hiddenKeys = [...new Set((hidden as unknown[] | undefined ?? []).filter((k): k is string => typeof k === 'string' && KEY.test(k)))]
  return hiddenKeys.length ? { items: out, hidden: hiddenKeys, updatedAt } : { items: out, updatedAt }
}

/** Hidden servers this device has. */
export function hiddenServers(layout: RailLayout, order: string[]): string[] {
  const hidden = new Set(layout.hidden ?? [])
  return order.filter((k) => hidden.has(k))
}

/** The hidden list with a server hidden or shown again. */
export function withHidden(layout: RailLayout, key: string, hide: boolean): string[] {
  const rest = (layout.hidden ?? []).filter((k) => k !== key)
  return hide ? [...rest, key] : rest
}

/** What the rail shows: only servers on this device, every one not hidden (new ones at the end), no empty folders. */
export function visibleRail(layout: RailLayout, order: string[]): RailItem[] {
  const hidden = new Set(layout.hidden ?? [])
  const known = new Set(order.filter((k) => !hidden.has(k)))
  const placed = new Set<string>()
  const items: RailItem[] = []
  for (const item of layout.items) {
    if (item.kind === 'server') {
      if (known.has(item.key) && !placed.has(item.key)) {
        items.push(item)
        placed.add(item.key)
      }
    } else {
      const servers = item.servers.filter((k) => known.has(k) && !placed.has(k))
      servers.forEach((k) => placed.add(k))
      if (servers.length) items.push({ ...item, servers })
    }
  }
  for (const key of order) if (known.has(key) && !placed.has(key)) items.push({ kind: 'server', key })
  return items
}

/** Every known server gets a place in the stored layout (so moves can refer to it). */
function withAll(layout: RailLayout, order: string[]): RailItem[] {
  const present = new Set(layout.items.flatMap((i) => (i.kind === 'server' ? [i.key] : i.servers)))
  return [...layout.items.map((i) => (i.kind === 'folder' ? { ...i, servers: [...i.servers] } : i)), ...order.filter((k) => !present.has(k)).map((key) => ({ kind: 'server' as const, key }))]
}

/** Empty folders go. */
function tidy(items: RailItem[]): RailItem[] {
  return items.filter((i) => i.kind === 'server' || i.servers.length > 0)
}

/** Puts a top-level server into a new folder of its own, where it was. */
export function newFolder(layout: RailLayout, order: string[], key: string, id: string): RailItem[] {
  return withAll(layout, order).map((i): RailItem => (i.kind === 'server' && i.key === key
    ? { kind: 'folder', id, name: '', color: FOLDER_COLORS[0], servers: [key], collapsed: false } : i))
}

const idOf = (i: RailItem) => (i.kind === 'server' ? i.key : i.id)

export type RailDrop =
  /** Next to a top-level server or folder, or next to a server inside a folder. */
  | { kind: 'before' | 'after'; target: string }
  /** Into a folder (at its end). */
  | { kind: 'into'; folder: string }
  /** Onto another server: the two become a new folder (or join the folder that server is in). */
  | { kind: 'combine'; target: string }

export function moveServer(layout: RailLayout, order: string[], key: string, drop: RailDrop, newFolderId: () => string): RailItem[] {
  if ((drop.kind === 'combine' || drop.kind === 'before' || drop.kind === 'after') && drop.target === key) return layout.items
  // Take it out of wherever it is.
  let items = withAll(layout, order)
    .map((i) => (i.kind === 'folder' ? { ...i, servers: i.servers.filter((k) => k !== key) } : i))
    .filter((i) => !(i.kind === 'server' && i.key === key))
  const folderOf = (k: string) => items.find((i): i is RailFolder => i.kind === 'folder' && i.servers.includes(k))

  if (drop.kind === 'into') {
    const folder = items.find((i): i is RailFolder => i.kind === 'folder' && i.id === drop.folder)
    if (folder) folder.servers.push(key)
    else items.push({ kind: 'server', key })
  } else if (drop.kind === 'combine') {
    const inFolder = folderOf(drop.target)
    if (inFolder) inFolder.servers.splice(inFolder.servers.indexOf(drop.target) + 1, 0, key)
    else {
      items = items.map((i) => (i.kind === 'server' && i.key === drop.target
        ? { kind: 'folder', id: newFolderId(), name: '', color: FOLDER_COLORS[0], servers: [drop.target, key], collapsed: false }
        : i))
    }
  } else {
    const inFolder = folderOf(drop.target)
    if (inFolder) {
      const at = inFolder.servers.indexOf(drop.target)
      inFolder.servers.splice(drop.kind === 'before' ? at : at + 1, 0, key)
    } else {
      const at = items.findIndex((i) => idOf(i) === drop.target)
      items.splice(at < 0 ? items.length : drop.kind === 'before' ? at : at + 1, 0, { kind: 'server', key })
    }
  }
  return tidy(items)
}

/** Folders move only at the top level, before or after another top-level item. */
export function moveFolder(layout: RailLayout, order: string[], id: string, drop: { kind: 'before' | 'after'; target: string }): RailItem[] {
  const items = withAll(layout, order)
  const folder = items.find((i) => i.kind === 'folder' && i.id === id)
  if (!folder || drop.target === id) return layout.items
  const rest = items.filter((i) => i !== folder)
  const at = rest.findIndex((i) => idOf(i) === drop.target)
  if (at < 0) return layout.items
  rest.splice(drop.kind === 'before' ? at : at + 1, 0, folder)
  return rest
}

export function updateFolder(layout: RailLayout, id: string, patch: Partial<Pick<RailFolder, 'name' | 'color' | 'collapsed'>>): RailItem[] {
  return layout.items.map((i) => (i.kind === 'folder' && i.id === id ? { ...i, ...patch } : i))
}

export function ungroup(layout: RailLayout, id: string): RailItem[] {
  return layout.items.flatMap((i): RailItem[] => (i.kind === 'folder' && i.id === id ? i.servers.map((key) => ({ kind: 'server', key })) : [i]))
}

/** One step up or down at its level (phones and keyboard). */
export function stepServer(layout: RailLayout, order: string[], key: string, direction: -1 | 1): RailItem[] {
  const shown = visibleRail(layout, order)
  const folder = shown.find((i): i is RailFolder => i.kind === 'folder' && i.servers.includes(key))
  const siblings = folder ? folder.servers : shown.map(idOf)
  const at = siblings.indexOf(key)
  const neighbour = siblings[at + direction]
  if (at < 0 || neighbour === undefined) return layout.items
  return moveServer(layout, order, key, { kind: direction === -1 ? 'before' : 'after', target: neighbour }, () => 'f-x')
}
