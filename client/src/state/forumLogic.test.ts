import { describe, expect, it } from 'vitest'
import type { ForumPost } from '../core/protocol'
import { sortPosts, trimSeen, unreadOf, upsertPost, visiblePosts } from './forumLogic'

const post = (id: number, patch: Partial<ForumPost> = {}): ForumPost => ({
  id, channelId: 1, rootId: id * 10, title: `p${id}`, author: 'alice', createdAt: id, replyCount: 0, lastMessageAt: null,
  lastActivity: id, lastAuthor: null, tags: [], pinned: false, closed: false, locked: false, excerpt: null, image: null,
  attachmentCount: 0, ...patch,
})

describe('forum lists', () => {
  it('sorts pinned first, then by activity or newest', () => {
    const posts = [post(1, { lastActivity: 100 }), post(2), post(3, { pinned: true }), post(4)]
    expect(sortPosts(posts, 'activity').map((p) => p.id)).toEqual([3, 1, 4, 2])
    expect(sortPosts(posts, 'newest').map((p) => p.id)).toEqual([3, 4, 2, 1])
  })

  it('filters by tag and replaces posts in place', () => {
    const posts = [post(1, { tags: [7] }), post(2)]
    expect(visiblePosts(posts, 'newest', 7).map((p) => p.id)).toEqual([1])
    expect(visiblePosts(posts, 'newest', null).map((p) => p.id)).toEqual([2, 1])
    const updated = upsertPost(posts, post(2, { title: 'renamed' }))
    expect(updated).toHaveLength(2)
    expect(updated[1].title).toBe('renamed')
    expect(upsertPost(posts, post(3))).toHaveLength(3)
  })
})

describe('unread markers', () => {
  const seen = { since: 50, posts: { 1: 2 } }

  it('marks posts you never opened that are newer than your first visit', () => {
    expect(unreadOf(post(60, { lastActivity: 60, lastAuthor: 'bob' }), seen, 'me')).toEqual({ kind: 'new' })
    expect(unreadOf(post(40, { lastActivity: 40 }), seen, 'me')).toBeNull()
    expect(unreadOf(post(60, { lastActivity: 60, author: 'me' }), seen, 'me')).toBeNull()
    expect(unreadOf(post(60, { lastActivity: 60 }), undefined, 'me')).toBeNull()
  })

  it('counts replies since you last opened a post, but not your own', () => {
    expect(unreadOf(post(1, { replyCount: 5, lastAuthor: 'bob' }), seen, 'me')).toEqual({ kind: 'replies', count: 3 })
    expect(unreadOf(post(1, { replyCount: 2, lastAuthor: 'bob' }), seen, 'me')).toBeNull()
    expect(unreadOf(post(1, { replyCount: 5, lastAuthor: 'me' }), seen, 'me')).toBeNull()
  })

  it('keeps the newest posts when trimming', () => {
    const big = { since: 0, posts: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i, i])) }
    expect(Object.keys(trimSeen(big, 3).posts).map(Number).sort()).toEqual([7, 8, 9])
    expect(trimSeen(seen)).toBe(seen)
  })
})
