// A media channel: its posts as a masonry grid of their first picture or video (tag filter, search, sort), a "Post"
// button, and the viewer for the open post (a post is a forum post, so its comments are its thread).
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { roleRank, type Channel, type FileInfo, type ForumPost, type ForumTag } from '../../core/protocol'
import { fileUrl, type ServerState } from '../../state/store'
import { forumKey, loadPosts, openPost, seenFor, useForums, type ForumView as View } from '../../state/forums'
import { visiblePosts } from '../../state/forumLogic'
import { openThread, useThreads } from '../../state/threads'
import { useJump } from '../../state/jump'
import { Avatar, Spinner } from '../bits'
import { Menu, Plus, Users } from '../icons'
import { plainText } from '../markdown'
import { stripMarkdown } from '../plainMarkdown'
import { PinIcon, SearchIcon } from '../chat/extraIcons'
import { ReplyCount, TagIcon } from '../forums/icons'
import { TagsDialog } from '../forums/ForumDialogs'
import { ChannelTopic } from '../chat/ChannelTopic'
import type { Panel } from '../Shell'
import { columnsFor, isSensitive, layoutMasonry, mediaOf, moveInGrid, postLabel, tileRatio, type GridKey } from './gallery'
import { EyeOffIcon, HeartIcon, MediaIcon, PlayIcon, StackIcon } from './icons'
import { NewMediaPostDialog } from './NewMediaPostDialog'
import { MediaViewer } from './MediaViewer'
import '../forums/forums.css'
import './media-channels.css'

const NO_TAGS: ForumTag[] = []
const DEFAULT: View = { sort: 'newest', tag: null, query: '' }
const GRID_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'])

export function MediaView({ server, channel, onToggle }: { server: ServerState; channel: Channel; onToggle: (panel: Panel) => void }) {
  const { t } = useTranslation()
  const key = forumKey(server.key, channel.id)
  const list = useForums((s) => s.lists[key])
  const tags = useForums((s) => s.tags[key]) ?? NO_TAGS
  const open = useThreads((s) => (s.open?.key === server.key ? s.open.id : null))
  const openThreadInfo = useThreads((s) => (open !== null ? s.threads[server.key]?.[open] : undefined))
  const [view, setView] = useState<View>(DEFAULT)
  const [search, setSearch] = useState('')
  const [dialog, setDialog] = useState<'post' | 'tags' | null>(null)
  const online = server.status.state === 'online'
  const me = server.me
  const canPost = !!me && roleRank(me.role) >= roleRank(channel.writeRole)
  const isAdmin = !!me && roleRank(me.role) >= roleRank('admin')

  useEffect(() => {
    seenFor(server.key, channel.id)
  }, [server.key, channel.id])

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
  const tagById = useMemo(() => new Map(tags.map((tag) => [tag.id, tag])), [tags])
  const filtering = view.tag !== null || view.query.trim() !== ''
  // The viewer shows a post of this channel (it may not be in the loaded list, e.g. opened from a link).
  const viewing = open !== null && (!openThreadInfo || openThreadInfo.channelId === channel.id) ? open : null

  return (
    <div className="chat forum media-channel">
      <header className="chat-header">
        <button className="icon-button mobile-only" onClick={() => onToggle('nav')} aria-label={t('mediaChannels.view.openChannels')}>
          <Menu />
        </button>
        <h1>
          <span className="hash"><MediaIcon size={20} /></span>
          {channel.name}
        </h1>
        <span className="spacer" />
        {isAdmin && (
          <button className="icon-button" onClick={() => setDialog('tags')} aria-label={t('mediaChannels.view.editTags')} title={t('mediaChannels.view.editTags')}>
            <TagIcon />
          </button>
        )}
        <button className="icon-button members-toggle" onClick={() => onToggle('members')} aria-label={t('mediaChannels.view.members')} title={t('mediaChannels.view.members')}>
          <Users />
        </button>
      </header>
      <ChannelTopic channel={channel} />

      <div className="forum-toolbar">
        <label className="forum-search">
          <SearchIcon size={15} />
          <input
            type="search"
            placeholder={t('mediaChannels.view.search', { channel: channel.name })}
            aria-label={t('mediaChannels.view.searchLabel')}
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
        <select className="forum-sort" aria-label={t('mediaChannels.view.sort')} value={view.sort} onChange={(e) => setView((v) => ({ ...v, sort: e.target.value as View['sort'] }))}>
          <option value="newest">{t('mediaChannels.view.newest')}</option>
          <option value="top">{t('mediaChannels.view.top')}</option>
          <option value="activity">{t('mediaChannels.view.activity')}</option>
        </select>
        {canPost && (
          <button className="button primary forum-new" onClick={() => setDialog('post')}>
            <Plus size={16} /> <span className="media-new-label">{t('mediaChannels.view.newPost')}</span>
          </button>
        )}
      </div>

      {tags.length > 0 && (
        <div className="forum-tags" role="group" aria-label={t('mediaChannels.view.filter')}>
          <button className={`tag-chip ${view.tag === null ? 'on' : ''}`} aria-pressed={view.tag === null} onClick={() => setView((v) => ({ ...v, tag: null }))}>
            {t('mediaChannels.view.all')}
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

      <div className="forum-posts media-posts">
        {list?.error && <div className="banner error"><span>{list.error}</span></div>}
        {!list || (list.loading && list.posts.length === 0) ? (
          <div className="forum-empty"><Spinner /></div>
        ) : posts.length === 0 ? (
          <div className="forum-empty">
            <span className="empty-icon"><MediaIcon size={30} /></span>
            {filtering ? (
              <>
                <h2>{t('mediaChannels.view.noMatch')}</h2>
                <p className="muted">{t('mediaChannels.view.noMatchHint')}</p>
              </>
            ) : (
              <>
                <h2>{t('mediaChannels.view.empty')}</h2>
                <p className="muted">{canPost ? t('mediaChannels.view.emptyCreate') : t('mediaChannels.view.emptyView')}</p>
                {canPost && <button className="button primary" onClick={() => setDialog('post')}><Plus size={16} /> {t('mediaChannels.view.newPost')}</button>}
              </>
            )}
          </div>
        ) : (
          <Grid server={server} channel={channel} posts={posts} tagById={tagById} active={viewing} />
        )}
        {list?.hasMore && (
          <button className="button load-more wide" disabled={list.loading} onClick={() => void loadPosts(server.key, channel.id, view, true)}>
            {list.loading ? t('common.loading') : t('mediaChannels.view.more')}
          </button>
        )}
      </div>

      {viewing !== null && (
        <MediaViewer
          key={channel.id}
          server={server}
          channel={channel}
          postId={viewing}
          posts={posts}
          tagById={tagById}
          onNearEnd={() => list?.hasMore && void loadPosts(server.key, channel.id, view, true)}
        />
      )}
      {dialog === 'post' && <NewMediaPostDialog server={server} channel={channel} tags={tags} onClose={() => setDialog(null)} />}
      {dialog === 'tags' && <TagsDialog server={server} forum={channel} tags={tags} onClose={() => setDialog(null)} />}
    </div>
  )
}

/** The masonry grid: columns by width, one tile in the Tab order, the arrow keys move between tiles. */
function Grid({ server, channel, posts, tagById, active }: {
  server: ServerState
  channel: Channel
  posts: ForumPost[]
  tagById: Map<number, ForumTag>
  active: number | null
}) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [focusId, setFocusId] = useState<number | null>(null)
  const tiles = useRef(new Map<number, HTMLButtonElement>())

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(el.clientWidth)
    const observer = new ResizeObserver(() => setWidth(el.clientWidth))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const columns = columnsFor(width)
  const layout = useMemo(() => layoutMasonry(posts.map((p) => tileRatio(mediaOf(p)[0])), columns), [posts, columns])
  const current = posts.findIndex((p) => p.id === focusId)
  const tabbable = current >= 0 ? current : Math.max(0, posts.findIndex((p) => p.id === active))

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>, index: number) {
    if (!GRID_KEYS.has(e.key)) return
    e.preventDefault()
    const next = moveInGrid(layout, index, e.key as GridKey)
    const post = posts[next]
    if (!post) return
    setFocusId(post.id)
    tiles.current.get(post.id)?.focus()
  }

  return (
    <div className="media-grid" ref={ref} role="list" aria-label={t('mediaChannels.view.grid', { channel: channel.name })} aria-description={t('mediaChannels.view.gridHint')}>
      {layout.columns.map((column, c) => (
        <div className="media-column" key={c}>
          {column.map((index) => {
            const post = posts[index]
            return (
              <div role="listitem" key={post.id} onKeyDown={(e) => onKeyDown(e, index)}>
                <Tile
                  server={server}
                  post={post}
                  tagById={tagById}
                  tabIndex={index === tabbable ? 0 : -1}
                  active={post.id === active}
                  onFocus={() => setFocusId(post.id)}
                  buttonRef={(el) => {
                    if (el) tiles.current.set(post.id, el)
                    else tiles.current.delete(post.id)
                  }}
                />
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

function Tile({ server, post, tagById, tabIndex, active, onFocus, buttonRef }: {
  server: ServerState
  post: ForumPost
  tagById: Map<number, ForumTag>
  tabIndex: number
  active: boolean
  onFocus: () => void
  buttonRef: (el: HTMLButtonElement | null) => void
}) {
  const { t } = useTranslation()
  const files = mediaOf(post)
  const first = files[0] as FileInfo | undefined
  const author = server.members[post.author]
  const name = author?.name ?? t('mediaChannels.tile.formerMember')
  const caption = post.excerpt ? stripMarkdown(plainText(post.excerpt, { nameOf: (k) => server.members[k]?.name ?? null })) : ''
  const label = postLabel(post, caption)
  const reactions = post.reactionCount ?? 0
  const tag = post.tags.map((id) => tagById.get(id)).find((x): x is ForumTag => !!x)
  const sensitive = isSensitive(first)
  const video = !!first?.type.startsWith('video/')
  const spoken = [
    label ? t('mediaChannels.tile.label', { label, name }) : t('mediaChannels.tile.untitled', { name }),
    post.pinned && t('mediaChannels.tile.pinned'),
    sensitive && t('mediaChannels.tile.sensitive'),
    video && t('mediaChannels.tile.video'),
    files.length > 1 && t('mediaChannels.tile.items', { count: files.length }),
    t('mediaChannels.tile.comments', { count: post.replyCount }),
    reactions > 0 && t('mediaChannels.tile.reactions', { count: reactions }),
    tag?.name,
  ].filter(Boolean).join(', ')

  return (
    <button
      ref={buttonRef}
      className={`media-tile ${active ? 'active' : ''} ${sensitive ? 'sensitive' : ''}`}
      style={{ aspectRatio: `1 / ${tileRatio(first)}` }}
      tabIndex={tabIndex}
      onFocus={onFocus}
      onClick={() => openPost(server.key, post)}
      aria-label={spoken}
      data-testid="media-tile"
    >
      {first ? (
        video
          ? <video src={fileUrl(server.key, first) + '#t=0.1'} muted playsInline preload="metadata" aria-hidden tabIndex={-1} />
          : <img src={fileUrl(server.key, first)} alt="" loading="lazy" draggable={false} />
      ) : <span className="media-tile-empty"><MediaIcon size={28} /></span>}
      {sensitive && <span className="media-sensitive"><EyeOffIcon size={18} /> {t('mediaChannels.tile.sensitive')}</span>}
      <span className="media-badges" aria-hidden>
        {post.pinned && <span className="media-badge"><PinIcon size={13} /></span>}
        {video && <span className="media-badge"><PlayIcon size={13} /></span>}
        {files.length > 1 && <span className="media-badge"><StackIcon size={13} /> {files.length}</span>}
      </span>
      <span className="media-info" aria-hidden>
        {label && <span className="media-title">{label}</span>}
        <span className="media-meta">
          <Avatar name={name} accountKey={post.author} size={18} />
          <span className="media-author">{name}</span>
          {tag && <span className="tag-chip small">{tag.emoji && <span>{tag.emoji}</span>}{tag.name}</span>}
          <span className="spacer" />
          {reactions > 0 && <span className="media-count"><HeartIcon size={13} /> {reactions}</span>}
          <span className="media-count"><ReplyCount size={13} /> {post.replyCount}</span>
        </span>
      </span>
    </button>
  )
}
