// The composer's picker: Emoji / GIFs / Stickers tabs in one popover (a sheet on phones).
import { useEffect, useRef, useState } from 'react'
import type { GifCategory, GifResult, MessageGif, Sticker } from '../../core/protocol'
import { serverFileUrl } from '../../state/expressions'
import { gifCategories, isFavourite, searchGifs, toggleFavourite, trendingGifs, useGifs } from '../../state/gifs'
import type { ServerState } from '../../state/store'
import { LINKS } from '../../links'
import { Spinner } from '../bits'
import { EmojiPicker } from '../expressions/EmojiPicker'
import { Lightbox } from './media'
import { StickerPanel } from './Stickers'
import './gifs.css'

export type ExpressionTab = 'emoji' | 'gifs' | 'stickers'
const TABS: { id: ExpressionTab; label: string }[] = [
  { id: 'emoji', label: 'Emoji' },
  { id: 'gifs', label: 'GIFs' },
  { id: 'stickers', label: 'Stickers' },
]

export function ExpressionPicker({ server, anchor, initialTab = 'emoji', onEmoji, onGif, onSticker, onClose }: {
  server: ServerState
  anchor: HTMLElement
  initialTab?: ExpressionTab
  onEmoji: (value: string) => void
  onGif: (gif: GifResult) => void
  onSticker: (sticker: Sticker) => void
  onClose: () => void
}) {
  const [tab, setTab] = useState<ExpressionTab>(initialTab)
  const tabs = (
    <div className="expression-tabs" role="tablist" aria-label="Pick">
      {TABS.map((t) => (
        <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  )
  const body = tab === 'gifs'
    ? <GifPanel server={server} onPick={(gif) => { onGif(gif); onClose() }} />
    : tab === 'stickers'
      ? <StickerPanel server={server} onPick={(sticker) => { onSticker(sticker); onClose() }} />
      : undefined
  return <EmojiPicker serverKey={server.key} anchor={anchor} keepOpen onPick={onEmoji} onClose={onClose} tabs={tabs} body={body} />
}

// ── GIFs ────────────────────────────────────────────────────────────────────

function GifPanel({ server, onPick }: { server: ServerState; onPick: (gif: GifResult) => void }) {
  const enabled = useGifs((s) => s.enabled[server.key])
  const favourites = useGifs((s) => s.favourites[server.key])
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [gifs, setGifs] = useState<GifResult[]>([])
  const [page, setPage] = useState(1)
  const [hasNext, setHasNext] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [categories, setCategories] = useState<GifCategory[]>([])
  const [view, setView] = useState<'browse' | 'favourites'>('browse')
  const run = useRef(0)

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 350)
    return () => clearTimeout(timer)
  }, [query])

  // A new search (or trending): start from page 1.
  useEffect(() => {
    if (!enabled) return
    void load(1, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced, enabled, server.key])

  useEffect(() => {
    if (!enabled) return
    gifCategories(server.key).then(setCategories).catch(() => setCategories([]))
  }, [enabled, server.key])

  async function load(next: number, fresh = false) {
    const id = ++run.current
    setBusy(true)
    setError(null)
    try {
      const result = debounced ? await searchGifs(server.key, debounced.slice(0, 100), next) : await trendingGifs(server.key, next)
      if (id !== run.current) return
      setGifs((list) => (fresh ? result.gifs : [...list, ...result.gifs.filter((g) => !list.some((x) => x.id === g.id))]))
      setPage(next)
      setHasNext(result.hasNext && next < 50)
    } catch (e) {
      if (id === run.current) setError((e as Error).message)
    } finally {
      if (id === run.current) setBusy(false)
    }
  }

  if (enabled === undefined) return <div className="gif-panel gif-center"><Spinner /></div>
  if (!enabled) {
    return (
      <div className="gif-panel gif-center gif-off">
        <strong>GIFs aren't on for this server yet</strong>
        <p className="muted">An admin can turn them on in Settings → Overview with a free API key from KLIPY. Searches then go through this server, so the GIF service never sees who you are.</p>
        <a className="button small" href={LINKS.gifsGuide} target="_blank" rel="noopener noreferrer">How to set up GIFs</a>
      </div>
    )
  }

  const shown = view === 'favourites' ? favourites ?? [] : gifs
  return (
    <div className="gif-panel">
      <div className="gif-top">
        <input className="gif-search" value={query} onChange={(e) => { setQuery(e.target.value); setView('browse') }} placeholder="Search GIFs" aria-label="Search GIFs" maxLength={100} />
        <button className={`gif-fav-toggle ${view === 'favourites' ? 'on' : ''}`} aria-pressed={view === 'favourites'} onClick={() => setView(view === 'favourites' ? 'browse' : 'favourites')} title="Favourites" aria-label={`Favourite GIFs (${favourites?.length ?? 0})`}>
          ★ <span>{favourites?.length ?? 0}</span>
        </button>
      </div>
      {view === 'browse' && !debounced && categories.length > 0 && (
        <div className="gif-categories" role="list" aria-label="Categories">
          {categories.slice(0, 20).map((c) => (
            <button key={c.query} role="listitem" onClick={() => setQuery(c.query)}>{c.name}</button>
          ))}
        </div>
      )}
      <div className="gif-scroll">
        {view === 'browse' && <h4 className="gif-heading">{debounced ? `Results for “${debounced}”` : 'Trending'}</h4>}
        {view === 'favourites' && !shown.length && <p className="muted picker-empty">Star a GIF to keep it here (on this device).</p>}
        {view === 'browse' && !busy && !error && !gifs.length && <p className="muted picker-empty">No GIFs found.</p>}
        <div className="gif-grid">
          {shown.map((gif) => (
            <div key={gif.id} className="gif-cell" style={{ aspectRatio: gif.width && gif.height ? `${gif.width} / ${gif.height}` : undefined }}>
              <button className="gif-send" onClick={() => onPick(gif)} aria-label={`Send GIF: ${gif.title}`} title={gif.title}>
                <img src={serverFileUrl(server.key, gif.preview) ?? undefined} alt="" loading="lazy" draggable={false} />
              </button>
              <button
                className={`gif-star ${isFavourite(favourites, gif) ? 'on' : ''}`}
                onClick={() => toggleFavourite(server.key, gif)}
                aria-label={isFavourite(favourites, gif) ? `Remove ${gif.title} from favourites` : `Add ${gif.title} to favourites`}
                aria-pressed={isFavourite(favourites, gif)}
              >
                ★
              </button>
            </div>
          ))}
        </div>
        {error && <p className="error-text picker-empty">{error}</p>}
        {busy && <div className="gif-center"><Spinner /></div>}
        {view === 'browse' && hasNext && !busy && <button className="button small gif-more" onClick={() => void load(page + 1)}>Load more</button>}
      </div>
      <footer className="gif-attribution muted">Powered by KLIPY · through {server.name}</footer>
    </div>
  )
}

/** A GIF in a message, shown through the server's proxy. */
export function GifMessage({ server, gif }: { server: ServerState; gif: MessageGif }) {
  const [open, setOpen] = useState(false)
  const url = serverFileUrl(server.key, gif.url)
  if (!url) return null
  const scale = Math.min(1, 320 / (gif.width || 320), 240 / (gif.height || 240))
  const size = gif.width && gif.height ? { width: Math.round(gif.width * scale), height: Math.round(gif.height * scale) } : undefined
  return (
    <>
      <button className="attachment-image chat-gif" onClick={() => setOpen(true)} aria-label={`GIF: ${gif.title}`}>
        <img src={url} alt={gif.title} loading="lazy" style={size} />
        <span className="chat-gif-badge" aria-hidden>GIF</span>
      </button>
      {open && <Lightbox items={[{ url, name: `${gif.title}.gif` }]} start={0} onClose={() => setOpen(false)} />}
    </>
  )
}
