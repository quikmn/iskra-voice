// The composer's picker: Emoji / GIFs / Stickers tabs in one popover (a sheet on phones).
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../../i18n/errors'
import { roleRank, type GifCategory, type GifResult, type MessageGif, type Sticker } from '../../core/protocol'
import { serverFileUrl } from '../../state/expressions'
import { gifCategories, isFavourite, searchGifs, toggleFavourite, trendingGifs, useGifs, useGifStatus } from '../../state/gifs'
import { klipyFrameDocument } from '../../core/klipy'
import type { ServerState } from '../../state/store'
import { LINKS } from '../../links'
import { openServerSettings } from '../settings/open'
import { Spinner } from '../bits'
import { EmojiPicker } from '../expressions/EmojiPicker'
import { Lightbox } from './media'
import { StickerPanel } from './Stickers'
import './gifs.css'

export type ExpressionTab = 'emoji' | 'gifs' | 'stickers'
const TABS = [
  { id: 'emoji', label: 'chat.picker.emoji' },
  { id: 'gifs', label: 'chat.picker.gifs' },
  { id: 'stickers', label: 'chat.picker.stickers' },
] as const

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
  const { t } = useTranslation()
  const tabs = (
    <div className="expression-tabs" role="tablist" aria-label={t('chat.picker.pick')}>
      {TABS.map((tb) => (
        <button key={tb.id} role="tab" aria-selected={tab === tb.id} className={tab === tb.id ? 'active' : ''} onClick={() => setTab(tb.id)}>
          {t(tb.label)}
        </button>
      ))}
    </div>
  )
  const body = tab === 'gifs'
    ? <GifPanel server={server} onPick={(gif) => { onGif(gif); onClose() }} onClose={onClose} />
    : tab === 'stickers'
      ? <StickerPanel server={server} onPick={(sticker) => { onSticker(sticker); onClose() }} />
      : undefined
  return <EmojiPicker serverKey={server.key} anchor={anchor} keepOpen onPick={onEmoji} onClose={onClose} tabs={tabs} body={body} />
}

// ── GIFs ────────────────────────────────────────────────────────────────────

function GifPanel({ server, onPick, onClose }: { server: ServerState; onPick: (gif: GifResult) => void; onClose: () => void }) {
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
  const { t } = useTranslation()

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
      if (id === run.current) setError(errorMessage(e))
    } finally {
      if (id === run.current) setBusy(false)
    }
  }

  const admin = !!server.me && roleRank(server.me.role) >= roleRank('admin')
  if (enabled === undefined) return <div className="gif-panel gif-center"><Spinner /></div>
  if (!enabled) {
    return (
      <div className="gif-panel gif-center gif-off">
        <strong>{t('chat.picker.offTitle')}</strong>
        {admin ? (
          <>
            <p className="muted">{t('chat.picker.offHintAdmin')}</p>
            <button type="button" className="button small primary" onClick={() => { onClose(); openServerSettings(server.key, 'gifs') }}>{t('chat.picker.openGifSettings')}</button>
          </>
        ) : (
          <>
            <p className="muted">{t('chat.picker.offHint')}</p>
            <a className="button small" href={LINKS.gifsGuide} target="_blank" rel="noopener noreferrer">{t('chat.picker.setUp')}</a>
          </>
        )}
      </div>
    )
  }

  const shown = view === 'favourites' ? favourites ?? [] : gifs
  return (
    <div className="gif-panel">
      <div className="gif-top">
        <input className="gif-search" value={query} onChange={(e) => { setQuery(e.target.value); setView('browse') }} placeholder={t('chat.picker.searchGifs')} aria-label={t('chat.picker.searchGifs')} maxLength={100} />
        <button className={`gif-fav-toggle ${view === 'favourites' ? 'on' : ''}`} aria-pressed={view === 'favourites'} onClick={() => setView(view === 'favourites' ? 'browse' : 'favourites')} title={t('chat.picker.favourites')} aria-label={t('chat.picker.favouriteCount', { n: favourites?.length ?? 0 })}>
          ★ <span>{favourites?.length ?? 0}</span>
        </button>
      </div>
      {view === 'browse' && !debounced && categories.length > 0 && (
        <div className="gif-categories" role="list" aria-label={t('chat.picker.categories')}>
          {categories.slice(0, 20).map((c) => (
            <button key={c.query} role="listitem" onClick={() => setQuery(c.query)}>{c.name}</button>
          ))}
        </div>
      )}
      <div className="gif-scroll">
        {view === 'browse' && <h4 className="gif-heading">{debounced ? t('chat.picker.resultsFor', { query: debounced }) : t('chat.picker.trending')}</h4>}
        {view === 'favourites' && !shown.length && <p className="muted picker-empty">{t('chat.picker.favouritesEmpty')}</p>}
        {view === 'browse' && !busy && !error && !gifs.length && <p className="muted picker-empty">{t('chat.picker.noGifs')}</p>}
        <div className="gif-grid">
          {shown.map((gif) => (
            <div key={gif.id} className="gif-cell" style={{ aspectRatio: gif.width && gif.height ? `${gif.width} / ${gif.height}` : undefined }}>
              <button className="gif-send" onClick={() => onPick(gif)} aria-label={t('chat.picker.sendGif', { title: gif.title })} title={gif.title}>
                <GifImage server={server} url={gif.preview} direct={!!gif.direct} alt="" />
              </button>
              <button
                className={`gif-star ${isFavourite(favourites, gif) ? 'on' : ''}`}
                onClick={() => toggleFavourite(server.key, gif)}
                aria-label={isFavourite(favourites, gif) ? t('chat.picker.unfavourite', { title: gif.title }) : t('chat.picker.favourite', { title: gif.title })}
                aria-pressed={isFavourite(favourites, gif)}
              >
                ★
              </button>
            </div>
          ))}
        </div>
        {error && <p className="error-text picker-empty">{error}</p>}
        {busy && <div className="gif-center"><Spinner /></div>}
        {view === 'browse' && hasNext && !busy && <button className="button small gif-more" onClick={() => void load(page + 1)}>{t('chat.picker.loadMore')}</button>}
      </div>
      <footer className="gif-attribution muted">
        {t('chat.picker.poweredBy')} · {isDirect ? t('chat.picker.directNote') : t('chat.picker.proxyNote', { name: server.name })}
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
  const { t } = useTranslation()
  const scale = Math.min(1, 320 / (gif.width || 320), 240 / (gif.height || 240))
  const size = gif.width && gif.height ? { width: Math.round(gif.width * scale), height: Math.round(gif.height * scale) } : { width: 240, height: 180 }
  if (gif.direct) {
    if (!autoLoad && !load) {
      return (
        <button className="gif-click-to-load" style={size} onClick={() => setLoad(true)}>
          <span className="chat-gif-badge" aria-hidden>GIF</span>
          <strong>{t('chat.picker.loadGif')}</strong>
          <span className="muted">{gif.title}</span>
          <span className="muted gif-note">{t('chat.picker.loadGifNote')}</span>
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
      <button className="attachment-image chat-gif" onClick={() => setOpen(true)} aria-label={t('chat.picker.gifLabel', { title: gif.title })}>
        <img src={url} alt={gif.title} loading="lazy" style={size} />
        <span className="chat-gif-badge" aria-hidden>GIF</span>
      </button>
      {open && <Lightbox items={[{ url, name: `${gif.title}.gif` }]} start={0} onClose={() => setOpen(false)} />}
    </>
  )
}
