// Docs channels: each channel's page list, page texts, the page open in each channel, drafts being edited, and the
// server's "Start here" page. Pages too big for one socket frame are saved as an upload (see "Docs channels" in PROTOCOL.md).
import { create } from 'zustand'
import type { DocHome, DocPage, DocRevision, DocSearchResult } from '../core/protocol'
import { connectionFor, onServerEvent, onWelcomeHook, selectChannel, uploadFile } from './store'
import { errorMessage } from '../i18n/errors'
import { upsertPage } from './docsLogic'

/** Text bigger than this (UTF-8 bytes) goes up as a file: a socket frame is 64 KB, JSON escaping included. */
export const INLINE_TEXT_BYTES = 40 * 1024
export const MAX_PAGE_BYTES = 100 * 1024
export const MAX_TITLE_LENGTH = 100

interface DocsList {
  pages: DocPage[]
  loading: boolean
  error: string | null
}

/** An edit in progress. `base*`: the page as it was when editing started (for merging after a conflict). */
export interface DocDraft {
  pageId: number | null
  /** New pages: where they go. */
  channelId: number
  parentId: number | null
  title: string
  text: string
  baseVersion: number
  baseTitle: string
  baseText: string
  /** Shown above the editor after a merge ("Merged with …: check and save"). */
  note?: 'merged' | 'markers' | null
}

interface DocsState {
  /** `${serverKey}:${channelId}` → its pages (no text). */
  lists: Record<string, DocsList>
  /** `${serverKey}:${pageId}` → the page with its text, as last fetched. */
  texts: Record<string, DocPage>
  /** `${serverKey}:${channelId}` → the open page (null: the channel's overview). */
  open: Record<string, number | null>
  /** `${serverKey}:${channelId}` → the draft being edited there. */
  drafts: Record<string, DocDraft>
  /** serverKey → its "Start here" page (as you see it). */
  home: Record<string, DocHome | null>
}

export const useDocs = create<DocsState>(() => ({ lists: {}, texts: {}, open: {}, drafts: {}, home: {} }))

export const docsKey = (serverKey: string, id: number) => `${serverKey}:${id}`

const byteLength = (text: string) => new TextEncoder().encode(text).length

function connection(serverKey: string) {
  const c = connectionFor(serverKey)
  if (!c) throw new Error('Not connected')
  return c
}

export async function loadPages(serverKey: string, channelId: number): Promise<void> {
  const key = docsKey(serverKey, channelId)
  useDocs.setState((s) => ({ lists: { ...s.lists, [key]: { pages: s.lists[key]?.pages ?? [], loading: true, error: null } } }))
  try {
    const { pages } = await connection(serverKey).request('docs.pages', { channelId })
    useDocs.setState((s) => ({ lists: { ...s.lists, [key]: { pages, loading: false, error: null } } }))
  } catch (e) {
    useDocs.setState((s) => ({ lists: { ...s.lists, [key]: { pages: s.lists[key]?.pages ?? [], loading: false, error: errorMessage(e) } } }))
  }
}

/** The page with its text: from the cache when it's current, else from the server. */
export async function loadPage(serverKey: string, pageId: number, force = false): Promise<DocPage> {
  const key = docsKey(serverKey, pageId)
  const cached = useDocs.getState().texts[key]
  const listed = Object.values(useDocs.getState().lists).flatMap((l) => l.pages).find((p) => p.id === pageId && p.channelId === cached?.channelId)
  if (cached && !force && (!listed || listed.version === cached.version)) return cached
  const { page } = await connection(serverKey).request('docs.page.get', { id: pageId })
  remember(serverKey, page)
  return page
}

function remember(serverKey: string, page: DocPage): void {
  useDocs.setState((s) => {
    const listKey = docsKey(serverKey, page.channelId)
    const list = s.lists[listKey]
    const { text: _text, ...summary } = page
    return {
      texts: page.text === undefined ? s.texts : { ...s.texts, [docsKey(serverKey, page.id)]: page },
      lists: list ? { ...s.lists, [listKey]: { ...list, pages: upsertPage(list.pages, summary) } } : s.lists,
    }
  })
}

export function openPage(serverKey: string, channelId: number, pageId: number | null): void {
  useDocs.setState((s) => ({ open: { ...s.open, [docsKey(serverKey, channelId)]: pageId } }))
}

/** A page link (or the "Start here" entry): go to its channel and open it. */
export function goToPage(serverKey: string, channelId: number, pageId: number): void {
  openPage(serverKey, channelId, pageId)
  selectChannel(serverKey, channelId)
}

// ── Editing ─────────────────────────────────────────────────────────────────

export function startEditing(serverKey: string, page: DocPage): void {
  const key = docsKey(serverKey, page.channelId)
  const existing = useDocs.getState().drafts[key]
  if (existing?.pageId === page.id) return
  setDraft(serverKey, page.channelId, {
    pageId: page.id, channelId: page.channelId, parentId: page.parentId, title: page.title, text: page.text ?? '',
    baseVersion: page.version, baseTitle: page.title, baseText: page.text ?? '', note: null,
  })
}

export function startNewPage(serverKey: string, channelId: number, parentId: number | null, title = ''): void {
  setDraft(serverKey, channelId, { pageId: null, channelId, parentId, title, text: '', baseVersion: 0, baseTitle: '', baseText: '', note: null })
}

export function setDraft(serverKey: string, channelId: number, draft: DocDraft | null): void {
  const key = docsKey(serverKey, channelId)
  useDocs.setState((s) => {
    const drafts = { ...s.drafts }
    if (draft) drafts[key] = draft
    else delete drafts[key]
    return { drafts }
  })
}

export function updateDraft(serverKey: string, channelId: number, patch: Partial<DocDraft>): void {
  const key = docsKey(serverKey, channelId)
  const draft = useDocs.getState().drafts[key]
  if (draft) setDraft(serverKey, channelId, { ...draft, ...patch })
}

/** `text` or, when it's big, an upload of it (the server reads the file). */
async function textField(serverKey: string, text: string): Promise<{ text: string } | { file: string }> {
  if (byteLength(text) <= INLINE_TEXT_BYTES) return { text }
  const file = await uploadFile(serverKey, new File([text], 'page.md', { type: 'text/markdown' }), () => undefined)
  return { file: file.id }
}

/** Saves a draft (creating the page if it's new). A stale draft rejects with code "conflict". */
export async function saveDraft(serverKey: string, draft: DocDraft): Promise<DocPage> {
  const c = connection(serverKey)
  const body = await textField(serverKey, draft.text)
  const { page } = draft.pageId === null
    ? await c.request('docs.page.create', { channelId: draft.channelId, title: draft.title, parentId: draft.parentId, ...body })
    : await c.request('docs.page.save', { id: draft.pageId, baseVersion: draft.baseVersion, title: draft.title, ...body })
  remember(serverKey, page)
  setDraft(serverKey, draft.channelId, null)
  openPage(serverKey, page.channelId, page.id)
  return page
}

export async function movePage(serverKey: string, pageId: number, parentId: number | null, before: number | null): Promise<void> {
  const { page } = await connection(serverKey).request('docs.page.move', { id: pageId, parentId, before })
  remember(serverKey, page)
}

export async function deletePage(serverKey: string, pageId: number): Promise<void> {
  await connection(serverKey).request('docs.page.delete', { id: pageId })
}

export async function pageHistory(serverKey: string, pageId: number): Promise<DocRevision[]> {
  return (await connection(serverKey).request('docs.page.history', { id: pageId })).revisions
}

export async function getRevision(serverKey: string, pageId: number, version: number): Promise<DocRevision> {
  const { revision } = await connection(serverKey).request('docs.page.get', { id: pageId, version })
  if (!revision) throw new Error('Missing revision')
  return revision
}

export async function restoreRevision(serverKey: string, page: DocPage, version: number): Promise<DocPage> {
  const { page: restored } = await connection(serverKey).request('docs.page.restore', { id: page.id, version, baseVersion: page.version })
  remember(serverKey, restored)
  return restored
}

export async function setHome(serverKey: string, pageId: number | null): Promise<void> {
  const { home } = await connection(serverKey).request('docs.home.set', { pageId })
  useDocs.setState((s) => ({ home: { ...s.home, [serverKey]: home } }))
}

export async function searchDocs(serverKey: string, query: string, channelId?: number): Promise<DocSearchResult[]> {
  return (await connection(serverKey).request('docs.search', { query, channelId, limit: 10 })).results
}

// ── Live updates ────────────────────────────────────────────────────────────

onServerEvent((serverKey, type, body) => {
  if (type === 'docs.page.updated') {
    const { page } = body as { page: DocPage }
    useDocs.setState((s) => {
      const key = docsKey(serverKey, page.channelId)
      const list = s.lists[key]
      const textKey = docsKey(serverKey, page.id)
      const cached = s.texts[textKey]
      const texts = cached && cached.version !== page.version ? { ...s.texts } : s.texts
      if (texts !== s.texts) delete texts[textKey] // the reader fetches the new text
      return { texts, lists: list ? { ...s.lists, [key]: { ...list, pages: upsertPage(list.pages, page) } } : s.lists }
    })
  } else if (type === 'docs.page.deleted') {
    const { channelId, ids } = body as { channelId: number; ids: number[] }
    useDocs.setState((s) => {
      const key = docsKey(serverKey, channelId)
      const list = s.lists[key]
      const open = s.open[key]
      return {
        lists: list ? { ...s.lists, [key]: { ...list, pages: list.pages.filter((p) => !ids.includes(p.id)) } } : s.lists,
        open: open !== undefined && open !== null && ids.includes(open) ? { ...s.open, [key]: null } : s.open,
      }
    })
  } else if (type === 'docs.home') {
    const { home } = body as { home: DocHome | null }
    useDocs.setState((s) => ({ home: { ...s.home, [serverKey]: home } }))
  }
})

onWelcomeHook((serverKey) => {
  // What we had may be stale after a reconnect: lists reload when shown.
  useDocs.setState((s) => ({
    lists: Object.fromEntries(Object.entries(s.lists).filter(([k]) => !k.startsWith(`${serverKey}:`))),
    texts: Object.fromEntries(Object.entries(s.texts).filter(([k]) => !k.startsWith(`${serverKey}:`))),
  }))
  connectionFor(serverKey)?.request('docs.home.get', {})
    .then(({ home }) => useDocs.setState((s) => ({ home: { ...s.home, [serverKey]: home } })))
    .catch(() => undefined) // an older server without docs
})
