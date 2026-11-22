// One server emoji, wherever it shows (messages, reactions, the picker, suggestions): its picture once that has loaded,
// and until then, or when there is none (deleted, not loaded yet, the file is gone), a small ":name:" chip. Never a
// broken image.
import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

/** Pictures that have loaded once: shown straight away the next time, so a message that re-renders doesn't flash its chips. */
const loaded = new Set<string>()

export function CustomEmojiImage({ src, name, className, decorative, lazy }: {
  /** Null: the emoji isn't known here (deleted, or the list hasn't arrived). */
  src: string | null | undefined
  /** Without the colons. */
  name: string
  className?: string
  /** Next to its own label (a suggestion row, a picker tab): hidden from screen readers. */
  decorative?: boolean
  lazy?: boolean
}) {
  const { t } = useTranslation()
  const img = useRef<HTMLImageElement>(null)
  // What happened to which picture: a new src starts over.
  const [seen, setSeen] = useState<{ src: string; ok: boolean } | null>(null)
  const state = !src ? 'missing' : seen?.src === src ? (seen.ok ? 'ok' : 'missing') : loaded.has(src) ? 'ok' : 'loading'
  // Already there (cached): no chip for a frame. A failure always comes through onError.
  useLayoutEffect(() => {
    const el = img.current
    if (src && state === 'loading' && el?.complete && el.naturalWidth > 0) settle(src, true)
  })
  function settle(of: string, ok: boolean) {
    if (ok) loaded.add(of)
    setSeen({ src: of, ok })
  }
  const label = `:${name}:`
  const extra = className ? ` ${className}` : ''
  return (
    <>
      {state !== 'ok' && (
        <span
          className={`emoji-chip${extra}`}
          {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': state === 'missing' ? t('expressions.emoji.missing', { name: label }) : label })}
          title={state === 'missing' ? t('expressions.emoji.missing', { name: label }) : label}
          data-emoji-state={state}
        >
          {label}
        </span>
      )}
      {src && state !== 'missing' && (
        <img
          ref={img}
          className={`custom-emoji${state === 'loading' ? ' loading' : ''}${extra}`}
          src={src}
          alt={decorative || state === 'loading' ? '' : label}
          aria-hidden={state === 'loading' || undefined}
          title={decorative ? undefined : label}
          loading={lazy ? 'lazy' : undefined}
          draggable={false}
          onLoad={() => settle(src, true)}
          onError={() => settle(src, false)}
        />
      )}
    </>
  )
}
