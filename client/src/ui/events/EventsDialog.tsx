// The events dialog: a server's calendar as a month or an agenda (upcoming and live events as cards: interested, add to
// calendar, join), the create/edit form, and "Add to my calendar".
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../../i18n/errors'
import { formatDate } from '../../i18n/format'
import { t as translate } from '../../i18n'
import type { CalendarBirthday, ServerEvent } from '../../core/protocol'
import type { ServerState } from '../../state/store'
import { cancelEvent, canCreateEvent, canManageEvent, setInterested, useEvents } from '../../state/events'
import { loadBirthdays, useCalendar } from '../../state/calendar'
import { addDays, agenda, dayOf, newEventStart } from '../../state/calendarLogic'
import { creatorTime, eventIcs, formatClock, formatRange, icsFileName, localZone, openEvents, repeatText, startsIn } from '../../state/eventTime'
import { joinVoice } from '../../state/voice'
import { Avatar, Modal } from '../bits'
import { Pencil, Plus, Volume } from '../icons'
import { EmptyState, Segmented } from '../kit'
import { usePhoneLayout } from '../usePhoneLayout'
import { CalendarMonth } from './CalendarMonth'
import { CalendarSubscribe } from './CalendarSubscribe'
import { CalendarIcon, CalendarPlus, MapPin, RepeatIcon, StarIcon } from '../forums/icons'
import { EventForm } from './EventForm'
import { useNow } from './useNow'
import { placeOf } from './place'

const VIEW_KEY = 'iskra.eventsView'
type View = 'month' | 'agenda'

/** The view picked last on this device; else the month on a computer and the agenda on a phone. */
function storedView(phone: boolean): View {
  try {
    const stored = localStorage.getItem(VIEW_KEY)
    if (stored === 'month' || stored === 'agenda') return stored
  } catch {
    /* no storage: the default */
  }
  return phone ? 'agenda' : 'month'
}

/** How far ahead the agenda shows the later days of a series and birthdays. */
const AGENDA_REPEAT_DAYS = 28
const AGENDA_BIRTHDAY_DAYS = 60

type Mode = { kind: 'view' } | { kind: 'form'; event?: ServerEvent; start?: number } | { kind: 'subscribe' }

export function EventsDialog({ server, focus, onClose }: { server: ServerState; focus?: number; onClose: () => void }) {
  const { t } = useTranslation()
  const phone = usePhoneLayout()
  const events = useEvents((s) => s.events[server.key])
  const birthdays = useCalendar((s) => s.birthdays[server.key]) ?? NO_BIRTHDAYS
  const [mode, setMode] = useState<Mode>({ kind: 'view' })
  // A reminder or a link to one event opens the agenda at that event.
  const [view, setView] = useState<View>(() => (focus !== undefined ? 'agenda' : storedView(phone)))
  const [focused, setFocused] = useState(focus)
  const now = useNow()
  const list = openEvents(Object.values(events ?? {}))
  const listRef = useRef<HTMLDivElement>(null)
  const zone = localZone()
  const today = dayOf(now, zone)

  useEffect(() => {
    void loadBirthdays(server.key)
  }, [server.key])

  useEffect(() => {
    if (mode.kind !== 'view' || view !== 'agenda' || focused === undefined) return
    listRef.current?.querySelector(`#event-${focused}`)?.scrollIntoView({ block: 'center' })
  }, [focused, mode.kind, view])

  function pickView(next: View) {
    setView(next)
    try {
      localStorage.setItem(VIEW_KEY, next)
    } catch {
      /* not remembered */
    }
  }

  function openEvent(id: number) {
    setFocused(id)
    setView('agenda')
  }

  if (mode.kind === 'form') {
    const editing = mode.event ? events?.[mode.event.id] ?? mode.event : undefined
    return (
      <EventForm
        server={server}
        event={editing}
        start={mode.start}
        onBack={() => setMode({ kind: 'view' })}
        onClose={onClose}
      />
    )
  }
  if (mode.kind === 'subscribe') return <CalendarSubscribe server={server} onBack={() => setMode({ kind: 'view' })} onClose={onClose} />

  // The agenda: every upcoming event as a card under its day, with birthdays and the next weeks' repeats between them.
  const firstDay = list.length > 0 && dayOf(list[0].startAt, zone) < today ? dayOf(list[0].startAt, zone) : today
  const days = view === 'agenda'
    ? agenda(list, birthdays, firstDay, 400, zone).map((day) => ({
      ...day,
      items: day.items.filter((item) => item.kind === 'birthday'
        ? day.day >= today && day.day <= addDays(today, AGENDA_BIRTHDAY_DAYS)
        : !item.projected || day.day <= addDays(today, AGENDA_REPEAT_DAYS)),
    })).filter((day) => day.items.length > 0)
    : []

  const dayNames = { today: t('calendar.today'), tomorrow: t('calendar.tomorrow') }

  return (
    <Modal
      title={t('events.dialog.title')}
      heading={<>{t('events.dialog.title')} <span className="muted">{t('events.dialog.on', { server: server.name })}</span></>}
      onClose={onClose}
      wide
      className={`events-modal ${view === 'month' ? 'calendar-wide' : ''}`}
      footer={canCreateEvent(server) ? (
        <button className="button primary" onClick={() => setMode({ kind: 'form' })}><Plus size={16} /> {t('events.dialog.schedule')}</button>
      ) : undefined}
    >
      <div className="events-toolbar">
        <Segmented
          label={t('calendar.view.label')} value={view} onChange={pickView}
          items={[{ id: 'month', label: t('calendar.view.month'), testId: 'events-view-month' }, { id: 'agenda', label: t('calendar.view.agenda'), testId: 'events-view-agenda' }]}
        />
        <button className="button small" onClick={() => setMode({ kind: 'subscribe' })} data-testid="calendar-subscribe-open">
          <CalendarPlus size={14} /> {t('calendar.subscribe.button')}
        </button>
      </div>
      {view === 'month' ? (
        <CalendarMonth
          server={server} events={list} birthdays={birthdays} now={now} canCreate={canCreateEvent(server)}
          onOpenEvent={openEvent} onCreate={(day) => setMode({ kind: 'form', start: newEventStart(day, zone) })}
        />
      ) : (
        <div ref={listRef} className="event-list">
          {days.length === 0 ? (
            <EmptyState className="event-empty" icon={<CalendarIcon size={28} />} title={t('events.dialog.empty')}
              body={canCreateEvent(server) ? t('events.dialog.emptyCreate') : t('events.dialog.emptyView')} />
          ) : (
            days.map(({ day, items }) => (
              <section key={day} className="agenda-day" aria-label={agendaDay(day, today, dayNames)}>
                <h3 className={day === today ? 'today' : ''}>{agendaDay(day, today, dayNames)}</h3>
                {items.map((item, i) => item.kind === 'birthday' ? (
                  <p key={`b${item.accountKey}`} className="agenda-row birthday">
                    <span aria-hidden>🎂</span> {t('calendar.birthday', { name: server.members[item.accountKey]?.name ?? '?' })}
                  </p>
                ) : item.projected ? (
                  <button key={`${item.event.id}-${i}`} className="agenda-row" onClick={() => openEvent(item.event.id)}>
                    <time dateTime={new Date(item.startAt).toISOString()}>{formatClock(item.startAt)}</time>
                    <strong>{item.event.title}</strong>
                    <span className="muted cal-row-note"><RepeatIcon size={13} /> {t('calendar.repeatsThen')}</span>
                  </button>
                ) : (
                  <EventCard key={item.event.id} server={server} event={item.event} now={now} focused={item.event.id === focused}
                    onEdit={() => setMode({ kind: 'form', event: item.event })} onJoined={onClose} />
                ))}
              </section>
            ))
          )}
        </div>
      )}
    </Modal>
  )
}

const NO_BIRTHDAYS: CalendarBirthday[] = []

/** "Today", "Tomorrow", or the day ("Saturday, October 24"; with the year when it isn't this one). */
function agendaDay(day: string, today: string, names: { today: string; tomorrow: string }): string {
  if (day === today) return names.today
  if (day === addDays(today, 1)) return names.tomorrow
  const [y, m, d] = day.split('-').map(Number)
  return formatDate(Date.UTC(y, m - 1, d, 12), { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC', ...(day.slice(0, 4) !== today.slice(0, 4) ? { year: 'numeric' } : {}) })
}

function downloadIcs(server: ServerState, event: ServerEvent) {
  const place = placeOf(server, event)
  const ics = eventIcs(event, { serverKey: server.key, place: place.voiceId !== null ? translate('events.dialog.icsPlace', { place: place.label, server: server.name }) : place.label })
  const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = icsFileName(event.title)
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

function EventCard({ server, event, now, focused, onEdit, onJoined }: {
  server: ServerState; event: ServerEvent; now: number; focused: boolean; onEdit: () => void; onJoined: () => void
}) {
  const { t } = useTranslation()
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const me = server.me?.accountKey
  const interested = !!me && event.interested.includes(me)
  const live = event.status === 'live' || event.startAt <= now
  const place = placeOf(server, event)
  const zone = localZone()
  const theirs = creatorTime(event, zone)
  const creator = server.members[event.createdBy]
  const start = new Date(event.startAt)
  const soon = startsIn(event.startAt, now)
  const repeats = repeatText(event)

  async function run(action: () => Promise<void>) {
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
    <article id={`event-${event.id}`} className={`event-card ${live ? 'live' : ''} ${focused ? 'focused' : ''}`} aria-label={event.title}>
      {event.image && (
        <img className="event-cover" src={server.url + event.image.url} alt="" width={event.image.width ?? undefined} height={event.image.height ?? undefined} />
      )}
      <div className="event-top">
        <div className="event-date" aria-hidden>
          <span>{formatDate(start, { month: 'short' })}</span>
          <strong>{start.getDate()}</strong>
        </div>
        <div className="event-head">
          <div className="event-status">
            {live ? <span className="live-pill">{t('events.dialog.liveNow')}</span> : soon && <span className="muted">{soon}</span>}
          </div>
          <h3>{event.title}</h3>
          <p className="event-when">
            <time dateTime={start.toISOString()}>{formatRange(event.startAt, event.endAt)}</time>
            {theirs && <span className="muted"> ({theirs})</span>}
          </p>
          <p className="event-where">
            {place.voiceId !== null ? <Volume size={14} /> : <MapPin size={14} />}
            <span>{place.label}</span>
          </p>
          {repeats && (
            <p className="event-where event-repeats">
              <RepeatIcon size={14} />
              <span>{repeats}</span>
            </p>
          )}
        </div>
      </div>
      {event.description && <p className="event-description">{event.description}</p>}
      <div className="event-people">
        <div className="avatar-stack" aria-hidden>
          {event.interested.slice(0, 5).map((key) => (
            <Avatar key={key} name={server.members[key]?.name ?? '?'} accountKey={key} size={22} />
          ))}
        </div>
        <span className="muted">
          {t('events.dialog.interestedCount', { count: event.interested.length, creator: creator?.name ?? t('events.dialog.formerMember') })}
        </span>
      </div>
      <div className="event-actions">
        <button
          className={`button small ${interested ? 'interested' : ''}`}
          aria-pressed={interested}
          disabled={busy}
          onClick={() => void run(() => setInterested(server.key, event.id, !interested))}
        >
          <StarIcon size={14} filled={interested} /> {interested ? t('events.dialog.interested') : t('events.dialog.imInterested')}
        </button>
        {live && place.voiceId !== null && server.voiceAvailable && (
          <button
            className="button primary small"
            onClick={() => {
              void joinVoice(server.key, place.voiceId!)
              onJoined()
            }}
          >
            <Volume size={14} /> {t('events.dialog.joinVoice')}
          </button>
        )}
        <button className="button ghost small" onClick={() => downloadIcs(server, event)}>
          <CalendarPlus size={14} /> {t('events.dialog.addToCalendar')}
        </button>
        {canManageEvent(server, event) && (
          confirmCancel ? (
            <span className="confirm-inline">
              {repeats ? t('events.dialog.cancelSeriesConfirm') : t('events.dialog.cancelConfirm')}
              {repeats ? (
                <>
                  <button className="button danger small" disabled={busy} onClick={() => void run(() => cancelEvent(server.key, event.id, 'one'))}>{t('events.dialog.cancelOne')}</button>
                  <button className="button danger small" disabled={busy} onClick={() => void run(() => cancelEvent(server.key, event.id, 'series'))}>{t('events.dialog.cancelSeries')}</button>
                </>
              ) : (
                <button className="button danger small" disabled={busy} onClick={() => void run(() => cancelEvent(server.key, event.id))}>{t('events.dialog.cancelEvent')}</button>
              )}
              <button className="button small" onClick={() => setConfirmCancel(false)}>{t('events.dialog.keep')}</button>
            </span>
          ) : (
            <>
              <button className="button ghost small" onClick={onEdit}><Pencil size={14} /> {t('common.edit')}</button>
              <button className="button ghost small danger-text" onClick={() => setConfirmCancel(true)}>{t('events.dialog.cancelEvent')}</button>
            </>
          )
        )}
      </div>
      {error && <p className="error-text">{error}</p>}
    </article>
  )
}
