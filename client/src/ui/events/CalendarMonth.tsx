// The month view of a server's calendar: a grid of days with the events that start on each (in the viewer's time
// zone, a series shown on every day it repeats), birthdays, a marker on today, and under it what's on the picked day.
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { intlLocale } from '../../i18n'
import { formatDate } from '../../i18n/format'
import type { ServerEvent } from '../../core/protocol'
import type { ServerState } from '../../state/store'
import { dayOf, itemsByDay, monthGrid, shiftMonth, weekStartOf, type Birthday, type CalendarItem, type DayKey } from '../../state/calendarLogic'
import { formatClock, localZone } from '../../state/eventTime'
import { ChevronLeft, ChevronRight, Plus } from '../icons'
import { RepeatIcon } from '../forums/icons'
import { usePhoneLayout } from '../usePhoneLayout'

/** Noon UTC on a day: formatting it in UTC gives that day's names whatever the viewer's zone. */
const noon = (day: DayKey) => {
  const [y, m, d] = day.split('-').map(Number)
  return Date.UTC(y, m - 1, d, 12)
}
const dayName = (day: DayKey, options: Intl.DateTimeFormatOptions) => formatDate(noon(day), { ...options, timeZone: 'UTC' })

/** How many events a day shows in the grid before "2 more". */
const MAX_CHIPS = 3

export function CalendarMonth({ server, events, birthdays, now, canCreate, onOpenEvent, onCreate }: {
  server: ServerState
  events: ServerEvent[]
  birthdays: Birthday[]
  now: number
  canCreate: boolean
  onOpenEvent: (id: number) => void
  /** A new event on that day. */
  onCreate: (day: DayKey) => void
}) {
  const { t } = useTranslation()
  const phone = usePhoneLayout()
  const zone = localZone()
  const today = dayOf(now, zone)
  const [at, setAt] = useState(() => ({ year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) - 1 }))
  const [selected, setSelected] = useState<DayKey>(today)
  const weeks = useMemo(() => monthGrid(at.year, at.month, weekStartOf(intlLocale())), [at])
  const first = weeks[0][0].day
  const last = weeks[weeks.length - 1][6].day
  const days = useMemo(() => itemsByDay(events, birthdays, first, last, zone), [events, birthdays, first, last, zone])
  const me = server.me?.accountKey
  const picked = days.get(selected) ?? []
  const canCreateOn = (day: DayKey) => canCreate && day >= today

  function go(by: number) {
    const next = shiftMonth(at, by)
    setAt(next)
    // Keep a day picked that is on screen: today when it's in the month, else the 1st.
    const firstOfMonth = `${next.year}-${String(next.month + 1).padStart(2, '0')}-01`
    setSelected(today.startsWith(firstOfMonth.slice(0, 7)) ? today : firstOfMonth)
  }

  function showToday() {
    setAt({ year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) - 1 })
    setSelected(today)
  }

  const nameOf = (item: CalendarItem) =>
    item.kind === 'birthday' ? t('calendar.birthday', { name: server.members[item.accountKey]?.name ?? '?' }) : item.event.title

  return (
    <div className="cal" data-testid="calendar-month">
      <div className="cal-bar">
        <h3 className="cal-title" aria-live="polite">{dayName(`${at.year}-${String(at.month + 1).padStart(2, '0')}-15`, { month: 'long', year: 'numeric' })}</h3>
        <button className="button small" onClick={showToday}>{t('calendar.today')}</button>
        <button className="icon-button" aria-label={t('calendar.previousMonth')} onClick={() => go(-1)}><ChevronLeft /></button>
        <button className="icon-button" aria-label={t('calendar.nextMonth')} onClick={() => go(1)}><ChevronRight /></button>
      </div>

      <div className="cal-grid" role="grid" aria-label={dayName(`${at.year}-${String(at.month + 1).padStart(2, '0')}-15`, { month: 'long', year: 'numeric' })}>
        <div className="cal-week cal-weekdays" role="row">
          {weeks[0].map(({ day }) => (
            <span key={day} role="columnheader" aria-label={dayName(day, { weekday: 'long' })}>{dayName(day, { weekday: 'short' })}</span>
          ))}
        </div>
        {weeks.map((week) => (
          <div key={week[0].day} className="cal-week" role="row">
            {week.map(({ day, inMonth }) => {
              const items = days.get(day) ?? []
              const full = dayName(day, { weekday: 'long', month: 'long', day: 'numeric' })
              const label = items.length === 0 ? t('calendar.dayLabelNone', { date: full }) : t('calendar.dayLabel', { date: full, count: items.length })
              const shown = items.slice(0, items.length > MAX_CHIPS ? MAX_CHIPS - 1 : MAX_CHIPS)
              return (
                <div
                  key={day} role="gridcell" data-day={day} aria-selected={day === selected}
                  className={`cal-day ${inMonth ? '' : 'other'} ${day === today ? 'today' : ''} ${day === selected ? 'selected' : ''} ${day < today ? 'past' : ''} ${canCreateOn(day) ? 'can-create' : ''}`}
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest('button')) return
                    setSelected(day)
                    // On a computer an empty part of a day makes an event there; on a phone the day opens below first.
                    if (!phone && canCreateOn(day)) onCreate(day)
                  }}
                >
                  <button className="cal-date" aria-label={label} aria-current={day === today ? 'date' : undefined} onClick={() => setSelected(day)}>
                    {Number(day.slice(8))}
                  </button>
                  {phone ? (
                    items.length > 0 && (
                      <span className="cal-dots" aria-hidden>
                        {items.slice(0, 3).map((item, i) => <i key={i} className={item.kind === 'birthday' ? 'birthday' : item.projected ? 'projected' : ''} />)}
                      </span>
                    )
                  ) : (
                    <>
                      {shown.map((item, i) => item.kind === 'birthday' ? (
                        <span key={`b${item.accountKey}`} className="cal-chip birthday" title={nameOf(item)}>
                          <span aria-hidden>🎂</span> <span className="cal-chip-title">{server.members[item.accountKey]?.name ?? '?'}</span>
                          <span className="sr-only">{nameOf(item)}</span>
                        </span>
                      ) : (
                        <button
                          key={`${item.event.id}-${i}`} title={item.event.title}
                          className={`cal-chip ${item.projected ? 'projected' : ''} ${item.event.status === 'live' && !item.projected ? 'live' : ''} ${me && item.event.interested.includes(me) ? 'mine' : ''}`}
                          onClick={() => onOpenEvent(item.event.id)}
                        >
                          <time dateTime={new Date(item.startAt).toISOString()}>{formatClock(item.startAt)}</time>
                          <span className="cal-chip-title">{item.event.title}</span>
                        </button>
                      ))}
                      {items.length > shown.length && (
                        <button className="cal-more" onClick={() => setSelected(day)}>{t('calendar.more', { count: items.length - shown.length })}</button>
                      )}
                    </>
                  )}
                </div>
              )
            })}
          </div>
        ))}
      </div>

      <section className="cal-picked" aria-label={dayName(selected, { weekday: 'long', month: 'long', day: 'numeric' })} data-testid="calendar-day">
        <header>
          <h4>{selected === today ? t('calendar.today') : dayName(selected, { weekday: 'long', month: 'long', day: 'numeric' })}</h4>
          {canCreateOn(selected) && (
            <button className="button small" onClick={() => onCreate(selected)}><Plus size={14} /> {t('calendar.newOnDay')}</button>
          )}
        </header>
        {picked.length === 0 ? (
          <p className="muted">{t('calendar.dayNothing')}</p>
        ) : (
          <ul>
            {picked.map((item, i) => item.kind === 'birthday' ? (
              <li key={`b${item.accountKey}`} className="cal-row birthday"><span aria-hidden>🎂</span> {nameOf(item)}</li>
            ) : (
              <li key={`${item.event.id}-${i}`}>
                <button className="cal-row" onClick={() => onOpenEvent(item.event.id)}>
                  <time dateTime={new Date(item.startAt).toISOString()}>{formatClock(item.startAt)} – {formatClock(item.endAt)}</time>
                  <strong>{item.event.title}</strong>
                  {item.projected && <span className="muted cal-row-note"><RepeatIcon size={13} /> {t('calendar.repeatsThen')}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
