// The inbox (bell): everything for you across servers and DMs, plus saved messages, reminders and scheduled messages.
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { ParseKeys } from 'i18next'
import { errorMessage } from '../../i18n/errors'
import { formatNumber } from '../../i18n/format'
import { useApp } from '../../state/store'
import { conversationLabel } from '../../state/threads'
import { nameOf, openConversation } from '../../state/dms'
import { openGroup, titleOf, useGroups } from '../../state/groups'
import { acceptFriend, ignoreFriend } from '../../state/friends'
import { jumpToMessage } from '../../state/jump'
import {
  closeInbox, loadMoreInbox, markAllInboxRead, markEntryRead, setInboxFilter, setIncludeEveryone, useInbox, useInboxEntries, type InboxTab,
} from '../../state/inbox'
import { filterInbox, type InboxEntry, type InboxFilter } from '../../state/inboxLogic'
import { unsaveMessage, useSavedList } from '../../state/saved'
import { openRef } from '../../state/messageRefs'
import { deleteReminder, openReminder, rescheduleReminder, splitReminders, useReminders, type Reminder } from '../../state/reminders'
import {
  deleteScheduled, openScheduledPlace, scheduledList, scheduledWhere, sendScheduledNow, updateScheduled, useScheduled, type Scheduled,
} from '../../state/scheduled'
import {
  CHANNEL_SEND_MAX_AHEAD, ENCRYPTED_SEND_MAX_AHEAD, REMINDER_MAX_AHEAD, type SavedEntry,
} from '../../state/productivityLogic'
import { Avatar, Modal } from '../bits'
import { plainText } from '../markdown'
import { Lock } from '../icons'
import { AlarmClock, Bookmark, CheckAll, Clock } from './icons'
import { WhenPicker, whenText } from './WhenPicker'
import './productivity.css'

const TABS: InboxTab[] = ['inbox', 'saved', 'reminders', 'scheduled']
const FILTERS: InboxFilter[] = ['all', 'mentions', 'replies', 'reminders', 'requests']

export function InboxPanel({ tab }: { tab: InboxTab }) {
  const { t } = useTranslation()
  return (
    <Modal title={t('productivity.inbox.title')} onClose={closeInbox} wide className="inbox-dialog">
      <div className="segmented inbox-tabs" role="tablist">
        {TABS.map((x) => (
          <button key={x} role="tab" aria-selected={tab === x} className={tab === x ? 'on' : ''} onClick={() => useInbox.setState({ open: x })}>
            {t(`productivity.inbox.tabs.${x}`)}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="inbox-panel">
        {tab === 'inbox' && <InboxTabView />}
        {tab === 'saved' && <SavedTab />}
        {tab === 'reminders' && <RemindersTab />}
        {tab === 'scheduled' && <ScheduledTab />}
      </div>
    </Modal>
  )
}

/** Opens a place and closes the inbox (it covers everything on phones). */
const go = (action: () => unknown) => () => {
  closeInbox()
  void action()
}

// ── Inbox ───────────────────────────────────────────────────────────────────

function InboxTabView() {
  const { t } = useTranslation()
  const filter = useInbox((s) => s.filter)
  const includeEveryone = useInbox((s) => s.includeEveryone)
  const more = useInbox((s) => Object.values(s.hasMore).some(Boolean))
  const entries = filterInbox(useInboxEntries(), filter)
  return (
    <>
      <div className="inbox-toolbar">
        <div className="inbox-filters" role="group" aria-label={t('productivity.inbox.filters.label')}>
          {FILTERS.map((f) => (
            <button key={f} className={`chip ${filter === f ? 'on' : ''}`} aria-pressed={filter === f} onClick={() => setInboxFilter(f)}>
              {t(`productivity.inbox.filters.${f}`)}
            </button>
          ))}
        </div>
        <button className="button small" onClick={markAllInboxRead}><CheckAll size={15} /> {t('productivity.inbox.markAll')}</button>
      </div>
      <label className="checkbox inbox-everyone">
        <input type="checkbox" checked={includeEveryone} onChange={(e) => setIncludeEveryone(e.target.checked)} />
        <span>{t('productivity.inbox.everyone')}</span>
      </label>
      {entries.length === 0 ? <p className="inbox-empty muted">{t('productivity.inbox.empty')}</p> : (
        <ul className="inbox-list">
          {entries.map((e) => <InboxRow key={e.key} entry={e} />)}
        </ul>
      )}
      {more && (filter === 'all' || filter === 'mentions' || filter === 'replies') && (
        <button className="button small inbox-more" onClick={() => void loadMoreInbox()}>{t('productivity.inbox.loadMore')}</button>
      )}
    </>
  )
}

function Row({ icon, title, sub, body, at, unread, onOpen, actions }: {
  icon: ReactNode; title: ReactNode; sub?: ReactNode; body?: ReactNode; at?: number; unread?: boolean; onOpen?: () => void; actions?: ReactNode
}) {
  const { t } = useTranslation()
  const main = (
    <>
      <span className="inbox-row-icon">{icon}</span>
      <span className="inbox-row-text">
        <span className="inbox-row-title">{title}{unread && <span className="inbox-unread" aria-label={t('productivity.inbox.unread')} />}</span>
        {sub && <span className="inbox-row-sub">{sub}</span>}
        {body && <span className="inbox-row-body">{body}</span>}
      </span>
      {at !== undefined && <time className="inbox-row-time">{whenText(at)}</time>}
    </>
  )
  return (
    <li className={`inbox-row ${unread ? 'unread' : ''}`}>
      {onOpen ? <button className="inbox-row-main" onClick={onOpen}>{main}</button> : <div className="inbox-row-main">{main}</div>}
      {actions && <div className="inbox-row-actions">{actions}</div>}
    </li>
  )
}

function InboxRow({ entry }: { entry: InboxEntry }) {
  const { t } = useTranslation()
  const servers = useApp((s) => s.servers)
  const groups = useGroups((s) => s.groups)
  const reminders = useReminders((s) => s.all)
  const markRead = <button className="icon-button small" title={t('productivity.inbox.markRead')} aria-label={t('productivity.inbox.markRead')}
    onClick={() => markEntryRead(entry)}><CheckAll size={15} /></button>

  if (entry.type === 'ping') {
    const server = servers[entry.server]
    const m = entry.item.message
    const author = m.webhook?.name ?? server?.members[m.author]?.name ?? t('common.someone')
    const where = server ? `${conversationLabel(server, m.channelId)} · ${server.name}` : ''
    return (
      <Row icon={<Avatar name={author} accountKey={m.author} size={32} />} unread={entry.unread} at={m.createdAt}
        title={<><strong>{author}</strong> {t(`productivity.inbox.kind.${entry.item.kind}` as ParseKeys)}</>}
        sub={where} body={plainText(m.text, { nameOf: (k) => server?.members[k]?.name ?? null }) || t('chat.message.attachment')}
        onOpen={go(() => { markEntryRead(entry); return jumpToMessage(entry.server, m.channelId, m.id) })}
        actions={entry.unread ? markRead : undefined} />
    )
  }
  if (entry.type === 'dm') {
    return (
      <Row icon={<Avatar name={nameOf(entry.peer)} accountKey={entry.peer} size={32} />} unread at={entry.at}
        title={<strong>{nameOf(entry.peer)}</strong>} sub={t('productivity.inbox.dm', { count: entry.count })}
        onOpen={go(() => openConversation(entry.peer))} actions={markRead} />
    )
  }
  if (entry.type === 'group') {
    const g = groups[entry.group]
    return (
      <Row icon={<span className="inbox-glyph" aria-hidden>#</span>} unread at={entry.at}
        title={<strong>{g ? titleOf(g) : t('groups.notify.aGroup')}</strong>} sub={t('productivity.inbox.dm', { count: entry.count })}
        onOpen={go(() => openGroup(entry.group))} actions={markRead} />
    )
  }
  if (entry.type === 'request') {
    return (
      <Row icon={<Avatar name={nameOf(entry.peer)} accountKey={entry.peer} size={32} />} unread at={entry.at}
        title={<><strong>{nameOf(entry.peer)}</strong> {t('productivity.inbox.request')}</>}
        actions={(
          <>
            <button className="button primary small" onClick={() => void acceptFriend(entry.peer)}>{t('productivity.inbox.accept')}</button>
            <button className="button small" onClick={() => void ignoreFriend(entry.peer)}>{t('productivity.inbox.ignore')}</button>
          </>
        )} />
    )
  }
  const reminder = reminders[`${entry.server}:${entry.id}`]
  return reminder ? <ReminderRow reminder={reminder} /> : null
}

// ── Saved ───────────────────────────────────────────────────────────────────

function SavedTab() {
  const { t } = useTranslation()
  const list = useSavedList()
  return (
    <>
      <p className="muted small-note"><Lock size={12} /> {t('productivity.saved.privacy')}</p>
      {list.length === 0 ? <p className="inbox-empty muted">{t('productivity.saved.none')}</p> : (
        <>
          <p className="muted small-note">{t('productivity.saved.count', { count: list.length, formattedCount: formatNumber(list.length) })}</p>
          <ul className="inbox-list">{list.map((e) => <SavedRow key={e.key} entry={e} />)}</ul>
        </>
      )}
    </>
  )
}

function SavedRow({ entry }: { entry: SavedEntry }) {
  const { t } = useTranslation()
  const [gone, setGone] = useState(false)
  const snap = entry.snap
  const open = async () => {
    setGone(false)
    if (await openRef(entry.ref)) closeInbox()
    else setGone(true)
  }
  return (
    <Row icon={snap ? <Avatar name={snap.authorName} accountKey={snap.author || entry.key} size={32} /> : <Bookmark filled />}
      title={<strong>{snap?.authorName ?? t('common.someone')}</strong>} sub={snap?.where} at={snap?.at}
      body={gone ? <em className="muted">{t('productivity.saved.gone')}</em> : snap?.preview}
      onOpen={() => void open()}
      actions={<button className="button small" onClick={() => void unsaveMessage(entry.key)}>{t('productivity.saved.remove')}</button>} />
  )
}

// ── Reminders ───────────────────────────────────────────────────────────────

function RemindersTab() {
  const { t } = useTranslation()
  const { upcoming, due } = splitReminders(useReminders((s) => s.all))
  if (upcoming.length === 0 && due.length === 0) return <p className="inbox-empty muted">{t('productivity.reminders.none')}</p>
  return (
    <>
      {due.length > 0 && <h3 className="inbox-heading">{t('productivity.reminders.due')}</h3>}
      {due.length > 0 && <ul className="inbox-list">{due.map((r) => <ReminderRow key={`${r.server}:${r.id}`} reminder={r} />)}</ul>}
      {upcoming.length > 0 && <h3 className="inbox-heading">{t('productivity.reminders.upcoming')}</h3>}
      {upcoming.length > 0 && <ul className="inbox-list">{upcoming.map((r) => <ReminderRow key={`${r.server}:${r.id}`} reminder={r} />)}</ul>}
    </>
  )
}

function ReminderRow({ reminder: r }: { reminder: Reminder }) {
  const { t } = useTranslation()
  const [timing, setTiming] = useState(false)
  const [gone, setGone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const c = r.content
  const fired = r.firedAt !== null
  const run = (action: () => Promise<unknown>) => () => void action().catch((e) => setError(errorMessage(e)))
  return (
    <>
      <Row icon={<span className="inbox-glyph reminder" aria-hidden><AlarmClock size={18} /></span>} unread={fired} at={fired ? undefined : r.dueAt}
        title={<><strong>{t('productivity.inbox.reminder')}</strong>{c?.note ? <> · {c.note}</> : null}</>}
        sub={c ? `${c.snap.authorName} · ${c.snap.where}` : t('productivity.reminders.unreadable')}
        body={gone ? <em className="muted">{t('productivity.saved.gone')}</em> : error ? <span className="error-text">{error}</span>
          : <>{c?.snap.preview}<span className="inbox-when">{fired ? t('productivity.reminders.firedAt', { when: whenText(r.firedAt!) }) : t('productivity.reminders.at', { when: whenText(r.dueAt) })}</span></>}
        onOpen={c ? () => void openReminder(r.server, r.id).then((ok) => (ok ? closeInbox() : setGone(true))) : undefined}
        actions={(
          <>
            {fired && <button className="button small" onClick={run(() => rescheduleReminder(r, Date.now() + 3_600_000))}>{t('productivity.reminders.snooze')}</button>}
            <button className="button small" onClick={() => setTiming(true)}>{t('productivity.reminders.changeTime')}</button>
            <button className={`button small ${fired ? 'primary' : ''}`} onClick={run(() => deleteReminder(r))}>
              {fired ? t('productivity.reminders.doneButton') : t('productivity.reminders.cancel')}
            </button>
          </>
        )} />
      {timing && (
        <TimeDialog title={t('productivity.reminders.changeTime')} initial={r.dueAt} maxAheadMs={REMINDER_MAX_AHEAD}
          onClose={() => setTiming(false)} onPick={(at) => rescheduleReminder(r, at)} />
      )}
    </>
  )
}

/** Reminder toasts (bottom corner), like event reminders. */
export function ReminderToasts() {
  const { t } = useTranslation()
  const toasts = useReminders((s) => s.toasts)
  const all = useReminders((s) => s.all)
  const shown = toasts.map((k) => all[k]).filter((r): r is Reminder => !!r)
  if (shown.length === 0) return null
  return (
    <div className="event-toasts reminder-toasts" role="status" aria-live="polite">
      {shown.map((r) => (
        <div key={`${r.server}:${r.id}`} className="event-toast reminder-toast">
          <span className="event-toast-icon"><AlarmClock size={18} /></span>
          <div className="event-toast-text">
            <strong>{r.content?.note || t('productivity.reminders.toastLabel')}</strong>
            <span>{r.content ? `${r.content.snap.authorName}: ${r.content.snap.preview}` : t('productivity.reminders.notifyBody')}</span>
          </div>
          {r.content && <button className="button primary small" onClick={() => void openReminder(r.server, r.id)}>{t('productivity.reminders.open')}</button>}
          <button className="button small" onClick={() => void deleteReminder(r).catch(() => undefined)}>{t('productivity.reminders.doneButton')}</button>
        </div>
      ))}
    </div>
  )
}

// ── Scheduled ───────────────────────────────────────────────────────────────

function ScheduledTab() {
  const { t } = useTranslation()
  const list = scheduledList(useScheduled((s) => s.all))
  if (list.length === 0) return <p className="inbox-empty muted">{t('productivity.scheduled.none')}</p>
  return <ul className="inbox-list">{list.map((item) => <ScheduledRow key={`${item.server}:${item.id}`} item={item} />)}</ul>
}

function ScheduledRow({ item }: { item: Scheduled }) {
  const { t } = useTranslation()
  const [timing, setTiming] = useState(false)
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const failed = item.status === 'failed'
  const encrypted = item.kind !== 'channel'
  const run = (action: () => Promise<unknown>) => async () => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Row icon={<span className={`inbox-glyph ${failed ? 'failed' : ''}`} aria-hidden><Clock size={18} /></span>} unread={failed}
        title={<><strong>{scheduledWhere(item)}</strong>{encrypted && <span className="muted" title={t('productivity.scheduled.encrypted')}> <Lock size={12} /></span>}</>}
        sub={failed ? <span className="error-text">{t('productivity.scheduled.failed')}: {item.error}</span> : t('productivity.scheduled.sendsAt', { when: whenText(item.sendAt) })}
        body={error ? <span className="error-text">{error}</span> : item.shown ?? <em className="muted">{t('productivity.scheduled.cantOpen')}</em>}
        onOpen={go(() => openScheduledPlace(item))}
        actions={(
          <>
            <button className="button small primary" disabled={busy} onClick={() => void run(() => sendScheduledNow(item))()}>{t('productivity.scheduled.sendNow')}</button>
            <button className="button small" disabled={busy || (encrypted && item.shown === null)} onClick={() => setTiming(true)}>{t('productivity.scheduled.changeTime')}</button>
            {item.shown !== null && <button className="button small" disabled={busy} onClick={() => setEditing(true)}>{t('productivity.scheduled.edit')}</button>}
            <button className="button small danger" disabled={busy} onClick={() => void run(() => deleteScheduled(item))()}>{t('productivity.scheduled.remove')}</button>
          </>
        )} />
      {timing && (
        <TimeDialog title={t('productivity.scheduled.changeTime')} initial={item.sendAt}
          maxAheadMs={encrypted ? ENCRYPTED_SEND_MAX_AHEAD : CHANNEL_SEND_MAX_AHEAD}
          onClose={() => setTiming(false)} onPick={(at) => updateScheduled(item, { sendAt: at })} />
      )}
      {editing && <EditScheduledDialog item={item} onClose={() => setEditing(false)} />}
    </>
  )
}

function EditScheduledDialog({ item, onClose }: { item: Scheduled; onClose: () => void }) {
  const { t } = useTranslation()
  const [text, setText] = useState(item.shown ?? '')
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    try {
      await updateScheduled(item, { text: text.trim() })
      onClose()
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  return (
    <Modal title={t('productivity.scheduled.editTitle')} onClose={onClose} footer={(
      <>
        <button className="button" onClick={onClose}>{t('common.cancel')}</button>
        <button className="button primary" disabled={!text.trim()} onClick={() => void save()}>{t('productivity.scheduled.save')}</button>
      </>
    )}>
      <textarea className="scheduled-edit" value={text} maxLength={4000} rows={5} onChange={(e) => setText(e.target.value)} autoFocus />
      {error && <p className="error-text" role="alert">{error}</p>}
    </Modal>
  )
}

function TimeDialog({ title, initial, maxAheadMs, onClose, onPick }: {
  title: string; initial: number; maxAheadMs: number; onClose: () => void; onPick: (at: number) => Promise<unknown>
}) {
  const { t } = useTranslation()
  const [custom, setCustom] = useState<number | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const pick = async (at: number) => {
    try {
      await onPick(at)
      onClose()
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  return (
    <Modal title={title} onClose={onClose} footer={custom !== undefined ? (
      <>
        <button className="button" onClick={onClose}>{t('common.cancel')}</button>
        <button className="button primary" disabled={custom === null} onClick={() => custom && void pick(custom)}>{t('common.save')}</button>
      </>
    ) : undefined}>
      <WhenPicker presets={['1h', '3h', 'tomorrow', 'nextWeek']} maxAheadMs={maxAheadMs} onPick={(at) => void pick(at)} onCustom={setCustom}
        initial={initial > Date.now() ? initial : undefined} />
      {error && <p className="error-text" role="alert">{error}</p>}
    </Modal>
  )
}
