// Key transparency in the app: each server's signed key log is checked and followed, servers are compared with each
// other, friends compare notes inside their DMs (gossip), and anything that doesn't add up becomes a finding the
// person sees. The checks themselves live in core/keylog.ts. See "Key transparency" in protocol/PROTOCOL.md.
import { create } from 'zustand'
import { b64u } from '../core/crypto'
import {
  checkGossip, compareGossip, emptyView, extendView, hashAt, LogError, lookalikes, rotationLogged, signGossip, splitViews, unloggedKeys,
  verifyHead, type LogView, type WireLogEntry,
} from '../core/keylog'
import type { KeyLogHead, Welcome } from '../core/protocol'
import type { AppliedRotation, Rotation } from '../core/rotation'
import * as storage from '../core/storage'
import { useDevices } from './devices'
import { devicesOf, setDmGossip, sharedServers, useDms } from './dms'
import { keysOf, keysReady, knownRotations, resolveKey, sameAccount } from './keyMap'
import { connectionFor, onServerEvent, onWelcomeHook, useApp } from './store'

export type FindingKind =
  | 'fork' | 'rollback' | 'bad-log' | 'unlogged-key' | 'unlogged-rotation' | 'split' | 'gossip-fork' | 'gossip-conflict' | 'lookalike'
  | 'device-unknown'

export interface Finding {
  /** Stable, so the same problem isn't reported twice. */
  id: string
  kind: FindingKind
  severity: 'high' | 'medium'
  at: number
  server?: string
  servers?: string[]
  /** The person it's about (their key when found). */
  person?: string
  keys?: string[]
  /** The friend whose gossip showed it. */
  by?: string
}

export type LogStatus =
  | { state: 'checking' }
  | { state: 'ok'; seq: number; hash: string; checkedAt: number }
  | { state: 'unsupported' }
  | { state: 'problem'; seq: number; hash: string; checkedAt: number }

/** When this device first saw each of a contact's keys (the "key history" in the safety number dialog). */
export interface SeenKey {
  first: number
  server?: string
}

interface StoredKt {
  v: 1
  views: Record<string, LogView>
  findings: Finding[]
  dismissed: string[]
  seen: Record<string, SeenKey>
  gossipSent: Record<string, number>
  gossipSeen: Record<string, number>
}

interface KtState {
  logs: Record<string, LogStatus>
  /** Findings not dismissed, newest first. */
  findings: Finding[]
  seen: Record<string, SeenKey>
}

export const useKt = create<KtState>(() => ({ logs: {}, findings: [], seen: {} }))

const HIGH: FindingKind[] = ['fork', 'rollback', 'bad-log', 'unlogged-key', 'unlogged-rotation', 'split', 'gossip-fork', 'gossip-conflict']
/** Gossip goes out at most this often per friend (more often when something changed). */
export const GOSSIP_EVERY_MS = 12 * 60 * 60 * 1000
const GOSSIP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const MAX_PAGES = 200
const MAX_FINDINGS = 200

let data: StoredKt = { v: 1, views: {}, findings: [], dismissed: [], seen: {}, gossipSent: {}, gossipSeen: {} }
let loading: Promise<void> | null = null

function ready(): Promise<void> {
  loading ??= storage.loadKt<StoredKt>().then((stored) => {
    if (stored?.v === 1) data = { ...data, ...stored }
    publish()
  }, () => undefined)
  return loading
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
function save(): void {
  publish()
  saveTimer ??= setTimeout(() => {
    saveTimer = null
    void storage.saveKt(data).catch(() => undefined)
  }, 300)
}

function publish(): void {
  const dismissed = new Set(data.dismissed)
  useKt.setState({ findings: data.findings.filter((f) => !dismissed.has(f.id)).sort((a, b) => b.at - a.at), seen: data.seen })
}

function report(finding: Omit<Finding, 'at' | 'severity'> & { severity?: Finding['severity'] }): void {
  if (data.findings.some((f) => f.id === finding.id)) return
  data.findings = [...data.findings, { severity: HIGH.includes(finding.kind) ? 'high' as const : 'medium' as const, at: Date.now(), ...finding }].slice(-MAX_FINDINGS)
  save()
}

export function dismissFinding(id: string): void {
  if (!data.dismissed.includes(id)) data.dismissed = [...data.dismissed, id].slice(-500)
  save()
}

const setLog = (serverKey: string, status: LogStatus) => useKt.setState((s) => ({ logs: { ...s.logs, [serverKey]: status } }))
const myKey = () => {
  const identity = useApp.getState().identity
  return identity ? b64u(identity.account.publicKey) : ''
}

// ── Following a server's log ────────────────────────────────────────────────

const syncing = new Map<string, Promise<void>>()

/** Brings our copy of a server's log up to date and checks what the server shows against it. */
export function syncServer(serverKey: string, head?: KeyLogHead | null, welcome?: Welcome, confirm = false): Promise<void> {
  const previous = syncing.get(serverKey) ?? Promise.resolve()
  const next = previous.then(() => doSync(serverKey, head, welcome, confirm)).catch(() => undefined)
  syncing.set(serverKey, next)
  return next
}

async function doSync(serverKey: string, welcomeHead: KeyLogHead | null | undefined, welcome: Welcome | undefined, confirm: boolean): Promise<void> {
  await ready()
  const conn = connectionFor(serverKey)
  if (!conn) return
  if (welcome && !welcome.keyLog) return setLog(serverKey, { state: 'unsupported' })
  const before = data.views[serverKey] ?? emptyView(serverKey)
  if (useKt.getState().logs[serverKey]?.state !== 'problem') setLog(serverKey, { state: 'checking' })
  try {
    if (welcomeHead && !verifyHead(serverKey, welcomeHead)) throw new LogError('bad-signature')
    const entries: WireLogEntry[] = []
    let head: KeyLogHead | null = null
    let after = before.head.seq
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await conn.request('keylog.entries', { after, limit: 100 })
      head = result.head
      entries.push(...result.entries)
      const last = result.entries.at(-1)?.seq ?? after
      if (!result.entries.length || last >= head.seq) break
      after = last
    }
    if (!head) return
    const { view, added } = extendView(before, head, entries)
    // The head in the welcome must be part of the same history.
    if (welcomeHead) {
      const at = hashAt(view, welcomeHead.seq)
      if (at !== null && at !== welcomeHead.hash) throw new LogError('fork')
    }
    data.views = { ...data.views, [serverKey]: view }
    setLog(serverKey, { state: 'ok', seq: view.head.seq, hash: view.head.hash, checkedAt: Date.now() })
    save()
    check(serverKey, view, welcome?.rotations ?? [], added.length > 0, confirm)
  } catch (e) {
    if (!(e instanceof LogError)) {
      // A server that doesn't know keylog.entries, or a dropped connection: not a finding.
      if ((e as { code?: string }).code === 'unknown_type') setLog(serverKey, { state: 'unsupported' })
      else if (useKt.getState().logs[serverKey]?.state === 'checking') setLog(serverKey, before.head.sig ? { state: 'ok', seq: before.head.seq, hash: before.head.hash, checkedAt: Date.now() } : { state: 'unsupported' })
      return
    }
    const kind: FindingKind = e.problem === 'rollback' ? 'rollback' : e.problem === 'fork' ? (e.message !== 'fork' ? 'gossip-fork' : 'fork') : 'bad-log'
    report({ id: `${kind}:${serverKey}`, kind, server: serverKey, ...(kind === 'gossip-fork' ? { by: e.message } : {}) })
    setLog(serverKey, { state: 'problem', seq: before.head.seq, hash: before.head.hash, checkedAt: Date.now() })
  }
}

/** What the server shows (members, rotations) must be in its log; servers must agree; friends' names aren't borrowed. */
function check(serverKey: string, view: LogView, rotations: AppliedRotation[], changed: boolean, confirm: boolean): void {
  const server = useApp.getState().servers[serverKey]
  if (!server) return
  const members = Object.values(server.members)
  const unlogged = unloggedKeys(view, members.map((m) => m.accountKey))
  // Someone may have joined while we were reading: read once more before calling it a finding.
  if (unlogged.length && !confirm) setTimeout(() => void syncServer(serverKey, null, undefined, true), 1000)
  else for (const key of unlogged) report({ id: `unlogged-key:${serverKey}:${key}`, kind: 'unlogged-key', server: serverKey, person: key, keys: [key] })
  for (const r of rotations)
    if (!rotationLogged(view, r)) report({ id: `unlogged-rotation:${serverKey}:${r.oldKey}:${r.newKey}`, kind: 'unlogged-rotation', server: serverKey, person: r.newKey, keys: [r.oldKey, r.newKey] })

  if (changed) {
    for (const split of splitViews(Object.values(data.views))) {
      const keys = Object.keys(split.claims)
      report({ id: `split:${split.oldKey}:${keys.sort().join(',')}`, kind: 'split', person: resolveKey(split.oldKey), keys: [split.oldKey, ...keys], servers: [...new Set(Object.values(split.claims).flat())] })
    }
  }

  const friends = Object.entries(useDms.getState().friends).map(([key, f]) => ({ key, name: f.name }))
  for (const l of lookalikes(friends, members.map((m) => ({ key: m.accountKey, name: m.name })), sameAccount))
    report({ id: `lookalike:${serverKey}:${l.key}`, kind: 'lookalike', server: serverKey, person: l.friend, keys: [l.key] })

  // First time we see a contact's key (friends and people we've talked to).
  const contacts = new Set([...friends.map((f) => f.key), ...Object.keys(useDms.getState().conversations)])
  let added = false
  for (const m of members) {
    if (!contacts.has(resolveKey(m.accountKey)) || data.seen[m.accountKey]) continue
    data.seen = { ...data.seen, [m.accountKey]: { first: Date.now(), server: serverKey } }
    added = true
  }
  if (added) save()
}

/** A rotation a server announced live: once its log has caught up, the log must have it. */
function checkRotation(serverKey: string, rotation: Rotation): void {
  void syncServer(serverKey).then(() => {
    const view = data.views[serverKey]
    if (view && !rotationLogged(view, rotation))
      report({ id: `unlogged-rotation:${serverKey}:${rotation.oldKey}:${rotation.newKey}`, kind: 'unlogged-rotation', server: serverKey, person: rotation.newKey, keys: [rotation.oldKey, rotation.newKey] })
  })
}

/** Remembers a contact's new key from a rotation (first seen now). */
function noteKey(key: string, serverKey: string): void {
  if (data.seen[key]) return
  data.seen = { ...data.seen, [key]: { first: Date.now(), server: serverKey } }
  save()
}

const pending = new Map<string, ReturnType<typeof setTimeout>>()
function syncSoon(serverKey: string): void {
  clearTimeout(pending.get(serverKey))
  pending.set(serverKey, setTimeout(() => {
    pending.delete(serverKey)
    void syncServer(serverKey)
  }, 1500))
}

onWelcomeHook((serverKey, welcome) => void syncServer(serverKey, welcome.keyLog ?? null, welcome))

onServerEvent((serverKey, type, body) => {
  switch (type) {
    case 'member.joined':
      syncSoon(serverKey)
      return
    case 'member.rotated':
    case 'account.disputed':
    case 'account.resolved': {
      const { rotation } = body as { rotation: AppliedRotation }
      noteKey(rotation.newKey, serverKey)
      checkRotation(serverKey, rotation)
    }
  }
})

// ── Gossip in DMs ───────────────────────────────────────────────────────────

/** A signed digest for <paramref name="peer"/>, at most every 12 hours per friend (or when a head moved). */
export async function gossipFor(peer: string, now = Date.now()): Promise<Record<string, unknown> | undefined> {
  await Promise.all([ready(), keysReady()])
  const identity = useApp.getState().identity
  if (!identity || peer === myKey()) return undefined
  const shared = sharedServers(peer)
  const heads = shared.map((s) => data.views[s]).filter((v): v is LogView => !!v?.head.sig).map((v) => ({ server: v.serverKey, ...v.head }))
  const last = data.gossipSent[peer] ?? 0
  if (now - last < GOSSIP_EVERY_MS && heads.every((h) => h.at <= last)) return undefined
  // Rotations for people on the servers we share (and our own), so the friend can compare them with theirs.
  const servers = useApp.getState().servers
  const near = new Set(shared.flatMap((s) => Object.keys(servers[s]?.members ?? {})).map(resolveKey))
  near.add(myKey())
  const rotations = knownRotations().filter((r) => near.has(resolveKey(r.newKey)))
  const devices = useDevices.getState().loaded ? useDevices.getState().devices.map((d) => d.deviceKey) : []
  data.gossipSent = { ...data.gossipSent, [peer]: now }
  save()
  return signGossip(identity, peer, { heads, rotations, devices }, now) as unknown as Record<string, unknown>
}

/** Gossip from a friend's DM: compare their heads and rotations with ours. */
export async function receiveGossip(from: string, to: string, raw: Record<string, unknown>, now = Date.now()): Promise<void> {
  await Promise.all([ready(), keysReady()])
  if (sameAccount(from, myKey())) return
  const g = checkGossip(raw, from, to, now, sameAccount)
  // Old gossip (from history) may describe a dispute that has since been settled.
  if (!g || g.at <= (data.gossipSeen[from] ?? 0) || now - g.at > GOSSIP_MAX_AGE_MS) return
  data.gossipSeen = { ...data.gossipSeen, [from]: g.at }
  const { findings, views } = compareGossip(data.views, g, resolveKey)
  data.views = views
  save()
  for (const f of findings) {
    if (f.kind === 'fork') {
      report({ id: `gossip-fork:${f.server}`, kind: 'gossip-fork', server: f.server, by: from })
      setLog(f.server, { state: 'problem', seq: data.views[f.server]?.head.seq ?? 0, hash: data.views[f.server]?.head.hash ?? '', checkedAt: Date.now() })
    } else {
      report({ id: `gossip-conflict:${f.oldKey}:${f.theirs}`, kind: 'gossip-conflict', person: f.mine, keys: [f.oldKey, f.mine, f.theirs], by: from })
    }
  }
  // Devices a server lists for them that they don't list themselves (an hour of slack for brand-new ones).
  if (g.devices.length) {
    for (const serverKey of sharedServers(from)) {
      const certs = await devicesOf(serverKey, from).catch(() => [])
      for (const cert of certs)
        if (!g.devices.includes(cert.deviceKey) && cert.created < g.at - 3_600_000)
          report({ id: `device-unknown:${serverKey}:${cert.deviceKey}`, kind: 'device-unknown', server: serverKey, person: from, keys: [cert.deviceKey] })
    }
  }
}

setDmGossip({ attach: (peer) => gossipFor(peer), receive: (from, to, raw) => void receiveGossip(from, to, raw) })

// ── For the UI ──────────────────────────────────────────────────────────────

/** Findings about one person (any of their keys). */
export const findingsAbout = (findings: Finding[], peer: string) => {
  const keys = new Set(keysOf(peer))
  return findings.filter((f) => (f.person && keys.has(resolveKey(f.person))) || f.keys?.some((k) => keys.has(resolveKey(k))))
}

/** Our verified copy of a server's log head, if any. */
export const storedHead = (serverKey: string) => data.views[serverKey]?.head ?? null
