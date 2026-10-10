// Small shared UI pieces.
import { useEffect, useRef, type ReactNode } from 'react'
import { hueFor, initials } from './format'

export function Avatar({ name, accountKey, size = 36, online }: { name: string; accountKey: string; size?: number; online?: boolean }) {
  const hue = hueFor(accountKey)
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.38, background: `hsl(${hue} 45% 32%)` }} aria-hidden>
      {initials(name)}
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

export function Modal({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    ref.current?.querySelector<HTMLElement>('input, textarea, button')?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <header className="modal-header">
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </div>
    </div>
  )
}

export function Spinner() {
  return <span className="spinner" aria-label="Loading" />
}
