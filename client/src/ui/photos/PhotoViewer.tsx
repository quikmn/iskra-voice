// The open photo, over everything: the picture (wheel, double-click or pinch to zoom, drag to pan) or the video,
// arrows or a swipe to the next one, who added it and when, its caption, reactions and comments (the photo's thread,
// beside it or below on phones). Escape or the back arrow closes.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { Channel } from '../../core/protocol'
import { MAX_CAPTION } from '../../core/photoCrypto'
import { photoLink } from '../../core/pushRoute'
import type { ServerState } from '../../state/store'
import { closeThread, useThreads } from '../../state/threads'
import {
  closePhotoViewer, deletePhotos, movePhotos, openComments, openPhotoViewer, reactToPhoto, setAlbumCover, setCaption, usePhotos,
} from '../../state/photos'
import { stepPhoto, type ShownAlbum, type ShownPhoto } from '../../state/photosLogic'
import { errorMessage } from '../../i18n/errors'
import { useEscapeLayer, useFocusTrap } from '../layers'
import { Avatar, Spinner } from '../bits'
import { appUrl } from '../format'
import { Check, ChevronLeft, ChevronRight, Close, Link, MessageCircle, MoreHorizontal, Pencil, Trash } from '../icons'
import { Menu, MenuGroup, MenuItem, type MenuAnchor } from '../kit'
import { renderMarkdown } from '../markdown'
import { formatSize } from '../chat/helpers'
import { ThreadPanel } from '../chat/ThreadPanel'
import { EmojiPicker } from '../expressions/EmojiPicker'
import { SmilePlus } from '../expressions/icons'
import { AlbumIcon, DownloadIcon, FolderMove, ZoomIn, ZoomOut } from './icons'
import { ConfirmDialog, dayTimeText, MoveDialog, PhotoReactions, useCanChange, usePhotoUrl, type PhotoAbilities } from './PhotoBits'

const MAX_ZOOM = 6
/** Typing somewhere: the arrow keys belong to the field. */
const typing = (el: Element | null) => !!el && (el.matches('input, textarea, select, [contenteditable="true"]') || !!el.closest('[contenteditable="true"]'))

interface Zoom {
  scale: number
  x: number
  y: number
}
const FIT: Zoom = { scale: 1, x: 0, y: 0 }

export function PhotoViewer({ server, channel, photoId, order, albums, can }: {
  server: ServerState
  channel: Channel
  photoId: number
  /** The photos the arrows step through, in the grid's order. */
  order: ShownPhoto[]
  albums: ShownAlbum[]
  can: PhotoAbilities
}) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  const photo = usePhotos((s) => s.galleries[`${server.key}:${channel.id}`]?.photos.find((p) => p.id === photoId))
  const thread = useThreads((s) => (s.open?.key === server.key && photo?.threadId === s.open.id ? s.open.id : null))
  const mayChange = useCanChange(server, can)
  const [zoom, setZoom] = useState<Zoom>(FIT)
  const [menu, setMenu] = useState<MenuAnchor | null>(null)
  const [picking, setPicking] = useState<HTMLElement | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [dialog, setDialog] = useState<'move' | 'delete' | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const prev = stepPhoto(order, photoId, -1)
  const next = stepPhoto(order, photoId, 1)
  const mine = !!photo && photo.uploader === server.me?.accountKey
  const album = photo?.albumId != null ? albums.find((a) => a.id === photo.albumId) : undefined
  const uploader = photo ? server.members[photo.uploader] : undefined
  const name = uploader?.name ?? t('common.someone')
  const source = usePhotoUrl(server.key, photo, 'file')
  const ahead = order.find((p) => p.id === next)
  const fail = (e: unknown) => setError(errorMessage(e))

  // Comments close first, then the viewer.
  useEscapeLayer(closePhotoViewer)
  useFocusTrap(ref)

  // Another photo is another viewer (its parent keys it by photo): the comments of this one close with it.
  useEffect(() => () => closeThread(), [])

  // The next picture is fetched ahead, so the arrow feels instant (encrypted ones only when asked for).
  const aheadUrl = ahead && !ahead.sealed && ahead.kind === 'image' && ahead.file ? server.url + ahead.file.url : null
  useEffect(() => {
    if (aheadUrl) new Image().src = aheadUrl
  }, [aheadUrl])

  // The photo was deleted (by you or someone else) while it was open.
  useEffect(() => {
    if (!photo) closePhotoViewer()
  }, [photo])

  const go = (id: number | null) => {
    if (id !== null) openPhotoViewer(server.key, channel.id, id)
  }

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
      } else if (e.key === '+' || e.key === '=') setZoom((z) => clamp({ ...z, scale: z.scale * 1.5 }))
      else if (e.key === '-') setZoom((z) => clamp({ ...z, scale: z.scale / 1.5 }))
      else if (e.key === '0') setZoom(FIT)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // ── Zoom, pan and swipe ───────────────────────────────────────────────────
  const stage = useRef<HTMLDivElement>(null)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const gesture = useRef<{ start: Zoom; distance: number; centre: { x: number; y: number }; moved: boolean; origin: { x: number; y: number } } | null>(null)

  /** Keeps the picture from being dragged off the stage. */
  function clamp(z: Zoom): Zoom {
    const scale = Math.min(MAX_ZOOM, Math.max(1, z.scale))
    if (scale === 1) return FIT
    const box = stage.current?.getBoundingClientRect()
    const limitX = box ? (box.width * (scale - 1)) / 2 : 0
    const limitY = box ? (box.height * (scale - 1)) / 2 : 0
    return { scale, x: Math.min(limitX, Math.max(-limitX, z.x)), y: Math.min(limitY, Math.max(-limitY, z.y)) }
  }

  const spread = () => {
    const [a, b] = [...pointers.current.values()]
    return { distance: Math.hypot(a.x - b.x, a.y - b.y), centre: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } }
  }

  function onPointerDown(e: ReactPointerEvent) {
    if ((e.target as Element).closest('button, video, a')) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    e.currentTarget.setPointerCapture(e.pointerId)
    const two = pointers.current.size === 2 ? spread() : null
    gesture.current = { start: zoom, distance: two?.distance ?? 0, centre: two?.centre ?? { x: e.clientX, y: e.clientY }, moved: false, origin: { x: e.clientX, y: e.clientY } }
  }

  function onPointerMove(e: ReactPointerEvent) {
    const g = gesture.current
    if (!g || !pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 2 && g.distance > 0) {
      const now = spread()
      g.moved = true
      setZoom(clamp({ scale: g.start.scale * (now.distance / g.distance), x: g.start.x + (now.centre.x - g.centre.x), y: g.start.y + (now.centre.y - g.centre.y) }))
    } else if (pointers.current.size === 1 && g.start.scale > 1) {
      if (Math.hypot(e.clientX - g.origin.x, e.clientY - g.origin.y) > 4) g.moved = true
      setZoom(clamp({ scale: g.start.scale, x: g.start.x + (e.clientX - g.origin.x), y: g.start.y + (e.clientY - g.origin.y) }))
    }
  }

  function onPointerUp(e: ReactPointerEvent) {
    const g = gesture.current
    const had = pointers.current.size
    pointers.current.delete(e.pointerId)
    if (!g || pointers.current.size > 0) {
      if (g && pointers.current.size === 1) {
        // One finger of a pinch lifted: the other one carries on panning from here.
        const [left] = [...pointers.current.values()]
        gesture.current = { start: zoom, distance: 0, centre: left, moved: true, origin: left }
      }
      return
    }
    gesture.current = null
    // A swipe across a picture that fits the screen goes to the next or the previous one (touch and pen only).
    if (had === 1 && g.start.scale === 1 && e.pointerType !== 'mouse') {
      const dx = e.clientX - g.origin.x
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(e.clientY - g.origin.y) * 1.5) go(dx < 0 ? next : prev)
    }
  }

  function onWheel(e: WheelEvent) {
    if (photo?.kind !== 'image') return
    setZoom((z) => clamp({ ...z, scale: z.scale * (e.deltaY < 0 ? 1.2 : 1 / 1.2) }))
  }

  async function saveCaption() {
    if (!photo || editing === null) return
    setError(null)
    try {
      if (editing.trim() !== photo.caption) await setCaption(server.key, photo, editing)
      setEditing(null)
    } catch (e) {
      fail(e)
    }
  }

  async function comments() {
    if (!photo) return
    if (thread !== null) return closeThread()
    setError(null)
    try {
      if (!(await openComments(server.key, photo))) setError(t('photos.viewer.noComments'))
    } catch (e) {
      fail(e)
    }
  }

  const original = photo && !photo.sealed && photo.file ? server.url + photo.file.url : source.url
  const shownAt = photo ? photo.takenAt ?? photo.createdAt : 0

  return createPortal(
    <div className={`photo-viewer ${thread !== null ? 'with-comments' : ''}`} role="dialog" aria-modal="true" ref={ref} tabIndex={-1} data-testid="photo-viewer"
      aria-label={t('photos.viewer.label', { name })} aria-description={t('photos.viewer.keys')}>
      <div className="photo-viewer-main">
        <header className="photo-viewer-bar">
          <button className="icon-button" onClick={closePhotoViewer} aria-label={t('photos.viewer.close')} title={t('photos.viewer.close')} data-testid="photo-viewer-close"><Close /></button>
          {photo && (
            <div className="photo-viewer-who">
              <Avatar name={name} accountKey={photo.uploader} size={32} />
              <span className="photo-viewer-names">
                <span className="photo-viewer-name" data-testid="photo-viewer-uploader">{name}</span>
                <time className="photo-viewer-date" dateTime={new Date(shownAt).toISOString()} data-testid="photo-viewer-date"
                  title={photo.takenAt ? t('photos.viewer.takenAdded', { taken: dayTimeText(photo.takenAt), added: dayTimeText(photo.createdAt) }) : undefined}>
                  {photo.takenAt ? dayTimeText(photo.takenAt) : t('photos.viewer.added', { date: dayTimeText(photo.createdAt) })}
                  {album && <> · {album.name}</>}
                </time>
              </span>
            </div>
          )}
          <span className="spacer" />
          {order.length > 1 && photo && <span className="photo-viewer-count" aria-live="polite">{t('photos.viewer.count', { n: order.findIndex((p) => p.id === photoId) + 1, total: order.length })}</span>}
          {photo?.kind === 'image' && (
            <>
              <button className="icon-button photo-zoom-button" onClick={() => setZoom((z) => clamp({ ...z, scale: z.scale / 1.5 }))} disabled={zoom.scale <= 1} aria-label={t('photos.viewer.zoomOut')} title={t('photos.viewer.zoomOut')}><ZoomOut /></button>
              <button className="icon-button photo-zoom-button" onClick={() => setZoom((z) => clamp({ ...z, scale: z.scale * 1.5 }))} disabled={zoom.scale >= MAX_ZOOM} aria-label={t('photos.viewer.zoomIn')} title={t('photos.viewer.zoomIn')} data-testid="photo-zoom-in"><ZoomIn /></button>
            </>
          )}
          {original && photo && (
            <a className="icon-button" href={original} download={photo.name || undefined} target={photo.sealed ? undefined : '_blank'} rel="noopener noreferrer"
              aria-label={t('photos.viewer.download')} title={t('photos.viewer.downloadSize', { size: formatSize(photo.sealed?.file.size ?? photo.file?.size ?? photo.size) })} data-testid="photo-download">
              <DownloadIcon />
            </a>
          )}
          {photo && (
            <button className="icon-button" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.right, y: r.bottom + 4, align: 'end' }) }}
              aria-label={t('photos.viewer.more')} title={t('photos.viewer.more')} aria-haspopup="menu" data-testid="photo-more"><MoreHorizontal /></button>
          )}
        </header>

        <div className={`photo-stage ${zoom.scale > 1 ? 'zoomed' : ''}`} ref={stage} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp} onWheel={onWheel}
          onDoubleClick={(e) => {
            if (photo?.kind === 'image' && !(e.target as Element).closest('button')) setZoom((z) => (z.scale > 1 ? FIT : clamp({ scale: 2.5, x: 0, y: 0 })))
          }}>
          {!photo ? <Spinner />
            : source.failed ? <p className="photo-stage-note" role="alert">{t('photos.viewer.cannotOpen')}</p>
            : !source.url ? (
              <div className="photo-stage-note" role="status">
                <Spinner />
                {photo.sealed && <span>{t('photos.viewer.decrypting', { percent: Math.round(source.progress * 100) })}</span>}
              </div>
            ) : photo.kind === 'video' ? (
              <video key={photo.id} className="photo-stage-item" src={source.url} controls playsInline autoPlay preload="metadata" data-testid="photo-viewer-video" />
            ) : (
              <img key={photo.id} className="photo-stage-item" src={source.url} alt={photo.caption || t('photos.grid.photo', { name })} draggable={false} data-testid="photo-viewer-image"
                style={{ transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})` }} data-scale={zoom.scale.toFixed(2)} />
            )}
          <button className="photo-nav prev" onClick={() => go(prev)} disabled={prev === null} aria-label={t('photos.viewer.previous')} title={t('photos.viewer.previous')} data-testid="photo-prev">
            <ChevronLeft size={26} />
          </button>
          <button className="photo-nav next" onClick={() => go(next)} disabled={next === null} aria-label={t('photos.viewer.next')} title={t('photos.viewer.next')} data-testid="photo-next">
            <ChevronRight size={26} />
          </button>
        </div>

        {photo && (
          <footer className="photo-viewer-meta">
            {editing !== null ? (
              <div className="photo-caption-edit">
                <textarea value={editing} maxLength={MAX_CAPTION} rows={2} autoFocus aria-label={t('photos.viewer.caption')} placeholder={t('photos.viewer.captionPlaceholder')}
                  data-testid="photo-caption-input" onChange={(e) => setEditing(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      void saveCaption()
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      e.stopPropagation()
                      setEditing(null)
                    }
                  }} />
                <button className="button small primary" onClick={() => void saveCaption()} data-testid="photo-caption-save">{t('common.save')}</button>
                <button className="button small" onClick={() => setEditing(null)}>{t('common.cancel')}</button>
              </div>
            ) : (
              <div className="photo-caption">
                {photo.caption
                  ? <div className="photo-caption-text" data-testid="photo-caption">{renderMarkdown(photo.caption, { nameOf: (k) => server.members[k]?.name ?? null, me: server.me?.accountKey, serverKey: server.key })}</div>
                  : mine && can.add ? <button className="link photo-caption-add" onClick={() => setEditing('')} data-testid="photo-caption-add">{t('photos.viewer.addCaption')}</button> : null}
                {photo.caption && mine && can.add && (
                  <button className="icon-button small" onClick={() => setEditing(photo.caption)} aria-label={t('photos.viewer.editCaption')} title={t('photos.viewer.editCaption')} data-testid="photo-caption-edit"><Pencil size={14} /></button>
                )}
              </div>
            )}
            <div className="photo-viewer-social">
              <PhotoReactions server={server} photo={photo} disabled={!can.add} />
              {can.add && (
                <button className="icon-button small" onClick={(e) => setPicking(picking ? null : e.currentTarget)} aria-label={t('chat.message.addReaction')} title={t('chat.message.addReaction')} data-testid="photo-react">
                  <SmilePlus size={18} />
                </button>
              )}
              <span className="spacer" />
              <button className={`button small photo-comments-button ${thread !== null ? 'on' : ''}`} aria-pressed={thread !== null} onClick={() => void comments()} data-testid="photo-comments">
                <MessageCircle size={16} /> {photo.comments > 0 ? t('photos.viewer.comments', { count: photo.comments }) : t('photos.viewer.comment')}
              </button>
            </div>
            {error && <div className="banner error" role="alert">{error}</div>}
          </footer>
        )}
      </div>

      {thread !== null && photo && <ThreadPanel key={thread} server={server} threadId={thread} embedded bare />}
      {picking && photo && <EmojiPicker serverKey={server.key} anchor={picking} onClose={() => setPicking(null)} onPick={(emoji) => reactToPhoto(server.key, photo, emoji)} />}
      {menu && photo && (
        <Menu anchor={menu} label={t('photos.viewer.more')} onClose={() => setMenu(null)}>
          <MenuGroup>
            <MenuItem icon={copied ? <Check size={16} /> : <Link size={16} />} testId="photo-copy-link" onClick={() => {
              navigator.clipboard.writeText(photoLink(appUrl(server.appUrl), server.key, channel.id, photo.id)).then(() => {
                setCopied(true)
                setTimeout(() => {
                  setCopied(false)
                  setMenu(null)
                }, 700)
              }).catch(() => setError(t('photos.viewer.copyFailed')))
            }}>{copied ? t('photos.viewer.copied') : t('photos.viewer.copyLink')}</MenuItem>
            {mine && can.add && <MenuItem icon={<Pencil size={16} />} onClick={() => { setMenu(null); setEditing(photo.caption) }}>{photo.caption ? t('photos.viewer.editCaption') : t('photos.viewer.addCaption')}</MenuItem>}
            {album && mayChange.album(album) && album.coverId !== photo.id && (
              <MenuItem icon={<AlbumIcon size={16} />} testId="photo-set-cover" onClick={() => { setMenu(null); setAlbumCover(server.key, album, photo.id).catch(fail) }}>{t('photos.viewer.setCover')}</MenuItem>
            )}
            {mayChange.photo(photo) && can.add && <MenuItem icon={<FolderMove size={16} />} testId="photo-move" onClick={() => { setMenu(null); setDialog('move') }}>{t('photos.select.move')}</MenuItem>}
          </MenuGroup>
          {mayChange.photo(photo) && (
            <MenuGroup>
              <MenuItem danger icon={<Trash size={16} />} testId="photo-delete" onClick={() => { setMenu(null); setDialog('delete') }}>{t('common.delete')}</MenuItem>
            </MenuGroup>
          )}
        </Menu>
      )}
      {dialog === 'move' && photo && (
        <MoveDialog count={1} albums={albums} current={photo.albumId} onClose={() => setDialog(null)} onMove={(albumId) => movePhotos(server.key, channel.id, [photo.id], albumId)} />
      )}
      {dialog === 'delete' && photo && (
        <ConfirmDialog title={t('photos.delete.title', { count: 1 })} body={t('photos.delete.body', { count: 1 })} action={t('common.delete')} onClose={() => setDialog(null)}
          onConfirm={async () => {
            const after = next ?? prev
            await deletePhotos(server.key, channel.id, [photo.id])
            if (after !== null) openPhotoViewer(server.key, channel.id, after)
          }} />
      )}
    </div>,
    document.body,
  )
}
