// Emoji picker: search, recently used, this server's emoji and the standard set. A popover on desktop, a sheet on phones.
import { useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { CustomEmoji } from '../../core/protocol'
import { serverFileUrl, useServerEmojis } from '../../state/expressions'
import { useApp } from '../../state/store'
import { parseCustomEmoji, searchEmoji, type EmojiResult } from './emoji'
import { EMOJI_CATEGORIES } from './emojiData'
import { usePopoverPosition } from './popover'
import { useEscapeLayer, useFocusTrap } from '../layers'
import { moveInGrid } from '../a11y'
import './expressions.css'
import { useTranslation } from 'react-i18next'
import type { en } from '../../i18n/en'

const RECENT_KEY = 'iskra.emoji.recent'

function loadRecent(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string').slice(0, 24) : []
  } catch {
    return []
  }
}

function remember(value: string): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([value, ...loadRecent().filter((v) => v !== value)].slice(0, 24)))
  } catch {
    /* private mode */
  }
}

/** A reaction or picked emoji: a server emoji image for <:name:id>, otherwise the text itself. */
export function EmojiGlyph({ serverKey, emoji, className }: { serverKey: string; emoji: string; className?: string }) {
  const custom = parseCustomEmoji(emoji)
  const emojis = useServerEmojis(serverKey)
  if (!custom) return <span className={className}>{emoji}</span>
  const found = emojis.find((e) => e.id === custom.id)
  const url = serverFileUrl(serverKey, found?.url ?? null)
  return url
    ? <img className={`custom-emoji ${className ?? ''}`} src={url} alt={`:${custom.name}:`} title={`:${found?.name ?? custom.name}:`} draggable={false} />
    : <span className={className}>:{custom.name}:</span>
}

type Category = keyof typeof en.expressions.picker.categories

const token = (e: CustomEmoji) => `<:${e.name}:${e.id}>`

interface Item {
  value: string
  label: string
  custom?: CustomEmoji
}

/**
 * Calls onPick with a standard emoji or a <:name:id> token. Positions itself next to the anchor
 * (above if there's room, else below); on narrow screens it's a bottom sheet.
 */
export function EmojiPicker({
  serverKey, anchor, onPick, onClose, keepOpen, tabs, body,
}: {
  serverKey: string
  anchor: HTMLElement | null
  onPick: (value: string) => void
  onClose: () => void
  /** Shift-click picks several (like Discord); otherwise picking closes. */
  keepOpen?: boolean
  /** Shown above everything (the composer's Emoji / GIFs / Stickers tabs). */
  tabs?: ReactNode
  /** Replaces the emoji grid (another tab's content), keeping the same frame and placement. */
  body?: ReactNode
}) {
  const { t } = useTranslation()
  const emojis = useServerEmojis(serverKey)
  const serverName = useApp((s) => s.servers[serverKey]?.name) ?? t('expressions.picker.thisServer')
  const [query, setQuery] = useState('')
  const [hover, setHover] = useState<Item | null>(null)
  const panel = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const { style, sheet } = usePopoverPosition(anchor, panel)
  const [recent] = useState(loadRecent)
  useEscapeLayer(onClose)
  useFocusTrap(panel)

  const customItems: Item[] = emojis.map((e) => ({ value: token(e), label: `:${e.name}:`, custom: e }))
  const recentItems: Item[] = recent
    .map((value): Item | null => {
      const custom = parseCustomEmoji(value)
      if (!custom) return { value, label: value }
      const found = emojis.find((e) => e.id === custom.id)
      return found ? { value: token(found), label: `:${found.name}:`, custom: found } : null
    })
    .filter((x): x is Item => x !== null)

  const results: Item[] | null = query.trim()
    ? searchEmoji(query.trim(), emojis, 120).map((r: EmojiResult) =>
      r.kind === 'custom' ? { value: token(r.emoji), label: `:${r.emoji.name}:`, custom: r.emoji } : { value: r.char, label: `:${r.name}:` })
    : null

  const sections: { id: string; title: string; icon: string | CustomEmoji; items: Item[] }[] = results
    ? [{ id: 'results', title: results.length ? t('expressions.picker.results') : t('expressions.picker.noResults'), icon: '🔍', items: results }]
    : [
      ...(recentItems.length ? [{ id: 'recent', title: t('expressions.picker.recent'), icon: '🕘', items: recentItems }] : []),
      ...(customItems.length ? [{ id: 'server', title: serverName, icon: emojis[0], items: customItems }] : []),
      ...EMOJI_CATEGORIES.map((c) => ({ id: c.name, title: t(`expressions.picker.categories.${c.name as Category}`), icon: c.icon, items: c.emoji.map((e) => ({ value: e.char, label: `:${e.name}:` })) })),
    ]

  function pick(item: Item, shift: boolean) {
    remember(item.value)
    onPick(item.value)
    if (!(keepOpen && shift)) onClose()
  }

  const glyph = (item: Item) =>
    item.custom
      ? <img className="custom-emoji" src={serverFileUrl(serverKey, item.custom.url) ?? undefined} alt={item.label} loading="lazy" draggable={false} />
      : item.value

  return createPortal(
    <div className={`emoji-picker-layer ${sheet ? 'sheet' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panel}
        className="emoji-picker"
        style={style}
        role="dialog"
        aria-label={t('expressions.picker.title')}
        tabIndex={-1}
      >
        {tabs}
        {body ?? <>
        <input
          className="emoji-search"
          placeholder={t('expressions.picker.search')}
          aria-label={t('expressions.picker.search')}
          value={query}
          autoFocus={!sheet}
          data-autofocus
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && results?.[0]) pick(results[0], e.shiftKey)
            // Down from the search goes into the grid.
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              scroller.current?.querySelector<HTMLElement>('.emoji-cell')?.focus()
            }
          }}
        />
        {!results && (
          <nav className="emoji-tabs" aria-label={t('expressions.picker.categoriesLabel')}>
            {sections.map((section) => (
              <button
                key={section.id}
                title={section.title}
                aria-label={section.title}
                onClick={() => scroller.current?.querySelector(`[data-section="${section.id}"]`)?.scrollIntoView({ block: 'start' })}
              >
                {typeof section.icon === 'string'
                  ? section.icon
                  : <img className="custom-emoji" src={serverFileUrl(serverKey, section.icon.url) ?? undefined} alt="" />}
              </button>
            ))}
          </nav>
        )}
        <div className="emoji-scroll" ref={scroller} onKeyDown={(e) => {
          const cells = [...(scroller.current?.querySelectorAll<HTMLElement>('.emoji-cell') ?? [])]
          if (moveInGrid(cells, document.activeElement, e.key)) e.preventDefault()
        }}>
          {sections.map((section) => (
            <section key={section.id} data-section={section.id}>
              <h3>{section.title}</h3>
              <div className="emoji-grid">
                {section.items.map((item) => (
                  <button
                    key={item.value}
                    className="emoji-cell"
                    aria-label={item.label}
                    title={item.label}
                    onMouseEnter={() => setHover(item)}
                    onFocus={() => setHover(item)}
                    onClick={(e) => pick(item, e.shiftKey)}
                  >
                    {glyph(item)}
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
        <footer className="emoji-preview">
          {hover ? <><span className="emoji-preview-glyph">{glyph(hover)}</span><span>{hover.label}</span></> : <span className="muted">{t('expressions.picker.pickOne')}</span>}
        </footer>
        </>}
      </div>
    </div>,
    document.body,
  )
}
