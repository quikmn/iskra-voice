// Photos channels: each channel's photos, albums and storage figures, kept live from events; the upload queue
// (clean on this device, make a thumbnail, upload, add); opening the envelopes of encrypted channels; the viewer; and
// the notification for a batch of new photos. See "Photos channels" in PROTOCOL.md.
import { create } from 'zustand'
import { RequestError, type Events, type Photo, type PhotoAlbum, type PhotoItem, type PhotoUsage, type Thread } from '../core/protocol'
import { b64u, randomBytes } from '../core/crypto'
import { cleanName, encryptedSize, type DmFile } from '../core/dmFiles'
import { DmError } from '../core/dm'
import { GroupBehindError, sameKey } from '../core/group'
import { MAX_ALBUM_NAME, MissingPhotoKey, openAlbum, openPhoto, sealPhoto, type PhotoEnvelope, type SealedPhoto } from '../core/photoCrypto'
import { ZipWriter } from '../core/zip'
import { errorMessage } from '../i18n/errors'
import { t } from '../i18n'
import { desktop } from '../platform/desktop'
import { native } from '../platform/native'
import { connectionFor, onChannelsGone, onServerEvent, onWelcomeHook, selectChannel, selectServer, useApp } from './store'
import { withoutChannels } from './channelGone'
import { cannotWrite, channelOpenKeys, channelSealKey, isEncrypted, syncChannel, useE2ee } from './e2eeChannels'
import { downloadDmFile, uploadEncrypted } from './dmFiles'
import { downloadFile } from './backups'
import { openThread, rememberThreads } from './threads'
import { show } from './notify'
import { notifyFor } from './organize'
import { shouldNotify } from './organizeLogic'
import { channelConv, isOnScreen, noteMessage, readOf, useReads } from './readState'
import { senderRules } from './senderRules'
import { NotAPhoto, preparePhoto, type PreparedPhoto } from './photoPrepare'
import {
  countAlbums, fits, mergePhotos, plainAlbum, plainPhoto, sealedPhoto, type Locked, type ShownAlbum, type ShownPhoto,
} from './photosLogic'

const KEEP_DATE_KEY = 'iskra.photos.keepDate'
const PAGE = 500
/** Photos sent in one photo.add: fewer in an encrypted channel, where each carries an envelope. */
const ADD_PLAIN = 20
const ADD_SEALED = 5
const UPLOADS_AT_ONCE = 3

export interface Gallery {
  photos: ShownPhoto[]
  albums: ShownAlbum[]
  usage?: PhotoUsage
  loading: boolean
  loaded: boolean
  error: string | null
}

export type UploadState = 'waiting' | 'preparing' | 'uploading' | 'adding' | 'done' | 'failed'

export interface PhotoUpload {
  id: string
  serverKey: string
  channelId: number
  batch: string
  name: string
  size: number
  fraction: number
  state: UploadState
  error?: string
}

interface PhotosState {
  /** `${serverKey}:${channelId}` → what this device has of the channel. */
  galleries: Record<string, Gallery>
  uploads: PhotoUpload[]
  /** The photo open in the viewer. */
  viewer: { serverKey: string; channelId: number; photoId: number } | null
}

export const usePhotos = create<PhotosState>(() => ({ galleries: {}, uploads: [], viewer: null }))

export const galleryKey = (serverKey: string, channelId: number) => `${serverKey}:${channelId}`

const EMPTY: Gallery = { photos: [], albums: [], loading: false, loaded: false, error: null }

function connection(serverKey: string) {
  const c = connectionFor(serverKey)
  if (!c) throw new Error(t('errors.codes.disconnected'))
  return c
}

const myKey = (serverKey: string) => useApp.getState().servers[serverKey]?.me?.accountKey ?? ''

function patch(key: string, change: (gallery: Gallery) => Partial<Gallery>): void {
  usePhotos.setState((s) => (s.galleries[key] ? { galleries: { ...s.galleries, [key]: { ...s.galleries[key], ...change(s.galleries[key]) } } } : s))
}

export function keepsDate(): boolean {
  try {
    return localStorage.getItem(KEEP_DATE_KEY) !== '0'
  } catch {
    return true
  }
}

export function setKeepsDate(keep: boolean): void {
  try {
    localStorage.setItem(KEEP_DATE_KEY, keep ? '1' : '0')
  } catch {
    /* private mode */
  }
}

// ── Encrypted channels: opening envelopes ───────────────────────────────────

/** What the server sent for encrypted channels, so envelopes can be opened again when a key arrives. */
const rawPhotos = new Map<string, Map<number, Photo>>()
const rawAlbums = new Map<string, Map<number, PhotoAlbum>>()

const chainOf = (envelope: unknown) => (envelope as Partial<PhotoEnvelope> | null)?.header?.chain
const versionOf = (envelope: unknown) => (envelope as Partial<PhotoEnvelope> | null)?.header?.version

/** Why an envelope didn't open: sealed before you could read the channel, a key still on its way, or something wrong. */
function lockOf(e: unknown, serverKey: string, envelope: unknown, view: { changes: { version: number; members: string[] }[] } | null): Locked {
  if (e instanceof GroupBehindError) return 'waiting'
  if (e instanceof MissingPhotoKey && view) {
    const me = myKey(serverKey)
    const wasIn = !!view.changes.find((c) => c.version === versionOf(envelope))?.members.some((m) => sameKey(m, me))
    return wasIn ? 'waiting' : 'before'
  }
  return 'error'
}

async function chainFor(serverKey: string, channelId: number, envelope: unknown, cache: Map<string, Awaited<ReturnType<typeof channelOpenKeys>>>) {
  const chain = chainOf(envelope)
  if (typeof chain !== 'string') return null
  if (!cache.has(chain)) {
    let found = await channelOpenKeys(serverKey, channelId, chain).catch(() => null)
    if (!found) found = await channelOpenKeys(serverKey, channelId, chain, true).catch(() => null)
    cache.set(chain, found)
  }
  return cache.get(chain) ?? null
}

/** The server's photos as the UI shows them: as they are, or (encrypted channels) with their envelopes opened on this device. */
async function shownPhotos(serverKey: string, channelId: number, photos: Photo[]): Promise<ShownPhoto[]> {
  const encrypted = isEncrypted(serverKey, channelId)
  if (!encrypted && photos.every((p) => !p.e2ee)) return photos.map(plainPhoto)
  const key = galleryKey(serverKey, channelId)
  const raw = rawPhotos.get(key) ?? new Map<number, Photo>()
  rawPhotos.set(key, raw)
  const chains = new Map<string, Awaited<ReturnType<typeof channelOpenKeys>>>()
  const out: ShownPhoto[] = []
  for (const p of photos) {
    raw.set(p.id, p)
    // A photo without an envelope in a channel this device knows as encrypted came from the server, not a member.
    if (!p.e2ee || !encrypted) {
      out.push(sealedPhoto(p, 'error'))
      continue
    }
    const found = await chainFor(serverKey, channelId, p.e2ee.envelope, chains)
    try {
      if (!found) throw new MissingPhotoKey()
      out.push(sealedPhoto(p, openPhoto(p.e2ee.envelope as PhotoEnvelope, p.uploader, channelId, found.view, (v) => found.keys.get(v))))
    } catch (e) {
      out.push(sealedPhoto(p, lockOf(e, serverKey, p.e2ee.envelope, found?.view ?? null)))
    }
  }
  return out
}

async function shownAlbums(serverKey: string, channelId: number, albums: PhotoAlbum[]): Promise<ShownAlbum[]> {
  const encrypted = isEncrypted(serverKey, channelId)
  if (!encrypted && albums.every((a) => !a.e2ee)) return albums.map(plainAlbum)
  const key = galleryKey(serverKey, channelId)
  const raw = rawAlbums.get(key) ?? new Map<number, PhotoAlbum>()
  rawAlbums.set(key, raw)
  const chains = new Map<string, Awaited<ReturnType<typeof channelOpenKeys>>>()
  const out: ShownAlbum[] = []
  for (const a of albums) {
    raw.set(a.id, a)
    const base = { ...plainAlbum(a), name: '' }
    if (!a.e2ee || !encrypted) {
      out.push({ ...base, locked: 'error' })
      continue
    }
    const found = await chainFor(serverKey, channelId, a.e2ee.envelope, chains)
    try {
      if (!found) throw new MissingPhotoKey()
      out.push({ ...base, name: openAlbum(a.e2ee.envelope as PhotoEnvelope, channelId, found.view, (v) => found.keys.get(v)).name })
    } catch (e) {
      out.push({ ...base, locked: lockOf(e, serverKey, a.e2ee.envelope, found?.view ?? null) })
    }
  }
  return out
}

/** A key or a chain change arrived: try the envelopes this device couldn't open again. */
async function reopen(serverKey: string, channelId: number): Promise<void> {
  const key = galleryKey(serverKey, channelId)
  const gallery = usePhotos.getState().galleries[key]
  if (!gallery) return
  const lockedPhotos = gallery.photos.filter((p) => p.locked === 'waiting').map((p) => rawPhotos.get(key)?.get(p.id)).filter((p): p is Photo => !!p)
  const lockedAlbums = gallery.albums.filter((a) => a.locked === 'waiting').map((a) => rawAlbums.get(key)?.get(a.id)).filter((a): a is PhotoAlbum => !!a)
  if (lockedPhotos.length === 0 && lockedAlbums.length === 0) return
  const [photos, albums] = await Promise.all([shownPhotos(serverKey, channelId, lockedPhotos), shownAlbums(serverKey, channelId, lockedAlbums)])
  patch(key, (g) => ({
    photos: mergePhotos(g.photos, photos.filter((p) => g.photos.some((had) => had.id === p.id))),
    albums: g.albums.map((a) => albums.find((x) => x.id === a.id) ?? a),
  }))
}

// A gallery's key is the encrypted channel's slot (both are `${serverKey}:${channelId}`).
useE2ee.subscribe((state, before) => {
  for (const [slot, crypto] of Object.entries(state.channels)) {
    const was = before.channels[slot]
    if (was && was.version === crypto.version && was.hasKey === crypto.hasKey) continue
    if (!usePhotos.getState().galleries[slot]) continue
    const at = slot.lastIndexOf(':')
    void reopen(slot.slice(0, at), Number(slot.slice(at + 1)))
  }
})

// ── Loading ─────────────────────────────────────────────────────────────────

const loads = new Map<string, Promise<void>>()

/** Loads a channel's albums, storage figures and every photo (a page at a time; the grid fills as they arrive). */
export function loadGallery(serverKey: string, channelId: number): Promise<void> {
  const key = galleryKey(serverKey, channelId)
  const running = loads.get(key)
  if (running) return running
  const run = (async () => {
    usePhotos.setState((s) => ({ galleries: { ...s.galleries, [key]: { ...(s.galleries[key] ?? EMPTY), loading: true, error: null } } }))
    try {
      const c = connection(serverKey)
      if (isEncrypted(serverKey, channelId)) await syncChannel(serverKey, channelId).catch(() => undefined)
      const info = await c.request('photo.info', { channelId })
      const albums = await shownAlbums(serverKey, channelId, info.albums)
      patch(key, () => ({ albums, usage: info.usage }))
      const seen = new Set<number>()
      let after = 0
      for (;;) {
        const page = await c.request('photo.list', { channelId, after, limit: PAGE })
        const shown = await shownPhotos(serverKey, channelId, page.photos)
        for (const p of shown) seen.add(p.id)
        patch(key, (g) => ({ photos: mergePhotos(g.photos, shown) }))
        if (!page.hasMore || page.photos.length === 0) break
        after = page.photos[page.photos.length - 1].id
      }
      // Photos deleted while this device was away aren't in any page: they go now.
      patch(key, (g) => ({ photos: g.photos.filter((p) => seen.has(p.id)), loading: false, loaded: true, error: null }))
    } catch (e) {
      patch(key, () => ({ loading: false, error: errorMessage(e) }))
    }
  })().finally(() => loads.delete(key))
  loads.set(key, run)
  return run
}

// ── Showing files ───────────────────────────────────────────────────────────

const serverUrl = (serverKey: string) => useApp.getState().servers[serverKey]?.url ?? ''

/** Which of a photo's files: its thumbnail, the picture or video as apps show it, or the original as it was added. */
export type PhotoPart = 'thumb' | 'view' | 'file'

/** What apps show for a photo: the copy made for display if it has one (a HEIC or AVIF original), else the original. */
function partOf<T>(photo: { kind: 'image' | 'video' }, files: { file?: T; thumb?: T; display?: T }, what: PhotoPart): T | undefined {
  if (what === 'file') return files.file
  const view = files.display ?? files.file
  return what === 'view' ? view : files.thumb ?? (photo.kind === 'image' ? view : undefined)
}

/** The URL of one of a photo's files in a channel the server can read. */
export function plainUrl(serverKey: string, photo: ShownPhoto, what: PhotoPart): string | null {
  const file = partOf(photo, photo, what)
  return file ? serverUrl(serverKey) + file.url : null
}

/** Decrypted files kept in memory as blob: URLs, the least recently used dropped first. */
class BlobCache {
  private readonly entries = new Map<string, Promise<string>>()
  private readonly max: number

  constructor(max: number) {
    this.max = max
  }

  get(tag: string, load: () => Promise<Blob>): Promise<string> {
    const had = this.entries.get(tag)
    if (had) {
      this.entries.delete(tag)
      this.entries.set(tag, had)
      return had
    }
    const run = load().then((blob) => URL.createObjectURL(blob))
    this.entries.set(tag, run)
    run.catch(() => this.entries.delete(tag))
    while (this.entries.size > this.max) {
      const [oldest, url] = this.entries.entries().next().value!
      this.entries.delete(oldest)
      void url.then((u) => URL.revokeObjectURL(u), () => undefined)
    }
    return run
  }

  clear(): void {
    for (const url of this.entries.values()) void url.then((u) => URL.revokeObjectURL(u), () => undefined)
    this.entries.clear()
  }
}

const thumbs = new BlobCache(600)
const originals = new BlobCache(4)

/** Links for encrypted files are asked for many at a time: every thumbnail wanted within a moment shares one request. */
const wanted = new Map<string, { serverKey: string; channelId: number; what: 'thumb' | 'display' | 'file'; ids: Map<number, { resolve: (url: string) => void; reject: (e: unknown) => void }[]> }>()
let linkTimer: ReturnType<typeof setTimeout> | null = null

function linkFor(serverKey: string, channelId: number, photoId: number, what: 'thumb' | 'display' | 'file'): Promise<string> {
  return new Promise((resolve, reject) => {
    const tag = `${serverKey}:${channelId}:${what}`
    const group = wanted.get(tag) ?? { serverKey, channelId, what, ids: new Map() }
    wanted.set(tag, group)
    group.ids.set(photoId, [...(group.ids.get(photoId) ?? []), { resolve, reject }])
    linkTimer ??= setTimeout(flushLinks, what === 'thumb' ? 30 : 0)
  })
}

function flushLinks(): void {
  linkTimer = null
  const groups = [...wanted.values()]
  wanted.clear()
  for (const group of groups) {
    const ids = [...group.ids.keys()]
    for (let i = 0; i < ids.length; i += 200) {
      const part = ids.slice(i, i + 200)
      const settle = (links: Record<string, string> | null, error?: unknown) => {
        for (const id of part) {
          const link = links?.[String(id)]
          for (const waiter of group.ids.get(id) ?? []) {
            if (link) waiter.resolve(link)
            else waiter.reject(error ?? new DmError(t('photos.viewer.cannotOpen')))
          }
        }
      }
      const c = connectionFor(group.serverKey)
      if (!c) settle(null, new Error(t('errors.codes.disconnected')))
      else c.request('photo.links', { channelId: group.channelId, ids: part, what: group.what }).then((r) => settle(r.links), (e) => settle(null, e))
    }
  }
}

/** A blob: URL of one of an encrypted photo's files, decrypted and checked on this device. */
export function sealedUrl(serverKey: string, photo: ShownPhoto, what: PhotoPart, onProgress?: (fraction: number) => void): Promise<string> {
  const sealed = photo.sealed
  const file: DmFile | undefined = sealed && partOf(sealed, sealed, what)
  if (!sealed || !file) return Promise.reject(new DmError(t('photos.viewer.cannotOpen')))
  // A photo without a thumbnail shows its full picture in the grid too; that one counts as a full-size file.
  const which = file === sealed.thumb ? 'thumb' : file === sealed.display ? 'display' : 'file'
  return (which === 'thumb' ? thumbs : originals).get(`${serverKey}:${file.id}`, async () => {
    const link = await linkFor(serverKey, photo.channelId, photo.id, which)
    const opened = await downloadDmFile(file, link, onProgress)
    // What is shown must be something apps draw; an original that is only downloaded (a HEIC) may be anything.
    if (what !== 'file' && !opened.inline) throw new DmError(t('photos.viewer.cannotOpen'))
    return opened.blob
  })
}

// ── Uploading ───────────────────────────────────────────────────────────────

interface Job {
  upload: PhotoUpload
  file: File
  albumId: number | null
  keepDate: boolean
  total: number
  abort: AbortController
}

const jobs: Job[] = []
/** Uploaded and waiting to be listed in a photo.add. */
const ready: { job: Job; item: PhotoItem; sealed?: SealedPhoto }[] = []
let working = 0
let adding = false

const patchUpload = (id: string, change: Partial<PhotoUpload>) =>
  usePhotos.setState((s) => ({ uploads: s.uploads.map((u) => (u.id === id ? { ...u, ...change } : u)) }))

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A request that waits and tries again while the server says "slow down" (a big batch outruns the rate limit). */
async function patient<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run()
    } catch (e) {
      const slow = e instanceof RequestError && e.code === 'rate_limited' && !e.key
      if (!slow || attempt >= 30 || signal?.aborted) throw e
      await wait(1500)
    }
  }
}

function put(url: string, body: Blob, onProgress: (fraction: number) => void, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total)
    xhr.onload = () => {
      try {
        if (xhr.status !== 200) throw new Error()
        resolve((JSON.parse(xhr.responseText) as { file: { id: string } }).file.id)
      } catch {
        reject(new Error(xhr.status === 413 ? t('app.upload.tooBig') : t('app.upload.failedStatus', { status: xhr.status })))
      }
    }
    xhr.onerror = () => reject(new Error(t('app.upload.failed')))
    xhr.onabort = () => reject(new DOMException('Upload cancelled.', 'AbortError'))
    signal.addEventListener('abort', () => xhr.abort(), { once: true })
    xhr.send(body)
  })
}

async function uploadOne(job: Job): Promise<void> {
  const { serverKey, channelId, id } = job.upload
  const signal = job.abort.signal
  patchUpload(id, { state: 'preparing' })
  const prepared: PreparedPhoto = await preparePhoto(job.file, job.keepDate)
  if (signal.aborted) throw new DOMException('Upload cancelled.', 'AbortError')
  const sealed = isEncrypted(serverKey, channelId)
  const server = useApp.getState().servers[serverKey]
  if (!server) throw new Error(t('errors.codes.disconnected'))
  const size = sealed ? encryptedSize(prepared.blob.size) : prepared.blob.size
  const thumbSize = prepared.thumb ? (sealed ? encryptedSize(prepared.thumb.size) : prepared.thumb.size) : undefined
  const displaySize = prepared.display ? (sealed ? encryptedSize(prepared.display.size) : prepared.display.size) : undefined
  // Checked here first so nothing is uploaded that the channel has no room for; the server checks again.
  const usage = usePhotos.getState().galleries[galleryKey(serverKey, channelId)]?.usage
  if (usage && !fits(usage, size + (thumbSize ?? 0) + (displaySize ?? 0))) {
    throw new Error(usage.capBytes !== null && usage.count < usage.maxPhotos
      ? t('errors.server.photos_full', { mb: Math.round(usage.capBytes / 1024 / 1024) }) : t('errors.server.photos_max', { max: usage.maxPhotos }))
  }
  const begun = await patient(() => connection(serverKey).request('photo.upload.begin', { channelId, size, name: prepared.name, ...(thumbSize ? { thumbSize } : {}), ...(displaySize ? { displaySize } : {}) }), signal)
  patchUpload(id, { state: 'uploading', fraction: 0 })
  const progress = (fraction: number) => patchUpload(id, { fraction: Math.min(0.99, fraction) })
  const name = cleanName(prepared.name)
  const base = { width: prepared.width, height: prepared.height, ...(prepared.duration ? { duration: prepared.duration } : {}), ...(prepared.takenAt ? { takenAt: prepared.takenAt } : {}) }

  if (sealed) {
    const file = await uploadEncrypted(server.url + begun.url, begun.partBytes, prepared.blob, progress, signal)
    const thumb = prepared.thumb && begun.thumbUrl ? await uploadEncrypted(server.url + begun.thumbUrl, begun.partBytes, prepared.thumb, () => undefined, signal) : undefined
    const display = prepared.display && begun.displayUrl ? await uploadEncrypted(server.url + begun.displayUrl, begun.partBytes, prepared.display, () => undefined, signal) : undefined
    if (prepared.display && !display) throw new Error(t('errors.server.photo_display_needed'))
    const content: SealedPhoto = {
      file: { server: serverKey, ...file, name, type: prepared.type, size: prepared.blob.size },
      ...(thumb ? { thumb: { server: serverKey, ...thumb, name: 'thumbnail.jpg', type: 'image/jpeg', size: prepared.thumb!.size } } : {}),
      ...(display ? { display: { server: serverKey, ...display, name: 'display.jpg', type: 'image/jpeg', size: prepared.display!.size } } : {}),
      kind: prepared.kind, name, ...base, caption: '',
    }
    ready.push({ job, item: { file: file.id, ...(thumb ? { thumb: thumb.id } : {}), ...(display ? { display: display.id } : {}) }, sealed: content })
  } else {
    const fileId = await put(server.url + begun.url, prepared.blob, progress, signal)
    const thumbId = prepared.thumb && begun.thumbUrl ? await put(server.url + begun.thumbUrl, prepared.thumb, () => undefined, signal) : undefined
    const displayId = prepared.display && begun.displayUrl ? await put(server.url + begun.displayUrl, prepared.display, () => undefined, signal) : undefined
    // An older server has no place for the copy: without it a HEIC can't be shown, so it isn't added.
    if (prepared.display && !displayId) throw new Error(t('errors.server.photo_display_needed'))
    ready.push({ job, item: { file: fileId, ...(thumbId ? { thumb: thumbId } : {}), ...(displayId ? { display: displayId } : {}), ...base } })
  }
  patchUpload(id, { state: 'adding', fraction: 0.99 })
}

function failUpload(job: Job, e: unknown): void {
  if ((e as Error)?.name === 'AbortError') {
    usePhotos.setState((s) => ({ uploads: s.uploads.filter((u) => u.id !== job.upload.id) }))
    return
  }
  patchUpload(job.upload.id, { state: 'failed', error: e instanceof NotAPhoto || !(e instanceof RequestError) ? (e as Error).message || errorMessage(e) : errorMessage(e) })
}

/** Lists uploaded photos in photo.add, a few per request, one request at a time (so a batch never outruns the server). */
async function addReady(): Promise<void> {
  if (adding) return
  adding = true
  try {
    while (ready.length > 0) {
      const first = ready[0]
      const { serverKey, channelId, batch } = first.job.upload
      const sealed = isEncrypted(serverKey, channelId)
      const same = (r: (typeof ready)[number]) => r.job.upload.batch === batch && r.job.albumId === first.job.albumId
      const group = ready.filter(same).slice(0, sealed ? ADD_SEALED : ADD_PLAIN)
      for (const r of group) ready.splice(ready.indexOf(r), 1)
      try {
        const common = { channelId, batch, total: first.job.total, keepDate: first.job.keepDate, ...(first.job.albumId !== null ? { albumId: first.job.albumId } : {}) }
        let result: { photos: Photo[]; usage: PhotoUsage }
        if (sealed) {
          result = await sealedRequest(serverKey, channelId, (view, key, identity) => connection(serverKey).request('photo.add', {
            ...common, version: view.version,
            items: group.map((r) => ({ ...r.item, envelope: sealPhoto(identity, view, key, channelId, 'photo', r.sealed!) })),
          }))
        } else {
          result = await patient(() => connection(serverKey).request('photo.add', { ...common, items: group.map((r) => r.item) }))
        }
        await putPhotos(serverKey, channelId, result.photos, result.usage)
        for (const r of group) patchUpload(r.job.upload.id, { state: 'done', fraction: 1 })
      } catch (e) {
        for (const r of group) failUpload(r.job, e)
      }
    }
  } finally {
    adding = false
  }
  // The queue is over: forget the finished ones after a moment (failed ones stay until dismissed).
  if (jobs.length === 0 && working === 0) setTimeout(clearFinished, 4000)
}

function clearFinished(): void {
  if (jobs.length > 0 || working > 0 || ready.length > 0) return
  usePhotos.setState((s) => ({ uploads: s.uploads.filter((u) => u.state !== 'done') }))
}

/** Jobs being prepared or uploaded right now, so cancelUploads can stop them. */
const active = new Set<Job>()

function pump(): void {
  while (working < UPLOADS_AT_ONCE && jobs.length > 0) {
    const job = jobs.shift()!
    working++
    active.add(job)
    uploadOne(job).catch((e) => failUpload(job, e)).finally(() => {
      working--
      active.delete(job)
      void addReady()
      pump()
    })
  }
}

/**
 * Queues files for a photos channel: each is cleaned and gets a thumbnail on this device, is uploaded (encrypted
 * first in an encrypted channel) and added. The whole pick is one batch, so people are told about it once.
 */
export function uploadPhotos(serverKey: string, channelId: number, files: File[], options: { albumId: number | null; keepDate: boolean }): void {
  if (files.length === 0) return
  const batch = b64u(randomBytes(12))
  const added: PhotoUpload[] = files.map((file) => ({
    id: b64u(randomBytes(9)), serverKey, channelId, batch, name: file.name, size: file.size, fraction: 0, state: 'waiting',
  }))
  usePhotos.setState((s) => ({ uploads: [...s.uploads.filter((u) => u.state !== 'done'), ...added] }))
  files.forEach((file, i) => jobs.push({ upload: added[i], file, albumId: options.albumId, keepDate: options.keepDate, total: files.length, abort: new AbortController() }))
  pump()
}

/** Takes the finished and failed uploads off the list. */
export function dismissUploads(): void {
  usePhotos.setState((s) => ({ uploads: s.uploads.filter((u) => u.state !== 'done' && u.state !== 'failed') }))
}

/** Stops everything still waiting or uploading in a channel (what was added already stays). */
export function cancelUploads(serverKey: string, channelId: number): void {
  const mine = (u: PhotoUpload) => u.serverKey === serverKey && u.channelId === channelId
  for (let i = jobs.length - 1; i >= 0; i--) if (mine(jobs[i].upload)) jobs.splice(i, 1)
  usePhotos.setState((s) => ({ uploads: s.uploads.filter((u) => !(mine(u) && u.state === 'waiting')) }))
  for (const job of active) if (mine(job.upload)) job.abort.abort()
}

// ── Sealing (encrypted channels) ────────────────────────────────────────────

type Identity = NonNullable<ReturnType<typeof useApp.getState>['identity']>
type SealKey = Awaited<ReturnType<typeof channelSealKey>>

/** Runs a request that seals under the channel's current key; if the members changed meanwhile, syncs and tries once more. */
async function sealedRequest<T>(serverKey: string, channelId: number, run: (view: SealKey['view'], key: Uint8Array, identity: Identity) => Promise<T>): Promise<T> {
  const identity = useApp.getState().identity
  if (!identity) throw new DmError(t('errors.codes.disconnected'))
  const blocked = cannotWrite(serverKey, channelId)
  if (blocked && blocked !== 'waiting') throw new DmError(blocked)
  for (let attempt = 0; ; attempt++) {
    const { view, key } = await channelSealKey(serverKey, channelId)
    try {
      return await run(view, key, identity)
    } catch (e) {
      if (e instanceof RequestError && e.code === 'conflict' && attempt === 0) {
        await syncChannel(serverKey, channelId)
        continue
      }
      throw e
    }
  }
}

// ── Keeping the gallery current ─────────────────────────────────────────────

async function putPhotos(serverKey: string, channelId: number, photos: Photo[], usage?: PhotoUsage): Promise<void> {
  const key = galleryKey(serverKey, channelId)
  if (!usePhotos.getState().galleries[key]) return
  const shown = await shownPhotos(serverKey, channelId, photos)
  patch(key, (g) => {
    const merged = mergePhotos(g.photos, shown)
    return { photos: merged, albums: countAlbums(g.albums, merged), ...(usage ? { usage } : {}) }
  })
}

async function putAlbums(serverKey: string, channelId: number, albums: PhotoAlbum[], replace: boolean): Promise<void> {
  const key = galleryKey(serverKey, channelId)
  if (!usePhotos.getState().galleries[key]) return
  const shown = await shownAlbums(serverKey, channelId, albums)
  patch(key, (g) => ({
    albums: replace ? shown : [...g.albums.filter((a) => !shown.some((x) => x.id === a.id)), ...shown].sort((a, b) => a.id - b.id),
  }))
}

function removePhotos(serverKey: string, channelId: number, ids: number[], usage?: PhotoUsage): void {
  const key = galleryKey(serverKey, channelId)
  const gone = new Set(ids)
  for (const id of ids) rawPhotos.get(key)?.delete(id)
  patch(key, (g) => {
    const photos = g.photos.filter((p) => !gone.has(p.id))
    return { photos, albums: countAlbums(g.albums, photos), ...(usage ? { usage } : {}) }
  })
  usePhotos.setState((s) => (s.viewer && s.viewer.serverKey === serverKey && gone.has(s.viewer.photoId) ? { viewer: null } : s))
}

// ── Changes ─────────────────────────────────────────────────────────────────

const chunks = <T,>(list: T[], size: number): T[][] => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size))

export async function deletePhotos(serverKey: string, channelId: number, ids: number[]): Promise<void> {
  for (const part of chunks(ids, 200)) {
    const { usage } = await patient(() => connection(serverKey).request('photo.delete', { ids: part }))
    removePhotos(serverKey, channelId, part, usage)
  }
}

export async function movePhotos(serverKey: string, channelId: number, ids: number[], albumId: number | null): Promise<void> {
  for (const part of chunks(ids, 200)) {
    await patient(() => connection(serverKey).request('photo.move', { ids: part, ...(albumId !== null ? { albumId } : {}) }))
    const moved = new Set(part)
    patch(galleryKey(serverKey, channelId), (g) => {
      const photos = g.photos.map((p) => (moved.has(p.id) ? { ...p, albumId } : p))
      return { photos, albums: countAlbums(g.albums, photos) }
    })
  }
}

export async function setCaption(serverKey: string, photo: ShownPhoto, caption: string): Promise<void> {
  const c = connection(serverKey)
  const { photo: updated } = photo.sealed
    ? await sealedRequest(serverKey, photo.channelId, (view, key, identity) => c.request('photo.update', {
      id: photo.id, version: view.version, envelope: sealPhoto(identity, view, key, photo.channelId, 'photo', { ...photo.sealed!, caption: caption.trim() }),
    }))
    : await c.request('photo.update', { id: photo.id, caption })
  await putPhotos(serverKey, photo.channelId, [updated])
}

export function reactToPhoto(serverKey: string, photo: ShownPhoto, emoji: string): void {
  const me = myKey(serverKey)
  const mine = photo.reactions.some((r) => r.emoji === emoji && r.accounts.includes(me))
  connectionFor(serverKey)?.request('photo.react', { id: photo.id, emoji, on: !mine }).catch(() => undefined)
}

/** Opens the photo's comments (its thread, made now if it has none). False if there are none and you can't write. */
export async function openComments(serverKey: string, photo: ShownPhoto): Promise<boolean> {
  const { thread } = await connection(serverKey).request('photo.comments', { id: photo.id })
  if (!thread) return false
  noteThread(serverKey, photo.channelId, photo.id, thread)
  openThread(serverKey, thread.id, thread)
  return true
}

function noteThread(serverKey: string, channelId: number, photoId: number, thread: Thread): void {
  rememberThreads(serverKey, [thread])
  patch(galleryKey(serverKey, channelId), (g) => ({
    photos: g.photos.map((p) => (p.id === photoId ? { ...p, threadId: thread.id, comments: thread.messageCount } : p)),
  }))
}

export async function createAlbum(serverKey: string, channelId: number, name: string): Promise<ShownAlbum> {
  const c = connection(serverKey)
  const { album } = isEncrypted(serverKey, channelId)
    ? await sealedRequest(serverKey, channelId, (view, key, identity) => c.request('photo.album.create', {
      channelId, version: view.version, envelope: sealPhoto(identity, view, key, channelId, 'album', { name: name.trim().slice(0, MAX_ALBUM_NAME) }),
    }))
    : await c.request('photo.album.create', { channelId, name })
  await putAlbums(serverKey, channelId, [album], false)
  return usePhotos.getState().galleries[galleryKey(serverKey, channelId)]?.albums.find((a) => a.id === album.id) ?? { ...plainAlbum(album), name: name.trim() }
}

export async function renameAlbum(serverKey: string, album: ShownAlbum, name: string): Promise<void> {
  const c = connection(serverKey)
  const { album: updated } = isEncrypted(serverKey, album.channelId)
    ? await sealedRequest(serverKey, album.channelId, (view, key, identity) => c.request('photo.album.update', {
      id: album.id, version: view.version, envelope: sealPhoto(identity, view, key, album.channelId, 'album', { name: name.trim().slice(0, MAX_ALBUM_NAME) }),
    }))
    : await c.request('photo.album.update', { id: album.id, name })
  await putAlbums(serverKey, album.channelId, [updated], false)
}

export async function setAlbumCover(serverKey: string, album: ShownAlbum, coverId: number | null): Promise<void> {
  const { album: updated } = await connection(serverKey).request('photo.album.update', { id: album.id, coverId })
  await putAlbums(serverKey, album.channelId, [updated], false)
}

export async function deleteAlbum(serverKey: string, album: ShownAlbum): Promise<void> {
  await connection(serverKey).request('photo.album.delete', { id: album.id })
  forgetAlbum(serverKey, album.channelId, album.id)
}

function forgetAlbum(serverKey: string, channelId: number, id: number): void {
  rawAlbums.get(galleryKey(serverKey, channelId))?.delete(id)
  patch(galleryKey(serverKey, channelId), (g) => ({
    albums: g.albums.filter((a) => a.id !== id),
    photos: g.photos.some((p) => p.albumId === id) ? g.photos.map((p) => (p.albumId === id ? { ...p, albumId: null } : p)) : g.photos,
  }))
}

export async function setCap(serverKey: string, channelId: number, mb: number | null): Promise<void> {
  const { usage } = await connection(serverKey).request('photo.cap.set', { channelId, mb })
  patch(galleryKey(serverKey, channelId), () => ({ usage }))
}

// ── Download as a zip ───────────────────────────────────────────────────────

interface Sink {
  write(data: Uint8Array): Promise<void>
  close(): Promise<void>
  abort(): Promise<void>
}

interface PickedFile {
  createWritable(): Promise<{ write(data: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> }>
}

/** Where a zip built on this device goes: straight to disk where the platform can, else gathered in memory and saved at the end. */
async function zipSink(name: string): Promise<Sink | null> {
  const bridge = desktop?.saveFile
  if (bridge) {
    const id = await bridge.begin(name)
    if (!id) return null
    const failed = () => new Error(t('photos.zip.saveFailed'))
    return {
      write: async (data) => {
        if (!(await bridge.write(id, data))) throw failed()
      },
      close: async () => {
        if (!(await bridge.finish(id))) throw failed()
      },
      abort: () => bridge.abort(id),
    }
  }
  const picker = (globalThis as { showSaveFilePicker?: (options: { suggestedName?: string }) => Promise<PickedFile> }).showSaveFilePicker
  if (typeof picker === 'function') {
    try {
      const writable = await (await picker.call(globalThis, { suggestedName: name })).createWritable()
      return { write: (data) => writable.write(data), close: () => writable.close(), abort: () => writable.abort().catch(() => undefined) }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return null
      // No picker after all (a browser that has the function but refuses it here): save from memory.
    }
  }
  const parts: Uint8Array<ArrayBuffer>[] = []
  return {
    write: async (data) => void parts.push(data.slice() as Uint8Array<ArrayBuffer>),
    abort: async () => void (parts.length = 0),
    close: async () => {
      const blob = new Blob(parts, { type: 'application/zip' })
      if (native) {
        await native.saveFile(blob, name)
        return
      }
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = name
      document.body.appendChild(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    },
  }
}

const zipName = (name: string) => `${cleanName(name).replace(/\.+$/, '') || 'photos'}.zip`

/**
 * Downloads the photos as a zip. A channel the server can read: the server builds it (a normal download). An encrypted
 * channel: this device downloads and decrypts each file and writes the zip itself. Resolves 'cancelled' if no place
 * to save was chosen. `photos` is what the zip should hold (an album, the photos in no album, or everything).
 */
export async function downloadZip(
  serverKey: string, channelId: number, what: { albumId: number } | { all: true } | { loose: true }, name: string, photos: ShownPhoto[],
  onProgress: (done: number, total: number) => void, signal?: AbortSignal,
): Promise<'started' | 'saved' | 'cancelled'> {
  if (!isEncrypted(serverKey, channelId)) {
    const { url } = await connection(serverKey).request('photo.album.zip', { channelId, ...('albumId' in what ? { albumId: what.albumId } : 'all' in what ? { all: true } : {}) })
    downloadFile(serverUrl(serverKey) + url)
    return 'started'
  }
  const readable = photos.filter((p) => p.sealed).sort((a, b) => a.sortAt - b.sortAt || a.id - b.id)
  if (readable.length === 0) throw new Error(t('errors.server.photo_zip_empty'))
  const sink = await zipSink(zipName(name))
  if (!sink) return 'cancelled'
  try {
    const zip = new ZipWriter((bytes) => sink.write(bytes))
    let done = 0
    onProgress(0, readable.length)
    for (const photo of readable) {
      if (signal?.aborted) throw new DOMException('Cancelled.', 'AbortError')
      const link = await linkFor(serverKey, channelId, photo.id, 'file')
      const { blob } = await downloadDmFile(photo.sealed!.file, link, undefined, signal)
      await zip.add(photo.name || `photo-${photo.id}`, new Uint8Array(await blob.arrayBuffer()), new Date(photo.sortAt))
      onProgress(++done, readable.length)
    }
    await zip.finish()
    await sink.close()
    return 'saved'
  } catch (e) {
    await sink.abort().catch(() => undefined)
    if ((e as Error).name === 'AbortError') return 'cancelled'
    throw e
  }
}

// ── The viewer and links ────────────────────────────────────────────────────

export function openPhotoViewer(serverKey: string, channelId: number, photoId: number): void {
  usePhotos.setState({ viewer: { serverKey, channelId, photoId } })
}

export function closePhotoViewer(): void {
  usePhotos.setState({ viewer: null })
}

/** Goes to a photos channel and opens one of its photos (a link, a notification). */
export function goToPhoto(serverKey: string, channelId: number, photoId: number): void {
  const app = useApp.getState()
  if (!app.servers[serverKey]) return
  if (app.activeServer !== serverKey) selectServer(serverKey)
  if (useApp.getState().activeChannel[serverKey] !== channelId) selectChannel(serverKey, channelId)
  openPhotoViewer(serverKey, channelId, photoId)
}

// ── Notifications ───────────────────────────────────────────────────────────

/** A batch of new photos from someone else notifies once, like a message, by your settings for the channel. */
function notifyBatch(serverKey: string, event: Events['photo.added']): void {
  const server = useApp.getState().servers[serverKey]
  if (!server || !event.batch?.first || event.by === myKey(serverKey) || senderRules.ignored(event.by)) return
  if (!shouldNotify(notifyFor(serverKey, event.channelId), false)) return
  if (isOnScreen(channelConv(serverKey, event.channelId))) return
  const channel = server.channels.find((c) => c.id === event.channelId)
  const author = server.members[event.by]?.name ?? t('common.someone')
  const count = Math.max(event.batch.total, event.photos.length)
  show(serverKey, t('app.notify.authorIn', { author, where: `#${channel?.name ?? ''}` }), t('photos.notify.added', { count }),
    () => goToPhoto(serverKey, event.channelId, event.photos[0].id), false, undefined, { kind: 'message', channelId: event.channelId })
}

// ── Live updates ────────────────────────────────────────────────────────────

onServerEvent((serverKey, type, body) => {
  if (type === 'photo.added') {
    const event = body as Events['photo.added']
    void putPhotos(serverKey, event.channelId, event.photos, event.usage)
    notifyBatch(serverKey, event)
    const newest = event.photos.reduce((best, p) => (p.id > best.id ? p : best), event.photos[0])
    // One unread mark per batch, not per photo or per request of a batch.
    if (newest) noteNewest(serverKey, event.channelId, newest.id, newest.createdAt, event.by, !event.batch || event.batch.first, true)
  } else if (type === 'photo.updated') {
    const { photo } = body as Events['photo.updated']
    void putPhotos(serverKey, photo.channelId, [photo])
  } else if (type === 'photo.moved') {
    const { channelId, ids, albumId, albums } = body as Events['photo.moved']
    const moved = new Set(ids)
    patch(galleryKey(serverKey, channelId), (g) => ({ photos: g.photos.map((p) => (moved.has(p.id) ? { ...p, albumId } : p)) }))
    void putAlbums(serverKey, channelId, albums, true)
  } else if (type === 'photo.deleted') {
    const { channelId, ids, usage, albums } = body as Events['photo.deleted']
    removePhotos(serverKey, channelId, ids, usage)
    void putAlbums(serverKey, channelId, albums, true)
  } else if (type === 'photo.reactions') {
    const { channelId, id, reactions } = body as Events['photo.reactions']
    patch(galleryKey(serverKey, channelId), (g) => ({ photos: g.photos.map((p) => (p.id === id ? { ...p, reactions } : p)) }))
  } else if (type === 'photo.album.updated') {
    const { album } = body as Events['photo.album.updated']
    void putAlbums(serverKey, album.channelId, [album], false)
  } else if (type === 'photo.album.deleted') {
    const { channelId, id } = body as Events['photo.album.deleted']
    forgetAlbum(serverKey, channelId, id)
  } else if (type === 'photo.usage') {
    const { channelId, usage } = body as Events['photo.usage']
    patch(galleryKey(serverKey, channelId), () => ({ usage }))
  } else if (type === 'thread.updated') {
    // A comment was written or deleted: the photo's count follows.
    const { thread } = body as Events['thread.updated']
    patch(galleryKey(serverKey, thread.channelId), (g) =>
      g.photos.some((p) => p.threadId === thread.id && p.comments !== thread.messageCount)
        ? { photos: g.photos.map((p) => (p.threadId === thread.id ? { ...p, comments: thread.messageCount } : p)) } : {})
  }
})

// ── Unread ──────────────────────────────────────────────────────────────────
// A photos channel is unread when someone else added photos since you last looked at it. Like all read state it is
// kept on this device: the newest photo id seen per channel, and the newest one this device knows of.

const SEEN_KEY = 'iskra.photos.seen'

function loadSeen(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}') as Record<string, number>
  } catch {
    return {}
  }
}

const seen = loadSeen()
const newestKnown: Record<string, number> = {}

function saveSeen(key: string, id: number): void {
  if ((seen[key] ?? 0) >= id) return
  seen[key] = id
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen))
  } catch {
    /* private mode */
  }
}

/** The newest photo of a channel, as an event or photo.latest told it. `count`: whether it counts as a new unread batch. */
function noteNewest(serverKey: string, channelId: number, id: number, at: number, by: string, count: boolean, live: boolean): void {
  const key = galleryKey(serverKey, channelId)
  if (id <= (newestKnown[key] ?? 0)) return
  newestKnown[key] = id
  const conv = channelConv(serverKey, channelId)
  // Your own photos, photos you're looking at, and what was there when this device first met the channel aren't news.
  if (by === myKey(serverKey) || isOnScreen(conv) || (!live && !(key in seen))) return saveSeen(key, id)
  if (id > (seen[key] ?? 0) && (count || readOf(conv).unread === 0)) noteMessage(conv, { id, at }, false)
}

// Opening the channel (or marking it read) reads it: what this device knows of counts as seen from then on.
useReads.subscribe((state, before) => {
  if (state.convs === before.convs) return
  for (const [key, id] of Object.entries(newestKnown)) {
    if ((seen[key] ?? 0) >= id) continue
    const at = key.lastIndexOf(':')
    if (!state.convs[channelConv(key.slice(0, at), Number(key.slice(at + 1)))]?.unread) saveSeen(key, id)
  }
})

/** After connecting: what was added to each photos channel while this device was away. */
async function loadLatest(serverKey: string): Promise<void> {
  try {
    const { channels } = await connection(serverKey).request('photo.latest', {})
    for (const c of channels) noteNewest(serverKey, c.channelId, c.id, c.at, c.by, true, false)
  } catch {
    /* an older server without photos channels */
  }
}

onWelcomeHook((serverKey) => {
  void loadLatest(serverKey)
  // What we had may be stale after a reconnect: a gallery on screen loads again (its view asks), the others when shown.
  usePhotos.setState((s) => ({
    galleries: Object.fromEntries(Object.entries(s.galleries).map(([k, g]) => (k.startsWith(`${serverKey}:`) ? [k, { ...g, loaded: false }] : [k, g]))),
  }))
})

function forgetGalleries(keys: string[]): void {
  for (const key of keys) {
    rawPhotos.delete(key)
    rawAlbums.delete(key)
  }
}

// A channel that's gone (deleted, or no longer readable): its photos leave this device.
onChannelsGone((serverKey, channelIds) => {
  forgetGalleries(channelIds.map((id) => galleryKey(serverKey, id)))
  usePhotos.setState((s) => ({
    galleries: withoutChannels(s.galleries, serverKey, channelIds),
    viewer: s.viewer && s.viewer.serverKey === serverKey && channelIds.includes(s.viewer.channelId) ? null : s.viewer,
  }))
})

// A server removed from this device takes its photos along.
useApp.subscribe((state, before) => {
  if (state.order === before.order) return
  const gone = before.order.filter((k) => !state.order.includes(k))
  if (!gone.length) return
  usePhotos.setState((s) => {
    const dropped = Object.keys(s.galleries).filter((k) => gone.some((g) => k.startsWith(`${g}:`)))
    forgetGalleries(dropped)
    if (dropped.length) {
      thumbs.clear()
      originals.clear()
    }
    return {
      galleries: Object.fromEntries(Object.entries(s.galleries).filter(([k]) => !dropped.includes(k))),
      viewer: s.viewer && gone.includes(s.viewer.serverKey) ? null : s.viewer,
    }
  })
})
