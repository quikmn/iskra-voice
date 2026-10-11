// Group DMs: 3–10 people on one server, end-to-end encrypted like DMs (see core/group.ts for the crypto).
// A group lives on the server it was made on: that server routes it by the signed member chain, which every
// device verifies for itself. Decrypted messages and the verified chain are kept on this device.
import { create } from 'zustand'
import { b64u } from '../core/crypto'
import { revokedSet } from '../core/devices'
import { DmError, type DmContent } from '../core/dm'
import {
  asRename, decryptGroup, encryptGroup, GroupBehindError, GroupError, MAX_GROUP_NAME, newGroupId, parseChange, signChange, verifyChain,
  type GroupAction, type GroupChange, type GroupEnvelope, type GroupView,
} from '../core/group'
import { RequestError, type WireGroup, type WireGroupMessage } from '../core/protocol'
import { checkFiles, type DmFile } from '../core/dmFiles'
import * as storage from '../core/storage'
import { ensurePrekeys, ownRevokedDevices } from './devices'
import { mergeDm, orderTime } from './dmMerge'
import { bundleOf, nameOf, useDms } from './dms'
import { groupTitle, type GroupMsg } from './groupLogic'
import { show } from './notify'
import { isBlocked, useBlocks } from './moderation'
import { connectionFor, onServerEvent, onWelcomeHook, useApp } from './store'
import { keysReady } from './keyMap'

export interface GroupConv {
  /** "<serverKey>/<groupId>" */
  key: string
  serverKey: string
  id: string
  /** The changes this device verified, exactly as signed. */
  chain: GroupChange[]
  view: GroupView | null
  name: string | null
  /** When the name was set (the newest rename wins). */
  nameAt: number
  /** Last known display names of the people in it (kept for when its server is gone). */
  names: Record<string, string>
  messages: GroupMsg[]
  loaded: boolean
  unread: number
  /** The server says we're not in it, without a signed change we could check (we may have missed it while away). */
  gone?: boolean
  /** The chain didn't verify, or contradicts what this device saw before. Shown; sending stays off. */
  problem?: string
}

export const useGroups = create<{ groups: Record<string, GroupConv> }>(() => ({ groups: {} }))

export const groupKey = (serverKey: string, id: string) => `${serverKey}/${id}`

const me = () => {
  const identity = useApp.getState().identity
  return identity ? b64u(identity.account.publicKey) : ''
}

/** Whether you're in this group as far as its verified chain says (and the server agrees). */
export const isMember = (g: GroupConv | undefined) => !!g?.view?.members.includes(me()) && !g.gone

/** The group lives on a server you left: kept read-only on this device until you remove it. */
export const isArchived = (g: GroupConv | undefined) => !!g && !useApp.getState().servers[g.serverKey]

/** Someone's name from any server, else as a group last saw it (its server may be gone). */
export function knownName(accountKey: string): string {
  const name = nameOf(accountKey)
  if (name !== 'Someone') return name
  for (const g of Object.values(useGroups.getState().groups)) if (g.names[accountKey]) return g.names[accountKey]
  return name
}

export function titleOf(g: GroupConv): string {
  return groupTitle(g.name, g.view?.members ?? [], me(), knownName)
}

/** Names of everyone who was ever in the group or wrote in it, refreshed from the servers we can see. */
function namesFor(g: GroupConv): Record<string, string> {
  const names = { ...g.names }
  const people = new Set([...(g.view?.changes.flatMap((c) => [c.by, ...c.targets]) ?? []), ...g.messages.map((m) => m.from)])
  for (const k of people) {
    const name = nameOf(k)
    if (name !== 'Someone') names[k] = name.slice(0, 32)
  }
  return names
}

function blank(serverKey: string, id: string): GroupConv {
  return { key: groupKey(serverKey, id), serverKey, id, chain: [], view: null, name: null, nameAt: 0, names: {}, messages: [], loaded: false, unread: 0 }
}

function patchGroup(key: string, patch: (g: GroupConv) => Partial<GroupConv>): void {
  const [serverKey, id] = key.split('/')
  let changed = false
  useGroups.setState((state) => {
    const current = state.groups[key] ?? blank(serverKey, id)
    const next = { ...current, ...patch(current) }
    changed = next.messages !== current.messages || next.chain !== current.chain || next.name !== current.name
    if (changed && useApp.getState().servers[serverKey]) next.names = namesFor(next)
    return { groups: { ...state.groups, [key]: next } }
  })
  if (changed) persist(key)
}

// ── The local copy ─────────────────────────────────────────────────────────

const MAX_LOCAL = 5000
const dirty = new Set<string>()
let saveTimer: ReturnType<typeof setTimeout> | null = null
let saving: Promise<void> = Promise.resolve()
let localLoaded = false
let localLoading: Promise<void> | null = null

function persist(key: string): void {
  if (!localLoaded) return
  dirty.add(key)
  saveTimer ??= setTimeout(() => {
    saveTimer = null
    const keys = [...dirty]
    dirty.clear()
    saving = saving.then(async () => {
      for (const k of keys) {
        const g = useGroups.getState().groups[k]
        if (!g) continue
        await storage.saveGroup(k, storable(g)).catch(() => undefined)
      }
    })
  }, 300)
}

/** Attachments from storage or another device, checked like freshly decrypted ones (dropped if malformed). */
function storedFiles(raw: unknown): { files?: DmFile[] } {
  try {
    const files = checkFiles(raw)
    return files.length ? { files } : {}
  } catch {
    return {}
  }
}

const storable = (g: GroupConv): storage.StoredGroup => ({
  serverKey: g.serverKey, id: g.id, chain: g.chain, name: g.name, nameAt: g.nameAt, names: namesFor(g),
  messages: g.messages.filter((m) => !m.pending && !m.error).slice(-MAX_LOCAL)
    .map(({ id, from, text, sentAt, call, group, files }) => ({
      id, from, to: g.id, text, sentAt, ...(call ? { call } : {}), ...(group ? { group } : {}), ...(files?.length ? { files } : {}),
    })),
})

/** Every group on this device with its chain and history, for a device link (the new device re-checks the chains). */
export function exportGroups(perGroup = MAX_LOCAL): storage.StoredGroup[] {
  return Object.values(useGroups.getState().groups)
    .filter((g) => g.chain.length > 0)
    .map((g) => {
      const stored = storable(g)
      return { ...stored, messages: stored.messages.slice(-perGroup) }
    })
}

/** Groups copied from another device (device linking). Chains are verified again when they load. */
export async function importGroups(groups: unknown): Promise<void> {
  if (!Array.isArray(groups)) return
  const text = (x: unknown, max: number) => typeof x === 'string' && x.length <= max
  for (const g of groups.slice(0, 1000) as Partial<storage.StoredGroup>[]) {
    if (!g || !text(g.serverKey, 64) || !text(g.id, 32) || !Array.isArray(g.chain) || !Array.isArray(g.messages)) continue
    const chain = g.chain.filter((c) => c && text(c.payload, 4096) && text(c.sig, 128)).map(({ payload, sig }) => ({ payload, sig }))
    const messages = g.messages.filter((m) => m && text(m.id, 64) && text(m.from, 64) && text(m.text, 4000) && typeof m.sentAt === 'number')
      .map(({ id, from, text, sentAt, call, group, files }) => ({ id, from, to: g.id!, text, sentAt,
        ...(call && typeof call === 'object' ? { call } : {}), ...(group && typeof group === 'object' ? { group } : {}), ...storedFiles(files) }))
    await storage.saveGroup(groupKey(g.serverKey!, g.id!), {
      serverKey: g.serverKey!, id: g.id!, chain, messages: messages.slice(-MAX_LOCAL),
      name: typeof g.name === 'string' ? g.name.slice(0, MAX_GROUP_NAME) : null, nameAt: typeof g.nameAt === 'number' ? g.nameAt : 0,
      names: Object.fromEntries(Object.entries(g.names && typeof g.names === 'object' ? g.names : {})
        .filter(([k, v]) => k.length <= 64 && typeof v === 'string').slice(0, 1000).map(([k, v]) => [k, String(v).slice(0, 32)])),
    })
  }
}

/** Loads the groups kept on this device, re-checking each chain. */
export function loadLocalGroups(): Promise<void> {
  localLoading ??= (async () => {
    await keysReady() // chains compare members under their current keys
    const stored = await storage.loadGroups().catch(() => [] as storage.StoredGroup[])
    for (const s of stored) {
      let view: GroupView | null = null
      let problem: string | undefined
      try {
        view = verifyChain(s.id, s.chain)
      } catch (e) {
        problem = (e as Error).message
      }
      const key = groupKey(s.serverKey, s.id)
      patchGroup(key, (g) => ({
        chain: view ? s.chain : g.chain, view: view ?? g.view, problem: problem ?? g.problem,
        name: s.nameAt >= g.nameAt ? s.name : g.name, nameAt: Math.max(s.nameAt, g.nameAt),
        names: { ...(s.names && typeof s.names === 'object' ? s.names : {}), ...g.names },
        messages: s.messages.map(({ id, from, text, sentAt, call, group, files }) => ({ id, from, text, sentAt, call, group, ...storedFiles(files) }))
          .reduce<GroupMsg[]>(mergeDm, g.messages),
      }))
    }
    localLoaded = true
    for (const key of Object.keys(useGroups.getState().groups)) persist(key)
  })()
  return localLoading
}

useApp.subscribe((state) => {
  if (state.phase === 'ready' && !localLoaded) void loadLocalGroups()
})

// ── The membership chain ───────────────────────────────────────────────────

/**
 * Adds changes to what this device verified. Changes we already have must be byte-for-byte the ones we saw
 * (so history can't be rewritten); new ones must follow on correctly.
 */
function applyChanges(key: string, changes: GroupChange[], server?: WireGroup): void {
  const g = useGroups.getState().groups[key] ?? blank(...(key.split('/') as [string, string]))
  let view = g.view
  const added: GroupChange[] = []
  try {
    for (const change of changes) {
      const { body, head } = parseChange(change)
      if (view && body.version <= view.version) {
        if (view.changes[body.version - 1]?.head !== head) throw new GroupError("This group's history doesn't match what this device saw before.")
        continue
      }
      view = verifyChain(g.id, [change], view)
      added.push({ payload: change.payload, sig: change.sig })
    }
  } catch (e) {
    patchGroup(key, () => ({ problem: (e as Error).message }))
    return
  }
  let problem = g.problem
  // The server routes by its own copy of the member list: it must be the one we verified.
  if (server && view && server.version === view.version && (server.head !== view.head || server.members.join() !== view.members.join()))
    problem = "The server's member list doesn't match the group's signed history."
  patchGroup(key, (cur) => ({ view, chain: added.length ? [...cur.chain, ...added] : cur.chain, problem, gone: false }))
}

const syncing = new Map<string, Promise<void>>()

/** Fetches the changes we haven't seen yet and verifies them. */
export function syncGroup(key: string): Promise<void> {
  let running = syncing.get(key)
  if (!running) {
    running = (async () => {
      const [serverKey, id] = key.split('/')
      const connection = connectionFor(serverKey)
      if (!connection) return
      const since = useGroups.getState().groups[key]?.view?.version ?? 0
      try {
        const { group, changes } = await connection.request('group.get', { groupId: id, since })
        applyChanges(key, changes, group)
      } catch (e) {
        if (e instanceof RequestError && e.code === 'not_found') patchGroup(key, () => ({ gone: true }))
      }
    })().finally(() => syncing.delete(key))
    syncing.set(key, running)
  }
  return running
}

// ── Messages ───────────────────────────────────────────────────────────────

async function openMessage(key: string, wire: WireGroupMessage): Promise<GroupMsg> {
  const identity = useApp.getState().identity!
  const routed = { group: wire.group, from: wire.from, version: wire.version }
  for (let attempt = 0; ; attempt++) {
    const view = useGroups.getState().groups[key]?.view
    try {
      if (!view) throw new GroupBehindError('Group not loaded yet.')
      const { text, header, call, group, files } = decryptGroup(identity, wire.envelope, routed, view)
      return { id: header.id, from: wire.from, text, sentAt: orderTime(header.sentAt, wire.createdAt), call, group, ...(files ? { files } : {}) }
    } catch (e) {
      if (e instanceof GroupBehindError && attempt === 0) {
        await syncGroup(key)
        continue
      }
      const headerId = wire.envelope?.header?.id
      return {
        id: typeof headerId === 'string' && headerId.length <= 32 ? headerId : `server-${wire.id}-${wire.createdAt}`,
        from: wire.from, text: '', sentAt: wire.createdAt,
        error: e instanceof DmError || e instanceof GroupError ? e.message : "This message couldn't be read.",
      }
    }
  }
}

/** Adds a message (and applies a rename in it if it's the newest one). */
function addMessage(key: string, message: GroupMsg, countUnread: boolean): void {
  const rename = !message.error && !message.pending ? asRename(message.group) : null
  patchGroup(key, (g) => ({
    messages: mergeDm(g.messages, message),
    unread: countUnread ? g.unread + 1 : g.unread,
    ...(rename && message.sentAt >= g.nameAt ? { name: rename.name || null, nameAt: message.sentAt } : {}),
  }))
}

const isViewing = (key: string) => {
  const open = useDms.getState().open
  return useApp.getState().activeServer === null && open.kind === 'group' && open.key === key && document.hasFocus()
}

async function onGroupMessage(serverKey: string, wire: WireGroupMessage): Promise<void> {
  await ensurePrekeys()
  const key = groupKey(serverKey, wire.group)
  if (!useGroups.getState().groups[key]?.view) await syncGroup(key)
  const message = await openMessage(key, wire)
  const mine = message.from === me()
  const viewing = isViewing(key)
  const silent = !!asRename(message.group) && (message.group as { silent?: unknown }).silent === true
  addMessage(key, message, !mine && !viewing && !silent)
  // Someone you blocked stays in the group and their messages arrive, but they never notify you.
  if (!mine && !viewing && !silent && !isBlocked(useBlocks.getState().entries, message.from)) {
    const g = useGroups.getState().groups[key]
    show(serverKey, `${nameOf(message.from)} in ${g ? titleOf(g) : 'a group'}`, message.error ? 'New message' : message.text, () => openGroup(key))
  }
}

export async function loadGroupHistory(key: string): Promise<void> {
  const [serverKey, id] = key.split('/')
  const connection = connectionFor(serverKey)
  if (!connection) return
  await ensurePrekeys()
  try {
    if (!useGroups.getState().groups[key]?.view) await syncGroup(key)
    const { messages } = await connection.request('group.history', { groupId: id, limit: 100 })
    const opened = await Promise.all(messages.map((m) => openMessage(key, m)))
    for (const m of opened) addMessage(key, m, false)
    patchGroup(key, () => ({ loaded: true }))
  } catch {
    patchGroup(key, () => ({ loaded: true }))
  }
}

/** Encrypts for every device of every member of the verified chain, never for revoked devices. */
async function encryptFor(g: GroupConv, content: DmContent): Promise<GroupEnvelope> {
  const identity = useApp.getState().identity
  if (!identity || !g.view) throw new DmError('No account on this device.')
  const [bundles, ownRevoked] = await Promise.all([
    Promise.all(g.view.members.map((accountKey) => bundleOf(g.serverKey, accountKey).then((bundle) => ({ accountKey, bundle })).catch(() => null))),
    ownRevokedDevices(),
    ensurePrekeys(),
  ])
  const found = bundles.filter((b) => !!b)
  const revokedDevices = [...ownRevoked, ...found.flatMap((b) => [...revokedSet(b.accountKey, b.bundle.revoked)])]
  return encryptGroup(identity, g.view, found.map((b) => ({ accountKey: b.accountKey, devices: b.bundle.devices })), content, Date.now(), {
    prekeys: found.flatMap((b) => b.bundle.prekeys ?? []),
    revokedDevices,
  })
}

/** Encrypts `content` for a group's current member list (for group call keys). */
export async function sealForGroup(key: string, content: DmContent): Promise<{ envelope: GroupEnvelope; version: number }> {
  const g = useGroups.getState().groups[key]
  const reason = cannotSend(g)
  if (reason) throw new DmError(reason)
  return { envelope: await encryptFor(g!, content), version: g!.view!.version }
}

/** Why you can't write in this group right now, or null if you can. */
export function cannotSend(g: GroupConv | undefined): string | null {
  if (!g) return 'This group is gone.'
  if (isArchived(g)) return "This group's server isn't in your list any more, so the group is archived. You can still read it here."
  if (g.problem) return g.problem
  if (!isMember(g)) return "You're not in this group any more."
  if (useApp.getState().servers[g.serverKey]?.status.state !== 'online') return "This group's server is offline right now, so messages can't be delivered."
  return null
}

/** Sends to the group, retrying once if it changed meanwhile (the new member list gets it). */
async function deliver(key: string, content: DmContent): Promise<GroupEnvelope> {
  for (let attempt = 0; ; attempt++) {
    const g = useGroups.getState().groups[key]
    const reason = cannotSend(g)
    if (reason) throw new DmError(reason)
    const envelope = await encryptFor(g!, content)
    try {
      await connectionFor(g!.serverKey)!.request('group.send', {
        groupId: g!.id, version: g!.view!.version, envelope, ...(content.files?.length ? { files: content.files.map((f) => f.id) } : {}),
      })
      return envelope
    } catch (e) {
      if (!(e instanceof RequestError && e.code === 'conflict') || attempt > 0) throw e
      await syncGroup(key)
    }
  }
}

export async function sendGroupMessage(key: string, text: string, extra: Pick<DmContent, 'call' | 'group' | 'files'> = {}): Promise<void> {
  const tempId = `pending-${Date.now()}-${Math.random()}`
  const mine = me()
  addMessage(key, { id: tempId, from: mine, text, sentAt: Date.now(), pending: 'sending', ...extra }, false)
  try {
    const envelope = await deliver(key, { text, ...extra })
    patchGroup(key, (g) => ({ messages: g.messages.filter((m) => m.id !== tempId) }))
    // The group.message event (sent to us too) brings the same id; this makes it show at once.
    addMessage(key, { id: envelope.header.id, from: mine, text, sentAt: envelope.header.sentAt, ...extra }, false)
  } catch (e) {
    patchGroup(key, (g) => ({
      messages: g.messages.map((m) => (m.id === tempId ? { ...m, pending: 'failed' as const, error: (e as Error).message } : m)),
    }))
  }
}

export function discardGroupMessage(key: string, id: string): void {
  patchGroup(key, (g) => ({ messages: g.messages.filter((m) => !(m.id === id && m.pending)) }))
}

export async function renameGroup(key: string, name: string): Promise<void> {
  const clean = name.trim().slice(0, MAX_GROUP_NAME)
  await sendGroupMessage(key, clean ? `Named the group ${clean}` : 'Removed the group name', { group: { kind: 'rename', name: clean } })
}

// ── Creating and changing groups ───────────────────────────────────────────

/** Makes a group on `serverKey` with you and `others` (2–9 people there), optionally named. Returns its key. */
export async function createGroup(serverKey: string, others: string[], name = ''): Promise<string> {
  const identity = useApp.getState().identity
  const connection = connectionFor(serverKey)
  if (!identity || !connection) throw new DmError("This server isn't connected right now.")
  const id = newGroupId()
  const change = signChange(identity, null, id, 'create', others)
  const { group } = await connection.request('group.create', { change })
  const key = groupKey(serverKey, id)
  applyChanges(key, [change], group)
  patchGroup(key, () => ({ loaded: true }))
  if (name.trim()) await renameGroup(key, name)
  openGroup(key)
  return key
}

/** Signs and sends a membership change, rebuilding it once if the group changed meanwhile. */
async function changeGroup(key: string, action: GroupAction, targets: string[]): Promise<void> {
  const identity = useApp.getState().identity
  if (!identity) return
  for (let attempt = 0; ; attempt++) {
    const g = useGroups.getState().groups[key]
    if (!g?.view) throw new GroupError('This group is gone.')
    const change = signChange(identity, g.view, g.id, action, targets)
    try {
      const { group } = await connectionFor(g.serverKey)!.request('group.change', { change })
      applyChanges(key, [change], group)
      return
    } catch (e) {
      if (!(e instanceof RequestError && e.code === 'conflict') || attempt > 0) throw e
      await syncGroup(key)
    }
  }
}

export async function addToGroup(key: string, people: string[]): Promise<void> {
  await changeGroup(key, 'add', people)
  // New people can't read the old rename, so tell everyone the current name again, quietly.
  const g = useGroups.getState().groups[key]
  if (g?.name) await sendGroupMessage(key, `The group is called ${g.name}`, { group: { kind: 'rename', name: g.name, silent: true } })
}

export const removeFromGroup = (key: string, person: string) => changeGroup(key, 'remove', [person])

/** Leaves the group and forgets it on this device. */
export async function leaveGroup(key: string): Promise<void> {
  const g = useGroups.getState().groups[key]
  if (g && isMember(g)) await changeGroup(key, 'leave', [me()])
  forgetGroup(key)
}

/** Drops a group from this device (after leaving, or when you were removed). */
export function forgetGroup(key: string): void {
  useGroups.setState((s) => {
    const groups = { ...s.groups }
    delete groups[key]
    return { groups }
  })
  void storage.deleteGroup(key).catch(() => undefined)
  const open = useDms.getState().open
  if (open.kind === 'group' && open.key === key) useDms.setState({ open: { kind: 'friends' } })
}

export function openGroup(key: string): void {
  useApp.setState({ activeServer: null })
  useDms.setState({ open: { kind: 'group', key } })
  patchGroup(key, () => ({ unread: 0 }))
  void loadGroupHistory(key)
}

export function markGroupRead(key: string): void {
  patchGroup(key, () => ({ unread: 0 }))
}

// ── Server events ──────────────────────────────────────────────────────────

onServerEvent((serverKey, type, body) => {
  if (type === 'group.message') void onGroupMessage(serverKey, (body as { message: WireGroupMessage }).message)
  if (type === 'group.changed') {
    const { group, change } = body as { group: WireGroup; change: GroupChange & { version: number } }
    const key = groupKey(serverKey, group.id)
    const view = useGroups.getState().groups[key]?.view
    if (view && change.version === view.version + 1) applyChanges(key, [change], group)
    else void syncGroup(key)
  }
})

onWelcomeHook((serverKey) => {
  void (async () => {
    await loadLocalGroups()
    const connection = connectionFor(serverKey)
    if (!connection) return
    try {
      const { groups } = await connection.request('group.list', {})
      const listed = new Set<string>()
      for (const { group, lastAt } of groups) {
        const key = groupKey(serverKey, group.id)
        listed.add(key)
        const g = useGroups.getState().groups[key]
        if (!g?.view || g.view.version < group.version) await syncGroup(key)
        if ((lastAt ?? 0) > (useGroups.getState().groups[key]?.messages.at(-1)?.sentAt ?? 0)) await loadGroupHistory(key)
      }
      // Groups we think we're in that the server no longer lists: find out (we may have been removed while away).
      for (const g of Object.values(useGroups.getState().groups))
        if (g.serverKey === serverKey && !listed.has(g.key) && isMember(g)) await syncGroup(g.key)
    } catch {
      /* the server is busy; the next connect tries again */
    }
  })()
})

/** People you could put in a group on this server: members who aren't bots, without you. */
export function groupCandidates(serverKey: string): string[] {
  const server = useApp.getState().servers[serverKey]
  if (!server) return []
  return Object.values(server.members).filter((m) => m.accountKey !== me() && !(m as { bot?: boolean }).bot).map((m) => m.accountKey)
}
