// A photos channel: every photo in a justified grid grouped by month (only the rows on screen are drawn, so
// thousands scroll smoothly), albums, a filter by person and a sort by date, selecting many to move or delete,
// adding photos (the picker, or drop them on the channel) and the storage figures. A photo opens in the viewer.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { Channel } from '../../core/protocol'
import type { ServerState } from '../../state/store'
import {
  deleteAlbum, deletePhotos, downloadZip, galleryKey, loadGallery, movePhotos, openPhotoViewer, renameAlbum, createAlbum, uploadPhotos, usePhotos,
} from '../../state/photos'
import {
  albumCover, DEFAULT_VIEW, durationText, layoutGrid, moveInGrid, rangeIds, rowOf, rowsInView, uploaders, usedFraction, visiblePhotos,
  type GridKey, type GridRow, type PhotoSort, type ShownAlbum, type ShownPhoto,
} from '../../state/photosLogic'
import { errorMessage } from '../../i18n/errors'
import { announce } from '../a11y'
import { Spinner } from '../bits'
import { ChevronLeft, Lock, Menu as MenuGlyph, MessageCircle, Pencil, Plus, Trash, Users } from '../icons'
import { EmptyState, Segmented } from '../kit'
import { ChannelTopic } from '../chat/ChannelTopic'
import { formatSize } from '../chat/helpers'
import { LockBadge } from '../e2ee/E2ee'
import { usePhoneLayout } from '../usePhoneLayout'
import type { Panel } from '../Shell'
import { AlbumIcon, DownloadIcon, FolderMove, PhotosIcon, PlayGlyph, SelectMark, StorageIcon, UploadIcon } from './icons'
import {
  AddPhotosDialog, AlbumNameDialog, ConfirmDialog, monthText, MoveDialog, StorageDialog, UploadTray, useCanChange, usePhotoAbilities, usePhotoUrl,
} from './PhotoBits'
import { PhotoViewer } from './PhotoViewer'
import './photos.css'

const NO_PHOTOS: ShownPhoto[] = []
const NO_ALBUMS: ShownAlbum[] = []
const GRID_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'])
const ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,image/avif,video/mp4,video/quicktime,.jpg,.jpeg,.png,.webp,.gif,.heic,.heif,.avif,.mp4,.mov,.m4v'

type Dialog =
  | { kind: 'add'; files: File[] }
  | { kind: 'album-new' }
  | { kind: 'album-rename'; album: ShownAlbum }
  | { kind: 'album-delete'; album: ShownAlbum }
  | { kind: 'move' }
  | { kind: 'delete' }
  | { kind: 'storage' }

export function PhotosView({ server, channel, onToggle }: { server: ServerState; channel: Channel; onToggle: (panel: Panel) => void }) {
  const { t } = useTranslation()
  const key = galleryKey(server.key, channel.id)
  const gallery = usePhotos((s) => s.galleries[key])
  const viewer = usePhotos((s) => (s.viewer?.serverKey === server.key && s.viewer.channelId === channel.id ? s.viewer.photoId : null))
  const can = usePhotoAbilities(server, channel)
  const mayChange = useCanChange(server, can)
  const phone = usePhoneLayout()
  const online = server.status.state === 'online'
  const [tab, setTabState] = useState<'photos' | 'albums'>('photos')
  /** The album that was opened: an id, 'none' (photos in no album), or null. */
  const [picked, setPicked] = useState<number | 'none' | null>(null)
  const [person, setPersonState] = useState<string | null>(null)
  const [sort, setSort] = useState<PhotoSort>(DEFAULT_VIEW.sort)
  const [selected, setSelected] = useState<ReadonlySet<number> | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [dropping, setDropping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [zip, setZip] = useState<{ done: number; total: number; abort: AbortController } | null>(null)
  const picker = useRef<HTMLInputElement>(null)
  const anchor = useRef<number | null>(null)

  const loaded = !!gallery?.loaded
  const failed = !!gallery?.error
  const busy = !!gallery?.loading
  useEffect(() => {
    if (online && !loaded && !busy && !failed) void loadGallery(server.key, channel.id)
  }, [online, loaded, busy, failed, server.key, channel.id])

  const photos = gallery?.photos ?? NO_PHOTOS
  const albums = gallery?.albums ?? NO_ALBUMS
  const usage = gallery?.usage
  const readable = useMemo(() => photos.filter((p) => !p.locked), [photos])
  const lockedBefore = photos.length - readable.length
  const openAlbum = typeof picked === 'number' ? albums.find((a) => a.id === picked) : undefined
  // An album that was deleted while it was open: back to the list of albums.
  const album = typeof picked === 'number' && loaded && !openAlbum ? null : picked
  // Another tab, album or person shows other photos: what was selected goes.
  const setTab = (next: 'photos' | 'albums') => {
    setTabState(next)
    setSelected(null)
  }
  const setAlbum = (next: number | 'none' | null) => {
    setPicked(next)
    setSelected(null)
  }
  const setPerson = (next: string | null) => {
    setPersonState(next)
    setSelected(null)
  }

  const showingGrid = tab === 'photos' || album !== null
  const shown = useMemo(
    () => visiblePhotos(readable, { album: album === null ? 'all' : album, person, sort }),
    [readable, album, person, sort])
  const people = useMemo(() => uploaders(album === null ? readable : readable.filter((p) => (album === 'none' ? p.albumId === null : p.albumId === album)))
    .map((u) => ({ ...u, name: server.members[u.key]?.name ?? t('common.someone') })), [readable, album, server.members, t])
  const loose = useMemo(() => readable.filter((p) => p.albumId === null), [readable])
  const fail = (e: unknown) => setError(typeof e === 'string' ? e : errorMessage(e))

  const chosen = useMemo(() => (selected ? shown.filter((p) => selected.has(p.id)) : []), [selected, shown])
  const canChangeChosen = chosen.length > 0 && chosen.every(mayChange.photo)

  function pick(files: FileList | File[] | null) {
    const list = [...(files ?? [])]
    if (list.length > 0) setDialog({ kind: 'add', files: list })
  }

  function onDrop(e: DragEvent) {
    setDropping(false)
    if (!can.add || e.dataTransfer.files.length === 0) return
    e.preventDefault()
    pick(e.dataTransfer.files)
  }

  const toggle = useCallback((id: number, range: boolean) => {
    setSelected((current) => {
      const next = new Set(current ?? [])
      if (range && anchor.current !== null) for (const each of rangeIds(shown, anchor.current, id)) next.add(each)
      else if (next.has(id)) next.delete(id)
      else next.add(id)
      anchor.current = id
      return next
    })
  }, [shown])

  const activate = useCallback((photo: ShownPhoto, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => {
    if (selected || e.ctrlKey || e.metaKey) toggle(photo.id, e.shiftKey)
    else openPhotoViewer(server.key, channel.id, photo.id)
  }, [selected, toggle, server.key, channel.id])

  async function download(what: { albumId: number } | { all: true } | { loose: true }, name: string, list: ShownPhoto[]) {
    setError(null)
    const abort = new AbortController()
    try {
      if (channel.e2ee) setZip({ done: 0, total: list.length, abort })
      const result = await downloadZip(server.key, channel.id, what, name, list, (done, total) => setZip({ done, total, abort }), abort.signal)
      if (result === 'saved') announce(t('photos.zip.saved'))
    } catch (e) {
      fail(e)
    } finally {
      setZip(null)
    }
  }

  const title = album === 'none' ? t('photos.albums.none') : openAlbum?.name ?? ''
  const zipOf = () => album === 'none' ? download({ loose: true }, `${channel.name} ${t('photos.albums.none')}`, loose)
    : openAlbum ? download({ albumId: openAlbum.id }, openAlbum.name, shown)
    : download({ all: true }, channel.name, readable)
  const fraction = usage ? usedFraction(usage) : null

  return (
    <div className={`chat photos ${dropping ? 'dropping' : ''}`} data-testid="photos-channel"
      onDragOver={(e) => {
        if (!can.add || !e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDropping(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false)
      }}
      onDrop={onDrop}>
      <header className="chat-header">
        <button className="icon-button mobile-only" onClick={() => onToggle('nav')} aria-label={t('photos.view.openChannels')}>
          <MenuGlyph />
        </button>
        <h1>
          <span className="hash"><PhotosIcon size={20} /></span>
          {channel.name}
          <LockBadge channel={channel} size={14} />
        </h1>
        <span className="spacer" />
        {usage && (
          <button className={`photos-storage-button ${fraction !== null && fraction >= 1 ? 'full' : ''}`} onClick={() => setDialog({ kind: 'storage' })}
            title={t('photos.storage.title')} data-testid="photos-storage">
            <StorageIcon size={16} />
            <span>{usage.capBytes === null ? formatSize(usage.bytes) : t('photos.storage.short', { used: formatSize(usage.bytes), cap: formatSize(usage.capBytes) })}</span>
          </button>
        )}
        <button className="icon-button members-toggle" onClick={() => onToggle('members')} aria-label={t('photos.view.members')} title={t('photos.view.members')}>
          <Users />
        </button>
      </header>
      <ChannelTopic channel={channel} />

      <div className="photos-toolbar">
        {album === null ? (
          <Segmented className="photos-tabs" label={t('photos.view.tabs')} value={tab} onChange={setTab}
            items={[
              { id: 'photos', label: <>{t('photos.view.all')} <span className="photos-count">{readable.length}</span></>, name: t('photos.view.all'), testId: 'photos-tab-photos' },
              { id: 'albums', label: <>{t('photos.view.albums')} <span className="photos-count">{albums.length}</span></>, name: t('photos.view.albums'), testId: 'photos-tab-albums' },
            ]} />
        ) : (
          <div className="photos-crumb">
            <button className="icon-button" onClick={() => setAlbum(null)} aria-label={t('photos.album.back')} title={t('photos.album.back')} data-testid="photos-album-back"><ChevronLeft /></button>
            <h2 data-testid="photos-album-title">{title}</h2>
            <span className="photos-count">{shown.length}</span>
          </div>
        )}
        {showingGrid && (
          <div className="photos-filters" role="group" aria-label={t('photos.filter.label')}>
            {people.length > 1 && (
              <select className="photos-select" aria-label={t('photos.filter.person')} value={person ?? ''} onChange={(e) => setPerson(e.target.value || null)} data-testid="photos-person">
                <option value="">{t('photos.filter.everyone')}</option>
                {people.map((p) => <option key={p.key} value={p.key}>{t('photos.filter.personCount', { name: p.name, count: p.count })}</option>)}
              </select>
            )}
            <select className="photos-select" aria-label={t('photos.sort.label')} value={sort} onChange={(e) => setSort(e.target.value as PhotoSort)} data-testid="photos-sort">
              <option value="newest">{t('photos.sort.newest')}</option>
              <option value="oldest">{t('photos.sort.oldest')}</option>
            </select>
          </div>
        )}
        <span className="spacer" />
        <div className="photos-actions">
          {openAlbum && mayChange.album(openAlbum) && (
            <>
              <button className="icon-button" onClick={() => setDialog({ kind: 'album-rename', album: openAlbum })} aria-label={t('photos.album.rename')} title={t('photos.album.rename')} data-testid="photos-album-rename"><Pencil size={16} /></button>
              <button className="icon-button" onClick={() => setDialog({ kind: 'album-delete', album: openAlbum })} aria-label={t('photos.album.delete')} title={t('photos.album.delete')} data-testid="photos-album-delete"><Trash size={16} /></button>
            </>
          )}
          {showingGrid && shown.length > 0 && (
            <>
              <button className="button photos-download" disabled={!!zip} onClick={() => void zipOf()} data-testid="photos-download"
                title={album === null ? t('photos.zip.all') : t('photos.zip.album')}>
                <DownloadIcon size={16} /> <span className="photos-wide-label">{album === null ? t('photos.zip.all') : t('photos.zip.album')}</span>
              </button>
              <button className={`button ${selected ? 'on' : ''}`} aria-pressed={!!selected} onClick={() => setSelected(selected ? null : new Set())} data-testid="photos-select">
                {selected ? t('common.cancel') : t('photos.select.start')}
              </button>
            </>
          )}
          {tab === 'albums' && album === null && can.add && (
            <button className="button" onClick={() => setDialog({ kind: 'album-new' })} data-testid="photos-new-album">
              <Plus size={16} /> {t('photos.album.new')}
            </button>
          )}
          {can.add && (
            <button className="button primary photos-add" onClick={() => picker.current?.click()} data-testid="photos-add">
              <UploadIcon size={16} /> <span className="photos-add-label">{t('photos.view.add')}</span>
            </button>
          )}
          <input ref={picker} type="file" accept={ACCEPT} multiple hidden data-testid="photos-file-input"
            onChange={(e) => {
              pick(e.target.files)
              e.target.value = ''
            }} />
        </div>
      </div>

      {error && <div className="banner error photos-banner" role="alert"><span>{error}</span><button className="link" onClick={() => setError(null)}>{t('common.close')}</button></div>}
      {gallery?.error && (
        <div className="banner error photos-banner" role="alert">
          <span>{gallery.error}</span>
          <button className="link" onClick={() => void loadGallery(server.key, channel.id)}>{t('photos.view.retry')}</button>
        </div>
      )}
      {can.blocked && channel.e2ee && <p className="photos-note muted small-text">{can.blocked}</p>}
      {lockedBefore > 0 && (
        <p className="photos-note muted small-text" data-testid="photos-locked"><Lock size={13} /> {t('photos.view.lockedBefore', { count: lockedBefore })}</p>
      )}
      {zip && (
        <div className="banner photos-banner" role="status" data-testid="photos-zip-progress">
          <span>{t('photos.zip.progress', { done: zip.done, total: zip.total })}</span>
          <button className="link" onClick={() => zip.abort.abort()}>{t('common.cancel')}</button>
        </div>
      )}

      {!loaded && !failed && photos.length === 0 ? (
        <div className="photos-wait"><Spinner /></div>
      ) : tab === 'albums' && album === null ? (
        <AlbumList server={server} albums={albums} photos={readable} loose={loose} onOpen={setAlbum} canAdd={can.add} onNew={() => setDialog({ kind: 'album-new' })} />
      ) : shown.length === 0 ? (
        <EmptyState size="page" icon={<PhotosIcon size={30} />} testId="photos-empty"
          title={person ? t('photos.empty.person') : album !== null ? t('photos.empty.album') : t('photos.empty.title')}
          body={person ? undefined : can.add ? (phone ? t('photos.empty.writerPhone') : t('photos.empty.writer')) : t('photos.empty.reader')}
          action={can.add && !person ? <button className="button primary" onClick={() => picker.current?.click()}><UploadIcon size={16} /> {t('photos.view.add')}</button> : undefined} />
      ) : (
        <PhotoGrid server={server} photos={shown} target={phone ? 112 : 196} gap={phone ? 3 : 4} months selected={selected}
          onActivate={activate} onSelect={toggle} label={title || channel.name} />
      )}

      {selected && (
        <div className="photos-selection" role="toolbar" aria-label={t('photos.select.label')} data-testid="photos-selection">
          <span className="photos-selection-count" aria-live="polite">{t('photos.select.count', { count: chosen.length })}</span>
          <button className="button small" onClick={() => setSelected(new Set(shown.map((p) => p.id)))} data-testid="photos-select-all">{t('photos.select.all')}</button>
          <span className="spacer" />
          <button className="button small" disabled={!canChangeChosen || !can.add} onClick={() => setDialog({ kind: 'move' })} data-testid="photos-move"
            title={chosen.length > 0 && !canChangeChosen ? t('photos.select.notYours') : undefined}>
            <FolderMove size={16} /> {t('photos.select.move')}
          </button>
          <button className="button small danger" disabled={!canChangeChosen} onClick={() => setDialog({ kind: 'delete' })} data-testid="photos-delete"
            title={chosen.length > 0 && !canChangeChosen ? t('photos.select.notYours') : undefined}>
            <Trash size={16} /> {t('common.delete')}
          </button>
        </div>
      )}

      <UploadTray serverKey={server.key} channelId={channel.id} />
      {dropping && <div className="photos-drop" aria-hidden><UploadIcon size={34} /><span>{t('photos.view.drop')}</span></div>}

      {dialog?.kind === 'add' && (
        <AddPhotosDialog server={server} channel={channel} files={dialog.files} albums={albums} album={typeof album === 'number' ? album : null}
          onClose={() => setDialog(null)}
          onAdd={(albumId, keepDate) => {
            uploadPhotos(server.key, channel.id, dialog.files, { albumId, keepDate })
            setDialog(null)
          }} />
      )}
      {dialog?.kind === 'album-new' && (
        <AlbumNameDialog title={t('photos.album.new')} initial="" action={t('photos.album.create')} onClose={() => setDialog(null)}
          onSave={async (name) => {
            const made = await createAlbum(server.key, channel.id, name)
            setAlbum(made.id)
          }} />
      )}
      {dialog?.kind === 'album-rename' && (
        <AlbumNameDialog title={t('photos.album.rename')} initial={dialog.album.name} action={t('common.save')} onClose={() => setDialog(null)}
          onSave={(name) => renameAlbum(server.key, dialog.album, name)} />
      )}
      {dialog?.kind === 'album-delete' && (
        <ConfirmDialog title={t('photos.album.deleteTitle', { name: dialog.album.name })} body={t('photos.album.deleteBody')} action={t('photos.album.delete')}
          onClose={() => setDialog(null)} onConfirm={async () => {
            await deleteAlbum(server.key, dialog.album)
            setAlbum(null)
          }} />
      )}
      {dialog?.kind === 'move' && (
        <MoveDialog count={chosen.length} albums={albums} onClose={() => setDialog(null)}
          current={chosen.every((p) => p.albumId === chosen[0]?.albumId) ? chosen[0]?.albumId : undefined}
          onMove={async (albumId) => {
            await movePhotos(server.key, channel.id, chosen.map((p) => p.id), albumId)
            setSelected(null)
          }} />
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog title={t('photos.delete.title', { count: chosen.length })} body={t('photos.delete.body', { count: chosen.length })} action={t('common.delete')}
          onClose={() => setDialog(null)} onConfirm={async () => {
            await deletePhotos(server.key, channel.id, chosen.map((p) => p.id))
            setSelected(null)
          }} />
      )}
      {dialog?.kind === 'storage' && <StorageDialog server={server} channel={channel} can={can} onClose={() => setDialog(null)} />}
      {viewer !== null && <PhotoViewer key={viewer} server={server} channel={channel} photoId={viewer} order={shown.some((p) => p.id === viewer) ? shown : readable} albums={albums} can={can} />}
    </div>
  )
}

// ── Albums ──────────────────────────────────────────────────────────────────

function AlbumList({ server, albums, photos, loose, onOpen, canAdd, onNew }: {
  server: ServerState
  albums: ShownAlbum[]
  photos: ShownPhoto[]
  loose: ShownPhoto[]
  onOpen: (album: number | 'none') => void
  canAdd: boolean
  onNew: () => void
}) {
  const { t } = useTranslation()
  const shown = albums.filter((a) => !a.locked)
  const hidden = albums.length - shown.length
  if (shown.length === 0 && loose.length === 0 && hidden === 0) {
    return (
      <EmptyState size="page" icon={<AlbumIcon size={30} />} title={t('photos.albums.emptyTitle')} body={canAdd ? t('photos.albums.emptyWriter') : t('photos.albums.emptyReader')}
        action={canAdd ? <button className="button primary" onClick={onNew}><Plus size={16} /> {t('photos.album.new')}</button> : undefined} />
    )
  }
  return (
    <div className="photos-scroll">
      <ul className="photos-albums" data-testid="photos-albums">
        {shown.map((album) => (
          <li key={album.id}>
            <AlbumCard server={server} name={album.name} count={album.count} cover={albumCover(album, photos)} onOpen={() => onOpen(album.id)} testId={`photos-album-${album.id}`} />
          </li>
        ))}
        {loose.length > 0 && (
          <li>
            <AlbumCard server={server} name={t('photos.albums.none')} count={loose.length} muted onOpen={() => onOpen('none')} testId="photos-album-none"
              cover={loose.reduce<ShownPhoto | undefined>((best, p) => (!best || p.sortAt > best.sortAt ? p : best), undefined)} />
          </li>
        )}
      </ul>
      {hidden > 0 && <p className="photos-note muted small-text"><Lock size={13} /> {t('photos.albums.lockedBefore', { count: hidden })}</p>}
    </div>
  )
}

function AlbumCard({ server, name, count, cover, onOpen, muted, testId }: {
  server: ServerState; name: string; count: number; cover: ShownPhoto | undefined; onOpen: () => void; muted?: boolean; testId: string
}) {
  const { t } = useTranslation()
  const source = usePhotoUrl(server.key, cover, 'thumb')
  return (
    <button className={`photos-album ${muted ? 'muted-album' : ''}`} onClick={onOpen} data-testid={testId} aria-label={t('photos.albums.open', { name, count })}>
      <span className="photos-album-cover">
        {source.url ? <img src={source.url} alt="" loading="lazy" decoding="async" draggable={false} /> : <AlbumIcon size={34} />}
      </span>
      <span className="photos-album-name">{name}</span>
      <span className="photos-album-count">{t('photos.albums.count', { count })}</span>
    </button>
  )
}

// ── The grid ────────────────────────────────────────────────────────────────

/** Only the rows on screen (and a little above and below) are in the document. */
function PhotoGrid({ server, photos, target, gap, months, selected, onActivate, onSelect, label }: {
  server: ServerState
  photos: ShownPhoto[]
  target: number
  gap: number
  months: boolean
  selected: ReadonlySet<number> | null
  onActivate: (photo: ShownPhoto, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => void
  onSelect: (id: number, range: boolean) => void
  label: string
}) {
  const { t } = useTranslation()
  const scroller = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [view, setView] = useState({ top: 0, height: 800 })
  const [focus, setFocus] = useState<number | null>(null)
  const pendingFocus = useRef(false)
  const frame = useRef(0)

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const measure = () => {
      const style = getComputedStyle(el)
      setWidth(Math.max(0, Math.floor(el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight))))
      setView((v) => (v.height === el.clientHeight ? v : { ...v, height: el.clientHeight }))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const layout = useMemo(() => layoutGrid(photos, width, target, gap, months), [photos, width, target, gap, months])
  const rows = useMemo(() => rowsInView(layout.rows, view.top, view.height), [layout, view])
  const byId = useMemo(() => new Map(photos.map((p) => [p.id, p])), [photos])
  // The arrow keys start from the photo that has the keyboard, else the first one.
  const tabStop = focus !== null && byId.has(focus) ? focus : photos[0]?.id ?? null

  useEffect(() => {
    if (!pendingFocus.current || focus === null) return
    pendingFocus.current = false
    scroller.current?.querySelector<HTMLElement>(`[data-photo="${focus}"]`)?.focus({ preventScroll: true })
  })

  function onKeyDown(e: KeyboardEvent) {
    if (!GRID_KEYS.has(e.key) || e.altKey || e.ctrlKey || e.metaKey || tabStop === null) return
    const next = moveInGrid(layout.rows, photos, tabStop, e.key as GridKey)
    e.preventDefault()
    if (next === null) return
    // Its row may not be drawn yet: bring it into view first, then the keyboard goes to it.
    const row = rowOf(layout.rows, next)
    const el = scroller.current
    if (row && el) {
      if (row.top < el.scrollTop) el.scrollTop = Math.max(0, row.top - 8)
      else if (row.top + row.height > el.scrollTop + el.clientHeight) el.scrollTop = row.top + row.height - el.clientHeight + 8
    }
    pendingFocus.current = true
    setFocus(next)
  }

  return (
    <div className="photos-scroll" ref={scroller} data-testid="photos-scroll"
      onScroll={(e) => {
        const top = e.currentTarget.scrollTop
        cancelAnimationFrame(frame.current)
        frame.current = requestAnimationFrame(() => setView((v) => (Math.abs(v.top - top) < 40 ? v : { ...v, top })))
      }}>
      <div className={`photo-grid ${selected ? 'selecting' : ''}`} style={{ height: layout.height }} role="group" aria-label={t('photos.grid.label', { name: label, count: photos.length })}
        onKeyDown={onKeyDown} data-testid="photo-grid" data-count={photos.length}>
        {rows.map((row) => <Row key={row.key} row={row} server={server} byId={byId} gap={gap} selected={selected} tabStop={tabStop}
          onActivate={onActivate} onSelect={onSelect} onFocus={setFocus} />)}
      </div>
    </div>
  )
}

const Row = memo(function Row({ row, server, byId, selected, tabStop, onActivate, onSelect, onFocus }: {
  row: GridRow
  server: ServerState
  byId: Map<number, ShownPhoto>
  gap: number
  selected: ReadonlySet<number> | null
  tabStop: number | null
  onActivate: (photo: ShownPhoto, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => void
  onSelect: (id: number, range: boolean) => void
  onFocus: (id: number) => void
}) {
  if (row.kind === 'header') {
    return <h3 className="photo-month" style={{ top: row.top, height: row.height }}>{monthText(row.month)}</h3>
  }
  return (
    <>
      {row.tiles.map((tile) => {
        const photo = byId.get(tile.id)
        if (!photo) return null
        return (
          <PhotoTile key={tile.id} server={server} photo={photo} style={{ top: row.top, left: tile.left, width: tile.width, height: row.height }}
            selected={selected ? selected.has(tile.id) : null} tabbable={tabStop === tile.id} onActivate={onActivate} onSelect={onSelect} onFocus={onFocus} />
        )
      })}
    </>
  )
})

const PhotoTile = memo(function PhotoTile({ server, photo, style, selected, tabbable, onActivate, onSelect, onFocus }: {
  server: ServerState
  photo: ShownPhoto
  style: { top: number; left: number; width: number; height: number }
  /** Null: not in select mode. */
  selected: boolean | null
  tabbable: boolean
  onActivate: (photo: ShownPhoto, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => void
  onSelect: (id: number, range: boolean) => void
  onFocus: (id: number) => void
}) {
  const { t } = useTranslation()
  const source = usePhotoUrl(server.key, photo, 'thumb')
  const [broken, setBroken] = useState(false)
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null)
  const held = useRef(false)
  const who = server.members[photo.uploader]?.name ?? t('common.someone')
  const labelText = photo.caption
    ? t('photos.grid.photoCaption', { name: who, caption: photo.caption })
    : t(photo.kind === 'video' ? 'photos.grid.video' : 'photos.grid.photo', { name: who })
  const stopHold = () => {
    if (hold.current) clearTimeout(hold.current)
    hold.current = null
  }

  return (
    <div className={`photo-tile ${selected ? 'selected' : ''} ${photo.kind}`} style={style}>
      <button className="photo-open" data-photo={photo.id} tabIndex={tabbable ? 0 : -1} aria-label={labelText} aria-pressed={selected ?? undefined}
        onFocus={() => onFocus(photo.id)}
        onClick={(e: MouseEvent) => {
          // A long press already selected it: the click that follows does nothing more.
          if (held.current) {
            held.current = false
            return
          }
          onActivate(photo, e)
        }}
        onPointerDown={(e) => {
          if (e.pointerType !== 'touch' || selected !== null) return
          held.current = false
          hold.current = setTimeout(() => {
            held.current = true
            navigator.vibrate?.(10)
            onSelect(photo.id, false)
          }, 450)
        }}
        onPointerMove={stopHold} onPointerUp={stopHold} onPointerCancel={stopHold} onContextMenu={(e) => (held.current || hold.current) && e.preventDefault()}>
        {source.url && !broken
          ? <img src={source.url} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setBroken(true)} />
          : <span className="photo-blank">{photo.kind === 'video' ? <PlayGlyph size={22} /> : source.failed || broken ? <PhotosIcon size={22} /> : null}</span>}
        {photo.kind === 'video' && (
          <span className="photo-badge video"><PlayGlyph size={10} /> {photo.duration ? durationText(photo.duration) : t('photos.grid.videoBadge')}</span>
        )}
        {photo.comments > 0 && <span className="photo-badge comments"><MessageCircle size={11} /> {photo.comments}</span>}
      </button>
      <button className="photo-check" tabIndex={-1} aria-hidden onClick={(e) => onSelect(photo.id, e.shiftKey)} data-testid={`photo-check-${photo.id}`}>
        <SelectMark on={!!selected} />
      </button>
    </div>
  )
})
