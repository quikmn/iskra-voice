// The composer's picker: Emoji / GIFs / Stickers tabs in one popover (a sheet on phones).
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { GifCategory, GifResult, MessageGif, Sticker } from '../../core/protocol'
import { serverFileUrl } from '../../state/expressions'
import { gifCategories, isFavourite, searchGifs, toggleFavourite, trendingGifs, useGifs, useGifStatus } from '../../state/gifs'
import { klipyFrameDocument } from '../../core/klipy'
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
  const status = useGifStatus(server.key)
  const enabled = status?.enabled
  const isDirect = status?.mode !== 'proxy'
  // Favourites made in the other mode can't be sent in this one.
  const favourites = useGifs((s) => s.favourites[server.key])?.filter((f) => !!f.direct === isDirect)
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
  }, [debounced, enabled, status?.mode, server.key])

  useEffect(() => {
    if (!enabled) return
    gifCategories(server.key).then(setCategories).catch(() => setCategories([]))
  }, [enabled, status?.mode, server.key])

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
        <p className="muted">An admin can turn them on in Settings → Overview with a free API key from KLIPY.</p>
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
                <GifImage server={server} url={gif.preview} direct={!!gif.direct} alt="" />
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
      <footer className="gif-attribution muted">
        Powered by KLIPY · {isDirect ? 'KLIPY sees your address and searches' : `through ${server.name}, so KLIPY doesn't see who you are`}
      </footer>
    </div>
  )
}

/**
 * One GIF image. Through the server: an <img> from its proxy. Direct: KLIPY's file inside a sandboxed frame whose own
 * policy lets it load images from KLIPY's media hosts only (and nothing else), after checking the address.
 */
function GifImage({ server, url, direct, alt, style }: { server: ServerState; url: string; direct: boolean; alt: string; style?: CSSProperties }) {
  if (!direct) return <img src={serverFileUrl(server.key, url) ?? undefined} alt={alt} loading="lazy" draggable={false} style={style} />
  const doc = klipyFrameDocument(url, alt)
  if (!doc) return null
  return <iframe className="klipy-frame" srcDoc={doc} sandbox="" referrerPolicy="no-referrer" title={alt || 'GIF'} loading="lazy" style={style} tabIndex={-1} />
}

/** A GIF in a message: through the server's proxy, or (direct mode) from KLIPY after a click unless auto-load is on. */
export function GifMessage({ server, gif }: { server: ServerState; gif: MessageGif }) {
  const [open, setOpen] = useState(false)
  const autoLoad = useGifs((s) => s.autoLoad)
  const [load, setLoad] = useState(false)
  const scale = Math.min(1, 320 / (gif.width || 320), 240 / (gif.height || 240))
  const size = gif.width && gif.height ? { width: Math.round(gif.width * scale), height: Math.round(gif.height * scale) } : { width: 240, height: 180 }
  if (gif.direct) {
    if (!autoLoad && !load) {
      return (
        <button className="gif-click-to-load" style={size} onClick={() => setLoad(true)}>
          <span className="chat-gif-badge" aria-hidden>GIF</span>
          <strong>Load GIF from KLIPY</strong>
          <span className="muted">{gif.title}</span>
          <span className="muted gif-note">KLIPY will see your address</span>
        </button>
      )
    }
    return (
      <div className="chat-gif direct" style={size}>
        <GifImage server={server} url={gif.url} direct alt={gif.title} style={size} />
        <span className="chat-gif-badge" aria-hidden>GIF</span>
      </div>
    )
  }
  const url = serverFileUrl(server.key, gif.url)
  if (!url) return null
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
