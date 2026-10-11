// Pick the square part of a picture to use as your avatar: drag to move, slide to zoom.
import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { AVATAR_SIZE } from '../../core/profile'
import { Modal } from '../bits'

const VIEW = 240

export function AvatarCropper({ file, onCancel, onDone }: { file: File; onCancel: () => void; onDone: (image: Blob) => void }) {
  const { t } = useTranslation()
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const drag = useRef<{ x: number; y: number; from: { x: number; y: number } } | null>(null)

  useEffect(() => {
    const objectUrl = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      setUrl(objectUrl)
      setImage(img)
      const s = Math.max(VIEW / img.naturalWidth, VIEW / img.naturalHeight)
      setOffset({ x: (VIEW - img.naturalWidth * s) / 2, y: (VIEW - img.naturalHeight * s) / 2 })
    }
    img.onerror = () => setError(t('profile.notPicture'))
    img.src = objectUrl
    return () => URL.revokeObjectURL(objectUrl)
  }, [file])

  const scale = image ? Math.max(VIEW / image.naturalWidth, VIEW / image.naturalHeight) * zoom : 1
  const clamp = (x: number, y: number) =>
    image
      ? {
          x: Math.min(0, Math.max(VIEW - image.naturalWidth * scale, x)),
          y: Math.min(0, Math.max(VIEW - image.naturalHeight * scale, y)),
        }
      : { x, y }

  function changeZoom(next: number) {
    if (!image) return
    // Zoom around the middle of the view.
    const ratio = next / zoom
    const center = VIEW / 2
    setZoom(next)
    const nextScale = Math.max(VIEW / image.naturalWidth, VIEW / image.naturalHeight) * next
    const x = center - (center - offset.x) * ratio
    const y = center - (center - offset.y) * ratio
    setOffset({
      x: Math.min(0, Math.max(VIEW - image.naturalWidth * nextScale, x)),
      y: Math.min(0, Math.max(VIEW - image.naturalHeight * nextScale, y)),
    })
  }

  function onPointerDown(e: PointerEvent) {
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, y: e.clientY, from: offset }
  }
  function onPointerMove(e: PointerEvent) {
    if (!drag.current) return
    setOffset(clamp(drag.current.from.x + e.clientX - drag.current.x, drag.current.from.y + e.clientY - drag.current.y))
  }

  async function save() {
    if (!image) return
    setBusy(true)
    const canvas = document.createElement('canvas')
    canvas.width = AVATAR_SIZE
    canvas.height = AVATAR_SIZE
    const ctx = canvas.getContext('2d')!
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(image, -offset.x / scale, -offset.y / scale, VIEW / scale, VIEW / scale, 0, 0, AVATAR_SIZE, AVATAR_SIZE)
    const encode = (type: string) => new Promise<Blob | null>((done) => canvas.toBlob(done, type, 0.9))
    // WebP where the browser can make it (smaller), PNG otherwise.
    let blob = await encode('image/webp')
    if (!blob || blob.type !== 'image/webp') blob = await encode('image/png')
    setBusy(false)
    if (blob) onDone(blob)
    else setError(t('profile.cantProcess'))
  }

  return (
    <Modal
      title={t('profile.crop')}
      onClose={onCancel}
      footer={
        <>
          <button className="button" onClick={onCancel}>{t('common.cancel')}</button>
          <button className="button primary" disabled={!image || busy} onClick={() => void save()}>{t('profile.usePicture')}</button>
        </>
      }
    >
      {error ? (
        <p className="error-text">{error}</p>
      ) : (
        <div className="cropper">
          <div
            className="crop-view"
            style={{ width: VIEW, height: VIEW }}
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
          <label className="field">
            <span>{t('profile.zoom')}</span>
            <input type="range" min={1} max={4} step={0.01} value={zoom} onChange={(e) => changeZoom(Number(e.target.value))} aria-label={t('profile.zoom')} />
          </label>
        </div>
      )}
    </Modal>
  )
}
