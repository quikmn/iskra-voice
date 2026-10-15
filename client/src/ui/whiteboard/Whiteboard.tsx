// The whiteboard itself: an infinite canvas (pan, zoom, fit), the tools, live cursors, and the text editor for text
// and sticky notes. Used by whiteboard channels and by the board a voice call opens.
//
// Two canvases: the board (paper, grid, objects), redrawn only when the board or the view changes, and an overlay on top
// (the stroke being drawn, others' cursors and strokes, selection), redrawn freely. Input is Pointer Events, so mouse,
// touch and pen all work; with a pen, fingers move the board instead of drawing (palm rejection), and two fingers pinch.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  encodePoints, hits, intersects, moved, newObjectId, round, simplify, type BoardKind, type Op, type Point, type Props, type Rect, type Shown,
} from '../../core/board'
import type { Channel } from '../../core/protocol'
import { uploadFile, type ServerState } from '../../state/store'
import {
  boardKey, change, clearBoard, closeBoard, openBoard, redo, setLive, subscribeBoard, undo, useWhiteboard, type Session,
} from '../../state/whiteboard'
import { errorMessage } from '../../i18n/errors'
import { formatNumber } from '../../i18n/format'
import { Modal, Spinner } from '../bits'
import { Trash } from '../icons'
import {
  ArrowIcon, ClearIcon, DownloadIcon, EllipseIcon, EraserIcon, FitIcon, HandIcon, HighlighterIcon, ImageIcon, LineIcon, NoteIcon, PenIcon, RectIcon,
  RedoIcon, SelectIcon, TextIcon, UndoIcon, ZoomInIcon, ZoomOutIcon,
} from './icons'
import {
  applyCamera, boundsOf, contentBounds, drawInk, drawObject, drawObjects, drawPaper, exportPng, fitCamera, FONT_FAMILY, NOTE_TEXT, type Camera,
} from './render'
import './whiteboard.css'

export type Tool = 'select' | 'pan' | 'pen' | 'hl' | 'eraser' | 'line' | 'arrow' | 'rect' | 'ellipse' | 'text' | 'note'

export const COLORS = ['#1f2328', '#e5484d', '#f76b15', '#f5d90a', '#30a46c', '#0090ff', '#8e4ec6', '#ffffff'] as const
const COLOR_NAMES = ['black', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'white'] as const
const NOTE_COLORS: Record<string, string> = { '#1f2328': '#e5e7eb', '#ffffff': '#f3f4f6', '#e5484d': '#fecaca', '#f76b15': '#fed7aa', '#f5d90a': '#fde68a', '#30a46c': '#bbf7d0', '#0090ff': '#bfdbfe', '#8e4ec6': '#e9d5ff' }
const SIZES: Record<'stroke' | 'hl' | 'text', [number, number, number]> = { stroke: [2, 4, 8], hl: [12, 20, 32], text: [18, 28, 44] }
const KEYS: Record<string, Tool> = { v: 'select', h: 'pan', p: 'pen', m: 'hl', e: 'eraser', l: 'line', a: 'arrow', r: 'rect', o: 'ellipse', t: 'text', n: 'note' }
const MIN_ZOOM = 0.1
const MAX_ZOOM = 8

interface Editing {
  id: string
  kind: 'text' | 'note'
  x: number
  y: number
  w?: number
  h?: number
  size: number
  color: string
  text: string
  isNew: boolean
}

type Gesture =
  | { kind: 'ink'; tool: 'pen' | 'hl'; id: string; points: Point[] }
  | { kind: 'shape'; tool: 'line' | 'arrow' | 'rect' | 'ellipse'; start: Point; end: Point }
  | { kind: 'erase'; ids: Set<string> }
  | { kind: 'move'; start: Point; dx: number; dy: number; ids: Set<string> }
  | { kind: 'marquee'; start: Point; end: Point }
  | { kind: 'pan'; last: { x: number; y: number } }

export function Whiteboard({ server, channel, canDraw, canClear, compact }: {
  server: ServerState
  channel: Channel
  /** May draw (the server checks too). */
  canDraw: boolean
  canClear: boolean
  /** In a call: a smaller toolbar. */
  compact?: boolean
}) {
  const { t } = useTranslation()
  const key = boardKey(server.key, channel.id)
  const board = useWhiteboard((s) => s.boards[key])
  const [session, setSession] = useState<Session | null>(null)
  const [tool, setTool] = useState<Tool>(canDraw ? 'pen' : 'select')
  const [color, setColor] = useState<string>(COLORS[0])
  const [sizeIndex, setSizeIndex] = useState(1)
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set())
  const [editing, setEditing] = useState<Editing | null>(null)
  const [zoom, setZoom] = useState(1)
  const [confirmClear, setConfirmClear] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [empty, setEmpty] = useState(true)

  const wrapRef = useRef<HTMLDivElement>(null)
  const baseRef = useRef<HTMLCanvasElement>(null)
  const overRef = useRef<HTMLCanvasElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const cam = useRef<Camera>({ x: -400, y: -300, zoom: 1 })
  const size = useRef({ w: 800, h: 600, dpr: 1 })
  const dirty = useRef({ base: true, over: true })
  const gesture = useRef<Gesture | null>(null)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const pinch = useRef<{ dist: number; mid: { x: number; y: number } } | null>(null)
  const penSeen = useRef(false)
  const fitted = useRef(false)
  const images = useRef(new Map<string, HTMLImageElement>())
  const selectionRef = useRef(selection)
  selectionRef.current = selection

  const encrypted = !!channel.e2ee
  const ready = board?.status === 'ready'
  const drawing = canDraw && ready
  const strokeSize = (t2: Tool) => (t2 === 'hl' ? SIZES.hl : t2 === 'text' || t2 === 'note' ? SIZES.text : SIZES.stroke)[sizeIndex]

  // ── Session ──
  useEffect(() => {
    const s = openBoard(server.key, channel.id)
    setSession(s)
    fitted.current = false
    return () => closeBoard(server.key, channel.id)
  }, [server.key, channel.id])

  const redraw = useCallback((base = true) => {
    if (base) dirty.current.base = true
    dirty.current.over = true
  }, [])

  useEffect(() => {
    if (!session) return
    return subscribeBoard(server.key, channel.id, () => {
      redraw(true)
      setEmpty(session.state.list().length === 0)
    })
  }, [session, server.key, channel.id, redraw])

  // Fit to content the first time the board is in.
  useEffect(() => {
    if (!ready || !session || fitted.current) return
    fitted.current = true
    fit()
    setEmpty(session.state.list().length === 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, session])

  // ── Images (pictures from this server's files) ──
  const image = useCallback((src: string): CanvasImageSource | null => {
    let img = images.current.get(src)
    if (!img) {
      img = new Image()
      img.crossOrigin = 'anonymous'
      img.onload = () => redraw(true)
      img.src = server.url + src
      images.current.set(src, img)
    }
    return img.complete && img.naturalWidth > 0 ? img : null
  }, [server.url, redraw])

  // ── Coordinates ──
  const toBoard = (clientX: number, clientY: number): Point => {
    const r = wrapRef.current!.getBoundingClientRect()
    return { x: cam.current.x + (clientX - r.left) / cam.current.zoom, y: cam.current.y + (clientY - r.top) / cam.current.zoom }
  }
  const viewRect = (): Rect => ({
    x0: cam.current.x, y0: cam.current.y, x1: cam.current.x + size.current.w / cam.current.zoom, y1: cam.current.y + size.current.h / cam.current.zoom,
  })

  function setCamera(next: Camera) {
    cam.current = { ...next, zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next.zoom)) }
    setZoom(cam.current.zoom)
    redraw(true)
  }

  function zoomAt(factor: number, sx = size.current.w / 2, sy = size.current.h / 2) {
    const c = cam.current
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, c.zoom * factor))
    const bx = c.x + sx / c.zoom
    const by = c.y + sy / c.zoom
    setCamera({ x: bx - sx / z, y: by - sy / z, zoom: z })
  }

  function fit() {
    if (!session) return
    setCamera(fitCamera(contentBounds(session.state.list()), size.current.w, size.current.h))
  }

  // ── Sizing and the render loop ──
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const w = wrap.clientWidth
      const h = wrap.clientHeight
      size.current = { w, h, dpr }
      for (const c of [baseRef.current, overRef.current]) {
        if (!c) continue
        c.width = Math.max(1, Math.round(w * dpr))
        c.height = Math.max(1, Math.round(h * dpr))
      }
      redraw(true)
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(wrap)
    return () => observer.disconnect()
  }, [redraw])

  useEffect(() => {
    let frame = 0
    let lastCursorTick = 0
    const loop = (now: number) => {
      frame = requestAnimationFrame(loop)
      const s = session
      if (!s) return
      // Cursors fade: redraw the overlay now and then while any are shown.
      if (s.cursors.size && now - lastCursorTick > 1000) {
        lastCursorTick = now
        dirty.current.over = true
      }
      const { w, h, dpr } = size.current
      const g = gesture.current
      if (dirty.current.base && baseRef.current) {
        dirty.current.base = false
        const ctx = baseRef.current.getContext('2d')!
        drawPaper(ctx, cam.current, w, h, dpr)
        applyCamera(ctx, cam.current, dpr)
        drawObjects(ctx, s.state.list(), viewRect(), image, {
          hidden: g?.kind === 'erase' ? g.ids : editing ? new Set([editing.id]) : undefined,
          offset: g?.kind === 'move' ? { ids: g.ids, dx: g.dx, dy: g.dy } : undefined,
        })
      }
      if (dirty.current.over && overRef.current) {
        dirty.current.over = false
        drawOverlay(overRef.current.getContext('2d')!, s, w, h, dpr)
      }
    }
    frame = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(frame)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, image, editing])

  useEffect(() => redraw(false), [selection, redraw])

  function drawOverlay(ctx: CanvasRenderingContext2D, s: Session, w: number, h: number, dpr: number) {
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, w * dpr, h * dpr)
    applyCamera(ctx, cam.current, dpr)
    const z = cam.current.zoom
    const now = Date.now()
    // Others' strokes being drawn, then this person's.
    for (const c of s.cursors.values()) if (c.draft && now - c.at < 10_000) drawInk(ctx, c.draft.kind, c.draft.color, c.draft.size, c.draft.pts)
    const g = gesture.current
    if (g?.kind === 'ink') drawInk(ctx, g.tool, color, strokeSize(g.tool), g.points.flatMap((p) => [p.x, p.y]))
    if (g?.kind === 'shape') drawObject(ctx, shapeProps(g.tool, g.start, g.end), image)
    // Selection.
    const list = s.state.list()
    ctx.lineWidth = 1.5 / z
    ctx.strokeStyle = '#0090ff'
    ctx.setLineDash([6 / z, 4 / z])
    const dx = g?.kind === 'move' ? g.dx : 0
    const dy = g?.kind === 'move' ? g.dy : 0
    for (const o of list) {
      if (!selectionRef.current.has(o.id)) continue
      const b = boundsOf(o)
      ctx.strokeRect(b.x0 - 4 / z + dx, b.y0 - 4 / z + dy, b.x1 - b.x0 + 8 / z, b.y1 - b.y0 + 8 / z)
    }
    if (g?.kind === 'marquee') {
      ctx.fillStyle = 'rgba(0, 144, 255, 0.08)'
      const r = norm(g.start, g.end)
      ctx.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0)
      ctx.strokeRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0)
    }
    ctx.setLineDash([])
    // Cursors with names (drawn text, never HTML).
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.font = `12px ${FONT_FAMILY}`
    ctx.textBaseline = 'middle'
    for (const c of s.cursors.values()) {
      const age = now - c.at
      if (age > 8000) continue
      const sx = (c.x - cam.current.x) * z
      const sy = (c.y - cam.current.y) * z
      if (sx < -20 || sy < -20 || sx > w + 20 || sy > h + 20) continue
      const hue = cursorColor(c.accountKey)
      ctx.globalAlpha = age > 5000 ? 1 - (age - 5000) / 3000 : 1
      ctx.fillStyle = hue
      ctx.beginPath()
      ctx.moveTo(sx, sy)
      ctx.lineTo(sx + 4, sy + 15)
      ctx.lineTo(sx + 8, sy + 9)
      ctx.lineTo(sx + 15, sy + 7)
      ctx.closePath()
      ctx.fill()
      const name = server.members[c.accountKey]?.name ?? t('whiteboard.someone')
      const label = name.length > 24 ? name.slice(0, 23) + '…' : name
      const tw = ctx.measureText(label).width
      ctx.fillRect(sx + 12, sy + 14, tw + 10, 18)
      ctx.fillStyle = '#ffffff'
      ctx.fillText(label, sx + 17, sy + 23)
      ctx.globalAlpha = 1
    }
  }

  // ── Changes ──
  const send = (ops: Op[]) => {
    if (!session || ops.length === 0) return
    try {
      change(session, ops)
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  const topZ = () => round((session?.state.maxZ ?? 0) + 1)

  function shapeProps(kind: 'line' | 'arrow' | 'rect' | 'ellipse', a: Point, b: Point): Props {
    return { kind, x: round(a.x), y: round(a.y), w: round(b.x - a.x), h: round(b.y - a.y), color, size: strokeSize(kind) }
  }

  function finishInk(g: Extract<Gesture, { kind: 'ink' }>) {
    let pts = g.points
    if (pts.length === 0) return
    let tolerance = 0.6 / cam.current.zoom
    pts = simplify(pts, tolerance)
    while (pts.length > 1900) {
      tolerance *= 2
      pts = simplify(pts, tolerance)
    }
    const ox = round(pts[0].x)
    const oy = round(pts[0].y)
    send([{ id: g.id, p: { kind: g.tool, x: ox, y: oy, pts: encodePoints(pts, ox, oy), color, size: strokeSize(g.tool), z: topZ() } }])
  }

  function deleteSelection() {
    if (!session || selection.size === 0) return
    send([...selection].map((id) => ({ id, p: { d: true } })))
    setSelection(new Set())
  }

  // ── Text and notes ──
  function startText(at: Point, kind: 'text' | 'note') {
    const id = newObjectId()
    if (kind === 'note') {
      const noteColor = NOTE_COLORS[color] ?? '#fde68a'
      setEditing({ id, kind, x: round(at.x), y: round(at.y), w: 220, h: 180, size: SIZES.text[0], color: noteColor, text: '', isNew: true })
    } else setEditing({ id, kind, x: round(at.x), y: round(at.y), size: strokeSize('text'), color, text: '', isNew: true })
  }

  function editExisting(o: Shown) {
    if (o.kind !== 'text' && o.kind !== 'note') return
    setEditing({ id: o.id, kind: o.kind, x: o.x ?? 0, y: o.y ?? 0, w: o.w, h: o.h, size: o.size ?? 24, color: o.color ?? COLORS[0], text: o.text ?? '', isNew: false })
    redraw(true)
  }

  function commitText() {
    const e = editing
    setEditing(null)
    redraw(true)
    if (!e || !session) return
    const text = e.text.replace(/\r/g, '').slice(0, 2000)
    const old = session.state.get(e.id)
    if (!text.trim()) {
      if (!e.isNew && old && e.kind === 'text') send([{ id: e.id, p: { d: true } }])
      else if (e.isNew && e.kind === 'note') send([{ id: e.id, p: { kind: 'note', x: e.x, y: e.y, w: e.w!, h: e.h!, color: e.color, size: e.size, text: '', z: topZ() } }])
      else if (!e.isNew && e.kind === 'note' && old?.text) send([{ id: e.id, p: { text: '' } }])
      return
    }
    if (e.isNew) {
      send([{ id: e.id, p: { kind: e.kind, x: e.x, y: e.y, ...(e.kind === 'note' ? { w: e.w!, h: e.h! } : {}), color: e.color, size: e.size, text, z: topZ() } }])
    } else if (old?.text !== text) send([{ id: e.id, p: { text } }])
  }

  // ── Pointer input ──
  const hitAt = (p: Point): Shown | null => {
    if (!session) return null
    const list = session.state.list()
    const slop = 6 / cam.current.zoom
    for (let i = list.length - 1; i >= 0; i--) if (hits(list[i], p, slop)) return list[i]
    return null
  }

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (!session || editing) {
      if (editing) commitText()
      return
    }
    wrapRef.current?.focus({ preventScroll: true })
    e.currentTarget.setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (e.pointerType === 'pen') penSeen.current = true
    // Two fingers: pinch to zoom and pan (whatever was being drawn is dropped).
    if (pointers.current.size === 2) {
      gesture.current = null
      const [a, b] = [...pointers.current.values()]
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } }
      redraw(true)
      return
    }
    if (pointers.current.size > 2) return
    const p = toBoard(e.clientX, e.clientY)
    const fingerWithPen = e.pointerType === 'touch' && penSeen.current
    const effective: Tool = e.button === 1 || fingerWithPen ? 'pan' : !drawing && tool !== 'select' ? 'pan' : tool
    switch (effective) {
      case 'pan':
        gesture.current = { kind: 'pan', last: { x: e.clientX, y: e.clientY } }
        break
      case 'pen':
      case 'hl':
        gesture.current = { kind: 'ink', tool: effective, id: newObjectId(), points: [p] }
        break
      case 'eraser': {
        const ids = new Set<string>()
        const hit = hitAt(p)
        if (hit) ids.add(hit.id)
        gesture.current = { kind: 'erase', ids }
        redraw(true)
        break
      }
      case 'line': case 'arrow': case 'rect': case 'ellipse':
        gesture.current = { kind: 'shape', tool: effective, start: p, end: p }
        break
      case 'text':
      case 'note': {
        const hit = hitAt(p)
        if (hit && hit.kind === effective) editExisting(hit)
        else startText(p, effective)
        break
      }
      case 'select': {
        const hit = hitAt(p)
        if (hit) {
          let ids = selectionRef.current
          if (e.shiftKey) {
            ids = new Set(ids)
            if (ids.has(hit.id)) (ids as Set<string>).delete(hit.id)
            else (ids as Set<string>).add(hit.id)
          } else if (!ids.has(hit.id)) ids = new Set([hit.id])
          setSelection(ids)
          gesture.current = drawing ? { kind: 'move', start: p, dx: 0, dy: 0, ids: new Set(ids) } : null
        } else {
          if (!e.shiftKey) setSelection(new Set())
          gesture.current = { kind: 'marquee', start: p, end: p }
        }
        break
      }
    }
    redraw(false)
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!session) return
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const p = toBoard(e.clientX, e.clientY)
    if (pinch.current && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      const dist = Math.hypot(a.x - b.x, a.y - b.y)
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      const r = wrapRef.current!.getBoundingClientRect()
      const c = cam.current
      const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, c.zoom * (dist / Math.max(1, pinch.current.dist))))
      const bx = c.x + (pinch.current.mid.x - r.left) / c.zoom
      const by = c.y + (pinch.current.mid.y - r.top) / c.zoom
      setCamera({ x: bx - (mid.x - r.left) / z, y: by - (mid.y - r.top) / z, zoom: z })
      pinch.current = { dist, mid }
      return
    }
    const g = gesture.current
    // Everyone viewing sees where this person points (and what they draw).
    if (g?.kind === 'ink') {
      const events = 'getCoalescedEvents' in e.nativeEvent ? e.nativeEvent.getCoalescedEvents() : []
      for (const ev of events.length ? events : [e.nativeEvent]) {
        const q = toBoard(ev.clientX, ev.clientY)
        const last = g.points[g.points.length - 1]
        if (Math.hypot(q.x - last.x, q.y - last.y) * cam.current.zoom >= 1) g.points.push(q)
      }
      setLive(session, { x: p.x, y: p.y, tool, draft: { id: g.id, kind: g.tool, color, size: strokeSize(g.tool), points: g.points.flatMap((q) => [q.x, q.y]) } })
      redraw(false)
      return
    }
    setLive(session, { x: p.x, y: p.y, tool })
    if (!g) return
    switch (g.kind) {
      case 'pan': {
        const c = cam.current
        setCamera({ x: c.x - (e.clientX - g.last.x) / c.zoom, y: c.y - (e.clientY - g.last.y) / c.zoom, zoom: c.zoom })
        g.last = { x: e.clientX, y: e.clientY }
        break
      }
      case 'shape':
        g.end = e.shiftKey ? snap(g.start, p, g.tool) : p
        redraw(false)
        break
      case 'erase': {
        const hit = hitAt(p)
        if (hit && !g.ids.has(hit.id)) {
          g.ids.add(hit.id)
          redraw(true)
        }
        break
      }
      case 'move':
        g.dx = p.x - g.start.x
        g.dy = p.y - g.start.y
        redraw(true)
        break
      case 'marquee':
        g.end = p
        redraw(false)
        break
    }
  }

  function onPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    pointers.current.delete(e.pointerId)
    if (pinch.current) {
      if (pointers.current.size < 2) pinch.current = null
      return
    }
    const g = gesture.current
    gesture.current = null
    if (!session || !g) return
    switch (g.kind) {
      case 'ink':
        finishInk(g)
        setLive(session, { x: g.points[g.points.length - 1].x, y: g.points[g.points.length - 1].y, tool })
        break
      case 'shape': {
        const big = Math.hypot(g.end.x - g.start.x, g.end.y - g.start.y) * cam.current.zoom > 4
        if (big) send([{ id: newObjectId(), p: { ...shapeProps(g.tool, g.start, g.end), z: topZ() } }])
        else if (g.tool === 'rect' || g.tool === 'ellipse') {
          send([{ id: newObjectId(), p: { ...shapeProps(g.tool, { x: g.start.x - 60, y: g.start.y - 40 }, { x: g.start.x + 60, y: g.start.y + 40 }), z: topZ() } }])
        }
        break
      }
      case 'erase':
        if (g.ids.size) send([...g.ids].map((id) => ({ id, p: { d: true } })))
        break
      case 'move':
        if (Math.abs(g.dx) + Math.abs(g.dy) > 0.5 / cam.current.zoom) {
          send([...g.ids].map((id) => ({ id, p: moved(session.state.get(id) ?? {}, g.dx, g.dy) })))
        }
        break
      case 'marquee': {
        const r = norm(g.start, g.end)
        if (r.x1 - r.x0 > 2 / cam.current.zoom || r.y1 - r.y0 > 2 / cam.current.zoom) {
          const picked = new Set(e.shiftKey ? selectionRef.current : [])
          for (const o of session.state.list()) if (intersects(boundsOf(o), r)) picked.add(o.id)
          setSelection(picked)
        }
        break
      }
    }
    redraw(true)
  }

  function onDoubleClick(e: React.MouseEvent) {
    if (!drawing) return
    const hit = hitAt(toBoard(e.clientX, e.clientY))
    if (hit && (hit.kind === 'text' || hit.kind === 'note')) editExisting(hit)
  }

  // Wheel: scroll pans, Ctrl/⌘ (and trackpad pinch) zooms at the pointer. Not passive, so the page doesn't zoom.
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = wrap.getBoundingClientRect()
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top)
      else {
        const c = cam.current
        setCamera({ x: c.x + e.deltaX / c.zoom, y: c.y + e.deltaY / c.zoom, zoom: c.zoom })
      }
    }
    wrap.addEventListener('wheel', onWheel, { passive: false })
    return () => wrap.removeEventListener('wheel', onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (editing || !session) return
    const mod = e.ctrlKey || e.metaKey
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      if (!drawing) return
      if (e.shiftKey) redo(session)
      else undo(session)
    } else if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault()
      if (drawing) redo(session)
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && drawing) {
      e.preventDefault()
      deleteSelection()
    } else if (e.key === 'Escape' && selection.size) {
      e.stopPropagation()
      setSelection(new Set())
    } else if (!mod && !e.altKey && KEYS[e.key.toLowerCase()]) {
      const next = KEYS[e.key.toLowerCase()]
      if (drawing || next === 'select' || next === 'pan') setTool(next)
    } else if (!mod && (e.key === '+' || e.key === '=')) zoomAt(1.25)
    else if (!mod && e.key === '-') zoomAt(0.8)
  }

  // ── Pictures ──
  async function addPicture(file: File) {
    if (!session) return
    setBusy(t('whiteboard.uploading'))
    try {
      const info = await uploadFile(server.key, file, () => undefined)
      if (!info.type.startsWith('image/')) throw new Error(t('whiteboard.notAPicture'))
      const w0 = info.width ?? 400
      const h0 = info.height ?? 300
      const scale = Math.min(1, 480 / Math.max(w0, h0))
      const v = viewRect()
      const w = round(w0 * scale)
      const h = round(h0 * scale)
      send([{ id: newObjectId(), p: { kind: 'image', x: round((v.x0 + v.x1) / 2 - w / 2), y: round((v.y0 + v.y1) / 2 - h / 2), w, h, src: info.url, z: topZ() } }])
      setTool('select')
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  async function savePng() {
    if (!session) return
    try {
      const blob = await exportPng(session.state.list(), image)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${channel.name}.png`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  async function doClear() {
    setConfirmClear(false)
    if (!session) return
    try {
      await clearBoard(session)
      setSelection(new Set())
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  // ── The text editor over the canvas (a real textarea: React renders its value) ──
  const editorStyle = useMemo((): CSSProperties | undefined => {
    if (!editing) return undefined
    const z = cam.current.zoom
    const left = (editing.x - cam.current.x) * z
    const top = (editing.y - cam.current.y) * z
    const base: CSSProperties = { left, top, fontSize: editing.size * z, fontFamily: FONT_FAMILY }
    if (editing.kind === 'note') {
      return { ...base, width: (editing.w ?? 220) * z, height: (editing.h ?? 180) * z, background: editing.color, color: NOTE_TEXT, padding: 12 * z, lineHeight: 1.3 }
    }
    return { ...base, color: editing.color, minWidth: 160, lineHeight: 1.25 }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, zoom])

  const sizeTool: Tool = tool === 'hl' ? 'hl' : tool === 'text' || tool === 'note' ? 'text' : 'pen'
  const tools: { id: Tool; icon: React.ReactNode; draw?: boolean }[] = [
    { id: 'select', icon: <SelectIcon /> },
    { id: 'pan', icon: <HandIcon /> },
    { id: 'pen', icon: <PenIcon />, draw: true },
    { id: 'hl', icon: <HighlighterIcon />, draw: true },
    { id: 'eraser', icon: <EraserIcon />, draw: true },
    { id: 'line', icon: <LineIcon />, draw: true },
    { id: 'arrow', icon: <ArrowIcon />, draw: true },
    { id: 'rect', icon: <RectIcon />, draw: true },
    { id: 'ellipse', icon: <EllipseIcon />, draw: true },
    { id: 'text', icon: <TextIcon />, draw: true },
    { id: 'note', icon: <NoteIcon />, draw: true },
  ]

  if (!board || board.status === 'loading') {
    return <div className="wb wb-center"><Spinner /><p className="muted">{t('whiteboard.loading')}</p></div>
  }
  if (board.status === 'error') {
    return <div className="wb wb-center"><p className="error-text">{board.error}</p></div>
  }

  return (
    <div className={`wb ${compact ? 'wb-compact' : ''}`} data-testid="whiteboard">
      <div className="wb-toolbar" role="toolbar" aria-label={t('whiteboard.tools')}>
        <div className="wb-group" role="radiogroup" aria-label={t('whiteboard.toolGroup')}>
          {tools.filter((x) => !x.draw || drawing).map((x) => (
            <button key={x.id} role="radio" aria-checked={tool === x.id} className={`wb-tool ${tool === x.id ? 'on' : ''}`}
              aria-label={t(`whiteboard.tool.${x.id}`)} title={t(`whiteboard.tool.${x.id}`)} onClick={() => setTool(x.id)}>
              {x.icon}
            </button>
          ))}
          {drawing && !encrypted && (
            <button className="wb-tool" aria-label={t('whiteboard.tool.image')} title={t('whiteboard.tool.image')} onClick={() => fileRef.current?.click()}>
              <ImageIcon />
            </button>
          )}
        </div>
        {drawing && (
          <>
            <div className="wb-group wb-colors" role="radiogroup" aria-label={t('whiteboard.colour')}>
              {COLORS.map((c, i) => (
                <button key={c} role="radio" aria-checked={color === c} className={`wb-swatch ${color === c ? 'on' : ''}`} style={{ background: c }}
                  aria-label={t(`whiteboard.colours.${COLOR_NAMES[i]}`)} title={t(`whiteboard.colours.${COLOR_NAMES[i]}`)}
                  onClick={() => {
                    setColor(c)
                    if (selection.size && session) {
                      send([...selection].flatMap((id) => {
                        const o = session.state.get(id)
                        if (!o || o.kind === 'image') return []
                        return [{ id, p: { color: o.kind === 'note' ? (NOTE_COLORS[c] ?? '#fde68a') : c } }]
                      }))
                    }
                  }} />
              ))}
            </div>
            <div className="wb-group" role="radiogroup" aria-label={t('whiteboard.size')}>
              {(['s', 'm', 'l'] as const).map((s2, i) => (
                <button key={s2} role="radio" aria-checked={sizeIndex === i} className={`wb-tool wb-size ${sizeIndex === i ? 'on' : ''}`}
                  aria-label={t(`whiteboard.sizes.${s2}`)} title={t(`whiteboard.sizes.${s2}`)} onClick={() => setSizeIndex(i)}>
                  <span style={{ width: Math.min(18, 3 + (sizeTool === 'pen' ? SIZES.stroke[i] : i * 5 + 4)), height: Math.min(18, 3 + (sizeTool === 'pen' ? SIZES.stroke[i] : i * 5 + 4)) }} />
                </button>
              ))}
            </div>
            <div className="wb-group">
              <button className="wb-tool" disabled={!board.canUndo} aria-label={t('whiteboard.undo')} title={t('whiteboard.undo')} onClick={() => session && undo(session)}><UndoIcon /></button>
              <button className="wb-tool" disabled={!board.canRedo} aria-label={t('whiteboard.redo')} title={t('whiteboard.redo')} onClick={() => session && redo(session)}><RedoIcon /></button>
              {selection.size > 0 && (
                <button className="wb-tool" aria-label={t('whiteboard.deleteSelected')} title={t('whiteboard.deleteSelected')} onClick={deleteSelection}><Trash /></button>
              )}
            </div>
          </>
        )}
        <span className="wb-spacer" />
        <div className="wb-group">
          <button className="wb-tool" aria-label={t('whiteboard.zoomOut')} title={t('whiteboard.zoomOut')} onClick={() => zoomAt(0.8)}><ZoomOutIcon /></button>
          <span className="wb-zoom" aria-live="polite">{t('whiteboard.zoom', { percent: formatNumber(Math.round(zoom * 100)) })}</span>
          <button className="wb-tool" aria-label={t('whiteboard.zoomIn')} title={t('whiteboard.zoomIn')} onClick={() => zoomAt(1.25)}><ZoomInIcon /></button>
          <button className="wb-tool" aria-label={t('whiteboard.fit')} title={t('whiteboard.fit')} onClick={fit}><FitIcon /></button>
          <button className="wb-tool" aria-label={t('whiteboard.export')} title={t('whiteboard.export')} onClick={() => void savePng()}><DownloadIcon /></button>
          {canClear && (
            <button className="wb-tool danger" aria-label={t('whiteboard.clear')} title={t('whiteboard.clear')} onClick={() => setConfirmClear(true)}><ClearIcon /></button>
          )}
        </div>
      </div>
      {(error || board.error) && (
        <div className="banner error wb-banner" role="alert">
          <span>{error ?? board.error}</span>
          <button className="link-button" onClick={() => { setError(null); useWhiteboard.setState((s) => ({ boards: { ...s.boards, [key]: { ...s.boards[key], error: undefined } } })) }}>{t('common.close')}</button>
        </div>
      )}
      {board.unreadable > 0 && <p className="wb-note muted small-text">{t('whiteboard.unreadable', { count: board.unreadable })}</p>}
      {busy && <p className="wb-note muted small-text" role="status">{busy}</p>}
      <div
        ref={wrapRef}
        className={`wb-canvas tool-${drawing ? tool : 'view'}`}
        tabIndex={0}
        role="application"
        aria-label={t('whiteboard.canvasLabel', { name: channel.name })}
        aria-roledescription={t('whiteboard.board')}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => session && !gesture.current && setLive(session, null)}
        onDoubleClick={onDoubleClick}
        onKeyDown={onKeyDown}
      >
        <canvas ref={baseRef} className="wb-layer" />
        <canvas ref={overRef} className="wb-layer" />
        {empty && !editing && (
          <p className="wb-empty muted">{drawing ? t('whiteboard.empty') : t('whiteboard.emptyReadOnly')}</p>
        )}
        {editing && (
          <textarea
            className={`wb-editor ${editing.kind}`}
            style={editorStyle}
            value={editing.text}
            maxLength={2000}
            autoFocus
            aria-label={editing.kind === 'note' ? t('whiteboard.noteText') : t('whiteboard.text')}
            placeholder={t('whiteboard.typeHere')}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => setEditing({ ...editing, text: e.target.value })}
            onBlur={commitText}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
                e.preventDefault()
                commitText()
              }
            }}
          />
        )}
      </div>
      {!canDraw && <p className="wb-note muted small-text">{t('whiteboard.readOnly')}</p>}
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => {
        const file = e.target.files?.[0]
        e.target.value = ''
        if (file) void addPicture(file)
      }} />
      {confirmClear && (
        <Modal title={t('whiteboard.clearTitle')} onClose={() => setConfirmClear(false)} footer={
          <>
            <button className="button" onClick={() => setConfirmClear(false)}>{t('common.cancel')}</button>
            <button className="button danger" onClick={() => void doClear()}>{t('whiteboard.clearConfirm')}</button>
          </>
        }>
          <p>{t('whiteboard.clearBody')}</p>
        </Modal>
      )}
    </div>
  )
}

const norm = (a: Point, b: Point): Rect => ({ x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) })

/** Shift while drawing: lines snap to 45°, rectangles and ellipses become squares and circles. */
function snap(a: Point, b: Point, kind: BoardKind): Point {
  const dx = b.x - a.x
  const dy = b.y - a.y
  if (kind === 'line' || kind === 'arrow') {
    const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4)
    const len = Math.hypot(dx, dy)
    return { x: a.x + Math.cos(angle) * len, y: a.y + Math.sin(angle) * len }
  }
  const s = Math.max(Math.abs(dx), Math.abs(dy))
  return { x: a.x + Math.sign(dx || 1) * s, y: a.y + Math.sign(dy || 1) * s }
}

/** A steady colour per person for their cursor. */
export function cursorColor(accountKey: string): string {
  let h = 0
  for (let i = 0; i < accountKey.length; i++) h = (h * 31 + accountKey.charCodeAt(i)) >>> 0
  return `hsl(${h % 360}, 70%, 42%)`
}
