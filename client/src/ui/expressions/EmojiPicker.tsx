// Emoji picker: search, recently used, this server's emoji, your other servers' emoji and the standard set. A popover on
// desktop, a sheet on phones. Picking an emoji from another server first copies it into this one (state/expressions.ts).
import { useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { CustomEmoji } from '../../core/protocol'
import { errorMessage } from '../../i18n/errors'
import { importEmoji, serverFileUrl, useExpressions, useOwnEmojis, useServerEmojis } from '../../state/expressions'
import { baseRolesFor } from '../../state/baseRoles'
import { baseAllows } from '../../state/permissions'
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
  /** The server a custom emoji lives on when that isn't this one: picking it copies it over first. */
  source?: string
}

const EMPTY: CustomEmoji[] = []

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
  const own = useOwnEmojis(serverKey)
  const usable = useServerEmojis(serverKey) // own and external: what a remembered token may point at
  const server = useApp((s) => s.servers[serverKey])
  const serverName = server?.name ?? t('expressions.picker.thisServer')
  const [query, setQuery] = useState('')
  const [hover, setHover] = useState<Item | null>(null)
  const [busy, setBusy] = useState<Item | null>(null)
  const [error, setError] = useState<string | null>(null)
  const panel = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const { style, sheet } = usePopoverPosition(anchor, panel)
  const [recent] = useState(loadRecent)
  useEscapeLayer(onClose)
  useFocusTrap(panel)

  // Your other servers' emoji (when this server lets you use them here), each under its own name.
  const order = useApp((s) => s.order)
  const servers = useApp((s) => s.servers)
  const ownLists = useExpressions((s) => s.emojis)
  const crossServer = !!server?.me && baseAllows(baseRolesFor(serverKey), server.me, 'externalEmoji')
  const others = crossServer ? order.filter((k) => k !== serverKey && servers[k]?.me && (ownLists[k] ?? EMPTY).length > 0) : []
  const sourceOf = new Map<string, string>()
  for (const k of others) for (const e of ownLists[k]) sourceOf.set(e.id, k)

  const asItem = (e: CustomEmoji, source?: string): Item => ({ value: token(e), label: `:${e.name}:`, custom: e, ...(source ? { source } : {}) })
  const customItems: Item[] = own.map((e) => asItem(e))
  const recentItems: Item[] = recent
    .map((value): Item | null => {
      const custom = parseCustomEmoji(value)
      if (!custom) return { value, label: value }
      const found = usable.find((e) => e.id === custom.id)
      return found ? asItem(found) : null
    })
    .filter((x): x is Item => x !== null)

  const results: Item[] | null = query.trim()
    ? searchEmoji(query.trim(), [...own, ...others.flatMap((k) => ownLists[k])], 120).map((r: EmojiResult) =>
      r.kind === 'custom' ? asItem(r.emoji, sourceOf.get(r.emoji.id)) : { value: r.char, label: `:${r.name}:` })
    : null

  const sections: { id: string; title: string; icon: string | CustomEmoji; source?: string; items: Item[] }[] = results
    ? [{ id: 'results', title: results.length ? t('expressions.picker.results') : t('expressions.picker.noResults'), icon: '🔍', items: results }]
    : [
      ...(recentItems.length ? [{ id: 'recent', title: t('expressions.picker.recent'), icon: '🕘', items: recentItems }] : []),
      ...(customItems.length ? [{ id: 'server', title: serverName, icon: own[0], items: customItems }] : []),
      ...others.map((k) => ({ id: `server-${k}`, title: servers[k].name, icon: ownLists[k][0], source: k, items: ownLists[k].map((e) => asItem(e, k)) })),
      ...EMOJI_CATEGORIES.map((c) => ({ id: c.name, title: t(`expressions.picker.categories.${c.name as Category}`), icon: c.icon, items: c.emoji.map((e) => ({ value: e.char, label: `:${e.name}:` })) })),
    ]

  async function pick(item: Item, shift: boolean) {
    let value = item.value
    if (item.source && item.custom) {
      // From another server: copy it into this one first (the server answers with what it already had for the same picture).
      if (busy) return
      setBusy(item)
      setError(null)
      try {
        value = token(await importEmoji(serverKey, item.source, item.custom))
      } catch (e) {
        setError(errorMessage(e))
        return
      } finally {
        setBusy(null)
      }
    }
    remember(value)
    onPick(value)
    if (!(keepOpen && shift)) onClose()
  }

  const glyph = (item: Item) =>
    item.custom
      ? <img className="custom-emoji" src={serverFileUrl(item.source ?? serverKey, item.custom.url) ?? undefined} alt={item.label} loading="lazy" draggable={false} />
      : item.value
  const describe = (item: Item) => (item.source ? t('expressions.picker.fromServer', { name: item.label, server: servers[item.source]?.name ?? '' }) : item.label)

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
            if (e.key === 'Enter' && results?.[0]) void pick(results[0], e.shiftKey)
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
                  : <img className="custom-emoji" src={serverFileUrl(section.source ?? serverKey, section.icon.url) ?? undefined} alt="" />}
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
                    key={`${item.source ?? ''}${item.value}`}
                    className={`emoji-cell ${busy === item ? 'busy' : ''}`}
                    aria-label={describe(item)}
                    title={describe(item)}
                    aria-busy={busy === item || undefined}
                    onMouseEnter={() => setHover(item)}
                    onFocus={() => setHover(item)}
                    onClick={(e) => void pick(item, e.shiftKey)}
                  >
                    {glyph(item)}
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
        <footer className="emoji-preview" aria-live="polite">
          {error ? <span className="error-text">{error}</span>
            : busy ? <><span className="emoji-preview-glyph">{glyph(busy)}</span><span>{t('expressions.picker.adding', { name: busy.label, server: serverName })}</span></>
              : hover ? <><span className="emoji-preview-glyph">{glyph(hover)}</span><span>{describe(hover)}</span></> : <span className="muted">{t('expressions.picker.pickOne')}</span>}
        </footer>
        </>}
      </div>
    </div>,
    document.body,
  )
}
