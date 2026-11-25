// A task board: three columns (to do, doing, done) of cards. Cards are dragged between and within columns on a
// desktop; every move is also in each card's menu and on Alt + arrow keys. Phones show one column at a time. A task
// opens beside the board (TaskPanel), where the thread panel would be.
import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { Channel, ForumTag, Task, TaskStatus } from '../../core/protocol'
import type { ServerState } from '../../state/store'
import { archiveDone, boardKey, createTask, loadBoard, moveTask, openTask, useTasks } from '../../state/tasks'
import { columnsOf, countsOf, dropTarget, isFiltering, MAX_TITLE_LENGTH, NO_FILTER, STATUSES, stepTarget, type TaskFilter } from '../../state/tasksLogic'
import { useThreads } from '../../state/threads'
import { channelConv, useReads } from '../../state/readState'
import { errorMessage } from '../../i18n/errors'
import { announce } from '../a11y'
import { Spinner } from '../bits'
import { Menu as MenuGlyph, MessageCircle, MoreHorizontal, Plus, Users } from '../icons'
import { Chip, EmptyState, Segmented } from '../kit'
import { ChannelTopic } from '../chat/ChannelTopic'
import { TagIcon } from '../forums/icons'
import { usePhoneLayout } from '../usePhoneLayout'
import type { Panel } from '../Shell'
import { ArchiveIcon, TasksIcon, TextIcon } from './icons'
import { ArchivedDialog, AssigneeStack, DueBadge, LabelChips, LabelsDialog, statusText, TaskMenu, useTaskAbilities, type TaskAbilities } from './TaskBits'
import type { MenuAnchor } from '../kit'
import './tasks.css'

const NO_TASKS: Task[] = []
const NO_LABELS: ForumTag[] = []

export function TasksView({ server, channel, onToggle }: { server: ServerState; channel: Channel; onToggle: (panel: Panel) => void }) {
  const { t } = useTranslation()
  const key = boardKey(server.key, channel.id)
  const board = useTasks((s) => s.boards[key])
  const openId = useThreads((s) => (s.open?.key === server.key ? s.open.id : null))
  const convs = useReads((s) => s.convs)
  const can = useTaskAbilities(server, channel)
  const phone = usePhoneLayout()
  const online = server.status.state === 'online'
  const me = server.me?.accountKey
  const [filter, setFilter] = useState<TaskFilter>(NO_FILTER)
  const [column, setColumn] = useState<TaskStatus>('todo')
  const [adding, setAdding] = useState<TaskStatus | null>(null)
  const [dialog, setDialog] = useState<'labels' | 'archived' | null>(null)
  const [menu, setMenu] = useState<{ id: number; anchor: MenuAnchor | null } | null>(null)
  const [drag, setDrag] = useState<number | null>(null)
  const [over, setOver] = useState<{ status: TaskStatus; index: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loaded = !!board?.loaded
  const failed = !!board?.error
  const busy = !!board?.loading
  useEffect(() => {
    if (online && !loaded && !busy && !failed) void loadBoard(server.key, channel.id)
  }, [online, loaded, busy, failed, server.key, channel.id])

  const tasks = board?.tasks ?? NO_TASKS
  const labels = board?.labels ?? NO_LABELS
  const columns = useMemo(() => columnsOf(tasks, filter, me), [tasks, filter, me])
  const counts = useMemo(() => countsOf(tasks), [tasks])
  const total = counts.todo + counts.doing + counts.done
  // People to filter by: everyone who has a task here.
  const people = useMemo(() => [...new Set(tasks.filter((x) => !x.archived).flatMap((x) => x.assignees))]
    .map((k) => ({ key: k, name: server.members[k]?.name ?? t('common.someone') })).sort((a, b) => a.name.localeCompare(b.name)), [tasks, server.members, t])
  const menuTask = menu ? tasks.find((x) => x.id === menu.id) : undefined
  const fail = (e: unknown) => setError(typeof e === 'string' ? e : errorMessage(e))

  function move(task: Task, status: TaskStatus, before: number | null) {
    setError(null)
    moveTask(server.key, task, status, before).catch(fail)
  }

  /** Alt + arrows on a card: up and down within the column, left and right to the next column. */
  function onCardKey(e: KeyboardEvent, task: Task) {
    if (!e.altKey || !can.edit) return
    const side = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0
    const step = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0
    if (side) {
      const next = STATUSES[STATUSES.indexOf(task.status) + side]
      e.preventDefault()
      if (!next) return
      move(task, next, null)
      announce(t('tasks.a11y.movedTo', { title: task.title, column: t(statusText(next)) }))
      if (phone) setColumn(next)
    } else if (step) {
      e.preventDefault()
      const target = stepTarget(columns[task.status], task.id, step)
      if (!target) return
      move(task, task.status, target.before)
      announce(step < 0 ? t('tasks.a11y.movedUp', { title: task.title }) : t('tasks.a11y.movedDown', { title: task.title }))
    } else return
    // The card is drawn again in its new place: keep the keyboard on it.
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-task="${task.id}"] .task-open`)?.focus())
  }

  /** Where in the column a dragged card would land: before the first card whose middle is below the pointer. */
  function onDragOver(e: DragEvent<HTMLElement>, status: TaskStatus) {
    if (drag === null) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const cards = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-task]')]
    const at = cards.findIndex((card) => {
      const box = card.getBoundingClientRect()
      return e.clientY < box.top + box.height / 2
    })
    const index = at < 0 ? cards.length : at
    setOver((o) => (o && o.status === status && o.index === index ? o : { status, index }))
  }

  function onDrop(e: DragEvent, status: TaskStatus) {
    e.preventDefault()
    const task = tasks.find((x) => x.id === drag)
    const target = task && over && over.status === status ? dropTarget(columns[status], task.id, status, over.index) : undefined
    setDrag(null)
    setOver(null)
    if (task && target) move(task, status, target.before)
  }

  return (
    <div className="chat tasks" data-testid="task-board">
      <header className="chat-header">
        <button className="icon-button mobile-only" onClick={() => onToggle('nav')} aria-label={t('tasks.view.openChannels')}>
          <MenuGlyph />
        </button>
        <h1>
          <span className="hash"><TasksIcon size={20} /></span>
          {channel.name}
        </h1>
        <span className="spacer" />
        {can.labels && (
          <button className="icon-button" onClick={() => setDialog('labels')} aria-label={t('tasks.view.editLabels')} title={t('tasks.view.editLabels')}>
            <TagIcon />
          </button>
        )}
        <button className="icon-button" onClick={() => setDialog('archived')} aria-label={t('tasks.view.archived')} title={t('tasks.view.archived')} data-testid="tasks-archived">
          <ArchiveIcon />
        </button>
        <button className="icon-button members-toggle" onClick={() => onToggle('members')} aria-label={t('tasks.view.members')} title={t('tasks.view.members')}>
          <Users />
        </button>
      </header>
      <ChannelTopic channel={channel} />

      <div className="tasks-toolbar">
        <div className="tasks-filters" role="group" aria-label={t('tasks.filter.label')}>
          <Chip on={filter.mine} onToggle={(mine) => setFilter((f) => ({ ...f, mine, assignee: mine ? null : f.assignee }))} testId="tasks-mine">{t('tasks.filter.mine')}</Chip>
          {people.length > 0 && (
            <select className="tasks-select" aria-label={t('tasks.filter.assignee')} value={filter.assignee ?? '*'}
              onChange={(e) => setFilter((f) => ({ ...f, assignee: e.target.value === '*' ? null : e.target.value, mine: e.target.value === '*' ? f.mine : false }))}>
              <option value="*">{t('tasks.filter.everyone')}</option>
              <option value="">{t('tasks.filter.unassigned')}</option>
              {people.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
            </select>
          )}
          {labels.length > 0 && (
            <select className="tasks-select" aria-label={t('tasks.filter.labelPick')} value={filter.label ?? ''}
              onChange={(e) => setFilter((f) => ({ ...f, label: e.target.value ? Number(e.target.value) : null }))}>
              <option value="">{t('tasks.filter.anyLabel')}</option>
              {labels.map((l) => <option key={l.id} value={l.id}>{l.emoji ? `${l.emoji} ${l.name}` : l.name}</option>)}
            </select>
          )}
          <Chip on={filter.hideDone} onToggle={(hideDone) => { setFilter((f) => ({ ...f, hideDone })); if (hideDone && column === 'done') setColumn('todo') }} testId="tasks-hide-done">{t('tasks.filter.hideDone')}</Chip>
        </div>
        {can.edit && (
          <button className="button primary tasks-new" onClick={() => { setAdding('todo'); setColumn('todo') }} data-testid="tasks-new">
            <Plus size={16} /> {t('tasks.view.newTask')}
          </button>
        )}
      </div>

      {error && <div className="banner error tasks-banner" role="alert"><span>{error}</span><button className="link" onClick={() => setError(null)}>{t('common.close')}</button></div>}
      {board?.error && (
        <div className="banner error tasks-banner" role="alert">
          <span>{board.error}</span>
          <button className="link" onClick={() => void loadBoard(server.key, channel.id)}>{t('tasks.view.retry')}</button>
        </div>
      )}

      {!loaded && !failed ? (
        <div className="tasks-wait"><Spinner /></div>
      ) : total === 0 && adding === null && loaded ? (
        <EmptyState size="page" icon={<TasksIcon size={30} />} title={t('tasks.empty.title')} body={can.edit ? t('tasks.empty.writer') : t('tasks.empty.reader')}
          action={can.edit ? <button className="button primary" onClick={() => setAdding('todo')}><Plus size={16} /> {t('tasks.view.newTask')}</button> : undefined} />
      ) : (
        <>
          <Segmented className="tasks-switch" label={t('tasks.view.columns')} value={column} onChange={setColumn}
            items={STATUSES.filter((s) => !(filter.hideDone && s === 'done')).map((s) => ({
              id: s, label: <>{t(statusText(s))} <span className="tasks-count">{counts[s]}</span></>,
              name: `${t(statusText(s))}: ${t('tasks.view.count', { count: counts[s] })}`, testId: `tasks-switch-${s}`,
            }))} />
          <div className={`tasks-columns ${filter.hideDone ? 'two' : ''}`}>
            {STATUSES.filter((s) => !(filter.hideDone && s === 'done')).map((status) => {
              const shown = columns[status]
              const dropping = over?.status === status && drag !== null
              return (
                <section key={status} className={`tasks-column status-${status} ${column === status ? 'current' : ''} ${dropping ? 'dropping' : ''}`}
                  aria-labelledby={`tasks-col-${channel.id}-${status}`} data-testid={`tasks-column-${status}`}
                  onDragOver={can.edit ? (e) => onDragOver(e, status) : undefined} onDrop={can.edit ? (e) => onDrop(e, status) : undefined}
                  onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((o) => (o?.status === status ? null : o)) }}>
                  <header className="tasks-column-head">
                    <span className={`task-status-dot status-${status}`} aria-hidden />
                    <h2 id={`tasks-col-${channel.id}-${status}`}>{t(statusText(status))}</h2>
                    <span className="tasks-count" aria-label={t('tasks.view.count', { count: shown.length })}>
                      {isFiltering(filter) && shown.length !== counts[status] ? `${shown.length}/${counts[status]}` : counts[status]}
                    </span>
                    <span className="spacer" />
                    {status === 'done' && can.edit && counts.done > 0 && (
                      <button className="button small tasks-archive-done" aria-label={t('tasks.view.archiveDoneLabel')} title={t('tasks.view.archiveDoneLabel')} onClick={() => archiveDone(server.key, channel.id).then((n) => announce(t('tasks.a11y.archived', { count: n }))).catch(fail)} data-testid="tasks-archive-done">
                        <ArchiveIcon size={14} /> {t('tasks.view.archiveDone')}
                      </button>
                    )}
                  </header>
                  <ul className="tasks-list">
                    {shown.map((task, index) => (
                      <TaskCard key={task.id} server={server} task={task} labels={labels} can={can} active={task.id === openId} dragging={drag === task.id}
                        dropBefore={dropping && over!.index === index} unread={(convs[channelConv(server.key, task.id)]?.unread ?? 0) > 0}
                        draggable={can.edit && !phone}
                        onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', task.title); setDrag(task.id) }}
                        onDragEnd={() => { setDrag(null); setOver(null) }}
                        onKeyDown={(e) => onCardKey(e, task)}
                        onMenu={(anchor) => setMenu({ id: task.id, anchor })} />
                    ))}
                    {dropping && over!.index >= shown.length && <li className="task-drop-end" aria-hidden />}
                  </ul>
                  {shown.length === 0 && adding !== status && (
                    <p className="tasks-none">{isFiltering(filter) && counts[status] > 0 ? t('tasks.view.noMatch') : t('tasks.view.none')}</p>
                  )}
                  {can.edit && (adding === status
                    ? <QuickAdd server={server} channel={channel} status={status} mine={filter.mine ? me : undefined} onClose={() => setAdding(null)} onError={fail} />
                    : <button className="tasks-add" onClick={() => setAdding(status)} data-testid={`tasks-add-${status}`}><Plus size={15} /> {t('tasks.view.add')}</button>)}
                </section>
              )
            })}
          </div>
        </>
      )}

      {menu && menuTask && (
        <TaskMenu server={server} task={menuTask} can={can} shown={columns[menuTask.status]} anchor={menu.anchor} onClose={() => setMenu(null)} onError={fail} />
      )}
      {dialog === 'labels' && <LabelsDialog server={server} channel={channel} labels={labels} onClose={() => setDialog(null)} />}
      {dialog === 'archived' && <ArchivedDialog server={server} channel={channel} can={can} labels={labels} onClose={() => setDialog(null)} />}
    </div>
  )
}

function TaskCard({ server, task, labels, can, active, dragging, dropBefore, unread, draggable, onDragStart, onDragEnd, onKeyDown, onMenu }: {
  server: ServerState; task: Task; labels: ForumTag[]; can: TaskAbilities; active: boolean; dragging: boolean; dropBefore: boolean; unread: boolean
  draggable: boolean
  onDragStart: (e: DragEvent) => void; onDragEnd: () => void; onKeyDown: (e: KeyboardEvent) => void; onMenu: (anchor: MenuAnchor | null) => void
}) {
  const { t } = useTranslation()
  const more = useRef<HTMLButtonElement>(null)
  const openMenu = () => {
    const rect = more.current?.getBoundingClientRect()
    onMenu(rect ? { x: rect.right, y: rect.bottom + 4, align: 'end' } : null)
  }
  return (
    <li className={`task-card ${active ? 'active' : ''} ${dragging ? 'dragging' : ''} ${dropBefore ? 'drop-before' : ''} ${task.status === 'done' ? 'is-done' : ''}`}
      data-task={task.id} draggable={draggable} onDragStart={onDragStart} onDragEnd={onDragEnd}
      onContextMenu={(e) => { e.preventDefault(); onMenu({ x: e.clientX, y: e.clientY }) }}>
      <button className="task-open" onClick={() => openTask(server.key, task)} onKeyDown={onKeyDown}
        aria-keyshortcuts={can.edit ? 'Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight' : undefined}>
        <span className="task-title">{task.title}{unread && <span className="task-unread" role="img" aria-label={t('tasks.card.newComments')} />}</span>
        <LabelChips labels={labels} ids={task.labels} />
        {(task.due || task.hasDescription || task.comments > 0 || task.assignees.length > 0) && (
          <span className="task-meta">
            <DueBadge task={task} />
            {task.hasDescription && <span className="task-fact" title={t('tasks.card.hasDescription')} role="img" aria-label={t('tasks.card.hasDescription')}><TextIcon size={13} /></span>}
            {task.comments > 0 && (
              <span className="task-fact" title={t('tasks.card.comments', { count: task.comments })} aria-label={t('tasks.card.comments', { count: task.comments })}>
                <MessageCircle size={13} /> {task.comments}
              </span>
            )}
            <span className="spacer" />
            <AssigneeStack server={server} keys={task.assignees} />
          </span>
        )}
      </button>
      <button ref={more} className="icon-button small task-more" onClick={openMenu} aria-label={t('tasks.card.more', { title: task.title })} title={t('tasks.card.moreShort')}>
        <MoreHorizontal size={16} />
      </button>
    </li>
  )
}

/** A title typed straight into a column: Enter adds the task and stays for the next one, Esc closes. */
function QuickAdd({ server, channel, status, mine, onClose, onError }: {
  server: ServerState; channel: Channel; status: TaskStatus; mine: string | undefined; onClose: () => void; onError: (e: unknown) => void
}) {
  const { t } = useTranslation()
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  async function add() {
    const text = title.trim()
    if (!text || busy) return
    setBusy(true)
    try {
      // Under "My tasks" a new task is mine, so it stays in view.
      await createTask(server.key, channel.id, text, { status, ...(mine ? { assignees: [mine] } : {}) })
      setTitle('')
    } catch (e) {
      onError(e)
    } finally {
      setBusy(false)
      input.current?.focus()
    }
  }

  return (
    <form className="tasks-quick" onSubmit={(e) => { e.preventDefault(); void add() }}>
      <input ref={input} autoFocus value={title} maxLength={MAX_TITLE_LENGTH} placeholder={t('tasks.view.addPlaceholder')} aria-label={t('tasks.view.addLabel', { column: t(statusText(status)) })}
        data-testid="tasks-quick-input"
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onClose()
          }
        }}
        onBlur={() => { if (!title.trim()) onClose() }} />
      <div className="tasks-quick-actions">
        <button type="submit" className="button primary small" disabled={!title.trim() || busy}>{t('tasks.view.addButton')}</button>
        <button type="button" className="button small" onMouseDown={(e) => e.preventDefault()} onClick={onClose}>{t('common.cancel')}</button>
      </div>
    </form>
  )
}
