// Whiteboards (PROTOCOL.md "Whiteboards"): loading a board, sending this app's changes in batches, folding everyone's
// batches in server order, live cursors, undo/redo, and for encrypted channels sealing and opening everything with the
// channel's keys (and uploading snapshots, which the server can't make for them).
//
// The board itself lives outside React (core/board.ts BoardState): a 5,000-stroke board changes many times a second
// while someone draws, so the canvas subscribes here and redraws on its own; React only hears about status changes.
import { create } from 'zustand'
import { b64u, randomBytes } from '../core/crypto'
import {
  batches as splitBatches, BoardState, checkLive, checkOps, History, type Live, type LiveDraft, type Op, type Props,
} from '../core/board'
import { openBoard as openSealed, sealBoard, type BoardEnvelope, type BoardWhat } from '../core/boardCrypto'
import { RequestError, type Events, type WireBatch, type WireBoard, type WireSnapshot } from '../core/protocol'
import { errorMessage } from '../i18n/errors'
import { channelOpenKeys, channelSealKey, syncChannel } from './e2eeChannels'
import { connectionFor, onChannelsGone, onServerEvent, onWelcomeHook, uploadFile, useApp } from './store'
import { withoutChannels } from './channelGone'

export const boardKey = (serverKey: string, channelId: number) => `${serverKey}:${channelId}`

/** What React shows about a board. The objects themselves come from {@link boardSession}. */
export interface BoardUi {
  status: 'loading' | 'ready' | 'none' | 'error'
  boardId: string | null
  encrypted: boolean
  viewers: string[]
  openedBy: string | null
  canUndo: boolean
  canRedo: boolean
  /** The last thing that went wrong (already translated). */
  error?: string
  /** Batches this device couldn't open (encrypted boards). */
  unreadable: number
}

export const useWhiteboard = create<{ boards: Record<string, BoardUi>; voice: Record<string, Record<number, WireBoard>> }>(() => ({ boards: {}, voice: {} }))

/** Someone else's cursor (board units), with the stroke they're drawing. */
export interface Cursor {
  accountKey: string
  x: number
  y: number
  tool?: string
  at: number
  draft?: { id: string; kind: 'pen' | 'hl'; color: string; size: number; pts: number[] }
}

/** What this app is drawing right now, for others to see live: absolute points as [x0, y0, x1, y1, …]. */
export interface LocalLive {
  x: number
  y: number
  tool?: string
  draft?: { id: string; kind: 'pen' | 'hl'; color: string; size: number; points: number[] }
}

interface Outgoing {
  cid: string
  ops: Op[]
}

export interface Session {
  key: string
  serverKey: string
  channelId: number
  boardId: string | null
  encrypted: boolean
  state: BoardState
  history: History
  lastSeq: number
  loading: boolean
  /** Events that arrived while loading. */
  queue: Events['wb.batch'][]
  outgoing: Outgoing[]
  inflight: boolean
  live: LocalLive | null
  liveDirty: boolean
  draftSent: { id: string; count: number } | null
  cursors: Map<string, Cursor>
  /** Envelope ids already applied (encrypted boards), so a replayed batch is dropped. */
  seen: Set<string>
  /** Encrypted batches signed before this (the snapshot's time, less the allowed clock skew) are ignored. */
  floor: number
  wantSnapshot: boolean
  snapshotTimer: ReturnType<typeof setTimeout> | null
  /** Decrypting and applying happen one batch at a time, in order. */
  chain: Promise<void>
  users: number
  listeners: Set<() => void>
  unreadable: number
}

const sessions = new Map<string, Session>()
const CLOCK_SKEW_MS = 10 * 60_000
const TICK_MS = 200

export const boardSession = (serverKey: string, channelId: number) => sessions.get(boardKey(serverKey, channelId))

/** The canvas redraws on these (board changes and cursors). */
export function subscribeBoard(serverKey: string, channelId: number, listener: () => void): () => void {
  const s = sessions.get(boardKey(serverKey, channelId))
  s?.listeners.add(listener)
  return () => s?.listeners.delete(listener)
}

function notify(s: Session): void {
  for (const l of s.listeners) l()
}

function ui(s: Session, patch: Partial<BoardUi>): void {
  useWhiteboard.setState((st) => {
    const old = st.boards[s.key] ?? {
      status: 'loading', boardId: null, encrypted: false, viewers: [], openedBy: null, canUndo: false, canRedo: false, unreadable: 0,
    }
    return { boards: { ...st.boards, [s.key]: { ...old, canUndo: s.history.canUndo, canRedo: s.history.canRedo, unreadable: s.unreadable, ...patch } } }
  })
}

function newSession(serverKey: string, channelId: number): Session {
  return {
    key: boardKey(serverKey, channelId), serverKey, channelId, boardId: null, encrypted: false, state: new BoardState(), history: new History(),
    lastSeq: 0, loading: false, queue: [], outgoing: [], inflight: false, live: null, liveDirty: false, draftSent: null, cursors: new Map(),
    seen: new Set(), floor: 0, wantSnapshot: false, snapshotTimer: null, chain: Promise.resolve(), users: 0, listeners: new Set(), unreadable: 0,
  }
}

function reset(s: Session): void {
  s.state.clear()
  s.history.clear()
  s.outgoing = []
  s.lastSeq = 0
  s.cursors.clear()
  s.seen.clear()
  s.floor = 0
  s.unreadable = 0
  s.wantSnapshot = false
}

const me = () => {
  const identity = useApp.getState().identity
  return identity ? b64u(identity.account.publicKey) : ''
}

// ── Opening and loading ──────────────────────────────────────────────────────

/** Starts showing a board (counted: the same board may be on screen twice). */
export function openBoard(serverKey: string, channelId: number): Session {
  const key = boardKey(serverKey, channelId)
  let s = sessions.get(key)
  if (!s) {
    s = newSession(serverKey, channelId)
    sessions.set(key, s)
  }
  s.users++
  if (s.users === 1) void load(s, false)
  ensureTicking()
  return s
}

export function closeBoard(serverKey: string, channelId: number): void {
  const s = sessions.get(boardKey(serverKey, channelId))
  if (!s || --s.users > 0) return
  // Changes not sent yet still go; then the session is dropped.
  void flushAll(s).finally(() => {
    if (s.users > 0) return
    sessions.delete(s.key)
    if (s.snapshotTimer) clearTimeout(s.snapshotTimer)
    void connectionFor(s.serverKey)?.request('wb.leave', { channelId: s.channelId }).catch(() => undefined)
  })
}

async function flushAll(s: Session): Promise<void> {
  for (let i = 0; i < 20 && s.outgoing.length; i++) {
    const before = s.outgoing.length
    await flush(s)
    if (s.outgoing.length === before) break
  }
}

/** Loads the board: everything (`incremental` false), or what's new since the last batch this app applied. */
function load(s: Session, incremental: boolean): Promise<void> {
  s.chain = s.chain.then(() => loadNow(s, incremental)).catch(() => undefined)
  return s.chain
}

async function loadNow(s: Session, incremental: boolean): Promise<void> {
  const connection = connectionFor(s.serverKey)
  if (!connection?.isOnline) return
  s.loading = true
  s.queue = []
  if (!incremental) ui(s, { status: 'loading', error: undefined })
  try {
    let reply = await connection.request('wb.get', { channelId: s.channelId, ...(incremental && s.lastSeq > 0 ? { since: s.lastSeq } : {}) })
    if (!reply.board) {
      reset(s)
      s.boardId = null
      ui(s, { status: 'none', boardId: null, viewers: reply.viewers })
      notify(s)
      return
    }
    if (reply.board.id !== s.boardId && incremental && s.boardId) {
      // Cleared meanwhile: start over with the new board.
      s.loading = false
      return await loadNow(s, false)
    }
    if (reply.board.id !== s.boardId) {
      reset(s)
      s.boardId = reply.board.id
    }
    s.encrypted = reply.board.encrypted
    if (reply.snapshot) await applySnapshot(s, reply.snapshot)
    for (;;) {
      for (const batch of reply.batches) await applyBatch(s, batch)
      if (!reply.hasMore) break
      reply = await connection.request('wb.get', { channelId: s.channelId, since: s.lastSeq })
      if (reply.board?.id !== s.boardId) {
        s.loading = false
        return await loadNow(s, false)
      }
    }
    // Batches that arrived while loading (the ones already in the reply are skipped by seq).
    const queued = s.queue
    s.queue = []
    for (const e of queued) if (e.boardId === s.boardId) await applyBatch(s, e.batch, e.cid)
    s.wantSnapshot = reply.wantSnapshot
    ui(s, { status: 'ready', boardId: s.boardId, encrypted: s.encrypted, viewers: reply.viewers, openedBy: reply.board.openedBy })
    if (s.wantSnapshot) scheduleSnapshot(s)
  } catch (e) {
    ui(s, { status: 'error', error: errorMessage(e) })
  } finally {
    s.loading = false
    notify(s)
  }
}

async function applySnapshot(s: Session, snap: WireSnapshot): Promise<void> {
  if (snap.objects) {
    s.state.load(snap.objects)
  } else if (snap.envelope) {
    const opened = await openEnvelope(s, snap.envelope, snap.by ?? '', 'snapshot')
    const objects = opened?.content && typeof opened.content === 'object' ? (opened.content as { objects?: unknown }).objects : null
    if (!opened || opened.header.seq !== snap.seq || !objects || typeof objects !== 'object') {
      s.unreadable++
      s.state.load({})
    } else {
      s.state.load(checkObjects(objects as Record<string, unknown>))
      s.floor = opened.header.sentAt - CLOCK_SKEW_MS
    }
  }
  s.lastSeq = snap.seq
}

/** Objects from an encrypted snapshot, checked like ops (anything malformed is left out). */
function checkObjects(objects: Record<string, unknown>): Record<string, Props> {
  const out: Record<string, Props> = {}
  for (const [id, p] of Object.entries(objects)) {
    try {
      checkOps([{ id, p }])
      out[id] = p as Props
    } catch {
      /* skipped */
    }
  }
  return out
}

/** Applies one batch in order. Older than what's applied: skipped. */
async function applyBatch(s: Session, batch: WireBatch, cid?: string): Promise<void> {
  if (batch.seq <= s.lastSeq) return
  let ops: Op[] | null = null
  try {
    if (batch.ops) ops = checkOps(batch.ops)
    else if (batch.envelope) {
      const env = batch.envelope
      if (s.seen.has(env.header?.id) || (env.header?.sentAt ?? 0) < s.floor) ops = null
      else {
        const opened = await openEnvelope(s, env, batch.by, 'ops')
        ops = opened ? checkOps((opened.content as { ops?: unknown })?.ops) : null
        if (opened) s.seen.add(opened.header.id)
      }
    }
  } catch {
    ops = null
  }
  s.lastSeq = batch.seq
  if (ops) {
    s.state.applyConfirmed(ops, cid)
    // A finished stroke replaces its live preview.
    const cursor = s.cursors.get(batch.by)
    if (cursor?.draft && ops.some((o) => o.id === cursor.draft!.id)) delete cursor.draft
  } else {
    if (cid) s.state.dropPending(cid)
    if (batch.by !== me() || !cid) s.unreadable++
  }
}

/** Opens an encrypted board envelope (fetching the chain and keys once if this device lacks them). Null: can't. */
async function openEnvelope(s: Session, env: BoardEnvelope, from: string, what: BoardWhat): Promise<{ content: unknown; header: BoardEnvelope['header'] } | null> {
  const place = { channel: s.channelId, board: s.boardId ?? '' }
  const chain = typeof env?.header?.chain === 'string' ? env.header.chain : ''
  for (const sync of [false, true]) {
    try {
      const keys = await channelOpenKeys(s.serverKey, s.channelId, chain, sync)
      if (!keys) continue
      return openSealed(env, from, place, what, keys.view, (v) => keys.keys.get(v))
    } catch {
      /* try once more after syncing */
    }
  }
  return null
}

// ── Local changes ──────────────────────────────────────────────────────────

/** Applies this person's change at once and queues it for the server. Undoable unless `record` is false. */
export function change(s: Session, ops: Op[], record = true): void {
  if (!s.boardId || ops.length === 0) return
  checkOps(ops.slice(0, 200))
  if (record) s.history.record(s.state, ops)
  for (const part of splitBatches(ops)) {
    const cid = b64u(randomBytes(9))
    s.state.addPending(cid, part)
    s.outgoing.push({ cid, ops: part })
  }
  ui(s, {})
  notify(s)
}

export function undo(s: Session): void {
  const ops = s.history.undo()
  if (ops) change(s, ops, false)
  ui(s, {})
}

export function redo(s: Session): void {
  const ops = s.history.redo()
  if (ops) change(s, ops, false)
  ui(s, {})
}

/** Where this person's cursor is (and what they're drawing), sent with the next tick. */
export function setLive(s: Session, live: LocalLive | null): void {
  s.live = live
  s.liveDirty = true
}

// ── Sending ────────────────────────────────────────────────────────────────

let ticker: ReturnType<typeof setInterval> | null = null

function ensureTicking(): void {
  ticker ??= setInterval(() => {
    if (sessions.size === 0) {
      clearInterval(ticker!)
      ticker = null
      return
    }
    for (const s of sessions.values()) if (!s.inflight && (s.outgoing.length || s.liveDirty)) void flush(s)
  }, TICK_MS)
}

/** The live cursor to send: only the points of the stroke being drawn that weren't sent yet. */
function liveToSend(s: Session): Live | null {
  const live = s.live
  if (!live) return null
  const out: Live = { x: Math.round(live.x * 10) / 10, y: Math.round(live.y * 10) / 10, ...(live.tool ? { tool: live.tool } : {}) }
  const d = live.draft
  if (d) {
    const from = s.draftSent?.id === d.id ? s.draftSent.count : 0
    let start = Math.min(from, d.points.length)
    if (d.points.length - start > 1600) start = d.points.length - 1600 - ((d.points.length - 1600) % 2)
    const draft: LiveDraft = { id: d.id, kind: d.kind, color: d.color, size: d.size, from: start, pts: d.points.slice(start).map((n) => Math.round(n * 10) / 10) }
    out.draft = draft
    s.draftSent = { id: d.id, count: d.points.length }
  } else s.draftSent = null
  return out
}

async function flush(s: Session): Promise<void> {
  const connection = connectionFor(s.serverKey)
  if (s.inflight || !s.boardId || !connection?.isOnline || s.loading) return
  s.inflight = true
  const next = s.outgoing[0]
  try {
    const live = s.liveDirty ? liveToSend(s) : null
    s.liveDirty = false
    if (next) {
      if (s.encrypted) {
        const { view, key } = await channelSealKey(s.serverKey, s.channelId)
        const envelope = sealBoard(useApp.getState().identity!, view, key, { channel: s.channelId, board: s.boardId }, 'ops', { ops: next.ops })
        await connection.request('wb.update', { channelId: s.channelId, boardId: s.boardId, cid: next.cid, version: view.version, envelope })
        if (live) await sendLive(s, live)
      } else {
        await connection.request('wb.update', { channelId: s.channelId, boardId: s.boardId, cid: next.cid, ops: next.ops, ...(live ? { live } : {}) })
      }
      if (s.outgoing[0] === next) s.outgoing.shift()
    } else if (live) {
      await sendLive(s, live)
    }
  } catch (e) {
    if (next) await failed(s, next, e)
  } finally {
    s.inflight = false
  }
}

async function sendLive(s: Session, live: Live): Promise<void> {
  const connection = connectionFor(s.serverKey)
  if (!connection || !s.boardId) return
  if (s.encrypted) {
    const { view, key } = await channelSealKey(s.serverKey, s.channelId)
    const envelope = sealBoard(useApp.getState().identity!, view, key, { channel: s.channelId, board: s.boardId }, 'live', live)
    await connection.request('wb.live', { channelId: s.channelId, boardId: s.boardId, version: view.version, envelope }).catch(() => undefined)
  } else {
    await connection.request('wb.live', { channelId: s.channelId, boardId: s.boardId, live }).catch(() => undefined)
  }
}

/** A batch the server didn't take: some reasons are worth another try, the rest drop the change (and say why). */
async function failed(s: Session, batch: Outgoing, e: unknown): Promise<void> {
  const code = e instanceof RequestError ? e.code : ''
  const key = e instanceof RequestError ? e.key : undefined
  if (code === 'rate_limited' || code === 'disconnected' || code === 'timeout') return // sent again on the next tick
  if (key === 'wb_compact') return void (await makeSnapshot(s).catch(() => undefined))
  if (code === 'conflict' && s.encrypted) return void (await syncChannel(s.serverKey, s.channelId))
  if (code === 'not_found') {
    // The board was cleared: everything waiting belongs to the old one.
    s.outgoing = []
    await load(s, false)
    return
  }
  s.outgoing = s.outgoing.filter((b) => b !== batch)
  s.state.dropPending(batch.cid)
  ui(s, { error: errorMessage(e) })
  notify(s)
}

// ── Snapshots of encrypted boards ──────────────────────────────────────────

/** Someone should seal the board under the current key: this app does, after a short random wait, if nobody beats it. */
function scheduleSnapshot(s: Session): void {
  if (!s.encrypted || s.snapshotTimer || s.unreadable > 0) return
  s.snapshotTimer = setTimeout(() => {
    s.snapshotTimer = null
    if (s.wantSnapshot && sessions.get(s.key) === s) void makeSnapshot(s).catch(() => undefined)
  }, 1000 + Math.random() * 3000)
}

async function makeSnapshot(s: Session): Promise<void> {
  const connection = connectionFor(s.serverKey)
  if (!connection || !s.boardId || !s.encrypted || s.loading || s.unreadable > 0 || s.lastSeq === 0) return
  const { view, key } = await channelSealKey(s.serverKey, s.channelId)
  const seq = s.lastSeq
  const envelope = sealBoard(useApp.getState().identity!, view, key, { channel: s.channelId, board: s.boardId }, 'snapshot', { objects: s.state.confirmedObjects() }, seq)
  const json = JSON.stringify(envelope)
  if (json.length < 40 * 1024) {
    await connection.request('wb.snapshot', { channelId: s.channelId, boardId: s.boardId, seq, version: view.version, envelope })
  } else {
    const file = await uploadFile(s.serverKey, new File([json], 'board.json', { type: 'application/json' }), () => undefined)
    await connection.request('wb.snapshot', { channelId: s.channelId, boardId: s.boardId, seq, version: view.version, file: file.id })
  }
  s.wantSnapshot = false
}

// ── Board actions ──────────────────────────────────────────────────────────

/** Opens a whiteboard in a voice call (or answers the one that's open). */
export async function openVoiceBoard(serverKey: string, channelId: number): Promise<WireBoard> {
  const { board } = await connectionFor(serverKey)!.request('wb.open', { channelId })
  setVoiceBoard(serverKey, board)
  return board
}

export async function clearBoard(s: Session): Promise<void> {
  if (!s.boardId) return
  await connectionFor(s.serverKey)!.request('wb.clear', { channelId: s.channelId, boardId: s.boardId })
}

function setVoiceBoard(serverKey: string, board: WireBoard | null, channelId = board?.channelId ?? 0): void {
  useWhiteboard.setState((st) => {
    const mine = { ...st.voice[serverKey] }
    if (board) mine[channelId] = board
    else delete mine[channelId]
    return { voice: { ...st.voice, [serverKey]: mine } }
  })
}

export const voiceBoardFor = (serverKey: string, channelId: number) => (st: { voice: Record<string, Record<number, WireBoard>> }) =>
  st.voice[serverKey]?.[channelId] ?? null

// ── Events ─────────────────────────────────────────────────────────────────

function onLive(s: Session, accountKey: string, raw: unknown): void {
  const live = checkLive(raw)
  if (!live) return
  const old = s.cursors.get(accountKey)
  const cursor: Cursor = { accountKey, x: live.x, y: live.y, tool: live.tool, at: Date.now() }
  const d = live.draft
  if (d) {
    const pts = old?.draft?.id === d.id ? old.draft.pts.slice(0, d.from) : []
    while (pts.length < d.from && pts.length < 200_000) pts.push(...(pts.length >= 2 ? pts.slice(-2) : d.pts.slice(0, 2)))
    pts.push(...d.pts)
    cursor.draft = { id: d.id, kind: d.kind as 'pen' | 'hl', color: d.color, size: d.size, pts }
  }
  s.cursors.set(accountKey, cursor)
  notify(s)
}

onServerEvent((serverKey, type, body) => {
  if (!type.startsWith('wb.')) return
  if (type === 'wb.board') {
    const { channelId, board } = body as Events['wb.board']
    setVoiceBoard(serverKey, board, channelId)
    const s = sessions.get(boardKey(serverKey, channelId))
    if (s && (board?.id ?? null) !== s.boardId) void load(s, false)
    return
  }
  const { channelId } = body as { channelId: number }
  const s = sessions.get(boardKey(serverKey, channelId))
  if (!s) return
  switch (type) {
    case 'wb.batch': {
      const e = body as Events['wb.batch']
      if (s.loading) {
        s.queue.push(e)
        return
      }
      if (e.boardId !== s.boardId) return void load(s, false)
      s.chain = s.chain.then(async () => {
        if (e.batch.seq > s.lastSeq + 1) return loadNow(s, true) // missed one: catch up from the server
        await applyBatch(s, e.batch, e.cid)
        if (e.wantSnapshot) {
          s.wantSnapshot = true
          scheduleSnapshot(s)
        }
        ui(s, {})
        notify(s)
      }).catch(() => undefined)
      return
    }
    case 'wb.live': {
      const e = body as Events['wb.live']
      if (e.boardId !== s.boardId) return
      if (e.envelope) {
        void openEnvelope(s, e.envelope, e.accountKey, 'live').then((opened) => opened && onLive(s, e.accountKey, opened.content))
      } else onLive(s, e.accountKey, e.live)
      return
    }
    case 'wb.viewers': {
      const { viewers } = body as Events['wb.viewers']
      for (const k of [...s.cursors.keys()]) if (!viewers.includes(k)) s.cursors.delete(k)
      ui(s, { viewers })
      notify(s)
      return
    }
    case 'wb.snapshot': {
      s.wantSnapshot = false
      if (s.snapshotTimer) clearTimeout(s.snapshotTimer)
      s.snapshotTimer = null
      return
    }
    case 'wb.cleared': {
      const { boardId } = body as Events['wb.cleared']
      if (boardId === s.boardId) void load(s, false)
      return
    }
  }
})

onWelcomeHook((serverKey) => {
  // Voice channels with a board open, and catching up on the boards on screen (the server forgot this session).
  void connectionFor(serverKey)?.request('wb.boards', {}).then(({ boards }) => {
    useWhiteboard.setState((st) => ({ voice: { ...st.voice, [serverKey]: Object.fromEntries(boards.map((b) => [b.channelId, b])) } }))
  }).catch(() => undefined)
  for (const s of sessions.values()) if (s.serverKey === serverKey && s.users > 0) void load(s, true)
})

// A board channel that's gone: what this device holds of it is cleared, and nothing unsent goes anywhere.
onChannelsGone((serverKey, channelIds) => {
  for (const id of channelIds) {
    const s = sessions.get(boardKey(serverKey, id))
    if (!s) continue
    sessions.delete(s.key)
    if (s.snapshotTimer) clearTimeout(s.snapshotTimer)
    reset(s)
    s.queue = []
    notify(s)
  }
  useWhiteboard.setState((st) => {
    const voice = st.voice[serverKey]
    const kept = voice ? Object.fromEntries(Object.entries(voice).filter(([id]) => !channelIds.includes(Number(id)))) : undefined
    return {
      boards: withoutChannels(st.boards, serverKey, channelIds),
      voice: voice && kept && Object.keys(kept).length !== Object.keys(voice).length ? { ...st.voice, [serverKey]: kept } : st.voice,
    }
  })
})
