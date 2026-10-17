// Message search: the query typed in the header, its results and paging. One server at a time, or "everywhere": the
// same request fanned out to every server you're on (each answers for itself; an offline server or one that refuses
// says so) plus the direct messages and groups kept on this device, grouped by server, newest group first.
import { create } from 'zustand'
import { t } from '../i18n'
import { errorMessage } from '../i18n/errors'
import type { SearchRequest, SearchResult } from '../core/protocol'
import { parseSearch } from '../ui/chat/searchQuery'
import { connectionFor, selectServer, useApp } from './store'
import { closeThread, rememberThreads } from './threads'
import { localSearchResults } from './e2eeChannels'
import { useDms } from './dms'
import { useGroups } from './groups'

export type SearchScope = 'server' | 'everywhere'

/** How one server (or this device's DMs) did in an "everywhere" search. */
export type GroupStatus = 'searching' | 'done' | 'offline' | 'forbidden' | 'error' | 'skipped'

/** What a direct message and a group message have in common, as far as search needs. */
export interface LocalMessage {
  id: string
  from: string
  text: string
  sentAt: number
  pending?: unknown
  error?: unknown
  call?: unknown
  notice?: unknown
  disappear?: unknown
  files?: unknown[]
}

/** A hit in a direct message or a group, found on this device. */
export interface DmHit {
  /** The conversation: a peer's account key, or a group's key ("<serverKey>/<groupId>"). */
  kind: 'dm' | 'group'
  key: string
  message: LocalMessage
  matches: [number, number][]
}

export interface SearchGroup {
  /** A server key, or `DMS` for the direct messages and groups on this device. */
  key: string
  status: GroupStatus
  results: SearchResult[]
  hits: DmHit[]
  total: number
  totalCapped: boolean
  hasMore: boolean
  /** Why nothing was searched here (a filter that means nothing on this server), or what went wrong. */
  note: string | null
  /** The newest hit's time: groups with something come first, newest first. */
  newest: number
  /** The request this server got, for its next page. */
  request: SearchRequest | null
}

export const DMS = 'dms'

interface SearchState {
  /** The server the panel belongs to, or null when closed. */
  key: string | null
  scope: SearchScope
  text: string
  /** The text the current results are for. */
  searched: string
  results: SearchResult[]
  total: number
  /** More matched than the server counts (total is then the cap). */
  totalCapped: boolean
  hasMore: boolean
  loading: boolean
  error: string | null
  /** "Everywhere": one group per server you're on, plus this device's DMs. */
  groups: SearchGroup[]
}

const initial = { text: '', searched: '', results: [], total: 0, totalCapped: false, hasMore: false, loading: false, error: null, groups: [] }

/** "1 message", "12 messages", "1000+ messages" (docs pages are listed apart). */
export const resultCount = (total: number, capped: boolean) => (capped ? t('chat.search.resultCountCapped', { n: total }) : t('chat.search.resultCount', { count: total }))

export const useSearch = create<SearchState>(() => ({ key: null, scope: 'server', ...initial }))

export const setSearchText = (text: string) => useSearch.setState({ text })

/** Opens the panel for a server; what's typed in the box stays. */
export function openSearch(key: string): void {
  const state = useSearch.getState()
  if (state.key !== key) useSearch.setState({ ...initial, key, text: state.text })
  closeThread()
}

/** Closes the panel and empties the box, so the next search starts fresh. */
export function closeSearch(): void {
  generation++
  useSearch.setState({ key: null, ...initial })
}

/** This server or everywhere; a search already shown is run again the new way. */
export function setSearchScope(scope: SearchScope): void {
  const state = useSearch.getState()
  if (state.scope === scope) return
  useSearch.setState({ scope })
  if (state.key && state.searched) void runSearch(state.key)
}

/** Ctrl+K's "Search everywhere for …": the panel on the server you're looking at (else your first), everywhere. */
export function openGlobalSearch(text: string): void {
  const app = useApp.getState()
  const key = app.activeServer && app.servers[app.activeServer] ? app.activeServer : app.order.find((k) => app.servers[k])
  if (!key) return
  if (app.activeServer !== key) selectServer(key)
  openSearch(key)
  useSearch.setState({ scope: 'everywhere', text })
  void runSearch(key)
}

let generation = 0

/** Runs the typed search, or loads the next page of the current one. */
export async function runSearch(key: string, more = false): Promise<void> {
  const state = useSearch.getState()
  if (state.scope === 'everywhere' && !more) return runEverywhere(key)
  const server = useApp.getState().servers[key]
  const connection = connectionFor(key)
  if (!server || !connection) return
  const text = more ? state.searched : state.text
  const parsed = parseSearch(text, { channels: server.channels, members: Object.values(server.members) })
  if (!more) openSearch(key)
  if (parsed.errors.length || parsed.empty) {
    useSearch.setState({
      searched: text, results: [], total: 0, hasMore: false, loading: false,
      error: parsed.errors[0] ?? t('chat.search.typeSomething'),
    })
    return
  }
  const cursor = more ? state.results.at(-1)?.message.id : undefined
  const mine = ++generation
  useSearch.setState({ loading: true, error: null, ...(more ? {} : { searched: text, results: [], total: 0, groups: [] }) })
  try {
    const reply = await connection.request('search', { ...parsed.request, cursor, limit: 25 })
    // Encrypted channels are searched on this device (the server has only ciphertext): their matches come first.
    const local = more ? [] : await localSearchResults(key, parsed.request).catch(() => [])
    if (mine !== generation) return
    rememberThreads(key, reply.threads)
    useSearch.setState((s) => ({
      results: more ? [...s.results, ...reply.results] : [...local, ...reply.results],
      total: reply.total + local.length,
      totalCapped: !!reply.totalCapped,
      hasMore: reply.hasMore,
      loading: false,
    }))
  } catch (e) {
    if (mine === generation) useSearch.setState({ loading: false, error: errorMessage(e) })
  }
}

// ── Everywhere ──────────────────────────────────────────────────────────────

const emptyGroup = (key: string, status: GroupStatus, note: string | null = null, request: SearchRequest | null = null): SearchGroup =>
  ({ key, status, results: [], hits: [], total: 0, totalCapped: false, hasMore: false, note, newest: 0, request })

/** Groups with something first, newest first; the rest in the order they were asked. */
function ordered(groups: SearchGroup[]): SearchGroup[] {
  return [...groups].sort((a, b) => (b.newest > 0 ? 1 : 0) - (a.newest > 0 ? 1 : 0) || b.newest - a.newest)
}

function patchGroup(mine: number, key: string, patch: Partial<SearchGroup>): void {
  if (mine !== generation) return
  useSearch.setState((s) => {
    const groups = ordered(s.groups.map((g) => (g.key === key ? { ...g, ...patch } : g)))
    const loading = groups.some((g) => g.status === 'searching')
    const total = groups.reduce((n, g) => n + g.total, 0)
    return { groups, loading, total, totalCapped: groups.some((g) => g.totalCapped) }
  })
}

/** The same search on every server you're on, each for itself, plus the DMs and groups on this device. */
async function runEverywhere(key: string): Promise<void> {
  const state = useSearch.getState()
  const app = useApp.getState()
  const text = state.text
  openSearch(key)
  const keys = app.order.filter((k) => app.servers[k]?.me)
  const groups: SearchGroup[] = []
  const requests = new Map<string, SearchRequest>()
  let author: string | undefined
  for (const k of keys) {
    const server = app.servers[k]
    const parsed = parseSearch(text, { channels: server.channels, members: Object.values(server.members) })
    if (parsed.empty && parsed.errors.length === 0) {
      useSearch.setState({ searched: text, results: [], groups: [], total: 0, hasMore: false, loading: false, error: t('chat.search.typeSomething') })
      return
    }
    // A filter that means nothing here ("from:" someone who isn't on this server, "in:" a channel it hasn't got) skips the server.
    if (parsed.errors.length) groups.push(emptyGroup(k, 'skipped', parsed.errors[0]))
    else if (!connectionFor(k)?.isOnline) groups.push(emptyGroup(k, 'offline'))
    else {
      groups.push(emptyGroup(k, 'searching', null, parsed.request))
      requests.set(k, parsed.request)
    }
    author ??= parsed.request.author
  }
  if (keys.length > 0 && groups.every((g) => g.status === 'skipped')) {
    useSearch.setState({ searched: text, results: [], groups: [], total: 0, hasMore: false, loading: false, error: groups[0].note })
    return
  }
  // Direct messages and groups: the filters a server-less search can honour (words, from:, has:, dates).
  const dmParsed = parseSearch(text, { channels: [], members: [] })
  const dmRequest: SearchRequest = { ...dmParsed.request, author, channelId: undefined }
  groups.push(emptyGroup(DMS, 'searching', null, dmRequest))

  const mine = ++generation
  useSearch.setState({ searched: text, results: [], total: 0, totalCapped: false, hasMore: false, loading: true, error: null, groups })

  const jobs = [...requests].map(async ([k, request]) => {
    try {
      const [reply, local] = await Promise.all([
        connectionFor(k)!.request('search', { ...request, limit: 25 }),
        localSearchResults(k, request).catch(() => []),
      ])
      if (mine !== generation) return
      rememberThreads(k, reply.threads)
      const results = [...local, ...reply.results]
      patchGroup(mine, k, {
        status: 'done', results, total: reply.total + local.length, totalCapped: !!reply.totalCapped, hasMore: reply.hasMore,
        newest: results.reduce((n, r) => Math.max(n, r.message.createdAt), 0),
      })
    } catch (e) {
      const code = (e as { code?: string })?.code
      patchGroup(mine, k, { status: code === 'forbidden' ? 'forbidden' : !connectionFor(k)?.isOnline ? 'offline' : 'error', note: code === 'forbidden' ? null : errorMessage(e) })
    }
  })
  const hits = localDmHits(dmRequest)
  patchGroup(mine, DMS, { status: 'done', hits, total: hits.length, newest: hits.reduce((n, h) => Math.max(n, h.message.sentAt), 0) })
  await Promise.all(jobs)
}

/** The next page of one server's results in an "everywhere" search. */
export async function runGroupMore(key: string): Promise<void> {
  const group = useSearch.getState().groups.find((g) => g.key === key)
  const connection = connectionFor(key)
  if (!group?.request || !connection || !group.hasMore) return
  const mine = generation
  const cursor = group.results.at(-1)?.message.id
  patchGroup(mine, key, { status: 'searching' })
  try {
    const reply = await connection.request('search', { ...group.request, cursor, limit: 25 })
    if (mine !== generation) return
    rememberThreads(key, reply.threads)
    const current = useSearch.getState().groups.find((g) => g.key === key)
    patchGroup(mine, key, { status: 'done', results: [...(current?.results ?? []), ...reply.results], hasMore: reply.hasMore })
  } catch (e) {
    patchGroup(mine, key, { status: 'error', note: errorMessage(e) })
  }
}

// ── Direct messages and groups, on this device ──────────────────────────────

/** Where every word is in a text (lower-cased offsets; words are matched case-insensitively). */
function wordMatches(text: string, words: string[]): [number, number][] | null {
  const lower = text.toLocaleLowerCase()
  const out: [number, number][] = []
  for (const w of words) {
    const at = lower.indexOf(w)
    if (at < 0) return null
    out.push([at, w.length])
  }
  return out
}

/**
 * Hits in the DMs and groups kept on this device (there is no server to ask: they're end-to-end encrypted). Every word
 * must appear; `from:` compares the author, `has:file` wants attachments, `has:link` a web address; dates on `sentAt`.
 * Newest first, at most 100.
 */
export function localDmHits(request: SearchRequest): DmHit[] {
  const words = (request.query ?? '').toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const keep = (m: LocalMessage) => {
    if (m.error || m.notice || m.call || m.disappear || m.pending) return null
    if (request.author && m.from !== request.author) return null
    if (request.before !== undefined && m.sentAt >= request.before) return null
    if (request.after !== undefined && m.sentAt <= request.after) return null
    if (request.has?.includes('file') && !(m.files && m.files.length > 0)) return null
    if (request.has?.includes('link') && !/https?:\/\//i.test(m.text)) return null
    return wordMatches(m.text, words)
  }
  const out: DmHit[] = []
  for (const [peer, conversation] of Object.entries(useDms.getState().conversations)) {
    for (const m of conversation.messages) {
      const matches = keep(m)
      if (matches) out.push({ kind: 'dm', key: peer, message: m, matches })
    }
  }
  for (const [key, group] of Object.entries(useGroups.getState().groups)) {
    for (const m of group.messages) {
      const matches = keep(m)
      if (matches) out.push({ kind: 'group', key, message: m, matches })
    }
  }
  return out.sort((a, b) => b.message.sentAt - a.message.sentAt).slice(0, 100)
}
