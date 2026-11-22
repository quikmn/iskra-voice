// The whiteboard's floating bars, over the canvas: the tools in one row (the shapes behind one button), colour and
// size in a popover, undo/redo and clear, and the view (zoom, fit, save) in a corner. On a narrow board the actions
// move to the bottom so every row fits.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Trash } from '../icons'
import { useEscapeLayer } from '../layers'
import {
  ArrowIcon, ClearIcon, DownloadIcon, EllipseIcon, EraserIcon, FitIcon, HandIcon, HighlighterIcon, ImageIcon, LineIcon, NoteIcon, PenIcon, RectIcon,
  RedoIcon, SelectIcon, TextIcon, UndoIcon, ZoomInIcon, ZoomOutIcon,
} from './icons'
import { COLOR_NAMES, COLORS, isShape, rowFor, SHAPES, sizeDot, sizeKind, type ShapeTool, type Tool } from './boardTools'

const ICONS: Record<Tool, ReactNode> = {
  select: <SelectIcon />, pan: <HandIcon />, pen: <PenIcon />, hl: <HighlighterIcon />, eraser: <EraserIcon />, line: <LineIcon />,
  arrow: <ArrowIcon />, rect: <RectIcon />, ellipse: <EllipseIcon />, text: <TextIcon />, note: <NoteIcon />,
}

type Popover = 'shapes' | 'style' | null

export function BoardToolbar({
  drawing, tool, onTool, onPicture, color, onColor, sizeIndex, onSize, canUndo, canRedo, onUndo, onRedo, hasSelection, onDelete, canClear, onClear,
}: {
  /** May draw: without it only select and move around show. */
  drawing: boolean
  tool: Tool
  onTool: (tool: Tool) => void
  /** Adds a picture (not offered on encrypted boards). */
  onPicture?: () => void
  color: string
  onColor: (color: string) => void
  sizeIndex: number
  onSize: (index: number) => void
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  hasSelection: boolean
  onDelete: () => void
  canClear: boolean
  onClear: () => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState<Popover>(null)
  // The shapes button shows the shape used last.
  const [shape, setShape] = useState<ShapeTool>('rect')
  const wrap = useRef<HTMLDivElement>(null)
  const opener = useRef<HTMLButtonElement | null>(null)
  const pop = useRef<HTMLDivElement>(null)
  if (isShape(tool) && tool !== shape) setShape(tool)

  const close = () => {
    setOpen(null)
    opener.current?.focus({ preventScroll: true })
  }
  useEscapeLayer(close, !!open)
  useEffect(() => {
    if (!open) return
    // A press anywhere else closes it (on the canvas, that press draws too).
    const outside = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(null)
    }
    document.addEventListener('pointerdown', outside, true)
    // Keyboards start on the chosen one.
    if (!matchMedia('(pointer: coarse)').matches) pop.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus({ preventScroll: true })
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [open])

  const toggle = (which: Exclude<Popover, null>, button: HTMLButtonElement) => {
    opener.current = button
    setOpen(open === which ? null : which)
  }
  const kind = sizeKind(tool)
  const dot = Math.max(10, sizeDot(kind, sizeIndex))

  return (
    <div className={`wb-float ${open ? `open-${open}` : ''}`} ref={wrap} role="toolbar" aria-label={t('whiteboard.tools')}>
      <div className="wb-pill wb-pill-tools" role="radiogroup" aria-label={t('whiteboard.toolGroup')}>
        {rowFor(drawing).map((x) => x === 'shapes' ? (
          <button key={x} className={`wb-tool wb-has-more ${isShape(tool) ? 'on' : ''}`} aria-haspopup="true" aria-expanded={open === 'shapes'}
            aria-label={t('whiteboard.shapes')} title={t('whiteboard.shapes')} data-testid="wb-shapes" onClick={(e) => toggle('shapes', e.currentTarget)}>
            {ICONS[shape]}
          </button>
        ) : (
          <button key={x} role="radio" aria-checked={tool === x} className={`wb-tool ${tool === x ? 'on' : ''}`}
            aria-label={t(`whiteboard.tool.${x}`)} title={t(`whiteboard.tool.${x}`)} onClick={() => onTool(x)}>
            {ICONS[x]}
          </button>
        ))}
        {drawing && onPicture && (
          <button className="wb-tool" aria-label={t('whiteboard.tool.image')} title={t('whiteboard.tool.image')} onClick={onPicture}>
            <ImageIcon />
          </button>
        )}
      </div>
      {drawing && (
        <div className="wb-pill wb-pill-actions" role="group" aria-label={t('whiteboard.actions')}>
          <button className="wb-tool wb-style" aria-haspopup="true" aria-expanded={open === 'style'} aria-label={t('whiteboard.style')} title={t('whiteboard.style')}
            data-testid="wb-style" onClick={(e) => toggle('style', e.currentTarget)}>
            <span className="wb-style-dot" style={{ background: color, width: dot, height: dot }} />
          </button>
          <span className="wb-sep" aria-hidden />
          <button className="wb-tool" disabled={!canUndo} aria-label={t('whiteboard.undo')} title={t('whiteboard.undo')} onClick={onUndo}><UndoIcon /></button>
          <button className="wb-tool" disabled={!canRedo} aria-label={t('whiteboard.redo')} title={t('whiteboard.redo')} onClick={onRedo}><RedoIcon /></button>
          {hasSelection && (
            <button className="wb-tool" aria-label={t('whiteboard.deleteSelected')} title={t('whiteboard.deleteSelected')} onClick={onDelete}><Trash /></button>
          )}
          {canClear && (
            <>
              <span className="wb-sep" aria-hidden />
              <button className="wb-tool danger" aria-label={t('whiteboard.clear')} title={t('whiteboard.clear')} onClick={onClear}><ClearIcon /></button>
            </>
          )}
        </div>
      )}
      {open === 'shapes' && (
        <div className="wb-pop wb-pop-shapes" ref={pop} role="radiogroup" aria-label={t('whiteboard.shapes')}>
          {SHAPES.map((x) => (
            <button key={x} role="radio" aria-checked={tool === x} className={`wb-tool ${tool === x ? 'on' : ''}`}
              aria-label={t(`whiteboard.tool.${x}`)} title={t(`whiteboard.tool.${x}`)}
              onClick={() => {
                onTool(x)
                close()
              }}>
              {ICONS[x]}
            </button>
          ))}
        </div>
      )}
      {open === 'style' && (
        <div className="wb-pop wb-pop-style" ref={pop} role="group" aria-label={t('whiteboard.style')}>
          <div className="wb-pop-label" aria-hidden>{t('whiteboard.colour')}</div>
          <div className="wb-colors" role="radiogroup" aria-label={t('whiteboard.colour')}>
            {COLORS.map((c, i) => (
              <button key={c} role="radio" aria-checked={color === c} className={`wb-swatch ${color === c ? 'on' : ''}`} style={{ background: c }}
                aria-label={t(`whiteboard.colours.${COLOR_NAMES[i]}`)} title={t(`whiteboard.colours.${COLOR_NAMES[i]}`)} onClick={() => onColor(c)} />
            ))}
          </div>
          <div className="wb-pop-label" aria-hidden>{t('whiteboard.size')}</div>
          <div className="wb-sizes" role="radiogroup" aria-label={t('whiteboard.size')}>
            {(['s', 'm', 'l'] as const).map((s, i) => (
              <button key={s} role="radio" aria-checked={sizeIndex === i} className={`wb-tool wb-size ${sizeIndex === i ? 'on' : ''}`}
                aria-label={t(`whiteboard.sizes.${s}`)} title={t(`whiteboard.sizes.${s}`)} onClick={() => onSize(i)}>
                <span style={{ width: sizeDot(kind, i), height: sizeDot(kind, i) }} />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/** The view, in the canvas's bottom corner: zoom, fit to content, save as a picture. */
export function BoardViewBar({ zoomLabel, onZoomIn, onZoomOut, onFit, onExport }: {
  zoomLabel: string; onZoomIn: () => void; onZoomOut: () => void; onFit: () => void; onExport: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="wb-pill wb-pill-view" role="group" aria-label={t('whiteboard.view')}>
      <button className="wb-tool" aria-label={t('whiteboard.zoomOut')} title={t('whiteboard.zoomOut')} onClick={onZoomOut}><ZoomOutIcon /></button>
      <span className="wb-zoom" aria-live="polite">{zoomLabel}</span>
      <button className="wb-tool" aria-label={t('whiteboard.zoomIn')} title={t('whiteboard.zoomIn')} onClick={onZoomIn}><ZoomInIcon /></button>
      <button className="wb-tool" aria-label={t('whiteboard.fit')} title={t('whiteboard.fit')} onClick={onFit}><FitIcon /></button>
      <button className="wb-tool" aria-label={t('whiteboard.export')} title={t('whiteboard.export')} onClick={onExport}><DownloadIcon /></button>
    </div>
  )
}
