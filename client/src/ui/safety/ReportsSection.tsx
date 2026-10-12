// Settings → This server → Reports (moderators): what people reported, and acting on it with the usual tools
// (delete the message, time out, kick, ban) or dismissing it. Also the "Reports" badge in the channel list.
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Report, ReportOutcome } from '../../core/protocol'
import { errorMessage } from '../../i18n/errors'
import { jumpToMessage } from '../../state/jump'
import { timeoutMember } from '../../state/moderation'
import { durationLabel, TIMEOUT_OPTIONS } from '../../state/moderationRules'
import { has, outranks } from '../../state/permissions'
import { isModerator, listReports, resolveReport, useReports } from '../../state/reports'
import { useServerRoles } from '../../state/roles'
import { connectionFor, fileUrl, type ServerState } from '../../state/store'
import { Avatar, Spinner } from '../bits'
import { fullTime, messageTime } from '../format'
import './safety.css'

/** In the channel list, for moderators with open reports. */
export function ReportsButton({ server, onOpen }: { server: ServerState; onOpen: () => void }) {
  const { t } = useTranslation()
  const open = useReports((s) => s.open[server.key] ?? 0)
  const roles = useServerRoles(server.key)
  if (open === 0 || !isModerator(server.me, roles)) return null
  return (
    <button className="reports-button" onClick={onOpen}>
      <ShieldIcon /> <span>{t('safety.queue.button')}</span>
      <span className="reports-badge" aria-label={t('safety.queue.openCount', { count: open })}>{open}</span>
    </button>
  )
}

const ShieldIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  </svg>
)

export function ReportsSection({ server, onClose }: { server: ServerState; onClose: () => void }) {
  const { t } = useTranslation()
  const [status, setStatus] = useState<'open' | 'resolved'>('open')
  const [reports, setReports] = useState<Report[] | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const open = useReports((s) => s.open[server.key] ?? 0)

  const load = useCallback(async (more = false, current: Report[] = []) => {
    try {
      const page = await listReports(server.key, status, more ? current.at(-1)?.id : undefined)
      setReports(more ? [...current, ...page.reports] : page.reports)
      setHasMore(page.hasMore)
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    }
  }, [server.key, status])

  // Reload when the count changes (someone reported, or another moderator handled one).
  useEffect(() => { void load() }, [load, open])

  const resolved = (report: Report) => setReports((list) => (list ?? []).filter((r) => r.id !== report.id))

  return (
    <section className="settings-section reports-section">
      <h2>{t('settings.sections.reports')}</h2>
      <p className="muted">{t('safety.queue.intro')}</p>
      <div className="segmented" role="tablist">
        <button role="tab" aria-selected={status === 'open'} className={status === 'open' ? 'on' : ''} onClick={() => { setReports(null); setStatus('open') }}>
          {t('safety.queue.open')}{open > 0 ? ` · ${open}` : ''}
        </button>
        <button role="tab" aria-selected={status === 'resolved'} className={status === 'resolved' ? 'on' : ''} onClick={() => { setReports(null); setStatus('resolved') }}>
          {t('safety.queue.resolved')}
        </button>
      </div>
      {error && <p className="error-text" role="alert">{error}</p>}
      {!reports ? <Spinner /> : reports.length === 0 ? (
        <p className="empty-note">{status === 'open' ? t('safety.queue.emptyOpen') : t('safety.queue.emptyResolved')}</p>
      ) : (
        <ul className="report-list">
          {reports.map((r) => <ReportCard key={r.id} server={server} report={r} onResolved={resolved} onJump={onClose} />)}
        </ul>
      )}
      {hasMore && reports && <button className="button" onClick={() => void load(true, reports)}>{t('safety.queue.more')}</button>}
    </section>
  )
}

type Step = null | 'delete' | 'timeout' | 'kick' | 'ban'

function ReportCard({ server, report, onResolved, onJump }: {
  server: ServerState; report: Report; onResolved: (r: Report) => void; onJump: () => void
}) {
  const { t } = useTranslation()
  const roles = useServerRoles(server.key)
  const [step, setStep] = useState<Step>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const me = server.me
  const member = server.members[report.target]
  const below = !!member && outranks(me, member, roles)
  const message = report.message
  const canDelete = !!message && !message.deleted && has(me, roles, 'manageMessages') && (!member || below)
  const canTimeout = below && has(me, roles, 'timeoutMembers')
  const canKick = below && has(me, roles, 'kickMembers')
  const canBan = below && has(me, roles, 'banMembers')
  const name = report.targetName || member?.name || t('safety.queue.someone')

  /** Does the moderation action (if any), then marks the report handled. */
  const act = (outcome: ReportOutcome, action?: () => Promise<unknown>) => async () => {
    setBusy(true)
    setError(null)
    try {
      if (action) await action()
      onResolved(await resolveReport(server.key, report.id, outcome, note))
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }
  const request = (type: 'member.kick' | 'member.ban', body: { accountKey: string }) => () => connectionFor(server.key)!.request(type, body)

  return (
    <li className={`report-card ${report.status}`}>
      <header className="report-head">
        <Avatar name={name} accountKey={report.target} size={32} />
        <div>
          <strong>{name}</strong>
          <span className="muted">
            {t(`safety.reasons.${report.reason}.label`)} · {t(`safety.queue.kind.${report.kind}`)} · <time title={fullTime(report.at)}>{messageTime(report.at)}</time>
          </span>
        </div>
      </header>

      {message && (
        <div className="report-body">
          <blockquote className="report-quote">
            <span>{message.text || t('safety.report.noText')}</span>
            {message.attachments.length > 0 && (
              <span className="report-files">
                {message.attachments.map((f) => <a key={f.id} href={fileUrl(server.key, f)} target="_blank" rel="noreferrer">{f.name}</a>)}
              </span>
            )}
          </blockquote>
          <p className="muted report-meta">
            #{message.channelName} · {messageTime(message.createdAt)}
            {message.deleted ? <> · {t('safety.queue.deleted')}</> : (
              <> · <button className="link" onClick={() => { onJump(); void jumpToMessage(server.key, message.channelId, message.id) }}>{t('safety.queue.jump')}</button></>
            )}
          </p>
        </div>
      )}
      {report.messages && (
        <div className="report-body">
          <p className="muted report-meta">{t('safety.queue.sharedNote')}</p>
          <ul className="report-shared">
            {report.messages.map((m, i) => (
              <li key={i}>
                <small className="muted">{m.author === report.target ? name : report.reporterName || t('safety.queue.reporter')} · {messageTime(m.at)}</small>
                <span>{m.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {report.note && <p className="report-note"><strong>{t('safety.queue.noteFrom')}</strong> {report.note}</p>}
      <p className="muted report-meta">
        {report.reporter ? t('safety.queue.reportedBy', { name: report.reporterName }) : t('safety.queue.reporterGone')}
      </p>

      {report.resolution ? (
        <p className="report-resolution">
          {t('safety.queue.resolvedBy', { name: report.resolution.byName, outcome: t(`safety.outcomes.${report.resolution.outcome}`), when: messageTime(report.resolution.at) })}
          {report.resolution.note && <><br /><span className="muted">{report.resolution.note}</span></>}
        </p>
      ) : (
        <div className="report-act">
          {step === null && (
            <div className="report-buttons">
              {canDelete && <button className="button small danger-outline" onClick={() => setStep('delete')}>{t('safety.queue.deleteMessage')}</button>}
              {canTimeout && <button className="button small" onClick={() => setStep('timeout')}>{t('safety.queue.timeout')}</button>}
              {canKick && <button className="button small danger-outline" onClick={() => setStep('kick')}>{t('safety.queue.kick')}</button>}
              {canBan && <button className="button small danger-outline" onClick={() => setStep('ban')}>{t('safety.queue.ban')}</button>}
              <button className="button small" disabled={busy} onClick={act('dismissed')}>{t('safety.queue.dismiss')}</button>
              <button className="button small" disabled={busy} onClick={act('other')} title={t('safety.queue.handledHint')}>{t('safety.queue.handled')}</button>
            </div>
          )}
          {step !== null && (
            <div className="report-confirm">
              {step === 'timeout' ? (
                <div className="report-buttons">
                  {TIMEOUT_OPTIONS.map((o) => (
                    <button key={o.ms} className="button small" disabled={busy}
                      onClick={act('timeout', () => timeoutMember(server.key, report.target, o.ms, t('safety.queue.timeoutReason')))}>
                      {durationLabel(o.ms)}
                    </button>
                  ))}
                  <button className="button small ghost" disabled={busy} onClick={() => setStep(null)}>{t('common.cancel')}</button>
                </div>
              ) : (
                <>
                  <p>{step === 'delete' ? t('safety.queue.confirmDelete') : step === 'kick' ? t('safety.queue.confirmKick', { name }) : t('safety.queue.confirmBan', { name })}</p>
                  <div className="report-buttons">
                    <button className="button small danger" disabled={busy} onClick={
                      step === 'delete' ? act('deleted', () => connectionFor(server.key)!.request('chat.delete', { id: message!.id }))
                        : step === 'kick' ? act('kick', request('member.kick', { accountKey: report.target }))
                          : act('ban', request('member.ban', { accountKey: report.target }))
                    }>
                      {step === 'delete' ? t('safety.queue.deleteMessage') : step === 'kick' ? t('safety.queue.kick') : t('safety.queue.ban')}
                    </button>
                    <button className="button small" disabled={busy} onClick={() => setStep(null)}>{t('common.cancel')}</button>
                  </div>
                </>
              )}
            </div>
          )}
          <input className="report-note-input" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('safety.queue.resolutionNote')} aria-label={t('safety.queue.resolutionNote')} />
        </div>
      )}
      {error && <p className="error-text" role="alert">{error}</p>}
    </li>
  )
}
