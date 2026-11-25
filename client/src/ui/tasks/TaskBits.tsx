// Pieces the board and the task panel share: what a member may do, label chips, the people on a task, the due day,
// a task's menu, the people picker, and the dialogs for labels and archived tasks.
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { roleRank, type Channel, type ForumTag, type Task, type TaskStatus } from '../../core/protocol'
import { taskLink } from '../../core/pushRoute'
import type { ServerState } from '../../state/store'
import { canSendIn, baseAllows, channelAccess, has } from '../../state/permissions'
import { useServerRoles } from '../../state/roles'
import { useServerBaseRoles } from '../../state/baseRoles'
import { boardKey, deleteTask, loadArchived, moveTask, openTask, saveLabels, updateTask, useTasks } from '../../state/tasks'
import {
  canDeleteTask, dueDate, dueState, MAX_ASSIGNEES, MAX_BOARD_LABELS, MAX_TASK_LABELS, STATUSES, stepTarget, toggleAssignee,
} from '../../state/tasksLogic'
import { errorMessage } from '../../i18n/errors'
import { formatDate } from '../../i18n/format'
import { Avatar, Modal, Spinner } from '../bits'
import { appUrl } from '../format'
import { Calendar, Check, Link, Plus, Trash, UserPlus } from '../icons'
import { EmptyState, Menu, MenuGroup, MenuItem, MenuTitle, type MenuAnchor } from '../kit'
import { ArchiveIcon, ArrowDown, ArrowUp, Undo } from './icons'
import '../forums/forums.css'

/** What a member may do on a board (mirrors the server's checks). */
export interface TaskAbilities {
  /** Create, edit, move, assign and archive. */
  edit: boolean
  /** Delete anyone's task (trusted+ writers, message managers). */
  moderate: boolean
  /** Change the board's labels. */
  labels: boolean
}

export function useTaskAbilities(server: ServerState, channel: Channel | undefined): TaskAbilities {
  const roles = useServerRoles(server.key)
  const baseRoles = useServerBaseRoles(server.key)
  const me = server.me
  const edit = !!channel && canSendIn(me, channel, roles)
  return {
    edit,
    moderate: edit && !!me && (roleRank(me.role) >= roleRank('trusted') || has(me, roles, 'manageMessages')),
    labels: !!channel && baseAllows(baseRoles, me, 'forumTags'),
  }
}

export const linkToTask = (server: ServerState, task: Pick<Task, 'id' | 'channelId'>) =>
  taskLink(appUrl(server.appUrl), server.key, task.channelId, task.id)

export const statusText = (status: TaskStatus): 'tasks.status.todo' | 'tasks.status.doing' | 'tasks.status.done' => `tasks.status.${status}`

/** "24 Dec", with the year when it isn't this one. */
export function dueText(due: string): string {
  const date = dueDate(due)
  return formatDate(date, date.getFullYear() === new Date().getFullYear() ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })
}

export function DueBadge({ task }: { task: Pick<Task, 'due' | 'status'> }) {
  const { t } = useTranslation()
  const state = dueState(task)
  if (!task.due || !state) return null
  const label = state === 'overdue' ? t('tasks.due.overdue', { date: dueText(task.due) }) : state === 'today' ? t('tasks.due.today') : t('tasks.due.on', { date: dueText(task.due) })
  return (
    <span className={`task-due due-${state}`} title={label} aria-label={label}>
      <Calendar size={12} /> {state === 'today' ? t('tasks.due.todayShort') : dueText(task.due)}
    </span>
  )
}

export function LabelChips({ labels, ids }: { labels: ForumTag[]; ids: number[] }) {
  const shown = ids.map((id) => labels.find((l) => l.id === id)).filter((l): l is ForumTag => !!l)
  if (shown.length === 0) return null
  return (
    <span className="task-labels">
      {shown.map((l) => <span key={l.id} className="tag-chip small">{l.emoji && <span aria-hidden>{l.emoji}</span>}{l.name}</span>)}
    </span>
  )
}

/** The people on a task as overlapping avatars (at most `max`, then "+2"). */
export function AssigneeStack({ server, keys, size = 22, max = 3 }: { server: ServerState; keys: string[]; size?: number; max?: number }) {
  const { t } = useTranslation()
  if (keys.length === 0) return null
  const names = keys.map((k) => server.members[k]?.name ?? t('common.someone'))
  return (
    <span className="task-people" title={names.join(', ')} role="img" aria-label={t('tasks.card.assignedTo', { names: names.join(', ') })}>
      {keys.slice(0, max).map((k, i) => <Avatar key={k} name={names[i]} accountKey={k} size={size} />)}
      {keys.length > max && <span className="task-people-more" style={{ height: size, minWidth: size }}>+{keys.length - max}</span>}
    </span>
  )
}

// ── A task's menu ────────────────────────────────────────────────────────────

/**
 * Everything that can be done to a task without opening it: the keyboard and phone way to move it between and within
 * columns, assign yourself, copy its link, archive and delete. `shown`: the tasks its column shows, for up and down.
 */
export function TaskMenu({ server, task, can, shown, anchor, onClose, onError }: {
  server: ServerState; task: Task; can: TaskAbilities; shown?: Task[]; anchor: MenuAnchor | null; onClose: () => void; onError: (message: string) => void
}) {
  const { t } = useTranslation()
  const [confirm, setConfirm] = useState(false)
  const [copied, setCopied] = useState(false)
  const me = server.me?.accountKey
  const mine = !!me && task.assignees.includes(me)
  const run = (work: () => Promise<unknown>) => () => {
    onClose()
    work().catch((e) => onError(errorMessage(e)))
  }
  const up = shown && stepTarget(shown, task.id, -1)
  const down = shown && stepTarget(shown, task.id, 1)

  if (confirm) {
    return (
      <Menu anchor={anchor} label={t('tasks.menu.deleteTitle', { title: task.title })} onClose={onClose}>
        <MenuTitle onBack={() => setConfirm(false)}>{t('tasks.menu.deleteTitle', { title: task.title })}</MenuTitle>
        <p className="task-menu-note">{t('tasks.menu.deleteHint')}</p>
        <MenuItem danger icon={<Trash size={16} />} onClick={run(() => deleteTask(server.key, task))} testId="task-delete-confirm">{t('tasks.menu.delete')}</MenuItem>
      </Menu>
    )
  }
  return (
    <Menu anchor={anchor} label={t('tasks.menu.label', { title: task.title })} onClose={onClose}>
      {can.edit && !task.archived && (
        <MenuGroup label={t('tasks.menu.moveTo')}>
          {STATUSES.map((status) => (
            <MenuItem key={status} checked={task.status === status} testId={`task-move-${status}`}
              onClick={task.status === status ? onClose : run(() => moveTask(server.key, task, status, null))}>{t(statusText(status))}</MenuItem>
          ))}
        </MenuGroup>
      )}
      {can.edit && !task.archived && shown && (
        <MenuGroup>
          <MenuItem icon={<ArrowUp size={16} />} disabled={!up} onClick={run(() => moveTask(server.key, task, task.status, up!.before))}>{t('tasks.menu.moveUp')}</MenuItem>
          <MenuItem icon={<ArrowDown size={16} />} disabled={!down} onClick={run(() => moveTask(server.key, task, task.status, down!.before))}>{t('tasks.menu.moveDown')}</MenuItem>
        </MenuGroup>
      )}
      <MenuGroup>
        {can.edit && me && (
          <MenuItem icon={<UserPlus size={16} />} testId="task-assign-me" disabled={!mine && task.assignees.length >= MAX_ASSIGNEES}
            onClick={run(() => updateTask(server.key, task.id, { assignees: toggleAssignee(task.assignees, me) }))}>
            {mine ? t('tasks.assign.unassignMe') : t('tasks.assign.me')}
          </MenuItem>
        )}
        <MenuItem icon={copied ? <Check size={16} /> : <Link size={16} />} testId="task-copy-link" onClick={() => {
          navigator.clipboard.writeText(linkToTask(server, task)).then(() => {
            setCopied(true)
            setTimeout(onClose, 700)
          }).catch(() => onError(t('tasks.menu.copyFailed')))
        }}>{copied ? t('tasks.menu.copied') : t('tasks.menu.copyLink')}</MenuItem>
      </MenuGroup>
      {(can.edit || canDeleteTask(task, me, can.moderate)) && (
        <MenuGroup>
          {can.edit && (task.archived
            ? <MenuItem icon={<Undo size={16} />} onClick={run(() => updateTask(server.key, task.id, { archived: false }))}>{t('tasks.menu.restore')}</MenuItem>
            : <MenuItem icon={<ArchiveIcon size={16} />} testId="task-archive" onClick={run(() => updateTask(server.key, task.id, { archived: true }))}>{t('tasks.menu.archive')}</MenuItem>)}
          {can.edit && canDeleteTask(task, me, can.moderate) && (
            <MenuItem danger submenu icon={<Trash size={16} />} testId="task-delete" onClick={() => setConfirm(true)}>{t('tasks.menu.delete')}</MenuItem>
          )}
        </MenuGroup>
      )}
    </Menu>
  )
}

// ── Picking people ───────────────────────────────────────────────────────────

/** The members who can see the board, to assign: you first, then by name; a search box once there are many. */
export function AssigneeMenu({ server, channel, task, anchor, onClose, onError }: {
  server: ServerState; channel: Channel; task: Task; anchor: MenuAnchor | null; onClose: () => void; onError: (message: string) => void
}) {
  const { t } = useTranslation()
  const roles = useServerRoles(server.key)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const me = server.me?.accountKey
  const people = useMemo(() => Object.values(server.members)
    .filter((m) => !m.bot && channelAccess(m, channel, roles).has('view'))
    .sort((a, b) => Number(b.accountKey === me) - Number(a.accountKey === me) || a.name.localeCompare(b.name)), [server.members, channel, roles, me])
  const needle = query.trim().toLowerCase()
  const shown = people.filter((m) => !needle || m.name.toLowerCase().includes(needle)).slice(0, 50)
  const full = task.assignees.length >= MAX_ASSIGNEES

  async function toggle(key: string) {
    if (busy) return
    setBusy(true)
    try {
      await updateTask(server.key, task.id, { assignees: toggleAssignee(task.assignees, key) })
    } catch (e) {
      onError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Menu anchor={anchor} label={t('tasks.assign.title')} onClose={onClose}>
      <MenuTitle>{t('tasks.assign.title')}</MenuTitle>
      {people.length > 8 && (
        <input className="task-people-search" type="search" value={query} maxLength={64} placeholder={t('tasks.assign.search')} aria-label={t('tasks.assign.search')}
          onChange={(e) => setQuery(e.target.value)} />
      )}
      <MenuGroup>
        {shown.map((m) => {
          const on = task.assignees.includes(m.accountKey)
          return (
            <MenuItem key={m.accountKey} toggle={on} disabled={!on && full} icon={<Avatar name={m.name} accountKey={m.accountKey} size={18} />}
              onClick={() => void toggle(m.accountKey)}>{m.accountKey === me ? t('tasks.assign.you', { name: m.name }) : m.name}</MenuItem>
          )
        })}
        {shown.length === 0 && <p className="task-menu-note">{t('tasks.assign.nobody')}</p>}
      </MenuGroup>
      {full && <p className="task-menu-note">{t('tasks.assign.max', { max: MAX_ASSIGNEES })}</p>}
    </Menu>
  )
}

/** The board's labels to put on a task or take off. */
export function LabelMenu({ server, task, labels, anchor, onClose, onError }: {
  server: ServerState; task: Task; labels: ForumTag[]; anchor: MenuAnchor | null; onClose: () => void; onError: (message: string) => void
}) {
  const { t } = useTranslation()
  const on = task.labels.filter((id) => labels.some((l) => l.id === id))
  const toggle = (id: number) => {
    updateTask(server.key, task.id, { labels: on.includes(id) ? on.filter((x) => x !== id) : [...on, id] }).catch((e) => onError(errorMessage(e)))
  }
  return (
    <Menu anchor={anchor} label={t('tasks.labels.pick')} onClose={onClose}>
      <MenuTitle>{t('tasks.labels.pick')}</MenuTitle>
      <MenuGroup>
        {labels.map((l) => (
          <MenuItem key={l.id} toggle={on.includes(l.id)} disabled={!on.includes(l.id) && on.length >= MAX_TASK_LABELS} onClick={() => toggle(l.id)}>
            {l.emoji ? `${l.emoji} ${l.name}` : l.name}
          </MenuItem>
        ))}
      </MenuGroup>
    </Menu>
  )
}

// ── Dialogs ──────────────────────────────────────────────────────────────────

interface DraftLabel {
  key: string
  id?: number
  name: string
  emoji: string
}

let labelKeys = 0

/** The board's labels: names with an optional emoji, like a forum's tags. */
export function LabelsDialog({ server, channel, labels, onClose }: { server: ServerState; channel: Channel; labels: ForumTag[]; onClose: () => void }) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<DraftLabel[]>(() => labels.map((l) => ({ key: `l${l.id}`, id: l.id, name: l.name, emoji: l.emoji ?? '' })))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const names = draft.map((l) => l.name.trim().toLowerCase())
  const problem = names.some((n) => !n) ? t('tasks.labels.problemName') : new Set(names).size !== names.length ? t('tasks.labels.problemUnique') : null
  const patch = (key: string, change: Partial<DraftLabel>) => setDraft((list) => list.map((l) => (l.key === key ? { ...l, ...change } : l)))

  async function save() {
    if (problem || busy) return
    setBusy(true)
    try {
      await saveLabels(server.key, channel.id, draft.map((l) => ({ id: l.id, name: l.name.trim(), emoji: l.emoji.trim() || null })))
      onClose()
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  return (
    <Modal
      title={t('tasks.labels.title')}
      onClose={onClose}
      footer={
        <>
          <button className="button" onClick={onClose}>{t('common.cancel')}</button>
          <button className="button primary" disabled={!!problem || busy} onClick={() => void save()}>{t('common.save')}</button>
        </>
      }
    >
      <p className="muted">{t('tasks.labels.intro', { max: MAX_TASK_LABELS })}</p>
      <ul className="tag-editor">
        {draft.map((l) => (
          <li key={l.key}>
            <input className="tag-emoji" value={l.emoji} maxLength={16} placeholder="🙂" aria-label={t('tasks.labels.emoji')} onChange={(e) => patch(l.key, { emoji: e.target.value })} />
            <input value={l.name} maxLength={20} placeholder={t('tasks.labels.name')} aria-label={t('tasks.labels.name')} onChange={(e) => patch(l.key, { name: e.target.value })} />
            <button className="icon-button" aria-label={l.name ? t('tasks.labels.remove', { name: l.name }) : t('tasks.labels.removeOne')}
              onClick={() => setDraft((list) => list.filter((x) => x.key !== l.key))}>
              <Trash size={16} />
            </button>
          </li>
        ))}
      </ul>
      {draft.length < MAX_BOARD_LABELS ? (
        <button className="button small" onClick={() => setDraft((list) => [...list, { key: `n${++labelKeys}`, name: '', emoji: '' }])}>
          <Plus size={14} /> {t('tasks.labels.add')}
        </button>
      ) : (
        <p className="muted">{t('tasks.labels.max', { max: MAX_BOARD_LABELS })}</p>
      )}
      {(problem && draft.length > 0 ? problem : error) && <p className="error-text">{error ?? problem}</p>}
    </Modal>
  )
}

/** Archived tasks, newest first: open one, put it back on the board, or delete it. */
export function ArchivedDialog({ server, channel, can, labels, onClose }: {
  server: ServerState; channel: Channel; can: TaskAbilities; labels: ForumTag[]; onClose: () => void
}) {
  const { t } = useTranslation()
  const list = useTasks((s) => s.archived[boardKey(server.key, channel.id)])
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<number | null>(null)
  const me = server.me?.accountKey

  useEffect(() => {
    loadArchived(server.key, channel.id).catch((e) => setError(errorMessage(e)))
  }, [server.key, channel.id])

  const act = (work: Promise<unknown>) => void work.catch((e) => setError(errorMessage(e)))

  return (
    <Modal title={t('tasks.archived.title')} onClose={onClose}>
      {error && <p className="error-text">{error}</p>}
      {!list ? (error ? null : <div className="tasks-archived-wait"><Spinner /></div>) : list.length === 0 ? (
        <EmptyState icon={<ArchiveIcon size={24} />} body={t('tasks.archived.empty')} />
      ) : (
        <ul className="tasks-archived">
          {list.map((task) => (
            <li key={task.id}>
              <button className="tasks-archived-open" onClick={() => { openTask(server.key, task); onClose() }}>
                <span className="tasks-archived-title">{task.title}</span>
                <span className="tasks-archived-meta">
                  <span className={`task-status-dot status-${task.status}`} aria-hidden /> {t(statusText(task.status))}
                  <LabelChips labels={labels} ids={task.labels} />
                </span>
              </button>
              {deleting === task.id ? (
                <span className="confirm-inline">
                  {t('tasks.archived.deleteConfirm')}
                  <button className="button danger small" onClick={() => { setDeleting(null); act(deleteTask(server.key, task)) }}>{t('common.delete')}</button>
                  <button className="button small" onClick={() => setDeleting(null)}>{t('tasks.archived.keep')}</button>
                </span>
              ) : (
                <>
                  {can.edit && (
                    <button className="button small" onClick={() => act(updateTask(server.key, task.id, { archived: false }))}>{t('tasks.archived.restore')}</button>
                  )}
                  {can.edit && canDeleteTask(task, me, can.moderate) && (
                    <button className="icon-button" aria-label={t('tasks.archived.delete', { title: task.title })} title={t('tasks.menu.delete')}
                      onClick={() => setDeleting(task.id)}><Trash size={16} /></button>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}
