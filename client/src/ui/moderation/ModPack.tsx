// The moderators' tool pack: selecting messages to delete together (the bar under the list, the tick boxes on rows),
// warnings (giving one, and the notice when you get one), private notes about a person, their moderation history,
// and the people who left. Everything shown comes from the server; the server checks every action again.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AuditEntry, Channel, Departed, Member, ModNote } from '../../core/protocol'
import { BAN_DELETE_WINDOWS } from '../../core/protocol'
import { errorMessage } from '../../i18n/errors'
import {
  addNote, banAccount, deleteNote, deleteSelected, dismissWarning, listNotes, loadDeparted, loadHistory, stopSelecting, toggleSelected,
  unbanAccount, useBulkSelect, useIsSelected, useSelectingIn, useWarnings, warnMember,
} from '../../state/modpack'
import { auditText, durationLabel } from '../../state/moderationRules'
import { has, isAdmin, outranks } from '../../state/permissions'
import { isModerator } from '../../state/reports'
import { useServerRoles } from '../../state/roles'
import { useApp, type ServerState } from '../../state/store'
import { Avatar, Modal } from '../bits'
import { fullTime, messageTime } from '../format'
import { Close, Trash } from '../icons'
import '../update-toast.css'
import './moderation.css'
import { JoinedViaLine } from './JoinedVia'

// ── Selecting messages ──────────────────────────────────────────────────────

/** The tick box in a message's gutter while selecting in its channel. */
export function SelectBox({ serverKey, channelId, id, allowed }: { serverKey: string; channelId: number; id: number; allowed: boolean }) {
  const { t } = useTranslation()
  const selecting = useSelectingIn(serverKey, channelId)
  const selected = useIsSelected(id)
  if (!selecting) return null
  return (
    <input type="checkbox" className="select-box" checked={selected} disabled={!allowed} aria-label={t('moderation.bulk.select')}
      onChange={() => toggleSelected(id)} onClick={(e) => e.stopPropagation()} />
  )
}

/** Under the message list while selecting: how many, delete (after a confirmation), or cancel. */
export function BulkSelectBar({ server, channel }: { server: ServerState; channel: Channel }) {
  const { t } = useTranslation()
  const selecting = useSelectingIn(server.key, channel.id)
  const count = useBulkSelect((s) => s.selecting?.ids.length ?? 0)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!selecting) return null

  async function remove() {
    setBusy(true)
    try {
      await deleteSelected()
      setConfirm(false)
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="composer read-only bulk-bar" role="toolbar" aria-label={t('moderation.bulk.title')} data-testid="bulk-bar">
      <span>{t('moderation.bulk.selected', { count })}</span>
      <button className="button danger small" disabled={count === 0 || busy} onClick={() => setConfirm(true)}><Trash size={14} /> {t('common.delete')}</button>
      <button className="button small" disabled={busy} onClick={stopSelecting}>{t('common.cancel')}</button>
      {error && <span className="error-text">{error}</span>}
      {confirm && (
        <Modal title={t('moderation.bulk.confirmTitle', { count })} onClose={() => setConfirm(false)}
          footer={<>
            <button className="button" disabled={busy} onClick={() => setConfirm(false)}>{t('common.cancel')}</button>
            <button className="button danger" disabled={busy} onClick={() => void remove()} data-testid="bulk-delete-confirm">{t('moderation.bulk.deleteCount', { count })}</button>
          </>}>
          <p>{t('moderation.bulk.confirmBody')}</p>
          {channel.e2ee && <p className="muted">{t('moderation.bulk.e2eeNote')}</p>}
        </Modal>
      )}
    </div>
  )
}

// ── Warnings ────────────────────────────────────────────────────────────────

/** A moderator warns a member (below them): the reason goes to the person and the activity log. */
export function WarnControls({ server, member, onWarned }: { server: ServerState; member: Member; onWarned?: () => void }) {
  const { t } = useTranslation()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function warn() {
    setBusy(true)
    try {
      await warnMember(server.key, member.accountKey, reason)
      setReason('')
      setDone(true)
      setError(null)
      onWarned?.()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="warn-controls">
      <strong>{t('moderation.warn.title')}</strong>
      <p className="muted">{t('moderation.warn.explain')}</p>
      <div className="timeout-form">
        <input value={reason} maxLength={200} placeholder={t('moderation.warn.reasonPlaceholder')} aria-label={t('moderation.warn.reasonLabel')} onChange={(e) => { setReason(e.target.value); setDone(false) }} />
        <button className="button danger-outline" disabled={busy || !reason.trim()} onClick={() => void warn()}>{t('moderation.warn.warn')}</button>
      </div>
      {done && <p className="muted" role="status">{t('moderation.warn.sent', { name: member.name })}</p>}
      {error && <p className="error-text">{error}</p>}
    </div>
  )
}

/** The notice when a moderator warned you (until dismissed). */
export function WarnToast() {
  const { t } = useTranslation()
  const warning = useWarnings((s) => s.list[s.list.length - 1])
  const server = useApp((s) => (warning ? s.servers[warning.serverKey] : undefined))
  if (!warning) return null
  return (
    <div className="update-toast warn-toast" role="alert" data-testid="warn-toast">
      <div className="update-toast-text">
        <strong>{t('moderation.warn.toastTitle', { server: server?.name ?? '' })}</strong>
        <span>{t('moderation.warn.toastBody', { name: warning.byName, reason: warning.reason })}</span>
      </div>
      <button className="icon-button" onClick={() => dismissWarning(warning.at)} aria-label={t('app.dismiss')} title={t('app.dismiss')}>
        <Close size={16} />
      </button>
    </div>
  )
}

// ── Notes and history ───────────────────────────────────────────────────────

/** Private notes about a person (member or not), for moderators. */
export function ModNotes({ server, accountKey }: { server: ServerState; accountKey: string }) {
  const { t } = useTranslation()
  const [notes, setNotes] = useState<ModNote[] | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const me = server.me
  useEffect(() => {
    listNotes(server.key, accountKey).then(setNotes, (e: unknown) => setError(errorMessage(e)))
  }, [server.key, accountKey])

  const run = (action: () => Promise<unknown>) => async () => {
    setBusy(true)
    try {
      await action()
      setNotes(await listNotes(server.key, accountKey))
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mod-notes" data-testid="mod-notes">
      <strong>{t('moderation.notes.title')}</strong>
      <p className="muted">{t('moderation.notes.explain')}</p>
      {notes && notes.length > 0 && (
        <ul className="mod-note-list">
          {notes.map((n) => (
            <li key={n.id} className="mod-note">
              <span className="mod-note-text">{n.text}</span>
              <small className="muted">
                {t('moderation.notes.by', { name: n.authorName })} · <time title={fullTime(n.createdAt)}>{messageTime(n.createdAt)}</time>
                {(n.author === me?.accountKey || isAdmin(me)) && (
                  <> · <button className="link" disabled={busy} onClick={run(() => deleteNote(server.key, n.id))}>{t('common.delete')}</button></>
                )}
              </small>
            </li>
          ))}
        </ul>
      )}
      <div className="timeout-form">
        <input value={text} maxLength={1000} placeholder={t('moderation.notes.placeholder')} aria-label={t('moderation.notes.label')} onChange={(e) => setText(e.target.value)} />
        <button className="button" disabled={busy || !text.trim()} onClick={run(async () => { await addNote(server.key, accountKey, text); setText('') })}>{t('moderation.notes.add')}</button>
      </div>
      {error && <p className="error-text">{error}</p>}
    </div>
  )
}

/** What moderators did about this person (from the activity log), newest first. `refresh` changing loads it again. */
export function ModHistory({ server, accountKey, refresh }: { server: ServerState; accountKey: string; refresh?: unknown }) {
  const { t } = useTranslation()
  const [entries, setEntries] = useState<AuditEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    loadHistory(server.key, accountKey).then(setEntries, (e: unknown) => setError(errorMessage(e)))
  }, [server.key, accountKey, refresh])
  return (
    <div className="mod-history" data-testid="mod-history">
      <strong>{t('moderation.history.title')}</strong>
      {error ? <p className="error-text">{error}</p>
        : !entries ? null
        : entries.length === 0 ? <p className="muted">{t('moderation.history.none')}</p>
        : (
          <ul className="audit-list mod-history-list">
            {entries.map((e) => (
              <li key={e.id} className="audit-entry">
                <span>{auditText(e)}</span>
                {e.reason && <span className="muted"> · {e.reason}</span>}
                <time className="muted" title={fullTime(e.at)}> · {messageTime(e.at)}</time>
              </li>
            ))}
          </ul>
        )}
    </div>
  )
}

/** Notes, history and a warning, in the member dialog, for moderators. */
export function ModTools({ server, member }: { server: ServerState; member: Member }) {
  const roles = useServerRoles(server.key)
  const me = server.me
  // A warning given here shows up in the history below right away (timeouts and the like arrive as member.updated).
  const [warned, setWarned] = useState(0)
  if (!isModerator(me, roles) || me?.accountKey === member.accountKey) return null
  return (
    <section className="settings-section mod-tools">
      {outranks(me, member, roles) && <WarnControls server={server} member={member} onWarned={() => setWarned((n) => n + 1)} />}
      <JoinedViaLine server={server} accountKey={member.accountKey} />
      <ModNotes server={server} accountKey={member.accountKey} />
      <ModHistory server={server} accountKey={member.accountKey} refresh={`${warned}:${member.timedOutUntil ?? ''}`} />
    </section>
  )
}

// ── Ban options ─────────────────────────────────────────────────────────────

/** "Also delete their recent messages": none, 24 hours or 7 days. */
export function BanDeleteSelect({ value, onChange }: { value: number; onChange: (ms: number) => void }) {
  const { t } = useTranslation()
  return (
    <label className="field inline ban-delete">
      <span>{t('moderation.ban.deleteLabel')}</span>
      <select value={value} aria-label={t('moderation.ban.deleteLabel')} onChange={(e) => onChange(Number(e.target.value))}>
        <option value={0}>{t('moderation.ban.deleteNone')}</option>
        {BAN_DELETE_WINDOWS.map((ms) => <option key={ms} value={ms}>{t('moderation.ban.deleteWindow', { duration: durationLabel(ms) })}</option>)}
      </select>
    </label>
  )
}

// ── People who left ─────────────────────────────────────────────────────────

/** Server settings → Members: recent leaves, kicks and bans, so a report about someone who's gone can still be acted on. */
export function DepartedList({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const roles = useServerRoles(server.key)
  const me = server.me
  const [people, setPeople] = useState<Departed[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const moderator = isModerator(me, roles)
  const canBan = has(me, roles, 'banMembers')
  const reload = () => loadDeparted(server.key).then(setPeople, (e: unknown) => setError(errorMessage(e)))
  useEffect(() => {
    if (moderator) void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.key, moderator, Object.keys(server.members).length])
  if (!moderator || !people || people.length === 0) return null

  const act = (key: string, action: () => Promise<unknown>) => async () => {
    setBusy(key)
    try {
      await action()
      await reload()
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="departed" data-testid="departed">
      <h3>{t('moderation.departed.title')}</h3>
      <p className="muted">{t('moderation.departed.intro')}</p>
      <ul className="room-members">
        {people.map((p) => {
          const name = p.name || t('moderation.departed.deletedAccount')
          return (
            <li key={p.accountKey} className="departed-row">
              <div className="room-member departed-main">
                <Avatar name={name} accountKey={p.accountKey} size={32} />
                <span className="room-member-text">
                  <span className="room-member-name">{name}</span>
                  <span className="muted">
                    {t(`moderation.departed.reason.${p.reason}`, { name: p.byName ?? t('moderation.audit.someone') })} · <time title={fullTime(p.at)}>{messageTime(p.at)}</time>
                    {p.banned && <> · {t('moderation.departed.banned')}</>}
                  </span>
                </span>
                <span className="departed-actions">
                  <button className="button small" onClick={() => setOpen(open === p.accountKey ? null : p.accountKey)} aria-expanded={open === p.accountKey}>
                    {t('moderation.departed.details')}
                  </button>
                  {canBan && (p.banned
                    ? <button className="button small" disabled={busy !== null} onClick={act(p.accountKey, () => unbanAccount(server.key, p.accountKey))}>{t('moderation.departed.unban')}</button>
                    : <button className="button small danger-outline" disabled={busy !== null} onClick={act(p.accountKey, () => banAccount(server.key, p.accountKey))}>{t('moderation.departed.ban')}</button>)}
                </span>
              </div>
              {open === p.accountKey && (
                <div className="departed-details">
                  <ModNotes server={server} accountKey={p.accountKey} />
                  <ModHistory server={server} accountKey={p.accountKey} />
                </div>
              )}
            </li>
          )
        })}
      </ul>
      {error && <p className="error-text">{error}</p>}
    </div>
  )
}
