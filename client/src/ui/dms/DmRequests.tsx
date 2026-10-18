// Message requests in the home sidebar and the DM view, and "Who can message me" in My settings → Privacy & data
// (state/dmRequests.ts keeps both in step with every server).
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { DmWho } from '../../core/protocol'
import { acceptRequest, blockRequest, ignoreRequest, setDmWho, useDmRequests, useDmStatus, useRequestPeers } from '../../state/dmRequests'
import { nameOf, openConversation, useDms, type Dm } from '../../state/dms'
import { errorMessage } from '../../i18n/errors'
import { AccountAvatar } from '../presence/Presence'
import { ChevronDown, ChevronRight, UserPlus } from '../icons'
import './dm-requests.css'

/** The "Message requests" part of the home sidebar: who's waiting (names only, never a preview) and, folded, who you ignored. */
export function DmRequestRows({ onNavigate }: { onNavigate: () => void }) {
  const { t } = useTranslation()
  const { requests, ignored } = useRequestPeers()
  const open = useDms((s) => s.open)
  const [showIgnored, setShowIgnored] = useState(false)
  if (requests.length === 0 && ignored.length === 0) return null
  const row = (peer: string) => (
    <button
      key={peer}
      className={`channel dm-row dm-request-row ${open.kind === 'dm' && open.peer === peer ? 'active' : ''}`}
      data-testid="dm-request-row"
      onClick={() => {
        openConversation(peer)
        onNavigate()
      }}
    >
      <AccountAvatar name={nameOf(peer)} accountKey={peer} size={28} />
      <span className="dm-row-text">
        <span className="channel-name">{nameOf(peer)}</span>
      </span>
    </button>
  )
  return (
    <div className="dm-requests" data-testid="dm-requests">
      <div className="channel-group">
        <span><UserPlus size={13} /> {t('dmRequests.title')}</span>
        {requests.length > 0 && <span className="badge" aria-label={t('dmRequests.badge', { count: requests.length })}>{requests.length}</span>}
      </div>
      {requests.length === 0 && <p className="sidebar-hint">{t('dmRequests.empty')}</p>}
      {requests.map(row)}
      {ignored.length > 0 && (
        <button className="link dm-requests-ignored-toggle" aria-expanded={showIgnored} onClick={() => setShowIgnored((v) => !v)}>
          {showIgnored ? <ChevronDown size={12} /> : <ChevronRight size={12} />} {t('dmRequests.ignoredCount', { count: ignored.length })}
        </button>
      )}
      {showIgnored && ignored.map(row)}
    </div>
  )
}

/** In place of the composer while a conversation is a request: accept, ignore or block. */
export function DmRequestBar({ peer }: { peer: string }) {
  const { t } = useTranslation()
  const status = useDmStatus(peer)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const name = nameOf(peer)
  const run = (action: (peer: string) => Promise<void>) => {
    setBusy(true)
    setError(null)
    action(peer).catch((e: unknown) => setError(errorMessage(e))).finally(() => setBusy(false))
  }
  return (
    <div className="composer read-only dm-request-bar" data-testid="dm-request-bar" role="region" aria-label={t('dmRequests.title')}>
      <div className="dm-request-text">
        <strong>{status === 'ignored' ? t('dmRequests.ignoredBar', { name }) : t('dmRequests.bar', { name })}</strong>
        <span className="muted">{t('dmRequests.barHint')}</span>
        {error && <span className="error" role="alert">{error}</span>}
      </div>
      <div className="dm-request-actions">
        <button className="button primary small" disabled={busy} onClick={() => run(acceptRequest)}>{t('dmRequests.accept')}</button>
        {status !== 'ignored' && <button className="button small" disabled={busy} onClick={() => run(ignoreRequest)}>{t('dmRequests.ignore')}</button>}
        <button className="button small danger" disabled={busy} onClick={() => run(blockRequest)}>{t('dmRequests.block')}</button>
      </div>
    </div>
  )
}

/** A request's message, held back: plain text (no links or previews) and no files until it's accepted. */
export function HeldDmBody({ dm }: { dm: Dm }) {
  const { t } = useTranslation()
  const files = (dm.files?.length ?? 0) + (dm.forward?.files.length ?? 0)
  return (
    <>
      {dm.text && <div className="message-text held-text">{dm.text}</div>}
      {files > 0 && <div className="message-notice held-files">{t('dmRequests.filesHidden', { count: files })}</div>}
    </>
  )
}

const LEVELS: DmWho[] = ['anyone', 'requests', 'known', 'nobody']

export function DmPrivacySettings() {
  const { t } = useTranslation()
  const who = useDmRequests((s) => s.who)
  return (
    <section className="settings-section" data-testid="dm-privacy-settings">
      <h2>{t('dmRequests.settingTitle')}</h2>
      <div className="dm-privacy-options" role="radiogroup" aria-label={t('dmRequests.settingTitle')}>
        {LEVELS.map((level) => (
          <label key={level} className="checkbox dm-privacy-option">
            <input type="radio" name="dm-who" value={level} checked={who === level} onChange={() => void setDmWho(level)} />
            <span>
              <span>{t(`dmRequests.who.${level}`)}</span>
              <span className="muted">{t(`dmRequests.whoHint.${level}`)}</span>
            </span>
          </label>
        ))}
      </div>
      <p className="muted">{t('dmRequests.settingHint')}</p>
    </section>
  )
}
