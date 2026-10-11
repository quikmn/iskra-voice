// Stickers: the picker in the composer, how a sticker message looks, and the admin list in Settings.
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../../i18n/errors'
import type { Sticker } from '../../core/protocol'
import { serverFileUrl } from '../../state/expressions'
import { MAX_STICKERS, addSticker, deleteSticker, renameSticker, useServerStickers } from '../../state/stickers'
import type { ServerState } from '../../state/store'
import { Trash } from '../icons'
import './stickers.css'

export const StickerIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9.5L21 14.5V5a2 2 0 0 0-2-2h-3.5" />
    <path d="M14 21v-4.5a2 2 0 0 1 2-2h5" />
    <path d="M8 13s1.5 2 4 2 4-2 4-2" />
    <line x1="9" x2="9.01" y1="9" y2="9" />
    <line x1="15" x2="15.01" y1="9" y2="9" />
  </svg>
)

/** The stickers tab of the composer's picker: search and a grid; picking sends. */
export function StickerPanel({ server, onPick }: { server: ServerState; onPick: (sticker: Sticker) => void }) {
  const stickers = useServerStickers(server.key)
  const [query, setQuery] = useState('')
  const { t } = useTranslation()
  const shown = stickers.filter((s) => s.name.toLowerCase().includes(query.trim().toLowerCase()))
  return (
    <div className="sticker-panel">
      <input className="sticker-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('chat.stickers.find')} aria-label={t('chat.stickers.search')} />
      <div className="sticker-grid">
        {shown.map((sticker) => (
          <button key={sticker.id} className="sticker-cell" onClick={() => onPick(sticker)} aria-label={t('chat.stickers.send', { name: sticker.name })} title={sticker.name}>
            <img src={serverFileUrl(server.key, sticker.url) ?? undefined} alt="" loading="lazy" draggable={false} />
          </button>
        ))}
        {stickers.length === 0 && <p className="muted picker-empty">{t('chat.stickers.none')}</p>}
        {stickers.length > 0 && shown.length === 0 && <p className="muted picker-empty">{t('chat.stickers.noMatch')}</p>}
      </div>
    </div>
  )
}

/** A sent sticker (or its name, once an admin removed it). */
export function StickerMessage({ server, sticker }: { server: ServerState; sticker: Sticker }) {
  const url = serverFileUrl(server.key, sticker.url)
  const { t } = useTranslation()
  if (!url) return <div className="sticker-gone muted">{t('chat.stickers.gone', { name: sticker.name })}</div>
  return <img className="sticker" src={url} alt={t('chat.stickers.alt', { name: sticker.name })} title={sticker.name} draggable={false} />
}

// ── Settings ────────────────────────────────────────────────────────────────

export function StickerSection({ server }: { server: ServerState }) {
  const stickers = useServerStickers(server.key)
  const input = useRef<HTMLInputElement>(null)
  const [pending, setPending] = useState<{ file: File; preview: string; name: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { t } = useTranslation()

  async function upload() {
    if (!pending || !pending.name.trim()) return
    setBusy(true)
    setError(null)
    try {
      await addSticker(server.key, pending.file, pending.name.trim())
      URL.revokeObjectURL(pending.preview)
      setPending(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="settings-section">
      <h3>{t('chat.stickers.title')} · {stickers.length} / {MAX_STICKERS}</h3>
      <p className="muted">{t('chat.stickers.intro')}</p>
      <input ref={input} type="file" hidden accept="image/png,image/gif,image/webp,image/jpeg" aria-label={t('chat.stickers.image')}
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (file) setPending({ file, preview: URL.createObjectURL(file), name: file.name.replace(/\.\w+$/, '').slice(0, 30) })
        }} />
      {pending ? (
        <div className="expression-new">
          <img className="sticker small" src={pending.preview} alt="" />
          <input value={pending.name} maxLength={30} aria-label={t('chat.stickers.name')} onChange={(e) => setPending({ ...pending, name: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && void upload()} />
          <button className="button primary" disabled={busy || !pending.name.trim()} onClick={() => void upload()}>{busy ? t('chat.stickers.adding') : t('common.add')}</button>
          <button className="button" disabled={busy} onClick={() => { URL.revokeObjectURL(pending.preview); setPending(null) }}>{t('common.cancel')}</button>
        </div>
      ) : (
        <button className="button" disabled={stickers.length >= MAX_STICKERS} onClick={() => input.current?.click()}>{t('chat.stickers.upload')}</button>
      )}
      {error && <p className="error-text">{error}</p>}
      {stickers.length > 0 && (
        <ul className="expression-list">
          {stickers.map((sticker) => <StickerRow key={sticker.id} server={server} sticker={sticker} />)}
        </ul>
      )}
    </section>
  )
}

function StickerRow({ server, sticker }: { server: ServerState; sticker: Sticker }) {
  const [name, setName] = useState(sticker.name)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const { t } = useTranslation()
  async function rename() {
    if (name.trim() === sticker.name || !name.trim()) return setName(sticker.name)
    try {
      await renameSticker(server.key, sticker.id, name.trim())
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
      setName(sticker.name)
    }
  }
  return (
    <li className="expression-row">
      <img className="sticker small" src={serverFileUrl(server.key, sticker.url) ?? undefined} alt="" />
      <div className="expression-fields">
        <input value={name} maxLength={30} aria-label={t('chat.stickers.nameOf', { name: sticker.name })} onChange={(e) => setName(e.target.value)} onBlur={() => void rename()}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
        <span className="muted">{t('chat.stickers.by', { name: server.members[sticker.createdBy ?? '']?.name ?? t('chat.stickers.formerMember') })}</span>
        {error && <span className="error-text">{error}</span>}
      </div>
      {confirm ? (
        <>
          <button className="button danger small" onClick={() => void deleteSticker(server.key, sticker.id).catch((e: Error) => setError(errorMessage(e)))}>{t('common.delete')}</button>
          <button className="button small" onClick={() => setConfirm(false)}>{t('chat.threads.keep')}</button>
        </>
      ) : (
        <button className="icon-button" aria-label={t('chat.stickers.delete', { name: sticker.name })} title={t('common.delete')} onClick={() => setConfirm(true)}><Trash size={16} /></button>
      )}
    </li>
  )
}
