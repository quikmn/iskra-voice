// Photos channels, the parts without the network or the DOM: what a photo looks like to the UI, sorting and
// filtering, the justified grid's rows (with month headers), which rows are on screen, moving between photos with the
// keyboard, album covers, and the storage figures.
import type { FileInfo, Photo, PhotoAlbum, PhotoReaction, PhotoUsage } from '../core/protocol'
import type { SealedPhoto } from '../core/photoCrypto'

/** Why an encrypted photo can't be shown on this device. */
export type Locked = 'before' | 'waiting' | 'error'

/** A photo as the UI shows it: the server's fields, or what its envelope held once this device opened it. */
export interface ShownPhoto {
  id: number
  channelId: number
  albumId: number | null
  uploader: string
  createdAt: number
  /** The date taken, else when it was added. */
  sortAt: number
  takenAt: number | null
  kind: 'image' | 'video'
  name: string
  width: number
  height: number
  duration: number | null
  caption: string
  size: number
  reactions: PhotoReaction[]
  comments: number
  threadId: number | null
  /** Channels the server can read. */
  file?: FileInfo
  thumb?: FileInfo
  /** A full-size picture every app can draw, when the original is a HEIC or AVIF. */
  display?: FileInfo
  /** Encrypted channels: the opened envelope (file keys), or why it couldn't be opened. */
  sealed?: SealedPhoto
  locked?: Locked
}

export interface ShownAlbum {
  id: number
  channelId: number
  name: string
  coverId: number | null
  createdBy: string
  createdAt: number
  count: number
  locked?: Locked
}

/** A photo of a channel the server can read. */
export function plainPhoto(p: Photo): ShownPhoto {
  return {
    id: p.id, channelId: p.channelId, albumId: p.albumId, uploader: p.uploader, createdAt: p.createdAt, sortAt: p.takenAt ?? p.createdAt,
    takenAt: p.takenAt, kind: p.kind === 'video' ? 'video' : 'image', name: p.file?.name ?? '', width: p.width, height: p.height,
    duration: p.duration, caption: p.caption, size: p.size, reactions: p.reactions, comments: p.comments, threadId: p.threadId,
    ...(p.file ? { file: p.file } : {}), ...(p.thumb ? { thumb: p.thumb } : {}), ...(p.display ? { display: p.display } : {}),
  }
}

/** A photo of an encrypted channel: `opened` is its envelope's content, or why this device couldn't open it. */
export function sealedPhoto(p: Photo, opened: SealedPhoto | Locked): ShownPhoto {
  const base = {
    id: p.id, channelId: p.channelId, albumId: p.albumId, uploader: p.uploader, createdAt: p.createdAt, size: p.size,
    reactions: p.reactions, comments: p.comments, threadId: p.threadId,
  }
  if (typeof opened === 'string') {
    return { ...base, sortAt: p.createdAt, takenAt: null, kind: 'image', name: '', width: 0, height: 0, duration: null, caption: '', locked: opened }
  }
  return {
    ...base, sortAt: opened.takenAt ?? p.createdAt, takenAt: opened.takenAt ?? null, kind: opened.kind, name: opened.name,
    width: opened.width, height: opened.height, duration: opened.duration ?? null, caption: opened.caption, sealed: opened,
  }
}

export const plainAlbum = (a: PhotoAlbum): ShownAlbum =>
  ({ id: a.id, channelId: a.channelId, name: a.name, coverId: a.coverId, createdBy: a.createdBy, createdAt: a.createdAt, count: a.count })

// ── Sorting and filtering ───────────────────────────────────────────────────

export type PhotoSort = 'newest' | 'oldest'

export interface PhotoView {
  /** 'all': the whole channel; 'none': photos in no album; a number: that album. */
  album: 'all' | 'none' | number
  /** An account key: only that person's photos. */
  person: string | null
  sort: PhotoSort
}

export const DEFAULT_VIEW: PhotoView = { album: 'all', person: null, sort: 'newest' }

/** The photos a view shows, in its order (by date taken, else upload time; the same moment: by when they were added). */
export function visiblePhotos(photos: readonly ShownPhoto[], view: PhotoView): ShownPhoto[] {
  const shown = photos.filter((p) =>
    (view.album === 'all' || (view.album === 'none' ? p.albumId === null : p.albumId === view.album))
    && (view.person === null || p.uploader === view.person))
  const direction = view.sort === 'newest' ? -1 : 1
  return shown.sort((a, b) => (a.sortAt - b.sortAt || a.id - b.id) * direction)
}

/** Who has photos here, most photos first (then by key, so the order is steady). */
export function uploaders(photos: readonly ShownPhoto[]): { key: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const p of photos) counts.set(p.uploader, (counts.get(p.uploader) ?? 0) + 1)
  return [...counts].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
}

/** The photo an album shows as its cover: the one picked, else its newest that this device can show. */
export function albumCover(album: Pick<ShownAlbum, 'id' | 'coverId'>, photos: readonly ShownPhoto[]): ShownPhoto | undefined {
  const mine = photos.filter((p) => p.albumId === album.id && !p.locked)
  return mine.find((p) => p.id === album.coverId) ?? mine.reduce<ShownPhoto | undefined>((best, p) => (!best || p.sortAt > best.sortAt || (p.sortAt === best.sortAt && p.id > best.id) ? p : best), undefined)
}

/** Upserts photos into a list kept in id order. */
export function mergePhotos(list: readonly ShownPhoto[], incoming: readonly ShownPhoto[]): ShownPhoto[] {
  if (incoming.length === 0) return list as ShownPhoto[]
  const byId = new Map(list.map((p) => [p.id, p]))
  for (const p of incoming) byId.set(p.id, p)
  return [...byId.values()].sort((a, b) => a.id - b.id)
}

/** Album counts after photos moved or were deleted, from the photos this device has (the server's counts win when it sends them). */
export function countAlbums(albums: readonly ShownAlbum[], photos: readonly ShownPhoto[]): ShownAlbum[] {
  const counts = new Map<number, number>()
  for (const p of photos) if (p.albumId !== null) counts.set(p.albumId, (counts.get(p.albumId) ?? 0) + 1)
  return albums.map((a) => ((counts.get(a.id) ?? 0) === a.count ? a : { ...a, count: counts.get(a.id) ?? 0 }))
}

// ── The grid ────────────────────────────────────────────────────────────────

/** Width over height as the grid draws a photo: its own shape within sane limits; a square when unknown. */
export function tileRatio(p: Pick<ShownPhoto, 'width' | 'height'>): number {
  if (!(p.width > 0) || !(p.height > 0)) return 1
  return Math.min(2.4, Math.max(0.5, p.width / p.height))
}

export interface Tile {
  id: number
  left: number
  width: number
}

export type GridRow =
  | { kind: 'header'; key: string; top: number; height: number; month: string }
  | { kind: 'photos'; key: string; top: number; height: number; tiles: Tile[] }

export interface GridLayout {
  rows: GridRow[]
  height: number
}

export const HEADER_HEIGHT = 40

/** "2026-07" in local time: photos are grouped by the month they were taken. */
export function monthOf(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/**
 * A justified grid: rows as wide as the container, every photo in its own shape, each row as close to `target` high
 * as its photos allow. The last row of a month keeps the target height instead of stretching. With `months`, a header
 * row starts each month. Pure arithmetic, so thousands of photos lay out in a few milliseconds.
 */
export function layoutGrid(photos: readonly ShownPhoto[], width: number, target: number, gap: number, months = true): GridLayout {
  const rows: GridRow[] = []
  let top = 0
  if (width <= 0) return { rows, height: 0 }
  let month = ''
  let pending: { id: number; ratio: number }[] = []
  let ratios = 0

  const flush = (last: boolean) => {
    if (pending.length === 0) return
    const inner = width - gap * (pending.length - 1)
    // A full row is stretched or squeezed to the width; a last, short row keeps the target height.
    const height = last && inner / ratios > target ? target : Math.max(40, inner / ratios)
    let left = 0
    const tiles = pending.map((item, i) => {
      const w = i === pending.length - 1 && !(last && inner / ratios > target) ? width - left : Math.round(height * item.ratio)
      const tile = { id: item.id, left, width: Math.max(1, w) }
      left += tile.width + gap
      return tile
    })
    rows.push({ kind: 'photos', key: `r${pending[0].id}`, top, height: Math.round(height), tiles })
    top += Math.round(height) + gap
    pending = []
    ratios = 0
  }

  for (const photo of photos) {
    const m = monthOf(photo.sortAt)
    if (months && m !== month) {
      flush(true)
      month = m
      rows.push({ kind: 'header', key: `h${m}`, top, height: HEADER_HEIGHT, month: m })
      top += HEADER_HEIGHT
    }
    const ratio = tileRatio(photo)
    pending.push({ id: photo.id, ratio })
    ratios += ratio
    if ((width - gap * (pending.length - 1)) / ratios <= target) flush(false)
  }
  flush(true)
  return { rows, height: Math.max(0, top - gap) }
}

/** The rows that intersect the viewport, with `overscan` pixels above and below (binary search: rows are in order). */
export function rowsInView(rows: readonly GridRow[], scrollTop: number, viewport: number, overscan = 600): GridRow[] {
  if (rows.length === 0) return []
  const from = scrollTop - overscan
  const to = scrollTop + viewport + overscan
  let lo = 0
  let hi = rows.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (rows[mid].top + rows[mid].height < from) lo = mid + 1
    else hi = mid
  }
  const out: GridRow[] = []
  for (let i = lo; i < rows.length && rows[i].top <= to; i++) out.push(rows[i])
  return out
}

/** The row a photo is in, for scrolling it into view. */
export function rowOf(rows: readonly GridRow[], id: number): GridRow | undefined {
  return rows.find((r) => r.kind === 'photos' && r.tiles.some((t) => t.id === id))
}

export type GridKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End'

/** Where the arrow keys go from a photo: left and right in reading order, up and down to the tile above or below. */
export function moveInGrid(rows: readonly GridRow[], order: readonly ShownPhoto[], id: number, key: GridKey): number | null {
  const index = order.findIndex((p) => p.id === id)
  if (index < 0) return order[0]?.id ?? null
  if (key === 'Home') return order[0].id
  if (key === 'End') return order[order.length - 1].id
  if (key === 'ArrowLeft') return order[index - 1]?.id ?? null
  if (key === 'ArrowRight') return order[index + 1]?.id ?? null
  const photoRows = rows.filter((r): r is Extract<GridRow, { kind: 'photos' }> => r.kind === 'photos')
  const at = photoRows.findIndex((r) => r.tiles.some((t) => t.id === id))
  const next = photoRows[at + (key === 'ArrowUp' ? -1 : 1)]
  if (at < 0 || !next) return null
  const tile = photoRows[at].tiles.find((t) => t.id === id)!
  const middle = tile.left + tile.width / 2
  return next.tiles.reduce((best, t) => (Math.abs(t.left + t.width / 2 - middle) < Math.abs(best.left + best.width / 2 - middle) ? t : best)).id
}

/** The photo before or after one in the viewer's order (null at the ends). */
export function stepPhoto(order: readonly ShownPhoto[], id: number, step: -1 | 1): number | null {
  const index = order.findIndex((p) => p.id === id)
  return index < 0 ? null : order[index + step]?.id ?? null
}

/** The ids between two photos in the grid's order, both included (shift-click selects a run). */
export function rangeIds(order: readonly ShownPhoto[], from: number, to: number): number[] {
  const a = order.findIndex((p) => p.id === from)
  const b = order.findIndex((p) => p.id === to)
  if (a < 0 || b < 0) return b >= 0 ? [to] : []
  return order.slice(Math.min(a, b), Math.max(a, b) + 1).map((p) => p.id)
}

// ── Storage ─────────────────────────────────────────────────────────────────

/** How full the channel is, 0 to 1 (null without a cap). */
export function usedFraction(usage: Pick<PhotoUsage, 'bytes' | 'capBytes'>): number | null {
  if (usage.capBytes === null) return null
  return usage.capBytes <= 0 ? 1 : Math.min(1, usage.bytes / usage.capBytes)
}

/** Whether `bytes` more would fit (a channel without a cap takes anything up to its photo count). */
export function fits(usage: PhotoUsage | undefined, bytes: number, count = 1): boolean {
  if (!usage) return true
  if (usage.count + count > usage.maxPhotos) return false
  return usage.capBytes === null || usage.bytes + bytes <= usage.capBytes
}

/** Megabytes typed into the cap field: a whole number from 1 up, or null for "no limit" (empty). Undefined: not valid. */
export function parseCapMb(text: string, unit: 'MB' | 'GB'): number | null | undefined {
  const trimmed = text.trim().replace(',', '.')
  if (trimmed === '') return null
  const n = Number(trimmed)
  if (!Number.isFinite(n) || n <= 0) return undefined
  const mb = Math.round(unit === 'GB' ? n * 1024 : n)
  return mb >= 1 && mb <= 4 * 1024 * 1024 ? mb : undefined
}

/** A cap in bytes as the field shows it: whole gigabytes as GB, anything else as MB. */
export function capField(capBytes: number | null): { text: string; unit: 'MB' | 'GB' } {
  if (capBytes === null) return { text: '', unit: 'GB' }
  const mb = Math.round(capBytes / 1024 / 1024)
  return mb >= 1024 && mb % 1024 === 0 ? { text: String(mb / 1024), unit: 'GB' } : { text: String(mb), unit: 'MB' }
}

/** "1:05" or "1:02:03" for a video's length. */
export function durationText(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

/** The size a thumbnail is drawn at: `short` pixels on its short side, never wider than `maxLong`, never enlarged. */
export function thumbSize(width: number, height: number, short = 400, maxLong = 1200): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: short, height: short }
  const scale = Math.min(1, short / Math.min(width, height), maxLong / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** What an upload queue shows in one line: how many are done, how many failed, and the whole queue's progress. */
export function queueSummary(uploads: readonly { state: string; fraction: number; size: number }[]): { total: number; done: number; failed: number; fraction: number; active: boolean } {
  const total = uploads.length
  const done = uploads.filter((u) => u.state === 'done').length
  const failed = uploads.filter((u) => u.state === 'failed').length
  const bytes = uploads.reduce((n, u) => n + Math.max(1, u.size), 0)
  const sent = uploads.reduce((n, u) => n + Math.max(1, u.size) * (u.state === 'done' || u.state === 'failed' ? 1 : u.fraction), 0)
  return { total, done, failed, fraction: bytes > 0 ? sent / bytes : 0, active: done + failed < total }
}
