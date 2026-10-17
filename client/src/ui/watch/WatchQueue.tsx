// Listen together: the queue of what plays next (a panel under the player; a bottom sheet on phones) and the compact
// now-playing bar shown instead of the video in audio-only mode. The server keeps the queue with the party.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { WatchItem, WatchParty, WatchSourceInput } from '../../core/protocol'
import { errorMessage } from '../../i18n/errors'
import { uploadFile, type ServerState } from '../../state/store'
import { addToQueue, moveInQueue, playNow, removeFromQueue } from '../../state/watch'
import { clearIfSent, isAudioish, itemTitle, moveTarget, youTubeThumb } from '../../state/watchQueueLogic'
import { parseWatchInput } from '../../state/watchSync'
import { useEscapeLayer, useFocusTrap } from '../layers'
import { Close, Trash } from '../icons'
import { MusicIcon, PlayIcon, TvIcon } from './watchIcons'

const PHONE = '(max-width: 760px), (pointer: coarse)'
const phoneLike = () => typeof window !== 'undefined' && window.matchMedia(PHONE).matches

/** Phone-sized (or touch): the queue is a sheet. Follows the window as it's resized. */
export function usePhoneLike(): boolean {
  const [phone, setPhone] = useState(phoneLike)
  useEffect(() => {
    const query = window.matchMedia(PHONE)
    const update = () => setPhone(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return phone
}

const nameIn = (server: ServerState, accountKey: string, someone: string) => server.members[accountKey]?.name ?? someone

/** What's playing, in a line: artwork (a YouTube still once this viewer loads from YouTube anyway), title, what's next. */
export function NowPlaying({ server, party, title, showArt }: { server: ServerState; party: WatchParty; title: string; showArt: boolean }) {
  const { t } = useTranslation()
  const next = party.queue?.[0]
  const art = showArt && party.source.kind === 'youtube' && party.source.videoId ? youTubeThumb(party.source.videoId) : null
  return (
    <div className="watch-now-playing" data-testid="watch-now-playing">
      <span className="watch-art" aria-hidden>
        {art ? <img src={art} alt="" /> : isAudioish(party.source) ? <MusicIcon size={26} /> : <TvIcon size={26} />}
      </span>
      <span className="watch-now-text">
        <span className="watch-now-label">{t('watch.nowPlaying')}</span>
        <strong title={title}>{title}</strong>
        <span className="muted">
          {t('watch.hostedBy', { name: nameIn(server, party.host, t('common.someone')) })}
          {' · '}
          {next ? t('watch.upNext', { title: itemTitle(next.source, { youtube: t('watch.youtubeVideo'), video: t('watch.video') }) }) : t('watch.queueEnd')}
        </span>
      </span>
    </div>
  )
}

/** The queue: inline under the player, or (phones) a sheet from the bottom. `control`: may add, reorder, remove, skip. */
export function WatchQueue({ server, party, control, sheet, onClose }: {
  server: ServerState; party: WatchParty; control: boolean; sheet: boolean; onClose: () => void
}) {
  const { t } = useTranslation()
  const queue = party.queue ?? []
  const [error, setError] = useState<string | null>(null)
  const names = { youtube: t('watch.youtubeVideo'), video: t('watch.video') }
  const run = (action: () => Promise<void>) => {
    setError(null)
    action().catch((e: Error) => setError(errorMessage(e)))
  }
  const step = (item: WatchItem, direction: -1 | 1) => {
    const target = moveTarget(queue, item.id, direction)
    if (target) run(() => moveInQueue(server.key, party, item.id, target.before))
  }

  const body = (
    <div className={`watch-queue ${sheet ? 'in-sheet' : ''}`} data-testid="watch-queue" aria-label={t('watch.queue')} role={sheet ? undefined : 'region'}>
      <header className="watch-queue-head">
        <strong>{t('watch.queue')}</strong>
        <span className="muted">{t('watch.queueCount', { count: queue.length })}</span>
        <span className="spacer" />
        <button className="icon-button small" onClick={onClose} aria-label={t('common.close')} title={t('common.close')}><Close size={14} /></button>
      </header>
      {queue.length === 0 ? (
        <p className="muted watch-queue-empty">{t('watch.queueEmpty')}</p>
      ) : (
        <ol className="watch-queue-list">
          {queue.map((item, i) => {
            const title = itemTitle(item.source, names)
            return (
              <li key={item.id} className="watch-queue-item" data-testid="watch-queue-item">
                <span className="watch-queue-n" aria-hidden>{i + 1}</span>
                <span className="watch-queue-kind" aria-hidden>{isAudioish(item.source) ? <MusicIcon size={16} /> : <TvIcon size={16} />}</span>
                <span className="watch-queue-text">
                  <span className="watch-queue-title" title={title}>{title}</span>
                  <span className="muted">{t('watch.addedBy', { name: nameIn(server, item.addedBy, t('common.someone')) })}</span>
                </span>
                {control && (
                  <span className="watch-queue-actions">
                    <button className="icon-button small" onClick={() => run(() => playNow(server.key, party, item.id))} aria-label={`${t('watch.playNow')}: ${title}`} title={t('watch.playNow')}><PlayIcon size={15} /></button>
                    <button className="icon-button small" disabled={i === 0} onClick={() => step(item, -1)} aria-label={`${t('watch.moveUp')}: ${title}`} title={t('watch.moveUp')}>▲</button>
                    <button className="icon-button small" disabled={i === queue.length - 1} onClick={() => step(item, 1)} aria-label={`${t('watch.moveDown')}: ${title}`} title={t('watch.moveDown')}>▼</button>
                    <button className="icon-button small" onClick={() => run(() => removeFromQueue(server.key, party, item.id))} aria-label={`${t('watch.removeItem')}: ${title}`} title={t('watch.removeItem')}><Trash size={15} /></button>
                  </span>
                )}
              </li>
            )
          })}
        </ol>
      )}
      {control && <AddToQueue server={server} party={party} onError={setError} />}
      {error && <p className="error-text" role="alert">{error}</p>}
    </div>
  )
  return sheet ? <QueueSheet onClose={onClose} label={t('watch.queue')}>{body}</QueueSheet> : body
}

/** A link (YouTube or https) with an optional title, or an upload, onto the end of the queue. */
function AddToQueue({ server, party, onError }: { server: ServerState; party: WatchParty; onError: (message: string | null) => void }) {
  const { t } = useTranslation()
  const [link, setLink] = useState('')
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const parsed = parseWatchInput(link)

  async function add(source: WatchSourceInput | null = parsed) {
    if (!source || busy) return
    setBusy(true)
    onError(null)
    const sent = { link, title }
    try {
      await addToQueue(server.key, party, source, title.trim() || undefined)
      // Whatever was typed while the add was on its way stays.
      setLink(clearIfSent(sent.link))
      setTitle(clearIfSent(sent.title))
    } catch (e) {
      onError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  async function upload(file: File) {
    setBusy(true)
    onError(null)
    try {
      const info = await uploadFile(server.key, file, setProgress)
      setBusy(false)
      await add({ kind: 'file', fileId: info.id })
    } catch (e) {
      onError(errorMessage(e))
      setBusy(false)
    } finally {
      setProgress(null)
    }
  }

  return (
    <form className="watch-queue-add" onSubmit={(e) => { e.preventDefault(); void add() }}>
      <input value={link} onChange={(e) => setLink(e.target.value)} placeholder={t('watch.linkPlaceholder')} aria-label={t('watch.link')} />
      <input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder={t('watch.titleOptional')} aria-label={t('watch.titleOptional')} />
      <button className="button primary small" type="submit" disabled={!parsed || busy}>{t('watch.add')}</button>
      <label className={`button small watch-upload ${busy ? 'disabled' : ''}`}>
        {progress !== null ? t('watch.uploading', { percent: Math.round(progress * 100) }) : t('watch.uploadVideo')}
        <input type="file" accept="video/mp4,video/webm,audio/*" hidden disabled={busy} onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
      </label>
      {link.trim() && !parsed && <p className="error-text">{t('watch.badLink')}</p>}
    </form>
  )
}

/** Phones: the queue slides up from the bottom, over everything. */
function QueueSheet({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEscapeLayer(onClose)
  useFocusTrap(ref)
  useEffect(() => {
    ref.current?.focus()
  }, [])
  return createPortal(
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className="action-sheet watch-queue-sheet" role="dialog" aria-label={label} tabIndex={-1}>
        <span className="sheet-grabber" aria-hidden />
        {children}
      </div>
    </div>,
    document.body,
  )
}
