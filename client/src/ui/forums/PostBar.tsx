// Inside the thread panel when the thread is a forum post: its tags and state, and the pin/close/lock/retag actions.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../../i18n/errors'
import type { ForumPost, ForumTag } from '../../core/protocol'
import type { ServerState } from '../../state/store'
import { canManagePost, canModerateForum, forumKey, markPostSeen, setPostState, updatePost, useForums } from '../../state/forums'
import { Lock } from '../icons'
import { PinIcon } from '../chat/extraIcons'
import { CheckCircle, TagIcon } from './icons'
import { MAX_POST_TAGS } from './ForumDialogs'
import './forums.css'

export function PostBar({ server, post }: { server: ServerState; post: ForumPost }) {
  const { t } = useTranslation()
  const tags = useForums((s) => s.tags[forumKey(server.key, post.channelId)]) ?? []
  const [editingTags, setEditingTags] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mod = canModerateForum(server, post.channelId)
  const isAuthor = server.me?.accountKey === post.author
  const canClose = mod || (isAuthor && !post.locked)
  const canRetag = mod || canManagePost(server, post)
  const shown = post.tags.map((id) => tags.find((tag) => tag.id === id)).filter((tag): tag is ForumTag => !!tag)

  // Reading it marks its replies as seen.
  useEffect(() => {
    markPostSeen(server.key, post)
  }, [server.key, post])

  async function run(action: () => Promise<void>) {
    setError(null)
    try {
      await action()
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  const toggleTag = (id: number) => {
    const next = post.tags.includes(id) ? post.tags.filter((x) => x !== id) : [...post.tags, id]
    void run(() => updatePost(server.key, post.id, { tags: next }))
  }

  if (shown.length === 0 && !post.closed && !post.locked && !post.pinned && !mod && !canClose && !(canRetag && tags.length > 0)) return null

  return (
    <div className="post-bar">
      <div className="post-bar-row">
        {post.pinned && <span className="post-state pinned"><PinIcon size={12} /> {t('forums.card.pinned')}</span>}
        {post.locked && <span className="post-state"><Lock size={12} /> {t('forums.card.locked')}</span>}
        {post.closed && !post.locked && <span className="post-state closed"><CheckCircle size={12} /> {t('forums.card.closed')}</span>}
        {shown.map((tag) => <span key={tag.id} className="tag-chip small">{tag.emoji && <span aria-hidden>{tag.emoji}</span>}{tag.name}</span>)}
        <span className="spacer" />
        {canRetag && tags.length > 0 && (
          <button className={`button ghost small ${editingTags ? 'on' : ''}`} aria-expanded={editingTags} onClick={() => setEditingTags((v) => !v)}>
            <TagIcon size={14} /> {t('forums.bar.tags')}
          </button>
        )}
        {mod && (
          <button className="button ghost small" onClick={() => void run(() => setPostState(server.key, post.id, { pinned: !post.pinned }))}>
            <PinIcon size={14} /> {post.pinned ? t('forums.bar.unpin') : t('forums.bar.pin')}
          </button>
        )}
        {canClose && (
          <button className="button ghost small" onClick={() => void run(() => setPostState(server.key, post.id, { closed: !post.closed }))}>
            <CheckCircle size={14} /> {post.closed ? t('forums.bar.reopen') : t('forums.bar.close')}
          </button>
        )}
        {mod && (
          <button className="button ghost small" onClick={() => void run(() => setPostState(server.key, post.id, { locked: !post.locked }))}>
            <Lock size={14} /> {post.locked ? t('forums.bar.unlock') : t('forums.bar.lock')}
          </button>
        )}
      </div>
      {editingTags && (
        <div className="forum-tags inline" role="group" aria-label={t('forums.bar.postTags')}>
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
