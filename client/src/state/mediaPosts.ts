// Media channels: the first message of each post opened in the viewer (its caption and reactions, which drive "Most
// reactions"), kept live from chat.reactions and chat.edited. The post lists themselves are the forum lists (forums.ts).
import { create } from 'zustand'
import type { Events, ForumPost, Message } from '../core/protocol'
import { connectionFor, onChannelsGone, onServerEvent } from './store'
import { useForums } from './forums'

interface MediaPostsState {
  /** `${serverKey}:${postId}` → the post's first message (null: deleted). */
  roots: Record<string, Message | null>
}

export const useMediaPosts = create<MediaPostsState>(() => ({ roots: {} }))

export const rootKey = (serverKey: string, postId: number) => `${serverKey}:${postId}`

/** Reactions counted the way the server does: one per person per emoji. */
export const reactionTotal = (message: Pick<Message, 'reactions'>) => message.reactions.reduce((n, r) => n + r.accounts.length, 0)

/** Fetches a post and its first message (and keeps the post in the forum store). */
export async function loadMediaPost(serverKey: string, postId: number): Promise<void> {
  const connection = connectionFor(serverKey)
  if (!connection?.isOnline) return
  try {
    const { post, root } = await connection.request('forum.post.get', { id: postId })
    useForums.setState((s) => ({ posts: { ...s.posts, [serverKey]: { ...s.posts[serverKey], [post.id]: post } } }))
    useMediaPosts.setState((s) => ({ roots: { ...s.roots, [rootKey(serverKey, postId)]: root } }))
  } catch {
    /* gone or not readable: the viewer says so */
  }
}

/** Puts a new reaction count on a post wherever the forum store shows it. */
function patchCount(serverKey: string, rootId: number, count: number): void {
  const patch = (p: ForumPost) => (p.rootId === rootId && p.reactionCount !== count ? { ...p, reactionCount: count } : p)
  useForums.setState((s) => {
    const mine = s.posts[serverKey]
    const known = mine && Object.values(mine).some((p) => p.rootId === rootId)
    const listed = Object.entries(s.lists).filter(([k, l]) => k.startsWith(`${serverKey}:`) && l.posts.some((p) => p.rootId === rootId))
    if (!known && listed.length === 0) return {}
    const posts = known ? { ...s.posts, [serverKey]: Object.fromEntries(Object.entries(mine).map(([id, p]) => [id, patch(p)])) } : s.posts
    return { posts, lists: { ...s.lists, ...Object.fromEntries(listed.map(([k, l]) => [k, { ...l, posts: l.posts.map(patch) }])) } }
  })
}

function patchRoot(serverKey: string, id: number, change: (m: Message) => Message): void {
  useMediaPosts.setState((s) => {
    const entry = Object.entries(s.roots).find(([k, m]) => k.startsWith(`${serverKey}:`) && m?.id === id)
    return entry ? { roots: { ...s.roots, [entry[0]]: change(entry[1]!) } } : {}
  })
}

onServerEvent((serverKey, type, body) => {
  if (type === 'chat.reactions') {
    const { id, reactions } = body as Events['chat.reactions']
    patchRoot(serverKey, id, (m) => ({ ...m, reactions }))
    patchCount(serverKey, id, reactions.reduce((n, r) => n + r.accounts.length, 0))
  } else if (type === 'chat.edited') {
    const { message } = body as Events['chat.edited']
    patchRoot(serverKey, message.id, () => message)
  } else if (type === 'thread.deleted') {
    const { id } = body as Events['thread.deleted']
    useMediaPosts.setState((s) => (rootKey(serverKey, id) in s.roots ? { roots: { ...s.roots, [rootKey(serverKey, id)]: null } } : {}))
  }
})

// Posts in a channel that's gone go with it (roots are keyed by post, so drop this server's whole set; they reload).
onChannelsGone((serverKey) => {
  useMediaPosts.setState((s) => ({ roots: Object.fromEntries(Object.entries(s.roots).filter(([k]) => !k.startsWith(`${serverKey}:`))) }))
})
