// Getting a picked file ready for a photos channel, on this device: decide what it is from its bytes, remove its
// metadata (core/photoMetadata.ts, core/mp4Metadata.ts), read its size and date, and draw its thumbnail. Nothing here
// talks to a server; state/photos.ts uploads the result.
import { t } from '../i18n'
import { cleanPicture, exifTime, isPictureType, PhotoRefused } from '../core/photoMetadata'
import { cleanVideo, isVideoHead, patchedParts, VideoRefused, type ReadAt } from '../core/mp4Metadata'
import { HeifRefused, planHeif } from '../core/heifMetadata'
import { decodeHeif } from './heifDecode'
import { sniff } from '../core/sniff'
import { thumbSize } from './photosLogic'

export interface PreparedPhoto {
  /** The cleaned file, ready to upload. */
  blob: Blob
  name: string
  kind: 'image' | 'video'
  type: string
  /** As shown (after turning it upright); 0 when this device couldn't decode it. */
  width: number
  height: number
  duration?: number
  /** Only when the uploader keeps the date. */
  takenAt?: number
  /** A small JPEG; missing when this device couldn't decode the file (some phone videos on a computer). */
  thumb?: Blob
  /** HEIC and AVIF: a full-size JPEG every app can show, next to the original. */
  display?: Blob
}

/** A file a photos channel doesn't take, with the reason in the app's language. */
export class NotAPhoto extends Error {}

const VIDEO_WAIT_MS = 10_000

async function head(file: Blob, bytes = 64): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(0, bytes).arrayBuffer())
}

function toJpeg(canvas: HTMLCanvasElement, quality = 0.82): Promise<Blob | undefined> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob ?? undefined), 'image/jpeg', quality))
}

/** The quality of the JPEG made from a HEIC or AVIF for apps that can't draw the original (which is kept as well). */
const DISPLAY_QUALITY = 0.92

function draw(source: CanvasImageSource, width: number, height: number): Promise<Blob | undefined> {
  const size = thumbSize(width, height)
  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  const context = canvas.getContext('2d')
  if (!context) return Promise.resolve(undefined)
  // Transparent pictures get the app's dark tile behind them instead of black.
  context.fillStyle = '#1b1b22'
  context.fillRect(0, 0, size.width, size.height)
  context.imageSmoothingQuality = 'high'
  context.drawImage(source, 0, 0, size.width, size.height)
  return toJpeg(canvas)
}

/** Decodes a picture the way browsers show it (turned upright) and draws its thumbnail. */
async function pictureThumb(blob: Blob): Promise<{ width: number; height: number; thumb?: Blob }> {
  const url = URL.createObjectURL(blob)
  try {
    const image = new Image()
    image.decoding = 'async'
    image.src = url
    await image.decode()
    const width = image.naturalWidth
    const height = image.naturalHeight
    return { width, height, thumb: await draw(image, width, height) }
  } catch {
    return { width: 0, height: 0 }
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Loads a video far enough to know its size and length, and draws the frame one second in. */
function videoThumb(blob: Blob): Promise<{ width: number; height: number; duration?: number; thumb?: Blob }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob)
    const video = document.createElement('video')
    let settled = false
    const finish = (result: { width: number; height: number; duration?: number; thumb?: Blob }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      video.removeAttribute('src')
      video.load()
      URL.revokeObjectURL(url)
      resolve(result)
    }
    const known = () => ({
      width: video.videoWidth, height: video.videoHeight,
      ...(Number.isFinite(video.duration) && video.duration > 0 ? { duration: Math.round(video.duration * 1000) } : {}),
    })
    const timer = setTimeout(() => finish(video.videoWidth ? known() : { width: 0, height: 0 }), VIDEO_WAIT_MS)
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    video.onerror = () => finish({ width: 0, height: 0 })
    video.onloadedmetadata = () => {
      // Sound but no picture: this device can't decode the video track, so there is no frame to wait for.
      if (!video.videoWidth) return finish(known())
      video.currentTime = Math.min(1, (Number.isFinite(video.duration) ? video.duration : 0) / 2)
    }
    video.onseeked = () => {
      void draw(video, video.videoWidth, video.videoHeight).then((thumb) => finish({ ...known(), ...(thumb ? { thumb } : {}) }), () => finish(known()))
    }
    video.src = url
  })
}

/**
 * Cleans a file and reads what the gallery needs. Throws `NotAPhoto` for anything a photos channel doesn't take
 * (decided from the bytes, not the name) or that can't be cleaned.
 */
export async function preparePhoto(file: File, keepDate: boolean): Promise<PreparedPhoto> {
  const first = await head(file)
  const kind = sniff(first)
  const fallbackDate = keepDate && file.lastModified > 0 ? file.lastModified : undefined
  if (isPictureType(kind.type)) {
    let cleaned: ReturnType<typeof cleanPicture>
    try {
      cleaned = cleanPicture(new Uint8Array(await file.arrayBuffer()), kind.type, keepDate)
    } catch (e) {
      if (e instanceof PhotoRefused) throw new NotAPhoto(t('photos.upload.damaged', { name: file.name }))
      throw e
    }
    const blob = new Blob([cleaned.bytes as Uint8Array<ArrayBuffer>], { type: kind.type })
    const shown = await pictureThumb(blob)
    const takenAt = keepDate ? exifTime(cleaned.kept) ?? fallbackDate : undefined
    return { blob, name: file.name, kind: 'image', type: kind.type, ...shown, ...(takenAt ? { takenAt } : {}) }
  }
  if (kind.type === 'image/heic' || kind.type === 'image/avif') {
    let blob: Blob
    let kept: Awaited<ReturnType<typeof planHeif>>['kept']
    try {
      const read: ReadAt = async (offset, length) => new Uint8Array(await file.slice(offset, Math.min(file.size, offset + length)).arrayBuffer())
      const plan = await planHeif(read, file.size, keepDate)
      kept = plan.kept
      blob = plan.patches.length === 0 ? file.slice(0, file.size, kind.type) : new Blob(patchedParts(file, plan.patches) as BlobPart[], { type: kind.type })
    } catch (e) {
      if (e instanceof HeifRefused) throw new NotAPhoto(t('photos.upload.uncleanable', { name: file.name }))
      throw e
    }
    // The original is kept as it is; a JPEG made here is what apps that can't draw HEIC show.
    const canvas = await decodeHeif(blob)
    const display = canvas ? await toJpeg(canvas, DISPLAY_QUALITY) : undefined
    if (!canvas || !display) throw new NotAPhoto(t('photos.upload.undecodable', { name: file.name }))
    const thumb = await draw(canvas, canvas.width, canvas.height)
    const takenAt = keepDate ? exifTime(kept) ?? fallbackDate : undefined
    return { blob, name: file.name, kind: 'image', type: kind.type, width: canvas.width, height: canvas.height, display, ...(thumb ? { thumb } : {}), ...(takenAt ? { takenAt } : {}) }
  }
  if (kind.type === 'video/mp4' && isVideoHead(first)) {
    let cleaned: Awaited<ReturnType<typeof cleanVideo>>
    try {
      cleaned = await cleanVideo(file, keepDate)
    } catch (e) {
      if (e instanceof VideoRefused) throw new NotAPhoto(t('photos.upload.uncleanable', { name: file.name }))
      throw e
    }
    const shown = await videoThumb(cleaned.blob)
    const takenAt = keepDate ? cleaned.createdAt ?? fallbackDate : undefined
    return { blob: cleaned.blob, name: file.name, kind: 'video', type: 'video/mp4', ...shown, ...(takenAt ? { takenAt } : {}) }
  }
  throw new NotAPhoto(t('photos.upload.notTaken', { name: file.name }))
}
