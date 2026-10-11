// A forum channel: its posts as cards (sort, tag filter, search), a "New post" button; posts open in the thread panel.
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatDate } from '../../i18n/format'
import { roleRank, type Channel, type ForumPost, type ForumTag } from '../../core/protocol'
import type { ServerState } from '../../state/store'
import { DEFAULT_VIEW, forumKey, loadPosts, openPost, seenFor, useForums, type ForumView as View } from '../../state/forums'
import { unreadOf, visiblePosts } from '../../state/forumLogic'
import { openThread, useThreads } from '../../state/threads'
import { useJump } from '../../state/jump'
import { Avatar, Spinner } from '../bits'
import { Lock, Menu, Plus, Users } from '../icons'
import { plainText } from '../markdown'
import { relativeTime } from '../chat/pinThreadHelpers'
import { PinIcon, SearchIcon } from '../chat/extraIcons'
import type { Panel } from '../Shell'
import { CheckCircle, ForumIcon, ReplyCount, TagIcon } from './icons'
import { NewPostDialog, TagsDialog } from './ForumDialogs'
import './forums.css'

const NO_TAGS: ForumTag[] = []

export function ForumView({ server, channel, onToggle }: { server: ServerState; channel: Channel; onToggle: (panel: Panel) => void }) {
  const { t } = useTranslation()
  const key = forumKey(server.key, channel.id)
  const list = useForums((s) => s.lists[key])
  const tags = useForums((s) => s.tags[key]) ?? NO_TAGS
  const seen = useForums((s) => s.seen[key])
  const openId = useThreads((s) => (s.open?.key === server.key ? s.open.id : null))
  const [view, setView] = useState<View>(DEFAULT_VIEW)
  const [search, setSearch] = useState('')
  const [dialog, setDialog] = useState<'post' | 'tags' | null>(null)
  const online = server.status.state === 'online'
  const me = server.me
  const canPost = !!me && roleRank(me.role) >= roleRank(channel.writeRole)
  const isAdmin = !!me && roleRank(me.role) >= roleRank('admin')

  useEffect(() => {
    seenFor(server.key, channel.id)
  }, [server.key, channel.id])

  // Typing in the search box waits a moment before asking the server.
  useEffect(() => {
    const timer = setTimeout(() => setView((v) => (v.query === search ? v : { ...v, query: search })), 300)
    return () => clearTimeout(timer)
  }, [search])

  useEffect(() => {
    if (online) void loadPosts(server.key, channel.id, view)
  }, [server.key, channel.id, view, online])

  // Jumping to a post's first message (a mention, a search result) opens that post.
  const target = useJump((s) => s.target)
  const loaded = server.messages[channel.id]
  useEffect(() => {
    if (!target || target.key !== server.key || target.channelId !== channel.id) return
    const root = loaded?.find((m) => m.id === target.messageId)
    if (!root) return
    useJump.setState({ target: null })
    if (root.thread) openThread(server.key, root.thread.id, root.thread)
  }, [target, loaded, server.key, channel.id])

  const posts = useMemo(() => visiblePosts(list?.posts ?? [], view.sort, view.tag), [list?.posts, view.sort, view.tag])
  const tagById = useMemo(() => new Map(tags.map((t) => [t.id, t])), [tags])
  const filtering = view.tag !== null || view.query.trim() !== ''

  return (
    <div className="chat forum">
      <header className="chat-header">
        <button className="icon-button mobile-only" onClick={() => onToggle('nav')} aria-label={t('forums.view.openChannels')}>
          <Menu />
        </button>
        <h1>
          <span className="hash"><ForumIcon size={20} /></span>
          {channel.name}
        </h1>
        <span className="spacer" />
        {isAdmin && (
          <button className="icon-button" onClick={() => setDialog('tags')} aria-label={t('forums.view.editTags')} title={t('forums.view.editTags')}>
            <TagIcon />
          </button>
        )}
        <button className="icon-button members-toggle" onClick={() => onToggle('members')} aria-label={t('forums.view.members')} title={t('forums.view.members')}>
          <Users />
        </button>
      </header>

      <div className="forum-toolbar">
        <label className="forum-search">
          <SearchIcon size={15} />
          <input
            type="search"
            placeholder={t('forums.view.search', { forum: channel.name })}
            aria-label={t('forums.view.searchLabel')}
            value={search}
            maxLength={200}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && search) {
                e.preventDefault()
                setSearch('')
              }
            }}
          />
        </label>
        <select className="forum-sort" aria-label={t('forums.view.sort')} value={view.sort} onChange={(e) => setView((v) => ({ ...v, sort: e.target.value as View['sort'] }))}>
          <option value="activity">{t('forums.view.activity')}</option>
          <option value="newest">{t('forums.view.newest')}</option>
        </select>
        {canPost && (
          <button className="button primary forum-new" onClick={() => setDialog('post')}>
            <Plus size={16} /> {t('forums.view.newPost')}
          </button>
        )}
      </div>

      {tags.length > 0 && (
        <div className="forum-tags" role="group" aria-label={t('forums.view.filter')}>
          <button className={`tag-chip ${view.tag === null ? 'on' : ''}`} aria-pressed={view.tag === null} onClick={() => setView((v) => ({ ...v, tag: null }))}>
            {t('forums.view.all')}
          </button>
          {tags.map((tag) => (
            <button
              key={tag.id}
              className={`tag-chip ${view.tag === tag.id ? 'on' : ''}`}
              aria-pressed={view.tag === tag.id}
              onClick={() => setView((v) => ({ ...v, tag: v.tag === tag.id ? null : tag.id }))}
            >
              {tag.emoji && <span aria-hidden>{tag.emoji}</span>}
              {tag.name}
            </button>
          ))}
        </div>
      )}

      <div className="forum-posts">
        {list?.error && <div className="banner error"><span>{list.error}</span></div>}
        {!list || (list.loading && list.posts.length === 0) ? (
          <div className="forum-empty"><Spinner /></div>
        ) : posts.length === 0 ? (
          <div className="forum-empty">
            <span className="empty-icon"><ForumIcon size={30} /></span>
            {filtering ? (
              <>
                <h2>{t('forums.view.noMatch')}</h2>
                <p className="muted">{t('forums.view.noMatchHint')}</p>
              </>
            ) : (
              <>
                <h2>{t('forums.view.empty')}</h2>
                <p className="muted">{canPost ? t('forums.view.emptyCreate') : t('forums.view.emptyView')}</p>
                {canPost && <button className="button primary" onClick={() => setDialog('post')}><Plus size={16} /> {t('forums.view.newPost')}</button>}
              </>
            )}
          </div>
        ) : (
          <ul className="post-list">
            {posts.map((post) => (
              <li key={post.id}>
                <PostCard server={server} post={post} tagById={tagById} active={post.id === openId} unread={unreadOf(post, seen, me?.accountKey)} />
              </li>
            ))}
          </ul>
        )}
        {list?.hasMore && (
          <button className="button load-more wide" disabled={list.loading} onClick={() => void loadPosts(server.key, channel.id, view, true)}>
            {list.loading ? t('common.loading') : t('forums.view.more')}
          </button>
        )}
      </div>

      {dialog === 'post' && <NewPostDialog server={server} forum={channel} tags={tags} onClose={() => setDialog(null)} />}
      {dialog === 'tags' && <TagsDialog server={server} forum={channel} tags={tags} onClose={() => setDialog(null)} />}
    </div>
  )
}

function PostCard({ server, post, tagById, active, unread }: {
  server: ServerState
  post: ForumPost
  tagById: Map<number, ForumTag>
  active: boolean
  unread: ReturnType<typeof unreadOf>
}) {
  const { t } = useTranslation()
  const author = server.members[post.author]
  const name = author?.name ?? t('forums.card.formerMember')
  const excerpt = post.excerpt ? plainText(post.excerpt, { nameOf: (k) => server.members[k]?.name ?? null }) : ''
  const label = [post.title, post.pinned && t('forums.card.pinnedFlag'), post.locked ? t('forums.card.lockedFlag') : post.closed && t('forums.card.closedFlag'),
    unread?.kind === 'new' ? t('forums.card.newFlag') : unread ? t('forums.card.newReplies', { count: unread.count }) : null].filter(Boolean).join(', ')
  return (
    <button className={`post-card ${active ? 'active' : ''} ${unread ? 'unread' : ''}`} onClick={() => openPost(server.key, post)} aria-label={label}>
      <div className="post-main">
        <div className="post-title-row">
          {post.pinned && <span className="post-flag pinned" title={t('forums.card.pinned')}><PinIcon size={14} /></span>}
          <span className="post-title">{post.title}</span>
          {post.locked ? (
            <span className="post-state" title={t('forums.card.lockedTitle')}><Lock size={12} /> {t('forums.card.locked')}</span>
          ) : post.closed ? (
            <span className="post-state closed" title={t('forums.card.closed')}><CheckCircle size={12} /> {t('forums.card.closed')}</span>
          ) : null}
          {unread && <span className="post-unread">{unread.kind === 'new' ? t('forums.card.new') : t('forums.card.newCount', { count: unread.count })}</span>}
        </div>
        {post.tags.length > 0 && (
          <div className="post-tags">
            {post.tags.map((id) => tagById.get(id)).filter((t): t is ForumTag => !!t).map((t) => (
              <span key={t.id} className="tag-chip small">{t.emoji && <span aria-hidden>{t.emoji}</span>}{t.name}</span>
            ))}
          </div>
        )}
        {excerpt ? <span className="post-excerpt">{excerpt}</span> : post.attachmentCount > 0 ? <span className="post-excerpt muted">{t('forums.card.attachment')}</span> : null}
        <div className="post-meta">
          <Avatar name={name} accountKey={post.author} size={18} />
          <span className="post-author">{name}</span>
          <span aria-hidden>·</span>
          <time title={formatDate(post.createdAt, { dateStyle: 'medium', timeStyle: 'short' })}>{relativeTime(post.createdAt)}</time>
          <span className="post-replies" title={t('forums.card.replies', { count: post.replyCount })}>
            <ReplyCount size={14} /> {post.replyCount}
          </span>
          {post.lastMessageAt && <span className="post-last">{t('forums.card.lastReply', { when: relativeTime(post.lastMessageAt) })}</span>}
        </div>
      </div>
      {post.image && (
        <img
          className="post-thumb"
          src={server.url + post.image.url}
          alt=""
          loading="lazy"
          width={post.image.width ?? undefined}
          height={post.image.height ?? undefined}
          draggable={false}
        />
      )}
    </button>
  )
}
