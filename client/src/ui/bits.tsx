// Small shared UI pieces.
import { useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useApp } from '../state/store'
import { hueFor, initials } from './format'
import { ChevronLeft, Close } from './icons'
import { useEscapeLayer, useFocusTrap } from './layers'

type AppSnapshot = ReturnType<typeof useApp.getState>

/** An account's profile picture: from the active server if it knows them, else from any server. */
function avatarUrlIn(state: AppSnapshot, accountKey: string): string | null {
  const active = state.activeServer ? state.servers[state.activeServer] : undefined
  for (const server of active ? [active, ...Object.values(state.servers)] : Object.values(state.servers)) {
    const avatar = server.members[accountKey]?.avatar
    if (avatar?.startsWith('/files/')) return server.url + avatar
  }
  return null
}

/** Initials on a colour, or the member's picture. `src` overrides the lookup (null: initials only). */
export function Avatar({ name, accountKey, size = 36, online, src }: { name: string; accountKey: string; size?: number; online?: boolean; src?: string | null }) {
  const hue = hueFor(accountKey)
  const found = useApp((s) => (src === undefined ? avatarUrlIn(s, accountKey) : src))
  const [broken, setBroken] = useState<string | null>(null)
  const image = found && found !== broken ? found : null
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.38, background: `hsl(${hue} 45% 32%)` }} aria-hidden>
      {image ? <img className="avatar-image" src={image} alt="" draggable={false} onError={() => setBroken(image)} /> : initials(name)}
      {online !== undefined && <span className={`presence ${online ? 'on' : 'off'}`} />}
    </span>
  )
}

/** Plain text with clickable http(s) links. Rendered by React, never as HTML. */
export function MessageText({ text }: { text: string }) {
  const parts: ReactNode[] = []
  const linkPattern = /https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g
  let last = 0
  for (const match of text.matchAll(linkPattern)) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    parts.push(
      <a key={match.index} href={match[0]} target="_blank" rel="noopener noreferrer">
        {match[0]}
      </a>,
    )
    last = match.index + match[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return <>{parts}</>
}

export function Modal({ title, heading, onBack, onClose, children, footer, wide, className }: {
  /** The dialog's name (and its heading, unless `heading` is given). */
  title: string
  heading?: ReactNode
  /** Shows a back arrow before the heading (phone list → detail flows). */
  onBack?: () => void
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEscapeLayer(onClose)
  useFocusTrap(ref)
  // In a portal, so a dialog opened from inside another (Link a device in Settings) isn't styled or clipped by it.
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''} ${className ?? ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref} tabIndex={-1}>
        <header className="modal-header">
          {onBack && (
            <button className="icon-button modal-back" onClick={onBack} aria-label="Back">
              <ChevronLeft />
            </button>
          )}
          <h2>{heading ?? title}</h2>
          <button className="icon-button modal-close" onClick={onClose} aria-label="Close">
            <Close />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </div>
    </div>,
    document.body,
  )
}

export function Spinner() {
  return <span className="spinner" aria-label="Loading" />
}

/** Hidden text that reveals on click (||like this||). */
export function Spoiler({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState(false)
  return (
    <span
      className={`spoiler ${shown ? 'shown' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={shown ? undefined : 'Spoiler, click to reveal'}
      onClick={() => setShown(true)}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setShown(true)}
    >
      {children}
    </span>
  )
}
