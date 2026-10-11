// The events dialog: upcoming and live events as cards (interested, add to calendar, join), and the create/edit form.
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../../i18n/errors'
import { formatDate } from '../../i18n/format'
import { t as translate } from '../../i18n'
import type { ServerEvent } from '../../core/protocol'
import type { ServerState } from '../../state/store'
import { cancelEvent, canCreateEvent, canManageEvent, setInterested, useEvents } from '../../state/events'
import { creatorTime, eventIcs, formatRange, icsFileName, localZone, openEvents, startsIn } from '../../state/eventTime'
import { joinVoice } from '../../state/voice'
import { Avatar, Modal } from '../bits'
import { Pencil, Plus, Volume } from '../icons'
import { CalendarIcon, CalendarPlus, MapPin, StarIcon } from '../forums/icons'
import { EventForm } from './EventForm'
import { useNow } from './useNow'
import { placeOf } from './place'

export function EventsDialog({ server, focus, onClose }: { server: ServerState; focus?: number; onClose: () => void }) {
  const { t } = useTranslation()
  const events = useEvents((s) => s.events[server.key])
  const [mode, setMode] = useState<{ kind: 'list' } | { kind: 'form'; event?: ServerEvent }>({ kind: 'list' })
  const now = useNow()
  const list = openEvents(Object.values(events ?? {}))
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (mode.kind !== 'list' || focus === undefined) return
    listRef.current?.querySelector(`#event-${focus}`)?.scrollIntoView({ block: 'center' })
  }, [focus, mode.kind])

  if (mode.kind === 'form') {
    const editing = mode.event ? events?.[mode.event.id] ?? mode.event : undefined
    return (
      <EventForm
        server={server}
        event={editing}
        onBack={() => setMode({ kind: 'list' })}
        onClose={onClose}
      />
    )
  }

  return (
    <Modal
      title={t('events.dialog.title')}
      heading={<>{t('events.dialog.title')} <span className="muted">{t('events.dialog.on', { server: server.name })}</span></>}
      onClose={onClose}
      wide
      className="events-modal"
      footer={canCreateEvent(server) ? (
        <button className="button primary" onClick={() => setMode({ kind: 'form' })}><Plus size={16} /> {t('events.dialog.schedule')}</button>
      ) : undefined}
    >
      <div ref={listRef} className="event-list">
        {list.length === 0 ? (
          <div className="event-empty">
            <span className="empty-icon"><CalendarIcon size={30} /></span>
            <h3>{t('events.dialog.empty')}</h3>
            <p className="muted">{canCreateEvent(server) ? t('events.dialog.emptyCreate') : t('events.dialog.emptyView')}</p>
          </div>
        ) : (
          list.map((event) => (
            <EventCard key={event.id} server={server} event={event} now={now} focused={event.id === focus}
              onEdit={() => setMode({ kind: 'form', event })} onJoined={onClose} />
          ))
        )}
      </div>
    </Modal>
  )
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
              {t('events.dialog.cancelConfirm')}
              <button className="button danger small" disabled={busy} onClick={() => void run(() => cancelEvent(server.key, event.id))}>{t('events.dialog.cancelEvent')}</button>
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
