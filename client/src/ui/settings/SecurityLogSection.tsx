// Settings → Security log (owner): the server's security events, data retention, and downloading someone's data for them.
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../../i18n/errors'
import { fingerprint } from '../../core/connection'
import { ROLES, type Retention, type Role, type SecurityEvent } from '../../core/protocol'
import type { TFunction } from 'i18next'
import { downloadFile } from '../../state/backups'
import {
  DAY_FIELDS, type DayField, dateStamp, deletesMore, fetchWholeSecurityLog, getRetention, loadSecurityLog, parseDays, requestDataExport, saveJson, SECURITY_EVENTS,
  securityEventLabel, updateRetention,
} from '../../state/compliance'
import type { ServerState } from '../../state/store'
import { Avatar, Spinner } from '../bits'
import { fullTime, messageTime } from '../format'
import '../moderation/moderation.css'
import './compliance.css'

export function SecurityLogSection({ server }: { server: ServerState }) {
  return (
    <>
      <SecurityLogList server={server} />
      <RetentionSettings server={server} />
      <SubjectExport server={server} />
    </>
  )
}

/** A short, readable line for an entry's details (never more than the server sent). */
function detailText(e: SecurityEvent, t: TFunction): string | null {
  const d = e.details ?? {}
  if (e.event === 'auth.failed' && typeof d.reason === 'string') return t('compliance.securityLog.reason', { reason: d.reason })
  if (e.event === 'rate_limited' && typeof d.type === 'string') return d.type
  if (e.event === 'member.joined' && typeof d.role === 'string') return ROLES.includes(d.role as Role) ? t(`common.roles.${d.role as Role}`) : d.role
  if (e.event === 'server.move' && typeof d.url === 'string') return d.url
  return null
}

function SecurityLogList({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const [event, setEvent] = useState('')
  const [entries, setEntries] = useState<SecurityEvent[] | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'more' | 'export' | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  const load = useCallback(async (before?: number) => {
    try {
      const page = await loadSecurityLog(server.key, { event: event || undefined, before })
      setEntries((list) => (before ? [...(list ?? []), ...page.entries] : page.entries))
      setHasMore(page.hasMore)
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
      if (!before) setEntries([])
    }
  }, [server.key, event])

  useEffect(() => {
    setEntries(null)
    void load()
  }, [load])

  async function more() {
    if (!entries?.length) return
    setBusy('more')
    await load(entries[entries.length - 1].id)
    setBusy(null)
  }

  async function exportAll() {
    setBusy('export')
    setStatus(null)
    try {
      const all = await fetchWholeSecurityLog(server.key)
      saveJson(`iskra-security-log-${dateStamp()}.json`, { format: 'iskra-security-log/v1', server: { name: server.name, key: server.key }, exportedAt: Date.now(), entries: all })
      setStatus(t('compliance.securityLog.exported', { count: all.length }))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="settings-section" data-testid="security-log-section">
      <h3>{t('settings.sections.securityLog')}</h3>
      <p className="muted">{t('compliance.securityLog.intro')}</p>
      <div className="audit-filters">
        <label className="field">
          <span>{t('compliance.securityLog.event')}</span>
          <select value={event} onChange={(e) => setEvent(e.target.value)}>
            <option value="">{t('compliance.securityLog.allEvents')}</option>
            {SECURITY_EVENTS.map((name) => <option key={name} value={name}>{securityEventLabel(name)}</option>)}
          </select>
        </label>
        <button className="button small" onClick={() => void load()}>{t('compliance.securityLog.refresh')}</button>
        <button className="button small" disabled={busy !== null} onClick={() => void exportAll()}>
          {busy === 'export' ? t('compliance.securityLog.exporting') : t('compliance.securityLog.export')}
        </button>
      </div>
      {status && <p className="muted" role="status">{status}</p>}
      {error && <p className="error-text">{error}</p>}
      {entries === null ? (
        <Spinner />
      ) : entries.length === 0 ? (
        <p className="empty-note">{event ? t('compliance.securityLog.emptyFiltered') : t('compliance.securityLog.empty')}</p>
      ) : (
        <ul className="audit-list security-log">
          {entries.map((e) => {
            const name = e.accountName ?? (e.account ? fingerprint(e.account) : t('compliance.securityLog.noAccount'))
            const detail = detailText(e, t)
            const suppressed = typeof e.details?.suppressedBefore === 'number' ? e.details.suppressedBefore : 0
            return (
              <li key={e.id} className="audit-entry">
                <Avatar name={name} accountKey={e.account ?? ''} size={28} />
                <div>
                  <div className="audit-text"><strong>{name}</strong> · {securityEventLabel(e.event)}</div>
                  {(detail || e.ip) && (
                    <div className="audit-reason">
                      {[detail, e.ip ? t('compliance.securityLog.ip', { ip: e.ip }) : null].filter(Boolean).join(' · ')}
                    </div>
                  )}
                  {suppressed > 0 && <div className="audit-reason">{t('compliance.securityLog.suppressed', { count: suppressed })}</div>}
                  <time className="muted" title={fullTime(e.at)}>{messageTime(e.at)}</time>
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {hasMore && (
        <button className="button small" disabled={busy !== null} onClick={() => void more()}>
          {busy === 'more' ? <Spinner /> : t('compliance.securityLog.loadMore')}
        </button>
      )}
    </section>
  )
}


function RetentionSettings({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const [retention, setRetention] = useState<Retention | null>(null)
  const [draft, setDraft] = useState<Partial<Record<DayField, string>>>({})
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    getRetention(server.key).then(setRetention, (e: unknown) => setError(errorMessage(e)))
  }, [server.key])

  async function apply(change: Partial<Retention>) {
    try {
      setRetention(await updateRetention(server.key, change))
      setDraft({})
      setConfirming(false)
      setError(null)
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  function save(confirmed: boolean) {
    if (!retention) return
    const change: Partial<Retention> = {}
    for (const f of DAY_FIELDS) {
      if (draft[f] === undefined) continue
      const days = parseDays(draft[f]!)
      if (days === null) {
        setError(t('compliance.retention.invalid'))
        return
      }
      change[f] = days
    }
    if (!confirmed && deletesMore(retention, change)) {
      setConfirming(true)
      return
    }
    void apply(change)
  }

  const dirty = DAY_FIELDS.some((f) => draft[f] !== undefined && draft[f] !== String(retention?.[f]))
  return (
    <section className="settings-section" data-testid="retention-section">
      <h3>{t('compliance.retention.title')}</h3>
      <p className="muted">{t('compliance.retention.intro')}</p>
      {!retention ? (
        error ? <p className="error-text">{error}</p> : <Spinner />
      ) : (
        <>
          <div className="limits-grid">
            {DAY_FIELDS.map((f) => {
              const value = draft[f] ?? String(retention[f])
              return (
                <label key={f} className="field">
                  <span>{t(`compliance.retention.${f}`)}</span>
                  <div className="limits-input">
                    <input type="number" inputMode="numeric" min={0} max={36500} step={1} value={value} aria-label={t(`compliance.retention.${f}`)}
                      onChange={(e) => { setDraft((d) => ({ ...d, [f]: e.target.value })); setConfirming(false) }} />
                    <span className="muted">{t('compliance.retention.days')}</span>
                  </div>
                  {value.trim() === '0' && <small className="muted">{t('compliance.retention.forever')}</small>}
                </label>
              )
            })}
          </div>
          {confirming ? (
            <div className="retention-confirm" role="alert">
              <p>{t('compliance.retention.confirm')}</p>
              <div className="copy-row">
                <button className="button danger" onClick={() => save(true)}>{t('compliance.retention.confirmSave')}</button>
                <button className="button" onClick={() => setConfirming(false)}>{t('common.cancel')}</button>
              </div>
            </div>
          ) : (
            <button className="button" disabled={!dirty} onClick={() => save(false)}>{t('compliance.retention.save')}</button>
          )}
          <label className="checkbox retention-ips">
            <input type="checkbox" checked={retention.securityLogIps} onChange={(e) => void apply({ securityLogIps: e.target.checked })} />
            <span>
              {t('compliance.retention.ips')}
              <small className="muted">{t('compliance.retention.ipsHint')}</small>
            </span>
          </label>
          {saved && <p className="muted" role="status">{t('compliance.retention.saved')}</p>}
          {error && <p className="error-text">{error}</p>}
        </>
      )}
    </section>
  )
}

function SubjectExport({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const [member, setMember] = useState('')
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const people = Object.values(server.members).filter((m) => m.accountKey !== server.me?.accountKey).sort((a, b) => a.name.localeCompare(b.name))
  const target = key.trim() || member

  async function download() {
    if (!target) return
    setBusy(true)
    setError(null)
    try {
      downloadFile((await requestDataExport(server.key, target)).url)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="settings-section">
      <h3>{t('compliance.subjectExport.title')}</h3>
      <p className="muted">{t('compliance.subjectExport.intro')}</p>
      <div className="audit-filters">
        <label className="field">
          <span>{t('compliance.subjectExport.member')}</span>
          <select value={member} onChange={(e) => setMember(e.target.value)}>
            <option value="">{t('compliance.subjectExport.pick')}</option>
            {people.map((m) => <option key={m.accountKey} value={m.accountKey}>{m.name}</option>)}
          </select>
        </label>
        <label className="field">
          <span>{t('compliance.subjectExport.accountKey')}</span>
          <input value={key} maxLength={64} spellCheck={false} autoComplete="off" onChange={(e) => setKey(e.target.value)} />
        </label>
        <button className="button small" disabled={!target || busy} onClick={() => void download()}>
          {busy ? <Spinner /> : t('compliance.subjectExport.download')}
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
    </section>
  )
}
