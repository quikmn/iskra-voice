// "Share to…": where text, links and files shared from another app go (state/shareIn.ts). Recent places first, search,
// an optional message, a preview of what will be sent. Nothing is sent until you pick a place and press Send.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../../i18n/errors'
import { formatNumber } from '../../i18n/format'
import { useApp } from '../../state/store'
import { discardShare, loadRecents, sendShare, useShareIn, useShareTargets } from '../../state/shareIn'
import { MAX_SHARE_TEXT, orderTargets, type IncomingShare, type ShareTarget } from '../../state/shareInLogic'
import { Avatar, Modal } from '../bits'
import { FileIcon, Hash, Lock, Users, Video } from '../icons'
import { formatSize } from '../chat/helpers'
import './share.css'

/** Mounted once (App.tsx); shows the picker while a share waits. */
export function ShareInLayer() {
  const share = useShareIn((s) => s.share)
  return share ? <SharePicker key={share.id} share={share} /> : null
}

function SharePicker({ share }: { share: IncomingShare }) {
  const { t } = useTranslation()
  const [text, setText] = useState(share.text)
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState<string | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const hasServers = useApp((s) => s.order.length > 0)
  const { targets, people } = useShareTargets()
  const [recents] = useState(loadRecents)
  const { recent, rest } = orderTargets(targets, people, recents, query)
  const all = [...recent, ...rest]
  // A place that went away (left the server, lost the right to post) is no longer chosen.
  const target = [...targets, ...people].find((x) => x.id === chosen) ?? null
  const busy = progress !== null
  const canSend = !!target && !busy && (text.trim().length > 0 || share.files.length > 0)

  async function send() {
    if (!target) return
    setError(null)
    setProgress(0)
    try {
      await sendShare(target, text, share.files, setProgress)
      discardShare()
    } catch (e) {
      setError(errorMessage(e))
      setProgress(null)
    }
  }

  const footer = (
    <>
      <button className="button" onClick={discardShare} disabled={busy}>{t('common.cancel')}</button>
      <button className="button primary" onClick={() => void send()} disabled={!canSend}
        aria-label={target ? t('share.sendTo', { target: targetLabel(target) }) : t('common.send')}>
        {busy ? t('share.sending', { percent: formatNumber(progress ?? 0, { style: 'percent', maximumFractionDigits: 0 }) }) : t('common.send')}
      </button>
    </>
  )

  return (
    <Modal title={t('share.title')} onClose={() => !busy && discardShare()} footer={footer} className="share-picker">
      <section className="share-preview" aria-label={t('share.preview')}>
        {share.files.length > 0 && (
          <ul className="share-files">
            {share.files.map((f) => (
              <li key={f.url} className="share-file" title={f.name}>
                {f.type.startsWith('image/')
                  ? <img src={f.url} alt={f.name} />
                  : <span className="share-file-icon">{f.type.startsWith('video/') ? <Video size={20} /> : <FileIcon size={20} />}</span>}
                <span className="share-file-name">{f.name}</span>
                <span className="muted share-file-size">{formatSize(f.size)}</span>
              </li>
            ))}
          </ul>
        )}
        {share.skipped > 0 && <p className="muted share-skipped">{t('share.skipped', { count: share.skipped })}</p>}
        <label className="field">
          <span>{t('share.message')}</span>
          <textarea value={text} onChange={(e) => setText(e.target.value.slice(0, MAX_SHARE_TEXT))} rows={text.includes('\n') || text.length > 60 ? 3 : 2}
            placeholder={t('share.messagePlaceholder')} disabled={busy} />
        </label>
      </section>

      {!hasServers ? (
        <p className="muted">{t('share.noServers')}</p>
      ) : (
        <>
          <label className="field share-search">
            <span>{t('share.sendToLabel')}</span>
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('share.search')} aria-label={t('share.search')} disabled={busy} />
          </label>
          <div className="share-targets" role="radiogroup" aria-label={t('share.places')}>
            {all.length === 0 && <p className="muted">{query.trim() ? t('share.nothing') : t('share.loading')}</p>}
            {recent.length > 0 && <h3 className="share-group">{t('share.recent')}</h3>}
            {recent.map((x) => <TargetRow key={x.id} target={x} chosen={chosen === x.id} disabled={busy} onPick={() => setChosen(x.id)} />)}
            {recent.length > 0 && rest.length > 0 && <h3 className="share-group">{t('share.everywhere')}</h3>}
            {rest.map((x) => <TargetRow key={x.id} target={x} chosen={chosen === x.id} disabled={busy} onPick={() => setChosen(x.id)} />)}
          </div>
        </>
      )}
      {busy && <div className="share-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((progress ?? 0) * 100)}><span style={{ width: `${(progress ?? 0) * 100}%` }} /></div>}
      {error && <p className="error-text" role="alert">{error}</p>}
    </Modal>
  )
}

const targetLabel = (x: ShareTarget) => (x.kind === 'channel' ? `#${x.name}` : x.name)

function TargetRow({ target, chosen, disabled, onPick }: { target: ShareTarget; chosen: boolean; disabled: boolean; onPick: () => void }) {
  const { t } = useTranslation()
  const sub = target.kind === 'channel' ? target.serverName : target.kind === 'dm' ? t('share.dm') : t('share.group', { server: target.serverName })
  return (
    <button type="button" role="radio" aria-checked={chosen} className={`share-target${chosen ? ' chosen' : ''}`} disabled={disabled} onClick={onPick}
      aria-label={`${targetLabel(target)}, ${sub}`}>
      {target.kind === 'dm'
        ? <Avatar name={target.name} accountKey={target.peer} size={28} />
        : <span className="share-target-icon">{target.kind === 'group' ? <Users size={18} /> : target.encrypted ? <Lock size={16} /> : <Hash size={18} />}</span>}
      <span className="share-target-text">
        <span className="share-target-name">{target.name}</span>
        <span className="muted share-target-sub">{sub}</span>
      </span>
      <span className="share-target-check" aria-hidden />
    </button>
  )
}
