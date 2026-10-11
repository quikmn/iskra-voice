// Attachments, Discord-style: several images as a grid, spoilers (SPOILER_ in the file name, hidden until clicked),
// a full-screen gallery with zoom and swipe, inline previews of text files, and long pastes sent as message.txt.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, ChevronRight, Close, FileIcon } from '../icons'
import { useEscapeLayer, useFocusTrap } from '../layers'
import { formatSize } from './helpers'
import './media.css'

export const isSpoilerName = (name: string) => name.startsWith('SPOILER_')
export const shownName = (name: string) => name.replace(/^SPOILER_/, '')

/** A paste too long for one message becomes a text file. */
export function longTextFile(text: string): File {
  return new File([text], 'message.txt', { type: 'text/plain' })
}

export function SpoilerToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  const { t } = useTranslation()
  return (
    <button className={`spoiler-toggle ${on ? 'on' : ''}`} onClick={onToggle} aria-pressed={on} title={on ? t('chat.media.spoilerOnTitle') : t('chat.media.spoilerOffTitle')}>
      {on ? t('chat.media.spoiler') : t('chat.media.markSpoiler')}
    </button>
  )
}

/** Covers its child until clicked once. */
export function SpoilerCover({ active, children, className }: { active: boolean; children: React.ReactNode; className?: string }) {
  const [shown, setShown] = useState(false)
  const { t } = useTranslation()
  if (!active || shown) return <>{children}</>
  return (
    <div className={`spoiler-cover ${className ?? ''}`}>
      <div className="spoiler-blur" aria-hidden>{children}</div>
      <button className="spoiler-reveal" onClick={() => setShown(true)}>{t('chat.media.spoiler')}</button>
    </div>
  )
}

// ── Image grid ──────────────────────────────────────────────────────────────

export interface GalleryItem {
  url: string
  name: string
  size?: number
  width?: number | null
  height?: number | null
}

/** One image, or several as a grid; clicking opens the gallery at that image. */
export function ImageGrid({ items, onOpen }: { items: GalleryItem[]; onOpen: (index: number) => void }) {
  const { t } = useTranslation()
  if (items.length === 0) return null
  const single = items.length === 1
  return (
    <div className={`attachment-grid n${Math.min(items.length, 5)}`}>
      {items.map((item, i) => (
        <SpoilerCover key={item.url} active={isSpoilerName(item.name)} className="grid-cell">
          <button className="attachment-image grid-cell" onClick={() => onOpen(i)} aria-label={t('chat.media.openImage', { name: shownName(item.name) })}>
            <img src={item.url} alt={shownName(item.name)} loading="lazy" style={single ? fitted(item) : undefined} />
          </button>
        </SpoilerCover>
      ))}
    </div>
  )
}

const fitted = (item: GalleryItem) => {
  if (!item.width || !item.height) return undefined
  const scale = Math.min(1, 420 / item.width, 320 / item.height)
  return { width: Math.round(item.width * scale), height: Math.round(item.height * scale) }
}

// ── Gallery ─────────────────────────────────────────────────────────────────

const MAX_ZOOM = 4

/** Full-screen images: arrows or swipe to move, double-click/double-tap, wheel or pinch to zoom, drag to pan. */
export function Lightbox({ items, start, onClose }: { items: GalleryItem[]; start: number; onClose: () => void }) {
  const [index, setIndex] = useState(start)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [drag, setDrag] = useState({ x: 0, y: 0 })
  const ref = useRef<HTMLDivElement>(null)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const gesture = useRef<{ x: number; y: number; pan: { x: number; y: number }; pinch?: number; zoom: number; lastTap?: number } | null>(null)
  const lastTap = useRef(0)
  /** The last gesture moved, so the click that follows it isn't a tap on the backdrop. */
  const dragged = useRef(false)
  const item = items[index]
  const { t } = useTranslation()
  useEscapeLayer(onClose)
  useFocusTrap(ref)

  const go = (delta: number) => {
    if (items.length < 2) return
    setIndex((i) => (i + delta + items.length) % items.length)
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }
  const setZoomClamped = (z: number) => {
    const next = Math.min(MAX_ZOOM, Math.max(1, z))
    setZoom(next)
    if (next === 1) setPan({ x: 0, y: 0 })
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') go(1)
      else if (e.key === 'ArrowLeft') go(-1)
      else if (e.key === '+' || e.key === '=') setZoomClamped(zoom * 1.5)
      else if (e.key === '-') setZoomClamped(zoom / 1.5)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const distance = () => {
    const [a, b] = [...pointers.current.values()]
    return Math.hypot(a.x - b.x, a.y - b.y)
  }

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    gesture.current = { x: e.clientX, y: e.clientY, pan, zoom, pinch: pointers.current.size === 2 ? distance() : undefined }
  }
  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!pointers.current.has(e.pointerId) || !gesture.current) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const g = gesture.current
    if (pointers.current.size === 2 && g.pinch) return setZoomClamped((g.zoom * distance()) / g.pinch)
    const dx = e.clientX - g.x
    const dy = e.clientY - g.y
    if (zoom > 1) setPan({ x: g.pan.x + dx, y: g.pan.y + dy })
    else setDrag({ x: dx, y: dy })
  }
  function onPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    pointers.current.delete(e.pointerId)
    const g = gesture.current
    if (!g || pointers.current.size > 0) return
    gesture.current = null
    const dx = e.clientX - g.x
    const dy = e.clientY - g.y
    setDrag({ x: 0, y: 0 })
    const moved = Math.hypot(dx, dy) > 10
    dragged.current = moved
    if (!moved) {
      // Double tap / double click toggles zoom.
      const now = performance.now()
      if (now - lastTap.current < 300) setZoomClamped(zoom > 1 ? 1 : 2.5)
      lastTap.current = now
      return
    }
    if (zoom > 1 || g.pinch) return
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1)
    else if (dy > 120) onClose() // swipe down to close
  }

  if (!item) return null
  const transform = zoom > 1 ? `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` : `translate(${drag.x}px, ${Math.max(0, drag.y)}px)`
  return createPortal(
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={shownName(item.name)} ref={ref} tabIndex={-1}>
      <header className="lightbox-bar">
        <span className="lightbox-title">{shownName(item.name)}{item.size !== undefined && <span className="muted"> · {formatSize(item.size)}</span>}</span>
        {items.length > 1 && <span className="lightbox-count" aria-live="polite">{index + 1} / {items.length}</span>}
        <a className="button small" href={item.url} target="_blank" rel="noopener noreferrer" download={shownName(item.name)}>{t('chat.media.openOriginal')}</a>
        <button className="icon-button" onClick={onClose} aria-label={t('common.close')}><Close /></button>
      </header>
      <div
        className="lightbox-stage"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={(e) => setZoomClamped(zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2))}
        onClick={(e) => e.target === e.currentTarget && zoom === 1 && !dragged.current && onClose()}
      >
        <img
          src={item.url}
          alt={shownName(item.name)}
          draggable={false}
          className={zoom > 1 ? 'zoomed' : ''}
          style={{ transform, transition: gesture.current ? 'none' : undefined }}
        />
      </div>
      {items.length > 1 && (
        <>
          <button className="lightbox-nav prev" onClick={() => go(-1)} aria-label={t('chat.media.previous')}><ChevronLeft size={28} /></button>
          <button className="lightbox-nav next" onClick={() => go(1)} aria-label={t('chat.media.next')}><ChevronRight size={28} /></button>
        </>
      )}
    </div>,
    document.body,
  )
}

// ── Text files ──────────────────────────────────────────────────────────────

const TEXT_FILE = /\.(txt|md|log|csv|json|ya?ml|toml|ini|xml|js|jsx|ts|tsx|py|cs|java|kt|c|h|cpp|go|rs|sh|ps1|sql|css|lua|rb|php)$/i
const MAX_PREVIEW_BYTES = 256 * 1024
const PREVIEW_LINES = 12

export const isTextFile = (name: string, size: number) => TEXT_FILE.test(name) && size <= MAX_PREVIEW_BYTES

/** The first lines of a text file, expandable; the text is shown as text, never interpreted. */
export function TextFilePreview({ url, name, size }: { url: string; name: string; size: number }) {
  const [text, setText] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const { t } = useTranslation()
  useEffect(() => {
    let alive = true
    fetch(url)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error())))
      .then((buffer) => alive && setText(new TextDecoder('utf-8', { fatal: false }).decode(buffer.slice(0, MAX_PREVIEW_BYTES))))
      .catch(() => alive && setText(null))
    return () => {
      alive = false
    }
  }, [url])
  const lines = text?.split('\n') ?? []
  const long = lines.length > PREVIEW_LINES
  return (
    <div className="text-file">
      <div className="text-file-head">
        <span className="file-icon" aria-hidden><FileIcon size={18} /></span>
        <span className="file-name">{shownName(name)}</span>
        <span className="muted">{formatSize(size)}</span>
        <a className="button small" href={url} download={shownName(name)} target="_blank" rel="noopener noreferrer">{t('common.download')}</a>
      </div>
      {text !== null && (
        <>
          <pre className="text-file-body">{expanded || !long ? text : lines.slice(0, PREVIEW_LINES).join('\n')}</pre>
          {long && <button className="link text-file-more" onClick={() => setExpanded((e) => !e)}>{expanded ? t('chat.media.showLess') : t('chat.media.showAllLines', { count: lines.length })}</button>}
        </>
      )}
    </div>
  )
}
