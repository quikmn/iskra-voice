// Settings → My account → Blocked people, and Settings → This server → Audit log (admins).
import { useCallback, useEffect, useState } from 'react'
import { fingerprint } from '../../core/connection'
import type { AuditEntry } from '../../core/protocol'
import { loadAudit, setBlocked, useBlocks } from '../../state/moderation'
import { AUDIT_ACTIONS, auditText } from '../../state/moderationRules'
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
  const entries = useBlocks((s) => s.entries)
  const nameOf = useNameOf()
  const blocked = entries.filter((e) => e.blocked).sort((a, b) => b.at - a.at)

  return (
    <section className="settings-section">
      <h3>Blocked people</h3>
      <p className="muted">
        People you block can't message or call you on any server you share, and their messages in channels are collapsed for you.
        They aren't told. Your list follows your account to every server and device.
      </p>
      {blocked.length === 0 ? (
        <p className="empty-note">You haven't blocked anyone. You can block someone from their profile (More → Block).</p>
      ) : (
        <ul className="blocked-list">
          {blocked.map((e) => {
            const name = nameOf(e.accountKey)
            return (
              <li key={e.accountKey}>
                <Avatar name={name ?? '?'} accountKey={e.accountKey} size={32} />
                <span className="blocked-name">
                  <strong>{name ?? 'Someone'}</strong>
                  <span className="muted">ID <code>{fingerprint(e.accountKey)}</code> · blocked {messageTime(e.at)}</span>
                </span>
                <button className="button small" onClick={() => void setBlocked(e.accountKey, false)}>Unblock</button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

export function AuditLogSection({ server }: { server: ServerState }) {
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
      setError((e as Error).message)
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
      (e: Error) => {
        if (!live) return
        setError(e.message)
        setEntries([])
      },
    )
    return () => { live = false }
  }, [server.key, action, person])

  const people = Object.values(server.members).sort((a, b) => a.name.localeCompare(b.name))

  return (
    <section className="settings-section">
      <h3>Audit log</h3>
      <p className="muted">Moderation and admin actions on this server from the last 90 days. Only admins can see this.</p>
      <div className="audit-filters">
        <label className="field">
          <span>Action</span>
          <select value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">All actions</option>
            {AUDIT_ACTIONS.map((a) => <option key={a.action} value={a.action}>{a.label}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Person</span>
          <select value={person} onChange={(e) => setPerson(e.target.value)}>
            <option value="">Everyone</option>
            {people.map((m) => <option key={m.accountKey} value={m.accountKey}>{m.name}</option>)}
          </select>
        </label>
        <button className="button small" onClick={() => void load()}>Refresh</button>
      </div>
      {error && <p className="error-text">{error}</p>}
      {entries === null ? (
        <Spinner />
      ) : entries.length === 0 ? (
        <p className="empty-note">Nothing here{action || person ? ' for these filters' : ' yet'}.</p>
      ) : (
        <ul className="audit-list">
          {entries.map((e) => (
            <li key={e.id} className="audit-entry">
              <Avatar name={e.actorName || '?'} accountKey={e.actor} size={28} />
              <div>
                <div className="audit-text">{auditText(e)}</div>
                {e.reason && <div className="audit-reason">Reason: {e.reason}</div>}
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
          {loadingMore ? 'Loading…' : 'Show older'}
        </button>
      )}
    </section>
  )
}
