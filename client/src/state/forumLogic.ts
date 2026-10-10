// Pure helpers for forum post lists: ordering, filtering and unread markers. No React, no store.
import type { ForumPost, ForumSort } from '../core/protocol'

/** Same order as the server: pinned first (latest pin first), then by activity or creation, newest first. */
export function sortPosts(posts: ForumPost[], sort: ForumSort): ForumPost[] {
  const key = (p: ForumPost) => (sort === 'newest' ? p.createdAt : p.lastActivity)
  return [...posts].sort((a, b) => Number(b.pinned) - Number(a.pinned) || key(b) - key(a) || b.id - a.id)
}

/** Posts for the current view. A live update can bring in a post that doesn't fit the tag filter. */
export function visiblePosts(posts: ForumPost[], sort: ForumSort, tag: number | null): ForumPost[] {
  return sortPosts(tag === null ? posts : posts.filter((p) => p.tags.includes(tag)), sort)
}

/** Replaces or adds a post, keeping the list free of duplicates. */
export function upsertPost(posts: ForumPost[], post: ForumPost): ForumPost[] {
  const index = posts.findIndex((p) => p.id === post.id)
  if (index < 0) return [...posts, post]
  return posts.map((p, i) => (i === index ? post : p))
}

/**
 * What you've seen of a forum, per device: when you first opened it (older posts count as read) and, per post you
 * opened, how many replies it had then.
 */
export interface ForumSeen {
  since: number
  posts: Record<number, number>
}

export type Unread = { kind: 'new' } | { kind: 'replies'; count: number } | null

/** "New" for a post you've never opened that appeared (or got replies) after your first visit; else new replies, if any. */
export function unreadOf(post: ForumPost, seen: ForumSeen | undefined, me: string | undefined): Unread {
  if (!seen) return null
  const opened = seen.posts[post.id]
  if (opened === undefined) {
    if (post.author === me && post.replyCount === 0) return null
    return post.lastActivity > seen.since && post.lastAuthor !== me ? { kind: 'new' } : null
  }
  const count = post.replyCount - opened
  return count > 0 && post.lastAuthor !== me ? { kind: 'replies', count } : null
}

/** Forgets the oldest remembered posts so the record stays small. */
export function trimSeen(seen: ForumSeen, max = 2000): ForumSeen {
  const ids = Object.keys(seen.posts).map(Number)
  if (ids.length <= max) return seen
  const keep = ids.sort((a, b) => b - a).slice(0, max)
  return { since: seen.since, posts: Object.fromEntries(keep.map((id) => [id, seen.posts[id]])) }
}
