// The open post of a media channel, over everything: its pictures and videos (arrows or swipe between posts), its
// tags and reactions, and its comments (the post's thread) beside it, or below on phones. Escape or the back arrow closes.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { Channel, ForumPost, ForumTag } from '../../core/protocol'
import { fileUrl, toggleReaction, type ServerState } from '../../state/store'
import { openPost, useForums } from '../../state/forums'
import { closeThread } from '../../state/threads'
import { loadMediaPost, rootKey, useMediaPosts } from '../../state/mediaPosts'
import { useEscapeLayer, useFocusTrap } from '../layers'
import { ChevronLeft, ChevronRight, Close } from '../icons'
import { Spinner } from '../bits'
import { plainText } from '../markdown'
import { stripMarkdown } from '../plainMarkdown'
import { SpoilerCover, shownName } from '../chat/media'
import { Reactions } from '../chat/MessageExtras'
import { EmojiPicker } from '../expressions/EmojiPicker'
import { SmilePlus } from '../expressions/icons'
import { ThreadPanel } from '../chat/ThreadPanel'
import { isSensitive, mediaOf, nearEnd, postLabel, stepPost } from './gallery'

/** Typing somewhere: the arrow keys belong to the field. */
const typing = (el: Element | null) => !!el && (el.matches('input, textarea, select, [contenteditable="true"]') || !!el.closest('[contenteditable="true"]'))

export function MediaViewer({ server, channel, postId, posts, tagById, onNearEnd }: {
  server: ServerState
  channel: Channel
  postId: number
  posts: ForumPost[]
  tagById: Map<number, ForumTag>
  onNearEnd: () => void
}) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  const known = useForums((s) => s.posts[server.key]?.[postId])
  const post = known ?? posts.find((p) => p.id === postId)
  const root = useMediaPosts((s) => s.roots[rootKey(server.key, postId)])
  const [shown, setShown] = useState({ postId, index: 0 })
  const [picking, setPicking] = useState<HTMLElement | null>(null)
  const swipe = useRef<{ x: number; y: number } | null>(null)
  const online = server.status.state === 'online'
  const index = shown.postId === postId ? shown.index : 0
  const files = post ? mediaOf(post) : []
  const file = files[Math.min(index, files.length - 1)]
  const prev = stepPost(posts, postId, -1)
  const next = stepPost(posts, postId, 1)
  const caption = post?.excerpt ? stripMarkdown(plainText(post.excerpt, { nameOf: (k) => server.members[k]?.name ?? null })) : ''
  const label = post ? postLabel(post, caption) : ''
  const tags = (post?.tags ?? []).map((id) => tagById.get(id)).filter((x): x is ForumTag => !!x)

  useEscapeLayer(closeThread)
  useFocusTrap(ref)

  useEffect(() => {
    if (online) void loadMediaPost(server.key, postId)
  }, [server.key, postId, online])

  // Close to the end of what's loaded: load the next page, so the arrows keep going.
  useEffect(() => {
    if (nearEnd(posts, postId)) onNearEnd()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [postId, posts.length])

  const go = (id: number | null) => {
    const target = id === null ? undefined : posts.find((p) => p.id === id)
    if (target) openPost(server.key, target)
  }

  // ← and → move between posts, unless you're typing a comment (or a dialog over the viewer has the keyboard).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || typing(document.activeElement)) return
      const inside = ref.current?.contains(document.activeElement) || document.activeElement === document.body
      if (!inside) return
      if (e.key === 'ArrowLeft' && prev !== null) {
        e.preventDefault()
        go(prev)
      } else if (e.key === 'ArrowRight' && next !== null) {
        e.preventDefault()
        go(next)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  function onPointerDown(e: ReactPointerEvent) {
    if (e.pointerType !== 'mouse') swipe.current = { x: e.clientX, y: e.clientY }
  }
  function onPointerUp(e: ReactPointerEvent) {
    const start = swipe.current
    swipe.current = null
    if (!start) return
    const dx = e.clientX - start.x
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(e.clientY - start.y) * 1.5) go(dx < 0 ? next : prev)
  }

  return createPortal(
    <div className="media-viewer" role="dialog" aria-modal="true" aria-label={t('mediaChannels.viewer.label', { label: label || channel.name })}
      aria-description={t('mediaChannels.viewer.keys')} ref={ref} tabIndex={-1} data-testid="media-viewer">
      <div className="media-viewer-main">
        <header className="media-viewer-bar">
          <span className="media-viewer-title">{label}</span>
          {files.length > 1 && <span className="media-viewer-count" aria-live="polite">{t('mediaChannels.viewer.count', { n: index + 1, total: files.length })}</span>}
          {file && (
            <a className="button small" href={fileUrl(server.key, file)} target="_blank" rel="noopener noreferrer" download={shownName(file.name)}>
              {t('mediaChannels.viewer.openOriginal')}
            </a>
          )}
          <button className="icon-button" onClick={closeThread} aria-label={t('mediaChannels.viewer.close')} title={t('mediaChannels.viewer.close')}><Close /></button>
        </header>
        <div className="media-stage" onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerCancel={() => (swipe.current = null)}>
          {!post ? (
            root === null ? <p className="muted">{t('mediaChannels.viewer.missing')}</p> : <Spinner />
          ) : file ? (
            <SpoilerCover key={file.id + postId} active={isSensitive(file)} className="media-stage-cover">
              {file.type.startsWith('video/')
                ? <video className="media-stage-item" src={fileUrl(server.key, file)} controls playsInline preload="metadata" />
                : <img className="media-stage-item" src={fileUrl(server.key, file)} alt={label || shownName(file.name)} draggable={false} />}
            </SpoilerCover>
          ) : null}
          <button className="media-nav prev" onClick={() => go(prev)} disabled={prev === null} aria-label={t('mediaChannels.viewer.previous')} title={t('mediaChannels.viewer.previous')}>
            <ChevronLeft size={26} />
          </button>
          <button className="media-nav next" onClick={() => go(next)} disabled={next === null} aria-label={t('mediaChannels.viewer.next')} title={t('mediaChannels.viewer.next')}>
            <ChevronRight size={26} />
          </button>
        </div>
        {files.length > 1 && (
          <div className="media-strip" role="group" aria-label={label}>
            {files.map((f, i) => (
              <button key={f.id + i} className={`media-thumb ${i === index ? 'on' : ''}`} aria-pressed={i === index}
                aria-label={t('mediaChannels.viewer.show', { n: i + 1, total: files.length })} onClick={() => setShown({ postId, index: i })}>
                {f.type.startsWith('video/')
                  ? <video src={fileUrl(server.key, f) + '#t=0.1'} muted playsInline preload="metadata" aria-hidden tabIndex={-1} />
                  : <img src={fileUrl(server.key, f)} alt="" loading="lazy" draggable={false} className={isSensitive(f) ? 'sensitive' : ''} />}
              </button>
            ))}
          </div>
        )}
        <div className="media-viewer-meta">
          {tags.map((tag) => <span key={tag.id} className="tag-chip small">{tag.emoji && <span aria-hidden>{tag.emoji}</span>}{tag.name}</span>)}
          {root && <Reactions server={server} message={root} />}
          {root && (
            <button className="icon-button small media-react" onClick={(e) => setPicking(picking ? null : e.currentTarget)}
              aria-label={t('chat.message.addReaction')} title={t('chat.message.addReaction')}>
              <SmilePlus size={18} />
            </button>
          )}
          {picking && root && (
            <EmojiPicker serverKey={server.key} anchor={picking} onClose={() => setPicking(null)} onPick={(emoji) => toggleReaction(server.key, root, emoji)} />
          )}
        </div>
      </div>
      <ThreadPanel key={postId} server={server} threadId={postId} embedded />
    </div>,
    document.body,
  )
}
