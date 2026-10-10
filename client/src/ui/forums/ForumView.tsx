// A forum channel: its posts as cards (sort, tag filter, search), a "New post" button; posts open in the thread panel.
import { useEffect, useMemo, useState } from 'react'
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

export function ForumView({ server, channel, onToggle }: { server: ServerState; channel: Channel; onToggle: (panel: Panel) => void }) {
  const key = forumKey(server.key, channel.id)
  const list = useForums((s) => s.lists[key])
  const tags = useForums((s) => s.tags[key]) ?? []
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
        <button className="icon-button mobile-only" onClick={() => onToggle('nav')} aria-label="Open channels">
          <Menu />
        </button>
        <h1>
          <span className="hash"><ForumIcon size={20} /></span>
          {channel.name}
        </h1>
        <span className="spacer" />
        {isAdmin && (
          <button className="icon-button" onClick={() => setDialog('tags')} aria-label="Edit tags" title="Edit tags">
            <TagIcon />
          </button>
        )}
        <button className="icon-button members-toggle" onClick={() => onToggle('members')} aria-label="Members" title="Members">
          <Users />
        </button>
      </header>

      <div className="forum-toolbar">
        <label className="forum-search">
          <SearchIcon size={15} />
          <input
            type="search"
            placeholder={`Search ${channel.name}`}
            aria-label="Search posts"
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
        <select className="forum-sort" aria-label="Sort posts" value={view.sort} onChange={(e) => setView((v) => ({ ...v, sort: e.target.value as View['sort'] }))}>
          <option value="activity">Latest activity</option>
          <option value="newest">Newest</option>
        </select>
        {canPost && (
          <button className="button primary forum-new" onClick={() => setDialog('post')}>
            <Plus size={16} /> New post
          </button>
        )}
      </div>

      {tags.length > 0 && (
        <div className="forum-tags" role="group" aria-label="Filter by tag">
          <button className={`tag-chip ${view.tag === null ? 'on' : ''}`} aria-pressed={view.tag === null} onClick={() => setView((v) => ({ ...v, tag: null }))}>
            All
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
                <h2>No posts match</h2>
                <p className="muted">Try another word or tag.</p>
              </>
            ) : (
              <>
                <h2>No posts yet</h2>
                <p className="muted">{canPost ? 'Start the first one: ask a question, share an idea, or plan something.' : 'Posts will show up here.'}</p>
                {canPost && <button className="button primary" onClick={() => setDialog('post')}><Plus size={16} /> New post</button>}
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
            {list.loading ? 'Loading…' : 'Show more posts'}
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
  const author = server.members[post.author]
  const name = author?.name ?? 'Former member'
  const excerpt = post.excerpt ? plainText(post.excerpt, { nameOf: (k) => server.members[k]?.name ?? null }) : ''
  const label = [post.title, post.pinned && 'pinned', post.locked ? 'locked' : post.closed && 'closed',
    unread?.kind === 'new' ? 'new' : unread ? `${unread.count} new replies` : null].filter(Boolean).join(', ')
  return (
    <button className={`post-card ${active ? 'active' : ''} ${unread ? 'unread' : ''}`} onClick={() => openPost(server.key, post)} aria-label={label}>
      <div className="post-main">
        <div className="post-title-row">
          {post.pinned && <span className="post-flag pinned" title="Pinned"><PinIcon size={14} /></span>}
          <span className="post-title">{post.title}</span>
          {post.locked ? (
            <span className="post-state" title="Locked: only moderators can reply"><Lock size={12} /> Locked</span>
          ) : post.closed ? (
            <span className="post-state closed" title="Closed"><CheckCircle size={12} /> Closed</span>
          ) : null}
          {unread && <span className="post-unread">{unread.kind === 'new' ? 'New' : `${unread.count} new`}</span>}
        </div>
        {post.tags.length > 0 && (
          <div className="post-tags">
            {post.tags.map((id) => tagById.get(id)).filter((t): t is ForumTag => !!t).map((t) => (
              <span key={t.id} className="tag-chip small">{t.emoji && <span aria-hidden>{t.emoji}</span>}{t.name}</span>
            ))}
          </div>
        )}
        {excerpt ? <span className="post-excerpt">{excerpt}</span> : post.attachmentCount > 0 ? <span className="post-excerpt muted">Attachment</span> : null}
        <div className="post-meta">
          <Avatar name={name} accountKey={post.author} size={18} />
          <span className="post-author">{name}</span>
          <span aria-hidden>·</span>
          <time title={new Date(post.createdAt).toLocaleString()}>{relativeTime(post.createdAt)}</time>
          <span className="post-replies" title={`${post.replyCount} ${post.replyCount === 1 ? 'reply' : 'replies'}`}>
            <ReplyCount size={14} /> {post.replyCount}
          </span>
          {post.lastMessageAt && <span className="post-last">Last reply {relativeTime(post.lastMessageAt)}</span>}
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
