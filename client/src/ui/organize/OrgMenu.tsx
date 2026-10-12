// A small menu: a popover at the pointer on desktop, a sheet from the bottom on phones.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import { useEscapeLayer, useFocusTrap } from '../layers'
import { focusFirstItem } from '../a11y'
import { ChevronLeft, ChevronRight } from '../icons'

export interface MenuAnchor {
  x: number
  y: number
}

const PHONE = '(max-width: 760px), (pointer: coarse)'
const phoneLike = () => window.matchMedia(PHONE).matches

export function OrgMenu({ anchor, label, onClose, children }: { anchor: MenuAnchor | null; label: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const sheet = !anchor || phoneLike()
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  useEscapeLayer(onClose)
  useFocusTrap(ref)
  // Keyboards start on the first item (arrow keys move on); touch screens keep focus on the sheet.
  useEffect(() => {
    if (!window.matchMedia('(pointer: coarse)').matches) focusFirstItem(ref.current)
  }, [])
  // Another page of the menu replaced the focused item: carry on from the first one.
  useLayoutEffect(() => {
    if (document.activeElement === document.body || !document.activeElement) focusFirstItem(ref.current)
  })

  useLayoutEffect(() => {
    if (sheet || !anchor || !ref.current) return
    const { offsetWidth: w, offsetHeight: h } = ref.current
    const left = Math.max(8, Math.min(anchor.x, window.innerWidth - w - 8))
    const top = Math.max(8, Math.min(anchor.y, window.innerHeight - h - 8))
    setPosition((p) => (p && p.left === left && p.top === top ? p : { left, top }))
  }, [anchor, sheet, children])

  return createPortal(
    <div className={sheet ? 'sheet-backdrop' : 'org-menu-backdrop'} onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onContextMenu={(e) => { e.preventDefault(); if (e.target === e.currentTarget) onClose() }}>
      <div
        ref={ref}
        className={sheet ? 'action-sheet org-sheet' : 'org-menu'}
        role="dialog"
        aria-label={label}
        tabIndex={-1}
        style={sheet ? undefined : { left: position?.left ?? -9999, top: position?.top ?? 0 }}
      >
        {sheet && <span className="sheet-grabber" aria-hidden />}
        {children}
      </div>
    </div>,
    document.body,
  )
}

/** One row of a menu. */
export function MenuItem({ children, onClick, danger, checked, disabled, hint, submenu }: {
  children: ReactNode
  onClick: () => void
  danger?: boolean
  /** Shows as a radio choice. */
  checked?: boolean
  disabled?: boolean
  hint?: string
  /** Opens another page of the menu: a chevron at the end. */
  submenu?: boolean
}) {
  const radio = checked !== undefined
  return (
    <button
      role={radio ? 'menuitemradio' : 'menuitem'}
      aria-checked={radio ? checked : undefined}
      className={`org-item ${danger ? 'danger' : ''} ${checked ? 'checked' : ''}`}
      disabled={disabled}
      onClick={onClick}
    >
      {radio && <span className="org-radio" aria-hidden />}
      <span className="org-item-text">{children}</span>
      {hint && <span className="org-item-hint">{hint}</span>}
      {submenu && <span className="org-item-hint" aria-hidden><ChevronRight size={14} /></span>}
    </button>
  )
}

export function MenuTitle({ children, onBack }: { children: ReactNode; onBack?: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="org-menu-title">
      {onBack && <button className="icon-button small" onClick={onBack} aria-label={t('common.back')}><ChevronLeft size={16} /></button>}
      <span>{children}</span>
    </div>
  )
}
