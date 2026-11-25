// Pieces of a photos channel shared by the grid and the viewer: showing a photo's file (decrypted first in an
// encrypted channel), what you may do with a photo, reactions, the dialogs (add photos, album name, move, storage,
// delete) and the list of running uploads.
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Channel } from '../../core/protocol'
import { MAX_ALBUM_NAME } from '../../core/photoCrypto'
import type { ServerState } from '../../state/store'
import { useServerRoles } from '../../state/roles'
import { canSendIn, has, outranks } from '../../state/permissions'
import {
  cancelUploads, createAlbum, dismissUploads, keepsDate, plainUrl, reactToPhoto, sealedUrl, setCap, setKeepsDate, usePhotos, type PhotoUpload,
} from '../../state/photos'
import { capField, parseCapMb, queueSummary, usedFraction, type ShownAlbum, type ShownPhoto } from '../../state/photosLogic'
import { errorMessage } from '../../i18n/errors'
import { dateTimeFormat } from '../../i18n/format'
import { useEncryptedWriteBlock } from '../e2ee/E2ee'
import { Modal, Spinner } from '../bits'
import { AlertTriangle, Check, Close, Lock } from '../icons'
import { formatSize } from '../chat/helpers'
import { EmojiGlyph } from '../expressions/EmojiPicker'

// ── Files ───────────────────────────────────────────────────────────────────

export interface PhotoSource {
  url: string | null
  failed: boolean
  /** Encrypted files: how much has been downloaded, 0 to 1. */
  progress: number
}

/** The URL to show a photo's thumbnail or full file from: the server's, or a blob: URL once this device decrypted it. */
export function usePhotoUrl(serverKey: string, photo: ShownPhoto | undefined, what: 'thumb' | 'file'): PhotoSource {
  const sealedId = photo?.sealed ? (what === 'thumb' ? photo.sealed.thumb?.id ?? photo.sealed.file.id : photo.sealed.file.id) : null
  const [state, setState] = useState<PhotoSource & { tag: string | null }>({ tag: null, url: null, failed: false, progress: 0 })
  const tag = sealedId ? `${serverKey}:${sealedId}:${what}` : null
  useEffect(() => {
    if (!photo?.sealed || !tag) return
    let alive = true
    setState({ tag, url: null, failed: false, progress: 0 })
    sealedUrl(serverKey, photo, what, (progress) => alive && setState((s) => (s.tag === tag && !s.url ? { ...s, progress } : s)))
      .then((url) => alive && setState({ tag, url, failed: false, progress: 1 }), () => alive && setState({ tag, url: null, failed: true, progress: 0 }))
    return () => {
      alive = false
    }
    // The photo's files never change; its id and which file is wanted name the work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverKey, tag])
  if (!photo) return { url: null, failed: false, progress: 0 }
  if (photo.sealed) return state.tag === tag ? state : { url: null, failed: false, progress: 0 }
  const url = plainUrl(serverKey, photo, what)
  return { url, failed: !url, progress: 1 }
}

// ── What you may do ─────────────────────────────────────────────────────────

export interface PhotoAbilities {
  /** Add photos, make albums, react, comment. */
  add: boolean
  /** Delete and move other people's photos and albums (the server also checks you outrank them). */
  moderate: boolean
  /** Set the storage cap. */
  manage: boolean
  /** Why you can't add to this encrypted channel right now (null: you can). */
  blocked: string | null
}

export function usePhotoAbilities(server: ServerState, channel: Channel): PhotoAbilities {
  const roles = useServerRoles(server.key)
  const blocked = useEncryptedWriteBlock(server, channel.id)
  return useMemo(() => ({
    add: canSendIn(server.me, channel, roles) && !blocked,
    moderate: has(server.me, roles, 'manageMessages'),
    manage: has(server.me, roles, 'manageChannels'),
    blocked,
  }), [server.me, channel, roles, blocked])
}

export function useCanChange(server: ServerState, can: PhotoAbilities) {
  const roles = useServerRoles(server.key)
  return useMemo(() => {
    const me = server.me
    const over = (owner: string) => can.moderate && (!server.members[owner] || outranks(me, server.members[owner], roles))
    return {
      /** Delete or move this photo. */
      photo: (photo: Pick<ShownPhoto, 'uploader'>) => !!me && (photo.uploader === me.accountKey || over(photo.uploader)),
      /** Rename, re-cover or delete this album. */
      album: (album: Pick<ShownAlbum, 'createdBy'>) => !!me && can.add && (album.createdBy === me.accountKey || over(album.createdBy)),
    }
  }, [server.me, server.members, roles, can.moderate, can.add])
}

// ── Dates ───────────────────────────────────────────────────────────────────

/** "July 2026" for a month key like "2026-07". */
export function monthText(month: string): string {
  const [year, m] = month.split('-').map(Number)
  return dateTimeFormat({ month: 'long', year: 'numeric' }).format(new Date(year, m - 1, 1))
}

export const dayText = (ms: number) => dateTimeFormat({ dateStyle: 'long' }).format(new Date(ms))
export const dayTimeText = (ms: number) => dateTimeFormat({ dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms))

// ── Reactions ───────────────────────────────────────────────────────────────

export function PhotoReactions({ server, photo, disabled }: { server: ServerState; photo: ShownPhoto; disabled?: boolean }) {
  const { t } = useTranslation()
  const me = server.me?.accountKey
  if (photo.reactions.length === 0) return null
  return (
    <div className="reactions photo-reactions">
      {photo.reactions.map((r) => {
        const mine = !!me && r.accounts.includes(me)
        const names = r.accounts.map((k) => server.members[k]?.name ?? t('common.someone')).join(', ')
        return (
          <button key={r.emoji} className={`reaction ${mine ? 'mine' : ''}`} title={t('chat.reactions.title', { names })} aria-pressed={mine}
            disabled={disabled} onClick={() => reactToPhoto(server.key, photo, r.emoji)}>
            <EmojiGlyph serverKey={server.key} emoji={r.emoji} /> <span className="count">{r.accounts.length}</span>
          </button>
        )
      })}
    </div>
  )
}

// ── Dialogs ─────────────────────────────────────────────────────────────────

/** After picking files: which album they go to, and whether the date taken is kept. */
export function AddPhotosDialog({ server, channel, files, albums, album, onAdd, onClose }: {
  server: ServerState
  channel: Channel
  files: File[]
  albums: ShownAlbum[]
  /** The album that was open when the files were picked. */
  album: number | null
  onAdd: (albumId: number | null, keepDate: boolean) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [albumId, setAlbumId] = useState<number | null>(album)
  const [keepDate, setKeepDate] = useState(keepsDate)
  const [naming, setNaming] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const size = files.reduce((n, f) => n + f.size, 0)
  const shown = albums.filter((a) => !a.locked)

  async function add() {
    setError(null)
    let target = albumId
    if (naming !== null) {
      if (!naming.trim()) return setError(t('photos.album.nameNeeded'))
      setBusy(true)
      try {
        target = (await createAlbum(server.key, channel.id, naming)).id
      } catch (e) {
        setBusy(false)
        return setError(errorMessage(e))
      }
    }
    setKeepsDate(keepDate)
    onAdd(target, keepDate)
  }

  return (
    <Modal title={t('photos.add.title', { count: files.length })} onClose={onClose} className="photos-add-modal"
      footer={<>
        <button className="button" onClick={onClose}>{t('common.cancel')}</button>
        <button className="button primary" disabled={busy} onClick={() => void add()} data-testid="photos-add-confirm">{t('photos.add.confirm', { count: files.length })}</button>
      </>}>
      <p className="muted photos-add-summary">{t('photos.add.summary', { count: files.length, size: formatSize(size) })}</p>
      <label className="field">
        <span>{t('photos.add.album')}</span>
        <select value={naming !== null ? 'new' : albumId ?? ''} data-testid="photos-add-album" onChange={(e) => {
          if (e.target.value === 'new') setNaming('')
          else {
            setNaming(null)
            setAlbumId(e.target.value ? Number(e.target.value) : null)
          }
        }}>
          <option value="">{t('photos.albums.none')}</option>
          {shown.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          <option value="new">{t('photos.add.newAlbum')}</option>
        </select>
      </label>
      {naming !== null && (
        <label className="field">
          <span>{t('photos.album.name')}</span>
          <input value={naming} maxLength={MAX_ALBUM_NAME} autoFocus placeholder={t('photos.album.placeholder')} onChange={(e) => setNaming(e.target.value)}
            data-testid="photos-add-album-name" onKeyDown={(e) => e.key === 'Enter' && void add()} />
        </label>
      )}
      <label className="checkbox photos-keep-date">
        <input type="checkbox" checked={keepDate} onChange={(e) => setKeepDate(e.target.checked)} data-testid="photos-keep-date" />
        <span>
          {t('photos.add.keepDate')}
          <span className="muted small-text">{t('photos.add.keepDateHint')}</span>
        </span>
      </label>
      <p className="photos-privacy-note" data-testid="photos-privacy-note">
        <Lock size={15} />
        <span>{channel.e2ee ? t('photos.add.privacyEncrypted') : t('photos.add.privacy')}</span>
      </p>
      {error && <div className="banner error" role="alert">{error}</div>}
    </Modal>
  )
}

/** A name for a new album, or a new name for one. */
export function AlbumNameDialog({ title, initial, action, onSave, onClose }: {
  title: string
  initial: string
  action: string
  onSave: (name: string) => Promise<void>
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    if (!name.trim()) return setError(t('photos.album.nameNeeded'))
    setBusy(true)
    setError(null)
    try {
      await onSave(name)
      onClose()
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  return (
    <Modal title={title} onClose={onClose}
      footer={<>
        <button className="button" onClick={onClose}>{t('common.cancel')}</button>
        <button className="button primary" disabled={busy || !name.trim()} onClick={() => void save()} data-testid="photos-album-save">{action}</button>
      </>}>
      <label className="field">
        <span>{t('photos.album.name')}</span>
        <input value={name} maxLength={MAX_ALBUM_NAME} autoFocus placeholder={t('photos.album.placeholder')} data-testid="photos-album-name"
          onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void save()} />
      </label>
      {error && <div className="banner error" role="alert">{error}</div>}
    </Modal>
  )
}

/** Where the selected photos go: an album, or none. */
export function MoveDialog({ count, albums, current, onMove, onClose }: {
  count: number
  albums: ShownAlbum[]
  /** The album every selected photo is in already (undefined: they differ). */
  current: number | null | undefined
  onMove: (albumId: number | null) => Promise<void>
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function move(albumId: number | null) {
    setBusy(true)
    setError(null)
    try {
      await onMove(albumId)
      onClose()
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  return (
    <Modal title={t('photos.move.title', { count })} onClose={onClose}>
      <ul className="photos-move-list">
        {[{ id: null as number | null, name: t('photos.albums.none') }, ...albums.filter((a) => !a.locked)].map((a) => (
          <li key={a.id ?? 'none'}>
            <button className="photos-move-row" disabled={busy || current === a.id} onClick={() => void move(a.id)} data-testid={`photos-move-${a.id ?? 'none'}`}>
              <span className="photos-move-name">{a.name}</span>
              {current === a.id && <Check size={16} />}
            </button>
          </li>
        ))}
      </ul>
      {error && <div className="banner error" role="alert">{error}</div>}
    </Modal>
  )
}

/** A yes/no question before something is deleted. */
export function ConfirmDialog({ title, body, action, onConfirm, onClose }: { title: string; body: string; action: string; onConfirm: () => Promise<void>; onClose: () => void }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <Modal title={title} onClose={onClose}
      footer={<>
        <button className="button" onClick={onClose}>{t('common.cancel')}</button>
        <button className="button danger" disabled={busy} data-testid="photos-confirm" onClick={() => {
          setBusy(true)
          setError(null)
          onConfirm().then(onClose, (e) => {
            setError(errorMessage(e))
            setBusy(false)
          })
        }}>{action}</button>
      </>}>
      <p>{body}</p>
      {error && <div className="banner error" role="alert">{error}</div>}
    </Modal>
  )
}

/** "1.2 GB of 5 GB used" with a bar; the cap itself is for people who manage channels. */
export function StorageDialog({ server, channel, can, onClose }: { server: ServerState; channel: Channel; can: PhotoAbilities; onClose: () => void }) {
  const { t } = useTranslation()
  const usage = usePhotos((s) => s.galleries[`${server.key}:${channel.id}`]?.usage)
  const start = capField(usage?.capBytes ?? null)
  const [text, setText] = useState(start.text)
  const [unit, setUnit] = useState(start.unit)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  if (!usage) return <Modal title={t('photos.storage.title')} onClose={onClose}><Spinner /></Modal>
  const fraction = usedFraction(usage)
  const mb = parseCapMb(text, unit)

  async function save() {
    if (mb === undefined) return setError(t('photos.storage.invalid'))
    setBusy(true)
    setError(null)
    try {
      await setCap(server.key, channel.id, mb)
      setSaved(true)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={t('photos.storage.title')} onClose={onClose}
      footer={can.manage ? <>
        <button className="button" onClick={onClose}>{t('common.close')}</button>
        <button className="button primary" disabled={busy} onClick={() => void save()} data-testid="photos-cap-save">{t('common.save')}</button>
      </> : undefined}>
      <UsageLine usage={usage} />
      {fraction !== null && fraction >= 1 && <p className="banner warning" role="status">{t('photos.storage.full')}</p>}
      <p className="muted small-text">{t('photos.storage.counts', { count: usage.count })}</p>
      {can.manage ? (
        <>
          <label className="field photos-cap-field">
            <span>{t('photos.storage.limit')}</span>
            <span className="photos-cap-row">
              <input inputMode="decimal" value={text} placeholder={t('photos.storage.noLimit')} data-testid="photos-cap-input"
                onChange={(e) => { setText(e.target.value); setSaved(false) }} onKeyDown={(e) => e.key === 'Enter' && void save()} />
              <select value={unit} aria-label={t('photos.storage.unit')} onChange={(e) => { setUnit(e.target.value as 'MB' | 'GB'); setSaved(false) }} data-testid="photos-cap-unit">
                <option value="MB">MB</option>
                <option value="GB">GB</option>
              </select>
            </span>
          </label>
          <p className="muted small-text">{t('photos.storage.limitHint')}</p>
          {saved && <p className="photos-saved" role="status"><Check size={15} /> {t('photos.storage.saved')}</p>}
        </>
      ) : (
        <p className="muted small-text">{usage.capBytes === null ? t('photos.storage.noLimitSet') : t('photos.storage.limitSetBy')}</p>
      )}
      {error && <div className="banner error" role="alert">{error}</div>}
    </Modal>
  )
}

/** "1.2 GB of 5 GB used" (or just what is used, without a cap) and a bar. */
export function UsageLine({ usage }: { usage: { bytes: number; capBytes: number | null } }) {
  const { t } = useTranslation()
  const fraction = usedFraction(usage)
  return (
    <div className="photos-usage" data-testid="photos-usage">
      <span className="photos-usage-text">
        {usage.capBytes === null ? t('photos.storage.used', { used: formatSize(usage.bytes) }) : t('photos.storage.usedOf', { used: formatSize(usage.bytes), cap: formatSize(usage.capBytes) })}
      </span>
      {fraction !== null && (
        <span className={`photos-usage-bar ${fraction >= 1 ? 'full' : fraction >= 0.9 ? 'near' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={Math.round(fraction * 100)} aria-label={t('photos.storage.title')}>
          <span style={{ width: `${Math.max(2, fraction * 100)}%` }} />
        </span>
      )}
    </div>
  )
}

// ── Uploads ─────────────────────────────────────────────────────────────────

const stateText = (u: PhotoUpload): 'photos.upload.waiting' | 'photos.upload.preparing' | 'photos.upload.uploading' | 'photos.upload.adding' | 'photos.upload.done' | 'photos.upload.failed' =>
  `photos.upload.${u.state}`

/** The uploads of this channel: one line for the whole queue, and each file with its own progress. */
export function UploadTray({ serverKey, channelId }: { serverKey: string; channelId: number }) {
  const { t } = useTranslation()
  const all = usePhotos((s) => s.uploads)
  const uploads = useMemo(() => all.filter((u) => u.serverKey === serverKey && u.channelId === channelId), [all, serverKey, channelId])
  const [open, setOpen] = useState(true)
  if (uploads.length === 0) return null
  const summary = queueSummary(uploads)
  return (
    <section className={`photos-uploads ${open ? 'open' : ''}`} aria-label={t('photos.upload.label')} data-testid="photos-uploads">
      <header className="photos-uploads-head">
        <button className="photos-uploads-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {summary.active ? <Spinner /> : summary.failed > 0 ? <AlertTriangle size={16} /> : <Check size={16} />}
          <span data-testid="photos-uploads-summary">
            {summary.active ? t('photos.upload.progress', { done: summary.done, total: summary.total })
              : summary.failed > 0 ? t('photos.upload.someFailed', { count: summary.failed, total: summary.total })
              : t('photos.upload.allDone', { count: summary.total })}
          </span>
        </button>
        {summary.active
          ? <button className="button small" onClick={() => cancelUploads(serverKey, channelId)}>{t('common.cancel')}</button>
          : <button className="icon-button small" onClick={dismissUploads} aria-label={t('common.close')} title={t('common.close')}><Close size={16} /></button>}
      </header>
      <div className="photos-uploads-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(summary.fraction * 100)} aria-label={t('photos.upload.label')}>
        <span style={{ width: `${summary.fraction * 100}%` }} />
      </div>
      {open && (
        <ul className="photos-uploads-list">
          {uploads.map((u) => (
            <li key={u.id} className={`photos-upload state-${u.state}`} data-testid="photos-upload">
              <span className="photos-upload-name" title={u.name}>{u.name}</span>
              <span className="photos-upload-state">{u.state === 'failed' ? u.error ?? t('photos.upload.failed') : u.state === 'uploading' ? `${Math.round(u.fraction * 100)}%` : t(stateText(u))}</span>
              {u.state !== 'failed' && u.state !== 'done' && (
                <span className="photos-upload-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(u.fraction * 100)} aria-label={u.name}>
                  <span style={{ width: `${u.fraction * 100}%` }} />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
