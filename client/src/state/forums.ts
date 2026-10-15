// Forum channels: the post list per forum, its tags, live updates, and which posts you've seen (per device).
// A post is a thread (state/threads.ts), so opening one shows it in the thread panel.
import { create } from 'zustand'
import { roleRank, type Events, type ForumPost, type ForumSort, type ForumTag, type Thread } from '../core/protocol'
import { connectionFor, onChannelsGone, onServerEvent, type ServerState } from './store'
import { withoutChannels } from './channelGone'
import { openThread, rememberThreads } from './threads'
import { trimSeen, upsertPost, type ForumSeen } from './forumLogic'
import { t } from '../i18n'
import { errorMessage } from '../i18n/errors'
import { baseRolesFor } from './baseRoles'
import { baseAllows, canSendIn, has } from './permissions'
import { rolesFor } from './roles'

export interface ForumView {
  sort: ForumSort
  tag: number | null
  query: string
}

interface ForumList {
  posts: ForumPost[]
  hasMore: boolean
  cursor: string | null
  loading: boolean
  error: string | null
  /** The view the list was loaded for. */
  view: ForumView
}

interface ForumsState {
  /** `${serverKey}:${forumId}` → the loaded list. */
  lists: Record<string, ForumList>
  /** `${serverKey}:${forumId}` → the forum's tags. */
  tags: Record<string, ForumTag[]>
  /** serverKey → post id → post, for posts open in the thread panel. */
  posts: Record<string, Record<number, ForumPost>>
  /** `${serverKey}:${forumId}` → what you've seen there. */
  seen: Record<string, ForumSeen>
}

export const useForums = create<ForumsState>(() => ({ lists: {}, tags: {}, posts: {}, seen: {} }))

export const forumKey = (serverKey: string, forumId: number) => `${serverKey}:${forumId}`
export const DEFAULT_VIEW: ForumView = { sort: 'activity', tag: null, query: '' }

// ── Seen markers (localStorage, per device) ─────────────────────────────────

const seenStorageKey = (key: string) => `iskra.forumSeen.${key}`

function loadSeen(key: string): ForumSeen | undefined {
  try {
    const raw = localStorage.getItem(seenStorageKey(key))
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as ForumSeen
    return typeof parsed.since === 'number' && parsed.posts && typeof parsed.posts === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

function saveSeen(key: string, seen: ForumSeen): void {
  try {
    localStorage.setItem(seenStorageKey(key), JSON.stringify(seen))
  } catch {
    /* private mode or full: markers just reset */
  }
}

/** What you've seen in a forum; the first visit starts the record (everything older counts as read). */
export function seenFor(serverKey: string, forumId: number): ForumSeen {
  const key = forumKey(serverKey, forumId)
  const known = useForums.getState().seen[key] ?? loadSeen(key)
  const seen = known ?? { since: Date.now(), posts: {} }
  if (!useForums.getState().seen[key]) {
    useForums.setState((s) => ({ seen: { ...s.seen, [key]: seen } }))
    if (!known) saveSeen(key, seen)
  }
  return seen
}

/** Opening a post (or reading new replies in it) marks its replies as seen. */
export function markPostSeen(serverKey: string, post: Pick<ForumPost, 'id' | 'channelId' | 'replyCount'>): void {
  const key = forumKey(serverKey, post.channelId)
  const seen = seenFor(serverKey, post.channelId)
  if (seen.posts[post.id] === post.replyCount) return
  const next = trimSeen({ since: seen.since, posts: { ...seen.posts, [post.id]: post.replyCount } })
  useForums.setState((s) => ({ seen: { ...s.seen, [key]: next } }))
  saveSeen(key, next)
}

/** Marking a forum read: every post and reply so far counts as seen. */
export function resetForumSeen(serverKey: string, forumId: number): void {
  const key = forumKey(serverKey, forumId)
  const next: ForumSeen = { since: Date.now(), posts: {} }
  useForums.setState((s) => ({ seen: { ...s.seen, [key]: next } }))
  saveSeen(key, next)
}

// ── Permissions (mirrors the server) ────────────────────────────────────────

/** Trusted+ who can write in the forum: pin, lock, close any post, retag. Mirrors Permissions.CanModerateForum. */
export function canModerateForum(server: ServerState, forumId: number): boolean {
  const me = server.me
  const forum = server.channels.find((c) => c.id === forumId)
  const base = baseRolesFor(server.key)
  const roles = rolesFor(server.key)
  return !!me && !!forum && (baseAllows(base, me, 'pin') || has(me, roles, 'manageMessages', base)) && canSendIn(me, forum, roles)
}

/** Whoever posted it, or an admin who outranks them: rename, delete. */
export function canManagePost(server: ServerState, post: ForumPost): boolean {
  const me = server.me
  if (!me) return false
  if (post.author === me.accountKey) return true
  const author = server.members[post.author]
  return roleRank(me.role) >= roleRank('admin') && (!author || roleRank(me.role) > roleRank(author.role))
}

/** Why you can't reply in this post, or null if you can. */
export function replyBlock(server: ServerState, post: ForumPost | undefined): string | null {
  if (!post || (!post.closed && !post.locked) || canModerateForum(server, post.channelId)) return null
  return post.locked ? t('forums.replyBlock.locked') : t('forums.replyBlock.closed')
}

// ── Loading ─────────────────────────────────────────────────────────────────

function rememberPosts(serverKey: string, posts: ForumPost[]): void {
  if (posts.length === 0) return
  useForums.setState((s) => ({ posts: { ...s.posts, [serverKey]: { ...s.posts[serverKey], ...Object.fromEntries(posts.map((p) => [p.id, p])) } } }))
}

const asThread = (p: ForumPost): Thread => ({
  id: p.id, channelId: p.channelId, rootId: p.rootId, name: p.title, createdBy: p.author, createdAt: p.createdAt,
  messageCount: p.replyCount, lastMessageAt: p.lastMessageAt,
})

let generation = 0

/** Loads the first page for a view (replacing the list), or the next page with `more`. */
export async function loadPosts(serverKey: string, forumId: number, view: ForumView, more = false): Promise<void> {
  const connection = connectionFor(serverKey)
  const key = forumKey(serverKey, forumId)
  const current = useForums.getState().lists[key]
  if (!connection?.isOnline) return
  if (more && (!current?.hasMore || current.loading)) return
  const run = ++generation
  useForums.setState((s) => ({
    lists: { ...s.lists, [key]: { ...(more && current ? current : { posts: [], hasMore: false, cursor: null }), loading: true, error: null, view } },
  }))
  try {
    const query = view.query.trim()
    const result = await connection.request('forum.posts', {
      channelId: forumId, sort: view.sort, tag: view.tag ?? undefined, query: query || undefined,
      cursor: more ? current?.cursor ?? undefined : undefined,
    })
    if (run !== generation && !more) return
    rememberPosts(serverKey, result.posts)
    rememberThreads(serverKey, result.posts.map(asThread))
    useForums.setState((s) => {
      const base = more ? s.lists[key]?.posts ?? [] : []
      return {
        tags: { ...s.tags, [key]: result.tags },
        lists: {
          ...s.lists,
          [key]: { posts: result.posts.reduce(upsertPost, base), hasMore: result.hasMore, cursor: result.cursor, loading: false, error: null, view },
        },
      }
    })
  } catch (e) {
    useForums.setState((s) => ({ lists: { ...s.lists, [key]: { ...(s.lists[key] ?? { posts: [], hasMore: false, cursor: null, view }), loading: false, error: errorMessage(e) } } }))
  }
}

/** A post by id (e.g. opened from a link or notification). */
export async function fetchPost(serverKey: string, id: number): Promise<ForumPost | null> {
  try {
    const { post } = await connectionFor(serverKey)!.request('forum.post.get', { id })
    rememberPosts(serverKey, [post])
    return post
  } catch {
    return null
  }
}

export function openPost(serverKey: string, post: ForumPost): void {
  rememberPosts(serverKey, [post])
  markPostSeen(serverKey, post)
  openThread(serverKey, post.id, asThread(post))
}

// ── Actions ─────────────────────────────────────────────────────────────────

export async function createPost(serverKey: string, forumId: number, title: string, text: string, tags: number[], attachments: string[]): Promise<ForumPost> {
  const { post } = await connectionFor(serverKey)!.request('forum.post.create', { channelId: forumId, title, text, tags, attachments })
  applyPost(serverKey, post)
  markPostSeen(serverKey, post)
  return post
}

export async function updatePost(serverKey: string, id: number, patch: { title?: string; tags?: number[] }): Promise<void> {
  const { post } = await connectionFor(serverKey)!.request('forum.post.update', { id, ...patch })
  applyPost(serverKey, post)
}

export async function setPostState(serverKey: string, id: number, patch: { pinned?: boolean; closed?: boolean; locked?: boolean }): Promise<void> {
  const { post } = await connectionFor(serverKey)!.request('forum.post.set', { id, ...patch })
  applyPost(serverKey, post)
}

export async function saveTags(serverKey: string, forumId: number, tags: { id?: number; name: string; emoji?: string | null }[]): Promise<void> {
  const result = await connectionFor(serverKey)!.request('forum.tags.set', { channelId: forumId, tags })
  useForums.setState((s) => ({ tags: { ...s.tags, [forumKey(serverKey, forumId)]: result.tags } }))
}

// ── Live updates ────────────────────────────────────────────────────────────

/** A post changed: update it wherever it's shown. New posts join the list unless a search is active. */
function applyPost(serverKey: string, post: ForumPost): void {
  rememberPosts(serverKey, [post])
  rememberThreads(serverKey, [asThread(post)])
  const key = forumKey(serverKey, post.channelId)
  useForums.setState((s) => {
    const list = s.lists[key]
    if (!list) return {}
    const known = list.posts.some((p) => p.id === post.id)
    if (!known && list.view.query.trim()) return {}
    return { lists: { ...s.lists, [key]: { ...list, posts: upsertPost(list.posts, post) } } }
  })
}

function patchPost(serverKey: string, id: number, patch: (p: ForumPost) => ForumPost): void {
  const known = useForums.getState().posts[serverKey]?.[id]
  if (!known) return
  const next = patch(known)
  applyPost(serverKey, next)
}

function removePost(serverKey: string, id: number, forumId: number): void {
  const key = forumKey(serverKey, forumId)
  useForums.setState((s) => {
    const posts = { ...s.posts[serverKey] }
    delete posts[id]
    const list = s.lists[key]
    return {
      posts: { ...s.posts, [serverKey]: posts },
      lists: list ? { ...s.lists, [key]: { ...list, posts: list.posts.filter((p) => p.id !== id) } } : s.lists,
    }
  })
}

onServerEvent((serverKey, type, body) => {
  if (type === 'forum.post.updated') {
    applyPost(serverKey, (body as Events['forum.post.updated']).post)
  } else if (type === 'forum.tags') {
    const { channelId, tags } = body as Events['forum.tags']
    useForums.setState((s) => ({ tags: { ...s.tags, [forumKey(serverKey, channelId)]: tags } }))
  } else if (type === 'thread.updated') {
    // Replies change a post's counts and activity; renames its title.
    const { thread } = body as Events['thread.updated']
    patchPost(serverKey, thread.id, (p) => ({
      ...p, title: thread.name, replyCount: thread.messageCount, lastMessageAt: thread.lastMessageAt,
      lastActivity: thread.lastMessageAt ?? thread.createdAt,
    }))
  } else if (type === 'chat.message') {
    const { message } = body as Events['chat.message']
    patchPost(serverKey, message.channelId, (p) => ({ ...p, lastAuthor: message.author }))
  } else if (type === 'thread.deleted') {
    const { id, channelId } = body as Events['thread.deleted']
    removePost(serverKey, id, channelId)
  } else if (type === 'channels') {
    // A forum that was deleted or hidden: drop what we had for it.
    const { channels } = body as Events['channels']
    useForums.setState((s) => {
      const lists = Object.fromEntries(Object.entries(s.lists).filter(([k]) => !k.startsWith(`${serverKey}:`) || channels.some((c) => forumKey(serverKey, c.id) === k)))
      return Object.keys(lists).length === Object.keys(s.lists).length ? {} : { lists }
    })
  }
})

// A forum that's gone: its posts, tags and what you'd seen there go.
onChannelsGone((serverKey, channelIds) => {
  useForums.setState((s) => ({
    lists: withoutChannels(s.lists, serverKey, channelIds), tags: withoutChannels(s.tags, serverKey, channelIds),
    posts: withoutChannels(s.posts, serverKey, channelIds), seen: withoutChannels(s.seen, serverKey, channelIds),
  }))
  for (const id of channelIds) {
    try {
      localStorage.removeItem(seenStorageKey(forumKey(serverKey, id)))
    } catch {
      /* private mode */
    }
  }
})
