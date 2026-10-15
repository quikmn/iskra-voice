// Pick the part of a picture to use: drag to move, slide to zoom. Square for avatars and server icons, wide for banners.
// The result is drawn on a canvas and encoded again, so nothing of the original file (EXIF, GPS) goes along.
import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { AVATAR_SIZE } from '../../core/profile'
import { Modal } from '../bits'

export interface CropShape {
  /** The picture made, in pixels. */
  width: number
  height: number
  /** The bytes it may take; past that it's encoded smaller (JPEG), else refused. */
  maxBytes?: number
  /** Round preview (avatars, icons) or rounded rectangle. */
  round?: boolean
}

const AVATAR: CropShape = { width: AVATAR_SIZE, height: AVATAR_SIZE, round: true }
const VIEW_MAX = 240
const WIDE_VIEW_MAX = 320

export function AvatarCropper({ file, onCancel, onDone, shape = AVATAR, title, confirm }: {
  file: File; onCancel: () => void; onDone: (image: Blob) => void; shape?: CropShape; title?: string; confirm?: string
}) {
  const { t } = useTranslation()
  const wide = shape.width > shape.height
  const viewW = wide ? WIDE_VIEW_MAX : Math.round(VIEW_MAX * Math.min(1, shape.width / shape.height))
  const viewH = Math.round(viewW * shape.height / shape.width)
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const drag = useRef<{ x: number; y: number; from: { x: number; y: number } } | null>(null)

  const fit = (img: HTMLImageElement) => Math.max(viewW / img.naturalWidth, viewH / img.naturalHeight)

  useEffect(() => {
    const objectUrl = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      setUrl(objectUrl)
      setImage(img)
      const s = fit(img)
      setOffset({ x: (viewW - img.naturalWidth * s) / 2, y: (viewH - img.naturalHeight * s) / 2 })
    }
    img.onerror = () => setError(t('profile.notPicture'))
    img.src = objectUrl
    return () => URL.revokeObjectURL(objectUrl)
  }, [file])

  const scale = image ? fit(image) * zoom : 1
  const clampTo = (x: number, y: number, s: number) =>
    image
      ? {
          x: Math.min(0, Math.max(viewW - image.naturalWidth * s, x)),
          y: Math.min(0, Math.max(viewH - image.naturalHeight * s, y)),
        }
      : { x, y }

  function changeZoom(next: number) {
    if (!image) return
    // Zoom around the middle of the view.
    const ratio = next / zoom
    setZoom(next)
    const x = viewW / 2 - (viewW / 2 - offset.x) * ratio
    const y = viewH / 2 - (viewH / 2 - offset.y) * ratio
    setOffset(clampTo(x, y, fit(image) * next))
  }

  function onPointerDown(e: PointerEvent) {
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, y: e.clientY, from: offset }
  }
  function onPointerMove(e: PointerEvent) {
    if (!drag.current) return
    setOffset(clampTo(drag.current.from.x + e.clientX - drag.current.x, drag.current.from.y + e.clientY - drag.current.y, scale))
  }

  async function save() {
    if (!image) return
    setBusy(true)
    const canvas = document.createElement('canvas')
    canvas.width = shape.width
    canvas.height = shape.height
    const ctx = canvas.getContext('2d')!
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(image, -offset.x / scale, -offset.y / scale, viewW / scale, viewH / scale, 0, 0, shape.width, shape.height)
    const encode = (type: string, quality = 0.9) => new Promise<Blob | null>((done) => canvas.toBlob(done, type, quality))
    // WebP where the browser can make it (smaller), PNG otherwise; JPEG if that's still too big.
    let blob = await encode('image/webp')
    if (!blob || blob.type !== 'image/webp') blob = await encode('image/png')
    if (shape.maxBytes && blob && blob.size > shape.maxBytes) blob = await encode('image/jpeg', 0.85)
    setBusy(false)
    if (blob && (!shape.maxBytes || blob.size <= shape.maxBytes)) onDone(blob)
    else setError(t('profile.cantProcess'))
  }

  return (
    <Modal
      title={title ?? t('profile.crop')}
      onClose={onCancel}
      footer={
        <>
          <button className="button" onClick={onCancel}>{t('common.cancel')}</button>
          <button className="button primary" disabled={!image || busy} onClick={() => void save()}>{confirm ?? t('profile.usePicture')}</button>
        </>
      }
    >
      {error ? (
        <p className="error-text">{error}</p>
      ) : (
        <div className="cropper">
          <div
            className={`crop-view ${shape.round === false ? 'rect' : ''}`}
            style={{ width: viewW, height: viewH }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={() => (drag.current = null)}
            onPointerCancel={() => (drag.current = null)}
          >
            {image && url && (
              <img
                src={url}
                alt=""
                draggable={false}
                style={{ width: image.naturalWidth * scale, height: image.naturalHeight * scale, transform: `translate(${offset.x}px, ${offset.y}px)` }}
              />
            )}
          </div>
          <label className="field" style={{ width: viewW }}>
            <span>{t('profile.zoom')}</span>
            <input type="range" min={1} max={4} step={0.01} value={zoom} onChange={(e) => changeZoom(Number(e.target.value))} aria-label={t('profile.zoom')} />
          </label>
        </div>
      )}
    </Modal>
  )
}
