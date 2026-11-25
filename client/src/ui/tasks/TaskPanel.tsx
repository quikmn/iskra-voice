// A task beside its board (full screen on phones): title, status, people, due day, labels and description above its
// comments, which are the task's thread. Shown where the thread panel would be while the channel is a task board.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { Channel, ForumTag, Task } from '../../core/protocol'
import { loadHistory, type ServerState } from '../../state/store'
import { closeThread } from '../../state/threads'
import { boardKey, fetchTask, knownTask, loadBoard, markAssignmentsSeen, moveTask, updateTask, useTasks } from '../../state/tasks'
import { dueDate, MAX_ASSIGNEES, MAX_DESCRIPTION_LENGTH, MAX_TITLE_LENGTH, STATUSES, toggleAssignee } from '../../state/tasksLogic'
import { alertPatternFor } from '../../state/alerts'
import { useRoleLookup } from '../../state/roles'
import { errorMessage } from '../../i18n/errors'
import { formatDate } from '../../i18n/format'
import { Composer, MessageList, TypingLine } from '../ChatView'
import { Avatar, Spinner } from '../bits'
import { fullTime } from '../format'
import { Close, MoreHorizontal, Pencil, Plus, UserPlus } from '../icons'
import { Segmented, type MenuAnchor } from '../kit'
import { useEscapeLayer } from '../layers'
import { renderMarkdown } from '../markdown'
import { ArrowLeft } from '../chat/extraIcons'
import { relativeTime } from '../chat/pinThreadHelpers'
import { TasksIcon } from './icons'
import { AssigneeMenu, LabelChips, LabelMenu, statusText, TaskMenu, useTaskAbilities } from './TaskBits'
import './tasks.css'

const NO_LABELS: ForumTag[] = []

export function TaskPanel({ server, channel, taskId }: { server: ServerState; channel: Channel; taskId: number }) {
  const { t } = useTranslation()
  const task = useTasks((s) => knownTask(server.key, taskId, s))
  const board = useTasks((s) => s.boards[boardKey(server.key, channel.id)])
  const can = useTaskAbilities(server, channel)
  const online = server.status.state === 'online'
  const [missing, setMissing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [menu, setMenu] = useState<MenuAnchor | null | false>(false)
  const more = useRef<HTMLButtonElement>(null)
  useEscapeLayer(closeThread)

  // The task with its description (lists come without), and again after a reconnect.
  useEffect(() => {
    if (!online) return
    let alive = true
    fetchTask(server.key, taskId).then(() => alive && setMissing(false)).catch(() => alive && setMissing(true))
    return () => {
      alive = false
    }
  }, [server.key, taskId, online])

  useEffect(() => {
    if (online) void loadHistory(server.key, taskId)
  }, [server.key, taskId, online])

  // Opened from a link: the board's labels may not be here yet.
  useEffect(() => {
    if (online && !board) void loadBoard(server.key, channel.id)
  }, [online, board, server.key, channel.id])

  useEffect(() => markAssignmentsSeen(server.key, [taskId]), [server.key, taskId])

  const labels = board?.labels ?? NO_LABELS

  return (
    <section className="side-panel task-panel" aria-label={task ? t('tasks.panel.label', { title: task.title }) : t('tasks.panel.task')} data-testid="task-panel"
      onDragOver={(e) => {
        if (can.edit && e.dataTransfer.types.includes('Files')) e.preventDefault()
      }}
      onDrop={(e) => {
        if (!can.edit || e.dataTransfer.files.length === 0) return
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('iskra:attach-thread', { detail: [...e.dataTransfer.files] }))
      }}>
      <header className="side-panel-header">
        <button className="icon-button panel-back" onClick={closeThread} aria-label={t('tasks.panel.back')}><ArrowLeft /></button>
        <span className="panel-icon"><TasksIcon /></span>
        <div className="panel-title">
          <h2>{t('tasks.panel.task')}</h2>
          <span className="muted">{t('tasks.panel.onBoard', { name: channel.name })}</span>
        </div>
        <span className="spacer" />
        {task && (
          <button ref={more} className="icon-button" aria-label={t('tasks.card.moreShort')} title={t('tasks.card.moreShort')} data-testid="task-panel-more"
            onClick={() => {
              const rect = more.current?.getBoundingClientRect()
              setMenu(rect ? { x: rect.right, y: rect.bottom + 4, align: 'end' } : null)
            }}>
            <MoreHorizontal />
          </button>
        )}
        <button className="icon-button panel-close" onClick={closeThread} aria-label={t('tasks.panel.close')} title={t('common.close')}><Close /></button>
      </header>
      {error && <div className="banner error" role="alert"><span>{error}</span><button className="link" onClick={() => setError(null)}>{t('common.close')}</button></div>}

      {missing && !task ? (
        <div className="empty-state"><p>{t('tasks.panel.missing')}</p></div>
      ) : !task ? (
        <div className="tasks-wait"><Spinner /></div>
      ) : (
        <>
          <MessageList key={taskId} server={server} channelId={taskId} thread
            header={<TaskDetails server={server} channel={channel} task={task} labels={labels} edit={can.edit} onError={setError} />} />
          <TypingLine server={server} channelId={taskId} />
          {can.edit
            ? <Composer server={server} channelId={taskId} channelName={task.title} thread placeholder={t('tasks.panel.comment')} />
            : <div className="composer read-only">{t('tasks.panel.readOnly')}</div>}
        </>
      )}
      {menu !== false && task && <TaskMenu server={server} task={task} can={can} anchor={menu} onClose={() => setMenu(false)} onError={setError} />}
    </section>
  )
}

function TaskDetails({ server, channel, task, labels, edit, onError }: {
  server: ServerState; channel: Channel; task: Task; labels: ForumTag[]; edit: boolean; onError: (message: string | null) => void
}) {
  const { t } = useTranslation()
  const roleOf = useRoleLookup(server.key, server.me)
  const [title, setTitle] = useState<string | null>(null)
  const [text, setText] = useState<string | null>(null)
  const [picker, setPicker] = useState<{ kind: 'people' | 'labels'; anchor: MenuAnchor | null } | null>(null)
  const [busy, setBusy] = useState(false)
  const me = server.me?.accountKey
  const mine = !!me && task.assignees.includes(me)
  const creator = server.members[task.createdBy]?.name ?? t('tasks.panel.formerMember')

  async function save(change: Parameters<typeof updateTask>[2], done?: () => void) {
    if (busy) return
    setBusy(true)
    onError(null)
    try {
      await updateTask(server.key, task.id, change)
      done?.()
    } catch (e) {
      onError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const saveTitle = () => {
    const next = title?.trim()
    if (!next || next === task.title) return setTitle(null)
    void save({ title: next }, () => setTitle(null))
  }
  const anchorOf = (el: HTMLElement): MenuAnchor => {
    const rect = el.getBoundingClientRect()
    return { x: rect.left, y: rect.bottom + 4 }
  }

  return (
    <div className="task-details">
      {title !== null ? (
        <input className="task-title-edit" value={title} maxLength={MAX_TITLE_LENGTH} autoFocus aria-label={t('tasks.panel.title')}
          onChange={(e) => setTitle(e.target.value)} onBlur={saveTitle}
          onKeyDown={(e) => {
            if (e.key === 'Enter') saveTitle()
            else if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              setTitle(null)
            }
          }} />
      ) : (
        <div className="task-title-row">
          <h3 className="task-panel-title" data-testid="task-panel-title">{task.title}</h3>
          {edit && <button className="icon-button small" onClick={() => setTitle(task.title)} aria-label={t('tasks.panel.rename')} title={t('tasks.panel.rename')}><Pencil size={15} /></button>}
        </div>
      )}
      {task.archived && <p className="task-archived-note">{t('tasks.panel.archived')}</p>}

      <dl className="task-fields">
        <Field label={t('tasks.panel.status')}>
          {edit && !task.archived ? (
            <Segmented className="task-status-pick" label={t('tasks.panel.status')} value={task.status}
              items={STATUSES.map((s) => ({ id: s, label: t(statusText(s)), testId: `task-status-${s}` }))}
              onChange={(status) => { if (status !== task.status) moveTask(server.key, task, status, null).catch((e) => onError(errorMessage(e))) }} />
          ) : (
            <span className="task-status-text"><span className={`task-status-dot status-${task.status}`} aria-hidden /> {t(statusText(task.status))}</span>
          )}
        </Field>
        <Field label={t('tasks.panel.assigned')}>
          <span className="task-assignees" data-testid="task-assignees">
            {task.assignees.map((k) => {
              const name = server.members[k]?.name ?? t('common.someone')
              return <span key={k} className="task-person"><Avatar name={name} accountKey={k} size={20} /> {name}</span>
            })}
            {task.assignees.length === 0 && <span className="muted">{t('tasks.panel.nobody')}</span>}
            {edit && me && (
              <button className="button small" disabled={busy || (!mine && task.assignees.length >= MAX_ASSIGNEES)} data-testid="task-panel-assign-me"
                onClick={() => void save({ assignees: toggleAssignee(task.assignees, me) })}>
                {mine ? t('tasks.assign.unassignMe') : t('tasks.assign.me')}
              </button>
            )}
            {edit && (
              <button className="icon-button small" aria-label={t('tasks.assign.title')} title={t('tasks.assign.title')} data-testid="task-panel-assign"
                onClick={(e) => setPicker({ kind: 'people', anchor: anchorOf(e.currentTarget) })}><UserPlus size={16} /></button>
            )}
          </span>
        </Field>
        <Field label={t('tasks.panel.due')}>
          {edit ? (
            <span className="task-due-edit">
              <input type="date" value={task.due ?? ''} aria-label={t('tasks.panel.due')} min="2000-01-01" max="2200-12-31" data-testid="task-due"
                onChange={(e) => void save({ due: e.target.value || null })} />
              {task.due && <button className="link" onClick={() => void save({ due: null })}>{t('tasks.panel.clearDue')}</button>}
            </span>
          ) : <DueText task={task} />}
        </Field>
        {(labels.length > 0 || task.labels.length > 0) && (
          <Field label={t('tasks.panel.labels')}>
            <span className="task-labels-row">
              <LabelChips labels={labels} ids={task.labels} />
              {task.labels.filter((id) => labels.some((l) => l.id === id)).length === 0 && !edit && <span className="muted">{t('tasks.panel.noLabels')}</span>}
              {edit && labels.length > 0 && (
                <button className="icon-button small" aria-label={t('tasks.labels.pick')} title={t('tasks.labels.pick')}
                  onClick={(e) => setPicker({ kind: 'labels', anchor: anchorOf(e.currentTarget) })}><Plus size={16} /></button>
              )}
            </span>
          </Field>
        )}
      </dl>

      <div className="task-description">
        <div className="task-section-head">
          <h4>{t('tasks.panel.description')}</h4>
          {edit && text === null && task.description !== null && (
            <button className="link" onClick={() => setText(task.description ?? '')} data-testid="task-edit-description">{task.description ? t('tasks.panel.edit') : t('tasks.panel.addDescription')}</button>
          )}
        </div>
        {text !== null ? (
          <>
            <textarea value={text} maxLength={MAX_DESCRIPTION_LENGTH} rows={6} autoFocus aria-label={t('tasks.panel.description')} placeholder={t('tasks.panel.descriptionPlaceholder')}
              data-testid="task-description-input"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void save({ description: text }, () => setText(null))
                else if (e.key === 'Escape') {
                  e.preventDefault()
                  e.stopPropagation()
                  setText(null)
                }
              }} />
            <div className="task-description-actions">
              <button className="button primary small" disabled={busy} onClick={() => void save({ description: text }, () => setText(null))}>{t('common.save')}</button>
              <button className="button small" onClick={() => setText(null)}>{t('common.cancel')}</button>
            </div>
          </>
        ) : task.description === null ? (
          <Spinner />
        ) : task.description ? (
          <div className="message-text task-description-text">
            {renderMarkdown(task.description, { nameOf: (k) => server.members[k]?.name ?? null, me, roleOf, serverKey: server.key, alerts: alertPatternFor(server.key) })}
          </div>
        ) : (
          <p className="muted task-no-description">{t('tasks.panel.noDescription')}</p>
        )}
      </div>

      <p className="muted task-made">
        {t('tasks.panel.madeBy', { name: creator })} · <time title={fullTime(task.createdAt)}>{relativeTime(task.createdAt)}</time>
        {task.updatedAt > task.createdAt + 60_000 && <> · {t('tasks.panel.updated')} <time title={fullTime(task.updatedAt)}>{relativeTime(task.updatedAt)}</time></>}
      </p>
      <h4 className="task-comments-head">{t('tasks.panel.comments')}</h4>
      {task.comments === 0 && <p className="muted task-no-comments">{edit ? t('tasks.panel.noCommentsWriter') : t('tasks.panel.noComments')}</p>}

      {picker?.kind === 'people' && <AssigneeMenu server={server} channel={channel} task={task} anchor={picker.anchor} onClose={() => setPicker(null)} onError={onError} />}
      {picker?.kind === 'labels' && <LabelMenu server={server} task={task} labels={labels} anchor={picker.anchor} onClose={() => setPicker(null)} onError={onError} />}
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="task-field">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function DueText({ task }: { task: Task }) {
  const { t } = useTranslation()
  if (!task.due) return <span className="muted">{t('tasks.panel.noDue')}</span>
  return <time dateTime={task.due}>{formatDate(dueDate(task.due), { dateStyle: 'medium' })}</time>
}
