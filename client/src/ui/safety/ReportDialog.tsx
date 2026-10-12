// Reporting a message or a person to a server's moderators. Opened from the message menu and the person menu.
// In encrypted DMs and groups no server can read the messages, so the reporter picks which ones to share (and
// sees exactly what goes) with the moderators of a server they share with the person, or just blocks them.
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { b64u } from '../../core/crypto'
import type { ReportReason } from '../../core/protocol'
import { errorMessage } from '../../i18n/errors'
import { nameOf, sharedServers } from '../../state/dms'
import { blockPerson } from '../../state/friends'
import { useIsBlocked } from '../../state/moderation'
import { closeReport, MAX_NOTE, MAX_SHARED, REPORT_REASONS, sendReport, shareCandidates, useReports, type ReportTarget } from '../../state/reports'
import { useApp } from '../../state/store'
import { safetyMailto } from '../../state/terms'
import { Modal, Spinner } from '../bits'
import { messageTime } from '../format'
import { plainText } from '../markdown'
import './safety.css'

export function ReportLayer() {
  const target = useReports((s) => s.dialog)
  if (!target) return null
  return <ReportDialog key={target.kind === 'message' ? `m${target.message.id}` : `p${target.accountKey}`} target={target} />
}

function ReportDialog({ target }: { target: ReportTarget }) {
  const { t } = useTranslation()
  const servers = useApp((s) => s.servers)
  const identity = useApp((s) => s.identity)
  const myKey = identity ? b64u(identity.account.publicKey) : ''
  const person = target.kind === 'message' ? target.message.author : target.accountKey
  const encrypted = target.kind === 'person' && target.serverKey === null
  const choices = encrypted ? sharedServers(person).filter((k) => servers[k]?.members[person]) : []
  const [serverKey, setServerKey] = useState<string | null>(target.serverKey ?? choices[0] ?? null)
  const server = serverKey ? servers[serverKey] : undefined
  const name = server?.members[person]?.name ?? nameOf(person)
  const [reason, setReason] = useState<ReportReason | null>(null)
  const [note, setNote] = useState('')
  const candidates = useMemo(() => (encrypted ? shareCandidates(person) : []), [encrypted, person])
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const blocked = useIsBlocked(person)
  // A message from an encrypted channel: the server can't read it, so the reporter may share what it says.
  const sealedText = target.kind === 'message' && target.message.e2ee ? target.message.text : ''
  const [shareSealed, setShareSealed] = useState(true)

  const shared = candidates.filter((c) => picked.has(c.id))
  const canSend = !!serverKey && !!reason && !busy && (shared.length === 0 || consent)
  const title = target.kind === 'message' ? t('safety.report.titleMessage') : t('safety.report.titlePerson', { name })

  async function submit() {
    if (!canSend || !serverKey || !reason) return
    setBusy(true)
    setError(null)
    try {
      await sendReport(serverKey, {
        reason, note,
        ...(target.kind === 'message'
          ? { messageId: target.message.id,
              ...(sealedText && shareSealed ? { messages: [{ author: target.message.author, text: sealedText.slice(0, 2000), at: target.message.createdAt }] } : {}) }
          : { accountKey: person, ...(shared.length ? { messages: shared.map(({ author, text, at }) => ({ author, text, at })) } : {}) }),
      })
      setSent(true)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const toggle = (id: string, on: boolean) => {
    const next = new Set(picked)
    if (on && next.size < MAX_SHARED) next.add(id)
    else next.delete(id)
    setPicked(next)
    setConsent(false) // agreeing covers exactly what's listed
  }

  const block = !blocked && person !== myKey && (
    <button className="button" onClick={() => void blockPerson(person).catch((e) => setError(errorMessage(e)))}>{t('safety.report.alsoBlock', { name })}</button>
  )
  const teamLink = (
    <p className="fine-print report-team">
      {t('safety.report.teamHint')}{' '}
      <a href={safetyMailto(t('safety.report.mailSubject'))}>{t('safety.links.reportToTeam')}</a>
    </p>
  )

  if (sent) {
    return (
      <Modal title={title} onClose={closeReport}>
        <div className="report-sent" role="status">
          <strong>{t('safety.report.sentTitle')}</strong>
          <p>{t('safety.report.sentBody', { server: server?.name ?? '', name })}</p>
        </div>
        <div className="report-actions">
          {block}
          <button className="button primary" onClick={closeReport}>{t('common.done')}</button>
        </div>
        {error && <p className="error-text" role="alert">{error}</p>}
      </Modal>
    )
  }

  // An encrypted conversation with nobody to send it to: blocking, or the Iskra team.
  if (encrypted && choices.length === 0) {
    return (
      <Modal title={title} onClose={closeReport}>
        <p>{t('safety.report.noSharedServer', { name })}</p>
        <div className="report-actions">
          {block}
          <button className="button" onClick={closeReport}>{t('common.close')}</button>
        </div>
        {teamLink}
        {error && <p className="error-text" role="alert">{error}</p>}
      </Modal>
    )
  }

  return (
    <Modal title={title} onClose={closeReport} className="report-modal">
      {target.kind === 'message' && server && (
        <blockquote className="report-quote" tabIndex={0}>
          <strong>{name}</strong>
          <span>{plainText(target.message.text, { nameOf: (k) => server.members[k]?.name ?? null }) || t('safety.report.noText')}</span>
        </blockquote>
      )}
      {sealedText && (
        <label className="checkbox report-consent">
          <input type="checkbox" checked={shareSealed} onChange={(e) => setShareSealed(e.target.checked)} />
          <span>{t('e2ee.report.share')}<br /><span className="muted small-text">{t('e2ee.report.shareHint')}</span></span>
        </label>
      )}
      <p className="muted report-lead">
        {encrypted ? t('safety.report.encryptedLead', { name }) : t('safety.report.lead', { server: server?.name ?? '', name })}
      </p>

      {encrypted && choices.length > 1 && (
        <label className="field">
          <span>{t('safety.report.server')}</span>
          <select value={serverKey ?? ''} onChange={(e) => { setServerKey(e.target.value); setConsent(false) }}>
            {choices.map((k) => <option key={k} value={k}>{servers[k].name}</option>)}
          </select>
        </label>
      )}

      <fieldset className="report-reasons">
        <legend>{t('safety.report.whatsWrong')}</legend>
        {REPORT_REASONS.map((r) => (
          <label key={r} className={`report-reason ${reason === r ? 'on' : ''}`}>
            <input type="radio" name="report-reason" checked={reason === r} onChange={() => setReason(r)} />
            <span>
              <strong>{t(`safety.reasons.${r}.label`)}</strong>
              <small className="muted">{t(`safety.reasons.${r}.hint`)}</small>
            </span>
          </label>
        ))}
      </fieldset>

      {encrypted && (
        <div className="report-share">
          <strong>{t('safety.report.shareTitle')}</strong>
          <p className="muted">{t('safety.report.shareHint', { max: MAX_SHARED })}</p>
          {candidates.length === 0 ? <p className="empty-note">{t('safety.report.nothingToShare')}</p> : (
            <ul className="report-share-list">
              {candidates.map((c) => (
                <li key={c.id}>
                  <label className="checkbox">
                    <input type="checkbox" checked={picked.has(c.id)} onChange={(e) => toggle(c.id, e.target.checked)} />
                    <span>
                      <small className="muted">
                        {c.author === myKey ? t('safety.report.you') : name} · {messageTime(c.at)}{c.where !== null ? ` · ${c.where || t('safety.report.aGroup')}` : ''}
                      </small>
                      <span className="report-share-text">{c.text}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {shared.length > 0 && (
            <label className="checkbox report-consent">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              <span>{t('safety.report.consent', { count: shared.length, server: server?.name ?? '' })}</span>
            </label>
          )}
        </div>
      )}

      <label className="field">
        <span>{t('safety.report.note')}</span>
        <textarea rows={3} maxLength={MAX_NOTE} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('safety.report.notePlaceholder')} />
      </label>

      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="report-actions">
        <button className="button" onClick={closeReport} disabled={busy}>{t('common.cancel')}</button>
        <button className="button danger" disabled={!canSend} onClick={() => void submit()}>
          {busy ? <Spinner /> : t('safety.report.send')}
        </button>
      </div>
      {teamLink}
    </Modal>
  )
}
