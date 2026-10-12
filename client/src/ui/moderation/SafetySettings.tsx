// Settings → My account → Blocked people, and Settings → This server → Audit log (admins).
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../../i18n/errors'
import { fingerprint } from '../../core/connection'
import type { AuditEntry } from '../../core/protocol'
import { loadAudit, setBlocked, useBlocks } from '../../state/moderation'
import { AUDIT_ACTIONS, auditActionLabel, auditText } from '../../state/moderationRules'
import { useDms } from '../../state/dms'
import { useApp, type ServerState } from '../../state/store'
import { Avatar, Spinner } from '../bits'
import { fullTime, messageTime } from '../format'
import './moderation.css'

/** A name for someone from any server you're on, or your friends list. */
function useNameOf(): (accountKey: string) => string | null {
  const servers = useApp((s) => s.servers)
  const friends = useDms((s) => s.friends)
  return (key) => {
    for (const server of Object.values(servers)) if (server.members[key]) return server.members[key].name
    return friends[key]?.name ?? null
  }
}

export function BlockedSection() {
  const { t } = useTranslation()
  const entries = useBlocks((s) => s.entries)
  const nameOf = useNameOf()
  const blocked = entries.filter((e) => e.blocked).sort((a, b) => b.at - a.at)

  return (
    <section className="settings-section">
      <h2>{t('moderation.blocked.title')}</h2>
      <p className="muted">{t('moderation.blocked.intro')}</p>
      {blocked.length === 0 ? (
        <p className="empty-note">{t('moderation.blocked.empty')}</p>
      ) : (
        <ul className="blocked-list">
          {blocked.map((e) => {
            const name = nameOf(e.accountKey)
            return (
              <li key={e.accountKey}>
                <Avatar name={name ?? '?'} accountKey={e.accountKey} size={32} />
                <span className="blocked-name">
                  <strong>{name ?? t('common.someone')}</strong>
                  <span className="muted">{t('moderation.blocked.id')} <code>{fingerprint(e.accountKey)}</code> · {t('moderation.blocked.when', { time: messageTime(e.at) })}</span>
                </span>
                <button className="button small" onClick={() => void setBlocked(e.accountKey, false)}>{t('moderation.blocked.unblock')}</button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

export function AuditLogSection({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const [action, setAction] = useState('')
  const [person, setPerson] = useState('')
  const [entries, setEntries] = useState<AuditEntry[] | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)

  const load = useCallback(async (before?: number) => {
    try {
      const page = await loadAudit(server.key, { action: action || undefined, person: person || undefined, before })
      setEntries((list) => (before ? [...(list ?? []), ...page.entries] : page.entries))
      setHasMore(page.hasMore)
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
      if (!before) setEntries([])
    }
  }, [server.key, action, person])

  useEffect(() => {
    let live = true
    loadAudit(server.key, { action: action || undefined, person: person || undefined }).then(
      (page) => {
        if (!live) return
        setEntries(page.entries)
        setHasMore(page.hasMore)
        setError(null)
      },
      (e: unknown) => {
        if (!live) return
        setError(errorMessage(e))
        setEntries([])
      },
    )
    return () => { live = false }
  }, [server.key, action, person])

  const people = Object.values(server.members).sort((a, b) => a.name.localeCompare(b.name))

  return (
    <section className="settings-section">
      <h2>{t('moderation.audit.title')}</h2>
      <p className="muted">{t('moderation.audit.intro')}</p>
      <div className="audit-filters">
        <label className="field">
          <span>{t('moderation.audit.action')}</span>
          <select value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">{t('moderation.audit.allActions')}</option>
            {AUDIT_ACTIONS.map((a) => <option key={a} value={a}>{auditActionLabel(a)}</option>)}
          </select>
        </label>
        <label className="field">
          <span>{t('moderation.audit.person')}</span>
          <select value={person} onChange={(e) => setPerson(e.target.value)}>
            <option value="">{t('moderation.audit.everyone')}</option>
            {people.map((m) => <option key={m.accountKey} value={m.accountKey}>{m.name}</option>)}
          </select>
        </label>
        <button className="button small" onClick={() => void load()}>{t('moderation.audit.refresh')}</button>
      </div>
      {error && <p className="error-text">{error}</p>}
      {entries === null ? (
        <Spinner />
      ) : entries.length === 0 ? (
        <p className="empty-note">{action || person ? t('moderation.audit.emptyFiltered') : t('moderation.audit.empty')}</p>
      ) : (
        <ul className="audit-list">
          {entries.map((e) => (
            <li key={e.id} className="audit-entry">
              <Avatar name={e.actorName || '?'} accountKey={e.actor} size={28} />
              <div>
                <div className="audit-text">{auditText(e)}</div>
                {e.reason && <div className="audit-reason">{t('moderation.audit.reason', { reason: e.reason })}</div>}
                <time className="muted" title={fullTime(e.at)}>{messageTime(e.at)}</time>
              </div>
            </li>
          ))}
        </ul>
      )}
      {entries && hasMore && (
        <button
          className="button" disabled={loadingMore}
          onClick={() => {
            setLoadingMore(true)
            void load(entries.at(-1)?.id).finally(() => setLoadingMore(false))
          }}
        >
          {loadingMore ? t('common.loading') : t('moderation.audit.showOlder')}
        </button>
      )}
    </section>
  )
}
