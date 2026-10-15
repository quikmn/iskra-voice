// Drawing a whiteboard on a canvas. Everything, text included, is drawn with the canvas API: nothing on a board ever
// becomes HTML. Paths and bounds are cached per object record (records are replaced, never changed), so a board with
// thousands of strokes redraws by replaying cached Path2Ds for what's on screen.
import { bounds, decodePoints, intersects, textBox, type Props, type Rect, type Shown } from '../../core/board'

/** screen = (board − (x, y)) × zoom */
export interface Camera {
  x: number
  y: number
  zoom: number
}

export const PAPER = '#fbfaf6'
const GRID = 'rgba(31, 35, 40, 0.09)'
export const NOTE_TEXT = '#1f2328'
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'

const paths = new WeakMap<object, Path2D>()
const boxes = new WeakMap<object, Rect>()

export function boundsOf(o: Props): Rect {
  let b = boxes.get(o)
  if (!b) {
    b = bounds(o)
    boxes.set(o, b)
  }
  return b
}

function strokePath(o: Props): Path2D {
  let p = paths.get(o)
  if (!p) {
    p = new Path2D()
    const pts = decodePoints(o)
    if (pts.length >= 2) {
      p.moveTo(pts[0], pts[1])
      if (pts.length === 2) p.lineTo(pts[0] + 0.01, pts[1])
      // Smooth through the midpoints (quadratic curves), which looks like ink rather than a polyline.
      for (let i = 2; i < pts.length - 2; i += 2) {
        const mx = (pts[i] + pts[i + 2]) / 2
        const my = (pts[i + 1] + pts[i + 3]) / 2
        p.quadraticCurveTo(pts[i], pts[i + 1], mx, my)
      }
      if (pts.length > 2) p.lineTo(pts[pts.length - 2], pts[pts.length - 1])
    }
    paths.set(o, p)
  }
  return p
}

/** A stroke being drawn (absolute points), not yet on the board. */
export function drawInk(ctx: CanvasRenderingContext2D, kind: 'pen' | 'hl', color: string, size: number, pts: number[]): void {
  if (pts.length < 2) return
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = color
  ctx.lineWidth = size
  if (kind === 'hl') ctx.globalAlpha = 0.35
  ctx.beginPath()
  ctx.moveTo(pts[0], pts[1])
  if (pts.length === 2) ctx.lineTo(pts[0] + 0.01, pts[1])
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1])
  ctx.stroke()
  ctx.restore()
}

function arrowHead(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, size: number): void {
  const angle = Math.atan2(y1 - y0, x1 - x0)
  const len = Math.max(10, size * 3.5)
  ctx.beginPath()
  ctx.moveTo(x1 - len * Math.cos(angle - 0.45), y1 - len * Math.sin(angle - 0.45))
  ctx.lineTo(x1, y1)
  ctx.lineTo(x1 - len * Math.cos(angle + 0.45), y1 - len * Math.sin(angle + 0.45))
  ctx.stroke()
}

/** Lines of a note's text wrapped to `width` (measured with the canvas). */
export function wrap(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const out: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const word of paragraph.split(/(\s+)/)) {
      const next = line + word
      if (line && ctx.measureText(next).width > width) {
        out.push(line.trimEnd())
        line = word.trimStart()
        // A single word longer than the note: break it.
        while (ctx.measureText(line).width > width && line.length > 1) {
          let cut = line.length - 1
          while (cut > 1 && ctx.measureText(line.slice(0, cut)).width > width) cut--
          out.push(line.slice(0, cut))
          line = line.slice(cut)
        }
      } else line = next
    }
    out.push(line)
  }
  return out
}

export type ImageSource = (src: string) => CanvasImageSource | null

/** Draws one object (board coordinates; the context carries the camera). */
export function drawObject(ctx: CanvasRenderingContext2D, o: Props, image: ImageSource): void {
  const x = o.x ?? 0
  const y = o.y ?? 0
  const w = o.w ?? 0
  const h = o.h ?? 0
  const size = o.size ?? 3
  const color = o.color ?? '#1f2328'
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = color
  ctx.lineWidth = size
  switch (o.kind) {
    case 'pen':
    case 'hl':
      if (o.kind === 'hl') ctx.globalAlpha = 0.35
      ctx.stroke(strokePath(o))
      break
    case 'line':
    case 'arrow':
      ctx.beginPath()
      ctx.moveTo(x, y)
      ctx.lineTo(x + w, y + h)
      ctx.stroke()
      if (o.kind === 'arrow') arrowHead(ctx, x, y, x + w, y + h, size)
      break
    case 'rect':
      if (o.fill) {
        ctx.fillStyle = o.fill
        ctx.fillRect(x, y, w, h)
      }
      ctx.strokeRect(x, y, w, h)
      break
    case 'ellipse':
      ctx.beginPath()
      ctx.ellipse(x + w / 2, y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2)
      if (o.fill) {
        ctx.fillStyle = o.fill
        ctx.fill()
      }
      ctx.stroke()
      break
    case 'text': {
      const fontSize = o.size ?? 24
      ctx.font = `${fontSize}px ${FONT}`
      ctx.fillStyle = color
      ctx.textBaseline = 'top'
      ;(o.text ?? '').split('\n').forEach((line, i) => ctx.fillText(line, x, y + i * fontSize * 1.25))
      break
    }
    case 'note': {
      const fontSize = o.size ?? 18
      ctx.shadowColor = 'rgba(0, 0, 0, 0.18)'
      ctx.shadowBlur = 8
      ctx.shadowOffsetY = 2
      ctx.fillStyle = o.color ?? '#fde68a'
      ctx.fillRect(x, y, w, h)
      ctx.shadowColor = 'transparent'
      ctx.font = `${fontSize}px ${FONT}`
      ctx.fillStyle = NOTE_TEXT
      ctx.textBaseline = 'top'
      const pad = 12
      ctx.beginPath()
      ctx.rect(x, y, w, h)
      ctx.clip()
      wrap(ctx, o.text ?? '', Math.max(10, w - pad * 2)).forEach((line, i) => ctx.fillText(line, x + pad, y + pad + i * fontSize * 1.3))
      break
    }
    case 'image': {
      const img = o.src ? image(o.src) : null
      if (img) ctx.drawImage(img, x, y, w, h)
      else {
        ctx.fillStyle = 'rgba(31, 35, 40, 0.06)'
        ctx.fillRect(x, y, w, h)
        ctx.strokeStyle = 'rgba(31, 35, 40, 0.25)'
        ctx.lineWidth = 1
        ctx.strokeRect(x, y, w, h)
      }
      break
    }
  }
  ctx.restore()
}

export function applyCamera(ctx: CanvasRenderingContext2D, cam: Camera, dpr: number): void {
  ctx.setTransform(dpr * cam.zoom, 0, 0, dpr * cam.zoom, -cam.x * cam.zoom * dpr, -cam.y * cam.zoom * dpr)
}

/** The paper and its dot grid (screen size in CSS pixels). */
export function drawPaper(ctx: CanvasRenderingContext2D, cam: Camera, width: number, height: number, dpr: number): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.fillStyle = PAPER
  ctx.fillRect(0, 0, width, height)
  let step = 32 * cam.zoom
  while (step < 14) step *= 2
  const ox = -((cam.x * cam.zoom) % step)
  const oy = -((cam.y * cam.zoom) % step)
  ctx.fillStyle = GRID
  for (let sx = ox; sx < width; sx += step) {
    for (let sy = oy; sy < height; sy += step) ctx.fillRect(sx - 1, sy - 1, 2, 2)
  }
}

export interface DrawOptions {
  /** Objects not drawn (being erased). */
  hidden?: ReadonlySet<string>
  /** Objects drawn moved (being dragged). */
  offset?: { ids: ReadonlySet<string>; dx: number; dy: number }
}

/** Draws every object on screen, bottom to top. */
export function drawObjects(ctx: CanvasRenderingContext2D, list: readonly Shown[], view: Rect, image: ImageSource, options: DrawOptions = {}): void {
  for (const o of list) {
    if (options.hidden?.has(o.id)) continue
    const moving = options.offset?.ids.has(o.id)
    const b = boundsOf(o)
    if (moving) {
      const { dx, dy } = options.offset!
      if (!intersects({ x0: b.x0 + dx, y0: b.y0 + dy, x1: b.x1 + dx, y1: b.y1 + dy }, view)) continue
      ctx.save()
      ctx.translate(dx, dy)
      drawObject(ctx, o, image)
      ctx.restore()
    } else if (intersects(b, view)) drawObject(ctx, o, image)
  }
}

/** Everything on the board, or null when it's empty. */
export function contentBounds(list: readonly Shown[]): Rect | null {
  if (list.length === 0) return null
  const r = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
  for (const o of list) {
    const b = boundsOf(o)
    r.x0 = Math.min(r.x0, b.x0); r.y0 = Math.min(r.y0, b.y0)
    r.x1 = Math.max(r.x1, b.x1); r.y1 = Math.max(r.y1, b.y1)
  }
  return r
}

/** The camera that shows `r` in a `width` × `height` view, with a margin. */
export function fitCamera(r: Rect | null, width: number, height: number): Camera {
  if (!r) return { x: -width / 2, y: -height / 2, zoom: 1 }
  const margin = 48
  const zoom = Math.max(0.1, Math.min(2, (width - margin * 2) / Math.max(1, r.x1 - r.x0), (height - margin * 2) / Math.max(1, r.y1 - r.y0)))
  return { x: (r.x0 + r.x1) / 2 - width / 2 / zoom, y: (r.y0 + r.y1) / 2 - height / 2 / zoom, zoom }
}

/** The whole board as a PNG (at most 8192 pixels on a side). */
export async function exportPng(list: readonly Shown[], image: ImageSource): Promise<Blob> {
  const r = contentBounds(list) ?? { x0: 0, y0: 0, x1: 400, y1: 300 }
  const pad = 32
  const w = r.x1 - r.x0 + pad * 2
  const h = r.y1 - r.y0 + pad * 2
  const scale = Math.min(2, 8192 / w, 8192 / h)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(w * scale))
  canvas.height = Math.max(1, Math.round(h * scale))
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = PAPER
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.setTransform(scale, 0, 0, scale, (pad - r.x0) * scale, (pad - r.y0) * scale)
  drawObjects(ctx, list, { x0: -Infinity, y0: -Infinity, x1: Infinity, y1: Infinity }, image)
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('export failed'))), 'image/png'))
}

/** The text box of a text object as the canvas measures it (more exact than textBox). */
export function measuredText(ctx: CanvasRenderingContext2D, o: Props): { w: number; h: number } {
  const size = o.size ?? 24
  ctx.save()
  ctx.font = `${size}px ${FONT}`
  const lines = (o.text ?? '').split('\n')
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width), size * 0.5)
  ctx.restore()
  return { w, h: lines.length * size * 1.25 || textBox(o).h }
}

export const FONT_FAMILY = FONT
