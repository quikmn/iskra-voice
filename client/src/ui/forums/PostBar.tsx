// Inside the thread panel when the thread is a forum post: its tags and state, and the pin/close/lock/retag actions.
import { useEffect, useState } from 'react'
import type { ForumPost, ForumTag } from '../../core/protocol'
import type { ServerState } from '../../state/store'
import { canManagePost, canModerateForum, forumKey, markPostSeen, setPostState, updatePost, useForums } from '../../state/forums'
import { Lock } from '../icons'
import { PinIcon } from '../chat/extraIcons'
import { CheckCircle, TagIcon } from './icons'
import { MAX_POST_TAGS } from './ForumDialogs'
import './forums.css'

export function PostBar({ server, post }: { server: ServerState; post: ForumPost }) {
  const tags = useForums((s) => s.tags[forumKey(server.key, post.channelId)]) ?? []
  const [editingTags, setEditingTags] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mod = canModerateForum(server, post.channelId)
  const isAuthor = server.me?.accountKey === post.author
  const canClose = mod || (isAuthor && !post.locked)
  const canRetag = mod || canManagePost(server, post)
  const shown = post.tags.map((id) => tags.find((t) => t.id === id)).filter((t): t is ForumTag => !!t)

  // Reading it marks its replies as seen.
  useEffect(() => {
    markPostSeen(server.key, post)
  }, [server.key, post])

  async function run(action: () => Promise<void>) {
    setError(null)
    try {
      await action()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const toggleTag = (id: number) => {
    const next = post.tags.includes(id) ? post.tags.filter((t) => t !== id) : [...post.tags, id]
    void run(() => updatePost(server.key, post.id, { tags: next }))
  }

  if (shown.length === 0 && !post.closed && !post.locked && !post.pinned && !mod && !canClose && !(canRetag && tags.length > 0)) return null

  return (
    <div className="post-bar">
      <div className="post-bar-row">
        {post.pinned && <span className="post-state pinned"><PinIcon size={12} /> Pinned</span>}
        {post.locked && <span className="post-state"><Lock size={12} /> Locked</span>}
        {post.closed && !post.locked && <span className="post-state closed"><CheckCircle size={12} /> Closed</span>}
        {shown.map((t) => <span key={t.id} className="tag-chip small">{t.emoji && <span aria-hidden>{t.emoji}</span>}{t.name}</span>)}
        <span className="spacer" />
        {canRetag && tags.length > 0 && (
          <button className={`button ghost small ${editingTags ? 'on' : ''}`} aria-expanded={editingTags} onClick={() => setEditingTags((v) => !v)}>
            <TagIcon size={14} /> Tags
          </button>
        )}
        {mod && (
          <button className="button ghost small" onClick={() => void run(() => setPostState(server.key, post.id, { pinned: !post.pinned }))}>
            <PinIcon size={14} /> {post.pinned ? 'Unpin' : 'Pin'}
          </button>
        )}
        {canClose && (
          <button className="button ghost small" onClick={() => void run(() => setPostState(server.key, post.id, { closed: !post.closed }))}>
            <CheckCircle size={14} /> {post.closed ? 'Reopen' : 'Close'}
          </button>
        )}
        {mod && (
          <button className="button ghost small" onClick={() => void run(() => setPostState(server.key, post.id, { locked: !post.locked }))}>
            <Lock size={14} /> {post.locked ? 'Unlock' : 'Lock'}
          </button>
        )}
      </div>
      {editingTags && (
        <div className="forum-tags inline" role="group" aria-label="Post tags">
          {tags.map((tag) => {
            const on = post.tags.includes(tag.id)
            return (
              <button key={tag.id} className={`tag-chip ${on ? 'on' : ''}`} aria-pressed={on} disabled={!on && post.tags.length >= MAX_POST_TAGS} onClick={() => toggleTag(tag.id)}>
                {tag.emoji && <span aria-hidden>{tag.emoji}</span>}
                {tag.name}
              </button>
            )
          })}
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
    </div>
  )
}
