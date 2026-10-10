// Message search: the query typed in the header, its results and paging.
import { create } from 'zustand'
import type { SearchResult } from '../core/protocol'
import { parseSearch } from '../ui/chat/searchQuery'
import { connectionFor, useApp } from './store'
import { closeThread, rememberThreads } from './threads'

interface SearchState {
  /** The server the panel belongs to, or null when closed. */
  key: string | null
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
}

const initial = { text: '', searched: '', results: [], total: 0, totalCapped: false, hasMore: false, loading: false, error: null }

/** "1 result", "12 results", "1000+ results". */
export const resultCount = (total: number, capped: boolean) => `${total}${capped ? '+' : ''} ${total === 1 && !capped ? 'result' : 'results'}`

export const useSearch = create<SearchState>(() => ({ key: null, ...initial }))

export const setSearchText = (text: string) => useSearch.setState({ text })

export function openSearch(key: string): void {
  if (useSearch.getState().key !== key) useSearch.setState({ ...initial, key })
  closeThread()
}

export function closeSearch(): void {
  useSearch.setState({ key: null })
}

let generation = 0

/** Runs the typed search, or loads the next page of the current one. */
export async function runSearch(key: string, more = false): Promise<void> {
  const state = useSearch.getState()
  const server = useApp.getState().servers[key]
  const connection = connectionFor(key)
  if (!server || !connection) return
  const text = more ? state.searched : state.text
  const parsed = parseSearch(text, { channels: server.channels, members: Object.values(server.members) })
  if (!more) openSearch(key)
  if (parsed.errors.length || parsed.empty) {
    useSearch.setState({
      searched: text, results: [], total: 0, hasMore: false, loading: false,
      error: parsed.errors[0] ?? 'Type something to search for.',
    })
    return
  }
  const cursor = more ? state.results.at(-1)?.message.id : undefined
  const mine = ++generation
  useSearch.setState({ loading: true, error: null, ...(more ? {} : { searched: text, results: [], total: 0 }) })
  try {
    const reply = await connection.request('search', { ...parsed.request, cursor, limit: 25 })
    if (mine !== generation) return
    rememberThreads(key, reply.threads)
    useSearch.setState((s) => ({
      results: more ? [...s.results, ...reply.results] : reply.results,
      total: reply.total,
      totalCapped: !!reply.totalCapped,
      hasMore: reply.hasMore,
      loading: false,
    }))
  } catch (e) {
    if (mine === generation) useSearch.setState({ loading: false, error: (e as Error).message })
  }
}
